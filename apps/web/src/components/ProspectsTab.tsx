import Link from 'next/link';
import { PROSPECT_NOTES_MAX, PROSPECT_STATUSES, PROSPECT_STATUS_COLORS, PROSPECT_STATUS_LABELS, directionsUrl, telHref, type ProspectStatus } from '@hazard/core';
import { getSql, listProspects, prospectCounts } from '@hazard/db';
import { createProspect, deleteProspect, logProspectCall, updateProspect } from '@/app/actions/prospects';

const SHOWN = 300;
const day = (d: Date | null) => (d ? new Date(d).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '');
const today = () => new Date().toLocaleDateString('en-CA');

/** The prospect list: who to call, what happened, and when to call again. */
export async function ProspectsTab({ organizationId, status }: { organizationId: string; status: ProspectStatus | null }) {
  const sql = getSql();
  const [prospects, counts] = await Promise.all([listProspects(sql, organizationId, status, SHOWN + 1), prospectCounts(sql, organizationId)]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const filterHref = (s: ProspectStatus | null) => `/clients?tab=prospects${s ? `&status=${s}` : ''}`;

  return (
    <>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Prospects are businesses and locations you want to call on. The quickest way to add them is from the <Link href="/">map</Link>: find businesses in an
          area or inside an alert, then press Add to prospects. They stay here until you remove them.
        </p>
        <details>
          <summary>Add a prospect by hand</summary>
          <form action={createProspect} className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            <label>
              Name
              <input type="text" name="name" required maxLength={160} />
            </label>
            <label>
              Type of business
              <input type="text" name="kind" maxLength={80} />
            </label>
            <label>
              Phone
              <input type="tel" name="phone" maxLength={30} />
            </label>
            <label>
              Address
              <input type="text" name="address" maxLength={160} />
            </label>
            <label>
              City
              <input type="text" name="city" maxLength={80} />
            </label>
            <label>
              State
              <input type="text" name="state" maxLength={2} style={{ width: 60 }} />
            </label>
            <label>
              ZIP
              <input type="text" name="zip" maxLength={10} style={{ width: 90 }} />
            </label>
            <label>
              Website
              <input type="text" name="website" maxLength={300} />
            </label>
            <button type="submit">Add prospect</button>
          </form>
        </details>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <div className="chips" role="navigation" aria-label="Show prospects by status">
          <Link href={filterHref(null)} className={status === null ? 'chip on' : 'chip'}>
            All ({total})
          </Link>
          {PROSPECT_STATUSES.map((s) => (
            <Link key={s} href={filterHref(s)} className={status === s ? 'chip on' : 'chip'}>
              {PROSPECT_STATUS_LABELS[s]} ({counts[s] ?? 0})
            </Link>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {total > 0 && (
          <a className="button secondary" href="/api/export/prospects">
            Download list (CSV)
          </a>
        )}
      </div>

      {prospects.length === 0 && (
        <div className="card muted">{total === 0 ? 'No prospects yet. Add some from the map, or add one by hand above.' : 'No prospects with this status.'}</div>
      )}
      {prospects.slice(0, SHOWN).map((p) => {
        const tel = telHref(p.phone);
        const directions = p.lon !== null && p.lat !== null ? directionsUrl(p.lat, p.lon) : null;
        const due = p.followUpOn !== null && p.followUpOn <= today();
        const place = [p.address, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        return (
          <div className={due ? 'card prospect due' : 'card prospect'} key={p.id}>
            <div className="prospect-who">
              <div>
                <strong>{p.name}</strong>{' '}
                <span className="pill" style={{ background: PROSPECT_STATUS_COLORS[p.status] }}>
                  {PROSPECT_STATUS_LABELS[p.status]}
                </span>
                {due && <span className="pill" style={{ background: 'var(--danger)', marginLeft: 4 }}>Follow-up due</span>}
              </div>
              {p.kind && <div className="muted">{p.kind}</div>}
              {place && <div>{place}</div>}
              <div className="prospect-links">
                {p.phone && (tel ? <a href={tel} className="prospect-phone">{p.phone}</a> : <span className="prospect-phone">{p.phone}</span>)}
                {p.website && (
                  <a href={p.website} target="_blank" rel="noopener noreferrer" data-site-popup>
                    Website
                  </a>
                )}
                {directions && (
                  <a href={directions} target="_blank" rel="noopener noreferrer">
                    Directions
                  </a>
                )}
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                {p.calls > 0 ? `Called ${p.calls} time${p.calls === 1 ? '' : 's'}, last on ${day(p.lastContactedAt)}.` : 'Not called yet.'}{' '}
                Added {day(p.createdAt)}
                {p.addedBy ? ` by ${p.addedBy}` : ''}
                {p.foundIn ? ` · ${p.foundIn}` : ''}
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <form action={logProspectCall}>
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="filter" value={status ?? ''} />
                  <button type="submit" className="secondary">
                    I called them
                  </button>
                </form>
                <form action={deleteProspect}>
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="filter" value={status ?? ''} />
                  <button type="submit" className="link">
                    Remove
                  </button>
                </form>
              </div>
            </div>
            <form action={updateProspect} className="prospect-track">
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="filter" value={status ?? ''} />
              <div className="row">
                <label>
                  Status
                  <select name="status" defaultValue={p.status}>
                    {PROSPECT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {PROSPECT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Follow up on
                  <input type="date" name="follow_up_on" defaultValue={p.followUpOn ?? ''} />
                </label>
              </div>
              <label>
                Notes
                <textarea name="notes" rows={2} maxLength={PROSPECT_NOTES_MAX} defaultValue={p.notes} placeholder="Who you spoke to, what they said, what to do next" />
              </label>
              <button type="submit">Save</button>
            </form>
          </div>
        );
      })}
      {prospects.length > SHOWN && <p className="small muted">Showing the first {SHOWN}. Pick a status above to narrow the list, or download it for all of them.</p>}
    </>
  );
}
