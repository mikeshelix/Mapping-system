/** Browser side of "Add to prospects". */
import { MAX_PROSPECTS_PER_ADD } from '@hazard/core';

export interface AddOutcome {
  added: number;
  already: number;
}

/** What a business needs to carry to become a prospect. Extra fields are ignored by the server. */
export interface ProspectCandidate {
  id: string;
  name: string;
  kind?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  website?: string;
  lon: number;
  lat: number;
}

async function send(body: { items?: ProspectCandidate[]; propertyIds?: string[]; foundIn: string }): Promise<AddOutcome> {
  const res = await fetch('/api/prospects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Please sign in again.');
  }
  const json = (await res.json().catch(() => ({}))) as Partial<AddOutcome> & { error?: string };
  if (!res.ok) throw new Error(json.error ?? 'The prospect list could not be updated. Please try again.');
  return { added: json.added ?? 0, already: json.already ?? 0 };
}

/** Adds businesses and/or the organization's own locations to the prospect list. Long lists go in several requests. */
export async function addToProspects(what: { items?: ProspectCandidate[]; propertyIds?: string[]; foundIn?: string }): Promise<AddOutcome> {
  const foundIn = what.foundIn ?? '';
  const total: AddOutcome = { added: 0, already: 0 };
  const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / MAX_PROSPECTS_PER_ADD) }, (_, i) => list.slice(i * MAX_PROSPECTS_PER_ADD, (i + 1) * MAX_PROSPECTS_PER_ADD));
  for (const items of chunks(what.items ?? [])) {
    const r = await send({ items, foundIn });
    total.added += r.added;
    total.already += r.already;
  }
  for (const propertyIds of chunks(what.propertyIds ?? [])) {
    const r = await send({ propertyIds, foundIn });
    total.added += r.added;
    total.already += r.already;
  }
  return total;
}

/** "3 added to your prospect list. 2 were already on it." */
export function addOutcomeText(o: AddOutcome): string {
  const parts: string[] = [];
  if (o.added > 0) parts.push(`${o.added.toLocaleString()} added to your prospect list.`);
  if (o.already > 0) parts.push(`${o.already.toLocaleString()} ${o.already === 1 ? 'was' : 'were'} already on it.`);
  return parts.join(' ') || 'Nothing was added.';
}
