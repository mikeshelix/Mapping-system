'use client';

import { useEffect, useState } from 'react';
import { type ForecastPeriod, HAZARD_LABELS, SEVERITY_COLORS, SEVERITY_LABELS, directionsUrl, type HazardType, type Severity } from '@hazard/core';

export interface LocationDetail {
  id: string;
  name: string;
  address: string;
  propertyType: string | null;
  declaredValue: number | null;
  lon: number;
  lat: number;
  placedBy: 'pin' | 'address';
  client: string;
  clientColor: string;
  alerts: Array<{ id: string; name: string; hazardType: string; severity: Severity; headline: string | null; endsAt: string | null; sourceUrl: string | null }>;
  contacts: Array<{ id: string; name: string; email: boolean; text: boolean }>;
}

type Forecast = { status: 'loading' | 'outside' | 'unavailable' } | { status: 'ok'; periods: ForecastPeriod[]; source: string };

/** The next three days at this location. Loaded on its own so a slow forecast never holds up the card. */
function ForecastSection({ propertyId }: { propertyId: string }) {
  const [forecast, setForecast] = useState<Forecast>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    setForecast({ status: 'loading' });
    fetch(`/api/property/${propertyId}/forecast`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: Forecast) => current && setForecast(json))
      .catch(() => current && setForecast({ status: 'unavailable' }));
    return () => {
      current = false;
    };
  }, [propertyId]);

  if (forecast.status === 'loading') return <p className="muted">Loading the forecast…</p>;
  if (forecast.status === 'outside') return <p className="muted">Forecasts cover locations in the United States only.</p>;
  if (forecast.status !== 'ok') return <p className="muted">The forecast is not available right now. Close and reopen this location to try again.</p>;
  return (
    <>
      {forecast.periods.map((p) => (
        <div key={p.startTime} className={`forecast-row${p.concerns.length ? ' watch' : ''}`} title={p.detailedForecast}>
          <div className="when">{p.name}</div>
          <div className="what">
            <div>
              {p.shortForecast}
              {p.temperature !== null && (
                <span className="muted">
                  {' '}
                  · {p.isDaytime ? 'High' : 'Low'} {p.temperature}°{p.temperatureUnit}
                </span>
              )}
            </div>
            <div className="small muted">
              {[p.precipChance !== null && p.precipChance > 0 ? `${p.precipChance}% chance of rain or snow` : null, p.wind ? `Wind ${p.wind}` : null].filter(Boolean).join(' · ')}
            </div>
            {p.concerns.length > 0 && <div className="small concern">Worth watching: {p.concerns.join(', ').toLowerCase()}</div>}
          </div>
        </div>
      ))}
      <p className="small muted" style={{ marginTop: 6 }}>
        Forecast from the {forecast.source}. Official warnings appear above under Affecting it now.
      </p>
    </>
  );
}

/** Everything about one location, shown beside the map when its pin is clicked. */
export function LocationCard({ detail, failed, onAlert }: { detail: LocationDetail | null; failed: boolean; onAlert: (eventId: string, hazardType: string) => void }) {
  if (failed) return <div className="flash error">This location could not be loaded. Click its pin to try again.</div>;
  if (!detail) return <p className="muted">Loading…</p>;
  const directions = directionsUrl(detail.lat, detail.lon);
  return (
    <div className="location-card">
      <h3>{detail.name}</h3>
      <div>{detail.address || <span className="muted">No address (placed by pin)</span>}</div>
      <div className="muted" style={{ marginTop: 4 }}>
        <span className="swatch" style={{ background: detail.clientColor }} />
        {detail.client}
        {detail.propertyType ? ` · ${detail.propertyType}` : ''}
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        Declared value: {detail.declaredValue === null ? 'not set' : `$${Math.round(detail.declaredValue).toLocaleString()}`}
      </div>

      {directions && (
        <a className="button-link" href={directions} target="_blank" rel="noopener noreferrer">
          Get directions
        </a>
      )}
      {directions && <div className="small muted">Opens Google Maps in a new tab, from where you are now.</div>}

      <h4>Affecting it now</h4>
      {detail.alerts.length === 0 && <p className="ok">Nothing is affecting this location right now.</p>}
      {detail.alerts.map((a) => (
        <button key={a.id} type="button" className="alert-item" style={{ borderLeftColor: SEVERITY_COLORS[a.severity] }} onClick={() => onAlert(a.id, a.hazardType)}>
          <div className="t">{a.name}</div>
          <div className="small">
            <span className="pill" style={{ background: SEVERITY_COLORS[a.severity] }}>
              {SEVERITY_LABELS[a.severity]}
            </span>{' '}
            {HAZARD_LABELS[a.hazardType as HazardType] ?? a.hazardType}
            {a.endsAt ? ` · until ${new Date(a.endsAt).toLocaleString()}` : ''}
          </div>
          {a.headline && <div className="small muted" style={{ marginTop: 4 }}>{a.headline}</div>}
        </button>
      ))}

      <h4>Forecast</h4>
      <ForecastSection propertyId={detail.id} />

      <h4>Who gets alerts</h4>
      {detail.contacts.length === 0 && (
        <p className="muted">
          No contacts are linked to this location or its client. <a href="/contacts">Add a contact</a>.
        </p>
      )}
      {detail.contacts.map((k) => (
        <div key={k.id} className="contact-row">
          <a href={`/contacts/${k.id}`}>{k.name}</a>
          <span className="small muted">{[k.email && 'email', k.text && 'text'].filter(Boolean).join(' and ') || 'no way to reach them yet'}</span>
        </div>
      ))}
      <p className="small muted" style={{ marginTop: 12 }}>
        A contact is only alerted when a rule covers this location. <a href="/rules">See alert rules</a>.
      </p>
    </div>
  );
}
