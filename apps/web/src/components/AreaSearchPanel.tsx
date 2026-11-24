'use client';

import { useState } from 'react';
import {
  MAX_AREA_SQ_MILES,
  PLACES_NOTE,
  PLACE_CATEGORIES,
  PLACE_CATEGORY_LABELS,
  directionsUrl,
  ringAreaSqMiles,
  toCsv,
  type LonLat,
  type Place,
  type PlaceCategory,
} from '@hazard/core';
import { addOutcomeText, addToProspects } from '@/lib/prospectsClient';

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
  /** Shown at the top when the area came from an alert, or when that could not be done. */
  notice?: { text: string; problem: boolean } | null;
  /** Saved with each prospect added from this search, e.g. the alert's name. */
  foundIn?: string;
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
  /** What is already on the prospect list from this search: "b:" + business id, "p:" + location id. */
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addNote, setAddNote] = useState<{ text: string; problem: boolean } | null>(null);

  const area = ring.length >= 3 ? ringAreaSqMiles(ring) : 0;
  const tooBig = area > MAX_AREA_SQ_MILES;
  const ready = !drawing && ring.length >= 3 && !tooBig;

  function reset() {
    setResults(null);
    setAdded(new Set());
    setAddNote(null);
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
      setAdded(new Set());
      setAddNote(null);
      props.onResults(json.places);
    } catch {
      setError('The search could not be completed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  /** Sends businesses and/or the organization's own locations to the prospect list and marks them as added here. */
  async function addProspects(places: Place[], own: OwnProperty[]) {
    if (adding || places.length + own.length === 0) return;
    setAdding(true);
    setAddNote(null);
    try {
      const outcome = await addToProspects({ items: places, propertyIds: own.map((p) => p.id), foundIn: props.foundIn || 'Area drawn on the map' });
      setAdded((prev) => new Set([...prev, ...places.map((p) => `b:${p.id}`), ...own.map((p) => `p:${p.id}`)]));
      setAddNote({ text: addOutcomeText(outcome), problem: false });
    } catch (e) {
      setAddNote({ text: e instanceof Error ? e.message : 'The prospect list could not be updated. Please try again.', problem: true });
    } finally {
      setAdding(false);
    }
  }

  function download() {
    if (!results) return;
    const csv = toCsv(
      ['Name', 'Category', 'Type', 'Address', 'City', 'State', 'ZIP', 'Phone', 'Website', 'Latitude', 'Longitude'],
      results.places.map((p) => [p.name, PLACE_CATEGORY_LABELS[p.category], p.kind, p.address, p.city, p.state, p.zip, p.phone, p.website, p.lat, p.lon]),
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
      {props.notice && <div className={props.notice.problem ? 'flash error' : 'flash notice'}>{props.notice.text}</div>}
      <section>
        <p className="muted">
          Draw a shape on the map to list the businesses inside it, for example the path of a hail swath or a flooded neighborhood. Or click an alert on the map and
          choose Find businesses in this area.
        </p>
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
          {busy && <p className="small muted" style={{ marginTop: 8 }}>The first search of a region can take about 15 seconds; after that it is usually a few seconds.</p>}
        </section>
      )}
      {error && <div className="flash error">{error}</div>}
      {results && (
        <section>
          <h2>
            {results.places.length.toLocaleString()} business{results.places.length === 1 ? '' : 'es'} found
          </h2>
          {results.truncated && <p className="small" style={{ color: 'var(--danger)' }}>This area holds more businesses than one search returns. The list is the first {results.places.length.toLocaleString()} by name: pick a kind of business or draw a smaller area for the rest.</p>}
          <p className="small muted">
            {results.ownProperties.length === 0
              ? 'None of your properties are inside this area.'
              : `${results.ownProperties.length} of your properties ${results.ownProperties.length === 1 ? 'is' : 'are'} inside this area:`}
          </p>
          {results.ownProperties.slice(0, 50).map((p) => (
            <div key={p.id} className="place-row">
              <button type="button" className="place own" onClick={() => props.onFocus(p.lon, p.lat)}>
                <strong>{p.name}</strong>
                <span className="small muted">
                  {p.client} · {p.address}
                </span>
              </button>
              <button type="button" className="add" disabled={adding || added.has(`p:${p.id}`)} onClick={() => void addProspects([], [p])} aria-label={`Add ${p.name} to prospects`}>
                {added.has(`p:${p.id}`) ? 'Added ✓' : '+ Prospect'}
              </button>
            </div>
          ))}
          {results.places.length > 0 && (
            <div className="row" style={{ margin: '8px 0' }}>
              <button type="button" disabled={adding || results.places.every((p) => added.has(`b:${p.id}`))} onClick={() => void addProspects(results.places.filter((p) => !added.has(`b:${p.id}`)), [])}>
                {adding ? 'Adding…' : results.places.every((p) => added.has(`b:${p.id}`)) ? 'All added to prospects ✓' : `Add all ${results.places.length.toLocaleString()} to prospects`}
              </button>
              <button type="button" className="secondary" onClick={download}>
                Download list (CSV)
              </button>
            </div>
          )}
          {addNote && (
            <div className={addNote.problem ? 'flash error' : 'flash notice'}>
              {addNote.text} {!addNote.problem && <a href="/clients?tab=prospects">Open the prospect list</a>}
            </div>
          )}
          {results.places.slice(0, 300).map((p) => (
            <div key={p.id} className="place-row">
              <button type="button" className="place" onClick={() => props.onFocus(p.lon, p.lat)}>
                <strong>{p.name}</strong>
                <span className="small muted">
                  {p.kind || PLACE_CATEGORY_LABELS[p.category]}
                  {p.address ? ` · ${[p.address, p.city].filter(Boolean).join(', ')}` : ''}
                  {p.phone ? ` · ${p.phone}` : ''}
                </span>
              </button>
              {p.website && (
                <a className="small" href={p.website} target="_blank" rel="noopener noreferrer" data-site-popup aria-label={`Website of ${p.name}, opens in a small window`}>
                  Website
                </a>
              )}
              {directionsUrl(p.lat, p.lon) && (
                <a className="small" href={directionsUrl(p.lat, p.lon)!} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${p.name}`}>
                  Directions
                </a>
              )}
              <button type="button" className="add" disabled={adding || added.has(`b:${p.id}`)} onClick={() => void addProspects([p], [])} aria-label={`Add ${p.name} to prospects`}>
                {added.has(`b:${p.id}`) ? 'Added ✓' : '+ Prospect'}
              </button>
            </div>
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
