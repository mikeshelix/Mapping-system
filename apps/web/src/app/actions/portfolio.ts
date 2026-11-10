'use server';

import { revalidatePath } from 'next/cache';
import { geocodeOneLine } from '@hazard/core';
import { flagActiveEvents, getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { back, isUuid, list, money, optional, str } from '@/lib/form';

async function ownsClient(orgId: string, clientId: string): Promise<boolean> {
  if (!isUuid(clientId)) return false;
  const [row] = await getSql()`SELECT 1 FROM clients WHERE id = ${clientId} AND organization_id = ${orgId}`;
  return !!row;
}

// ------------------------------------------------------------------ clients
export async function createClientAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const name = str(form, 'name');
  const color = /^#[0-9a-f]{6}$/i.test(str(form, 'color')) ? str(form, 'color') : '#2563eb';
  if (!name) back('/clients', 'error', 'Client name is required.');
  await getSql()`INSERT INTO clients (organization_id, name, color) VALUES (${user.organizationId}, ${name}, ${color})`;
  revalidatePath('/clients');
}

export async function updateClientColor(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  const color = str(form, 'color');
  if (!isUuid(id) || !/^#[0-9a-f]{6}$/i.test(color)) return;
  await getSql()`UPDATE clients SET color = ${color} WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  revalidatePath('/clients');
}

export async function deleteClient(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  if (!isUuid(id)) return;
  await getSql()`DELETE FROM clients WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  revalidatePath('/clients');
}

// ------------------------------------------------------------------ properties
export async function createProperty(form: FormData): Promise<void> {
  const user = await requireUser();
  const clientId = str(form, 'client_id');
  const name = str(form, 'name');
  const address = optional(form, 'address');
  const city = optional(form, 'city');
  const state = optional(form, 'state');
  const zip = optional(form, 'zip');
  if (!(await ownsClient(user.organizationId, clientId))) back('/properties', 'error', 'Choose a client.');
  if (!name) back('/properties', 'error', 'Property name is required.');

  let lon = Number(str(form, 'lon'));
  let lat = Number(str(form, 'lat'));
  let source: 'manual' | 'census' = 'manual';
  let matchedAddress: string | null = null;
  const hasPin = str(form, 'lon') !== '' && str(form, 'lat') !== '' && Number.isFinite(lon) && Number.isFinite(lat);

  if (!hasPin) {
    if (!address) back('/properties', 'error', 'Enter an address or drop a pin on the map.');
    const oneLine = [address, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    let result;
    try {
      result = await geocodeOneLine(oneLine);
    } catch {
      back('/properties', 'error', 'The Census geocoder is not responding. Try again, or drop a pin on the map.');
    }
    if (!result.matched || result.lon === null || result.lat === null) {
      back('/properties', 'error', `No match for "${oneLine}". Check the address, or drop a pin on the map instead.`);
    }
    lon = result.lon;
    lat = result.lat;
    source = 'census';
    matchedAddress = result.matchedAddress;
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) back('/properties', 'error', 'Pin location is not valid.');

  const sql = getSql();
  await sql`
    INSERT INTO properties (organization_id, client_id, name, address, city, state, zip, location, geocode_source,
      matched_address, property_type, declared_value)
    VALUES (${user.organizationId}, ${clientId}, ${name}, ${address}, ${city}, ${state}, ${zip},
      ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326), ${source}, ${matchedAddress},
      ${optional(form, 'property_type')}, ${money(str(form, 'declared_value'))})`;
  // A new property may sit inside a hazard that is already in effect.
  await flagActiveEvents(sql);
  revalidatePath('/properties');
  back('/properties', 'notice', `Added ${name}${matchedAddress ? ` at ${matchedAddress}` : ' at the pinned location'}.`);
}

export async function deleteProperty(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  if (!isUuid(id)) return;
  await getSql()`DELETE FROM properties WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  revalidatePath('/properties');
}

// ------------------------------------------------------------------ contacts
export async function createContact(form: FormData): Promise<void> {
  const user = await requireUser();
  const name = str(form, 'name');
  const email = optional(form, 'email');
  const mobile = optional(form, 'mobile');
  const clientId = optional(form, 'client_id');
  const smsOptIn = form.get('sms_opt_in') === 'on' && !!mobile;
  if (!name) back('/contacts', 'error', 'Contact name is required.');
  if (!email && !mobile) back('/contacts', 'error', 'Enter an email address or a mobile number.');
  if (clientId && !(await ownsClient(user.organizationId, clientId))) back('/contacts', 'error', 'Unknown client.');
  const sql = getSql();
  await sql`
    INSERT INTO contacts (organization_id, client_id, name, email, mobile, sms_opt_in, sms_opt_in_at)
    VALUES (${user.organizationId}, ${clientId}, ${name}, ${email}, ${mobile}, ${smsOptIn}, ${smsOptIn ? sql`now()` : null})`;
  await flagActiveEvents(sql, user.organizationId);
  revalidatePath('/contacts');
}

export async function deleteContact(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  if (!isUuid(id)) return;
  await getSql()`DELETE FROM contacts WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  revalidatePath('/contacts');
}

/** Limit a contact to specific properties (empty selection = all of their client's properties). */
export async function setContactProperties(form: FormData): Promise<void> {
  const user = await requireUser();
  const contactId = str(form, 'contact_id');
  const propertyIds = list(form, 'property_id').filter(isUuid);
  if (!isUuid(contactId)) return;
  const sql = getSql();
  const [contact] = await sql`SELECT id FROM contacts WHERE id = ${contactId} AND organization_id = ${user.organizationId}`;
  if (!contact) back('/contacts', 'error', 'Unknown contact.');
  await sql.begin(async (tx) => {
    await tx`DELETE FROM contact_properties WHERE contact_id = ${contactId}`;
    if (propertyIds.length) {
      await tx`
        INSERT INTO contact_properties (contact_id, property_id)
        SELECT ${contactId}, id FROM properties
        WHERE id = ANY(${propertyIds}::uuid[]) AND organization_id = ${user.organizationId}`;
    }
  });
  await flagActiveEvents(sql, user.organizationId);
  revalidatePath('/contacts');
  back('/contacts', 'notice', 'Contact coverage saved.');
}
