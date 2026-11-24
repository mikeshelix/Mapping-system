import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { MAX_PROSPECTS_PER_ADD, cleanFoundIn, cleanProspectInputs } from '@hazard/core';
import { addPropertyProspects, addProspects, getSql } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';

export const dynamic = 'force-dynamic';

/**
 * Adds things found on the map to the signed-in organization's prospect list.
 * Body: { items?: businesses as shown on the map, propertyIds?: the organization's own locations, foundIn?: why }.
 * Businesses come from open map data (Overture). Nothing from Google is ever sent here or stored.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { items?: unknown; propertyIds?: unknown; foundIn?: unknown } | null;
  const items = cleanProspectInputs(body?.items);
  const propertyIds = Array.isArray(body?.propertyIds) ? [...new Set(body.propertyIds.filter((v): v is string => typeof v === 'string' && isUuid(v)))].slice(0, MAX_PROSPECTS_PER_ADD) : [];
  if (items.length === 0 && propertyIds.length === 0) return NextResponse.json({ error: 'Nothing to add.' }, { status: 400 });
  const foundIn = cleanFoundIn(body?.foundIn);

  try {
    const sql = getSql();
    const [businesses, locations] = await Promise.all([
      addProspects(sql, user.organizationId, user.id, items, 'business', foundIn),
      addPropertyProspects(sql, user.organizationId, user.id, propertyIds, foundIn),
    ]);
    revalidatePath('/clients');
    return NextResponse.json({ added: businesses.added + locations.added, already: businesses.already + locations.already });
  } catch (error) {
    console.error('[prospects]', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'The prospect list could not be updated just now. Please try again.' }, { status: 500 });
  }
}
