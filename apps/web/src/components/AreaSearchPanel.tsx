'use client';

import { useState } from 'react';
import {
  MAX_AREA_SQ_MILES,
  PLACES_NOTE,
  PLACE_CATEGORIES,
  PLACE_CATEGORY_LABELS,
  ringAreaSqMiles,
  toCsv,
  type LonLat,
  type Place,
  type PlaceCategory,
} from '@hazard/core';

export interface OwnProperty {
  id: string;
  name: string;
  address: string;
  client: string;
  lon: number;
  lat: number;
}
interface Results {
  places: Place[];
  ownProperties: OwnProperty[];
  areaSqMiles: number;
  truncated: boolean;
  attribution: string;
  category: PlaceCategory;
}

/** Draw a shape on the map and list the businesses inside it. */
export function AreaSearchPanel(props: {
  ring: LonLat[];
  drawing: boolean;
  onStartDrawing: () => void;
  onFinishDrawing: () => void;
  onClear: () => void;
  onResults: (places: Place[]) => void;
  onFocus: (lon: number, lat: number) => void;
}) {
  const { ring, drawing } = props;
  const [category, setCategory] = useState<PlaceCategory>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Results | null>(null);

  const area = ring.length >= 3 ? ringAreaSqMiles(ring) : 0;
  const tooBig = area > MAX_AREA_SQ_MILES;
  const ready = !drawing && ring.length >= 3 && !tooBig;

  function reset() {
    setResults(null);
    setError(null);
    props.onResults([]);
  }

  async function search() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ring, category }),
      });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const json = (await res.json().catch(() => ({}))) as Partial<Results> & { error?: string };
      if (!res.ok || !json.places) {
        setError(json.error ?? 'The search failed. Please try again.');
        return;
      }
      setResults({ ...(json as Results), category });
      props.onResults(json.places);
    } catch {
      setError('The search could not be completed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!results) return;
    const csv = toCsv(
      ['Name', 'Category', 'Type', 'Address', 'City', 'State', 'ZIP', 'Phone', 'Website', 'Latitude', 'Longitude', 'OpenStreetMap link'],
      results.places.map((p) => [p.name, PLACE_CATEGORY_LABELS[p.category], p.kind, p.address, p.city, p.state, p.zip, p.phone, p.website, p.lat, p.lon, p.url]),
    );
    // The byte-order mark makes Excel read the file as UTF-8.
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `businesses-in-area-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <section>
        <p className="muted">Draw a shape on the map to list the businesses inside it, for example the path of a hail swath or a flooded neighborhood.</p>
        <div className="row">
          {!drawing && (
            <button
              type="button"
              onClick={() => {
                reset();
                props.onStartDrawing();
              }}
            >
              {ring.length ? 'Draw a new area' : 'Draw an area'}
            </button>
          )}
          {drawing && (
            <button type="button" onClick={props.onFinishDrawing} disabled={ring.length < 3}>
              Finish shape
            </button>
          )}
          {(drawing || ring.length > 0) && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                reset();
                props.onClear();
              }}
            >
              Clear
            </button>
          )}
        </div>
        {drawing && (
          <p className="small muted" style={{ marginTop: 8 }}>
            Click the map to add each corner ({ring.length} so far). Double-click, or press Finish shape, to close it.
          </p>
        )}
        {ring.length >= 3 && (
          <p className={`small ${tooBig ? '' : 'muted'}`} style={{ marginTop: 8, color: tooBig ? 'var(--danger)' : undefined }}>
            Area: about {area < 10 ? area.toFixed(2) : Math.round(area).toLocaleString()} square miles.
            {tooBig && ` The most that can be searched at once is ${MAX_AREA_SQ_MILES}.`}
          </p>
        )}
      </section>
      {ring.length >= 3 && !drawing && (
        <section>
          <label>
            Kind of business
            <select value={category} onChange={(e) => setCategory(e.target.value as PlaceCategory)}>
              {PLACE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {PLACE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" style={{ marginTop: 8 }} onClick={() => void search()} disabled={!ready || busy}>
            {busy ? 'Searching…' : 'Find businesses'}
          </button>
          {busy && <p className="small muted" style={{ marginTop: 8 }}>This uses a free public map-data service and can take up to a minute when it is busy.</p>}
        </section>
      )}
      {error && <div className="flash error">{error}</div>}
      {results && (
        <section>
          <h2>
            {results.places.length.toLocaleString()} business{results.places.length === 1 ? '' : 'es'} found
          </h2>
          {results.truncated && <p className="small" style={{ color: 'var(--danger)' }}>The list is incomplete because the area holds too many. Draw a smaller area for a full list.</p>}
          <p className="small muted">
            {results.ownProperties.length === 0
              ? 'None of your properties are inside this area.'
              : `${results.ownProperties.length} of your properties ${results.ownProperties.length === 1 ? 'is' : 'are'} inside this area:`}
          </p>
          {results.ownProperties.slice(0, 50).map((p) => (
            <button key={p.id} type="button" className="place own" onClick={() => props.onFocus(p.lon, p.lat)}>
              <strong>{p.name}</strong>
              <span className="small muted">
                {p.client} · {p.address}
              </span>
            </button>
          ))}
          {results.places.length > 0 && (
            <button type="button" className="secondary" style={{ margin: '8px 0' }} onClick={download}>
              Download list (CSV)
            </button>
          )}
          {results.places.slice(0, 300).map((p) => (
            <button key={p.id} type="button" className="place" onClick={() => props.onFocus(p.lon, p.lat)}>
              <strong>{p.name}</strong>
              <span className="small muted">
                {p.kind || PLACE_CATEGORY_LABELS[p.category]}
                {p.address ? ` · ${p.address}` : ''}
              </span>
            </button>
          ))}
          {results.places.length > 300 && <p className="small muted">Showing the first 300 here. The download has all {results.places.length.toLocaleString()}.</p>}
          <p className="small muted">
            {PLACES_NOTE} {results.attribution}.
          </p>
        </section>
      )}
    </div>
  );
}
