/**
 * Prospects: businesses and locations a user wants to call on, usually found on the map
 * after a hazard. Everything here is pure, so the same checks run in the browser and on
 * the server.
 */
export const PROSPECT_STATUSES = ['new', 'called', 'follow_up', 'interested', 'not_interested', 'won'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  new: 'New',
  called: 'Called',
  follow_up: 'Follow up',
  interested: 'Interested',
  not_interested: 'Not interested',
  won: 'Won',
};

export const PROSPECT_STATUS_COLORS: Record<ProspectStatus, string> = {
  new: '#2563eb',
  called: '#6b7280',
  follow_up: '#d97706',
  interested: '#0f766e',
  not_interested: '#9ca3af',
  won: '#16a34a',
};

/** Where a prospect came from: typed in by hand, a business found on the map, or one of the organization's own locations. */
export const PROSPECT_SOURCES = ['manual', 'business', 'property'] as const;
export type ProspectSource = (typeof PROSPECT_SOURCES)[number];

export const PROSPECT_SOURCE_LABELS: Record<ProspectSource, string> = {
  manual: 'Added by hand',
  business: 'Found on the map',
  property: 'One of your locations',
};

/** The most prospects one request may add. Longer lists are sent in several requests. */
export const MAX_PROSPECTS_PER_ADD = 500;
export const PROSPECT_NOTES_MAX = 4000;
export const PROSPECT_FOUND_IN_MAX = 200;

export interface ProspectInput {
  name: string;
  kind: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  website: string;
  lon: number | null;
  lat: number | null;
  /** The map data's own id for the business, so the same business is never added twice. Null for hand-typed prospects. */
  sourceRef: string | null;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** One prospect as sent by the browser, tidied and length-limited; null when it has no name. */
export function cleanProspectInput(raw: unknown): ProspectInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 160);
  if (!name) return null;
  const lon = typeof r.lon === 'number' ? r.lon : Number.NaN;
  const lat = typeof r.lat === 'number' ? r.lat : Number.NaN;
  const located = Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
  const website = text(r.website, 300);
  const ref = text(r.id ?? r.sourceRef, 80);
  return {
    name,
    kind: text(r.kind, 80),
    address: text(r.address, 160),
    city: text(r.city, 80),
    state: text(r.state, 40),
    zip: text(r.zip, 12),
    phone: text(r.phone, 30),
    // Only ordinary web links are kept.
    website: /^https?:\/\/[^\s"'<>]+$/i.test(website) ? website : '',
    lon: located ? lon : null,
    lat: located ? lat : null,
    sourceRef: ref || null,
  };
}

/** A list of prospects from the browser: at most MAX_PROSPECTS_PER_ADD, unusable entries dropped. */
export function cleanProspectInputs(raw: unknown): ProspectInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_PROSPECTS_PER_ADD).map(cleanProspectInput).filter((p): p is ProspectInput => p !== null);
}

/** Why the prospect was added, e.g. "Flood Warning, Brevard County". */
export function cleanFoundIn(raw: unknown): string {
  return text(raw, PROSPECT_FOUND_IN_MAX);
}

export const isProspectStatus = (v: unknown): v is ProspectStatus => (PROSPECT_STATUSES as readonly string[]).includes(v as string);

/** A phone number as a tel: link target, or null when it holds too few digits to dial. */
export function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 7 ? `tel:${digits}` : null;
}
