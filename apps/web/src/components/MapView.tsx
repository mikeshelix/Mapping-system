'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { DISCLAIMER, HAZARD_LABELS, SEVERITY_COLORS, SEVERITY_LABELS, type HazardType, type Severity } from '@hazard/core';
import { BASE_STYLE_URL, addSatelliteLayer, firstLabelLayer, setSatellite } from './basemap';

interface Client {
  id: string;
  name: string;
  color: string;
}
interface HazardEvent {
  id: string;
  name: string;
  hazardType: HazardType;
  severity: Severity;
  status: string;
  headline: string | null;
  area: string | null;
  endsAt: string | null;
  sourceUrl: string | null;
  propertyIds: string[];
}
interface MapData {
  clients: Client[];
  properties: GeoJSON.FeatureCollection<GeoJSON.Point>;
  events: HazardEvent[];
  hazards: GeoJSON.FeatureCollection;
}

const REFRESH_MS = 60_000;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function severityExpression(property: string, fallback: string): maplibregl.ExpressionSpecification {
  return [
    'match',
    ['get', property],
    'extreme', SEVERITY_COLORS.extreme,
    'severe', SEVERITY_COLORS.severe,
    'moderate', SEVERITY_COLORS.moderate,
    'minor', SEVERITY_COLORS.minor,
    'unknown', SEVERITY_COLORS.unknown,
    fallback,
  ];
}

function bounds(geometry: GeoJSON.Geometry, into = new maplibregl.LngLatBounds()): maplibregl.LngLatBounds {
  const walk = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === 'number') into.extend(coords as [number, number]);
    else if (Array.isArray(coords)) coords.forEach(walk);
  };
  if (geometry.type === 'GeometryCollection') geometry.geometries.forEach((g) => bounds(g, into));
  else walk(geometry.coordinates);
  return into;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function MapView({ focusEventId }: { focusEventId: string | null }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const dataRef = useRef<MapData | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [satellite, setSat] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(focusEventId);

  // ---- map setup (once)
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: BASE_STYLE_URL, center: [-96, 38.5], zoom: 3.4 });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    map.on('load', () => {
      addSatelliteLayer(map);
      const below = firstLabelLayer(map);
      map.addSource('hazards', { type: 'geojson', data: EMPTY });
      map.addSource('properties', { type: 'geojson', data: EMPTY });
      map.addLayer(
        { id: 'hazard-fill', type: 'fill', source: 'hazards', paint: { 'fill-color': severityExpression('severity', '#6b7280'), 'fill-opacity': 0.22 } },
        below,
      );
      map.addLayer(
        { id: 'hazard-line', type: 'line', source: 'hazards', paint: { 'line-color': severityExpression('severity', '#6b7280'), 'line-width': 1.5 } },
        below,
      );
      map.addLayer({
        id: 'hazard-selected',
        type: 'line',
        source: 'hazards',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-color': '#111827', 'line-width': 3 },
      });
      // Ring in the hazard's severity color around every affected property.
      map.addLayer({
        id: 'property-impact',
        type: 'circle',
        source: 'properties',
        filter: ['!=', ['get', 'impact'], 'none'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 7, 12, 13],
          'circle-color': severityExpression('impact', '#000000'),
          'circle-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'property-dot',
        type: 'circle',
        source: 'properties',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 12, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });

      map.on('click', 'property-dot', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string>;
        const events = (dataRef.current?.events ?? []).filter((ev) => ev.status === 'active' && ev.propertyIds.includes(p.id!));
        const alerts = events.length
          ? '<div style="margin-top:6px"><strong>Active alerts</strong>' +
            events
              .map(
                (ev) =>
                  `<div><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${SEVERITY_COLORS[ev.severity]};margin-right:5px"></span>${escapeHtml(ev.name)} (${SEVERITY_LABELS[ev.severity]})</div>`,
              )
              .join('') +
            '</div>'
          : '<div style="margin-top:6px;color:#6b7280">No active alerts</div>';
        new maplibregl.Popup({ maxWidth: '300px' })
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(
            `<strong>${escapeHtml(p.name ?? '')}</strong><div>${escapeHtml(p.address ?? '')}</div>` +
              `<div style="color:#6b7280">${escapeHtml(p.clientName ?? '')}${p.propertyType ? ' · ' + escapeHtml(p.propertyType) : ''}</div>${alerts}`,
          )
          .addTo(map);
      });
      map.on('click', 'hazard-fill', (e) => {
        // Property clicks take priority over the polygon underneath.
        if (map.queryRenderedFeatures(e.point, { layers: ['property-dot'] }).length) return;
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) setSelected(id);
      });
      for (const layer of ['property-dot', 'hazard-fill']) {
        map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
      }
      setReady(true);
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- data loading + periodic refresh
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/map${focusEventId ? `?event=${focusEventId}` : ''}`, { cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as MapData;
      dataRef.current = json;
      setData(json);
      setError(null);
    } catch {
      setError('The map data could not be refreshed. What is shown may be out of date.');
    }
  }, [focusEventId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // ---- push data into the map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !data) return;
    (map.getSource('properties') as maplibregl.GeoJSONSource).setData(data.properties);
    (map.getSource('hazards') as maplibregl.GeoJSONSource).setData(data.hazards);
    if (!fitted.current && !focusEventId && data.properties.features.length) {
      fitted.current = true;
      const b = new maplibregl.LngLatBounds();
      for (const f of data.properties.features) b.extend(f.geometry.coordinates as [number, number]);
      map.fitBounds(b, { padding: 60, maxZoom: 12, duration: 0 });
    }
  }, [data, ready, focusEventId]);

  // ---- client filter
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const visible: maplibregl.FilterSpecification = ['!', ['in', ['get', 'clientId'], ['literal', [...hidden]]]];
    map.setFilter('property-dot', visible);
    map.setFilter('property-impact', ['all', ['!=', ['get', 'impact'], 'none'], visible]);
  }, [hidden, ready]);

  // ---- selected event: outline it and move the map to it
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter('hazard-selected', ['==', ['get', 'id'], selected ?? '']);
    if (!selected || !data) return;
    const feature = data.hazards.features.find((f) => f.properties?.id === selected);
    const b = feature ? bounds(feature.geometry) : new maplibregl.LngLatBounds();
    if (!feature) {
      // No polygon yet (zone shapes still loading): frame the affected properties instead.
      const ids = new Set(data.events.find((e) => e.id === selected)?.propertyIds ?? []);
      for (const f of data.properties.features) {
        if (ids.has(f.properties?.id)) b.extend(f.geometry.coordinates as [number, number]);
      }
    }
    if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 11 });
    // Re-run only when the selection changes, not on every data refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, ready, data === null]);

  const counts = useMemo(() => {
    const byClient = new Map<string, number>();
    for (const f of data?.properties.features ?? []) {
      const id = f.properties?.clientId as string;
      byClient.set(id, (byClient.get(id) ?? 0) + 1);
    }
    return byClient;
  }, [data]);

  const visibleEvents = useMemo(() => {
    if (!data) return [];
    const clientOf = new Map(data.properties.features.map((f) => [f.properties?.id as string, f.properties?.clientId as string]));
    return data.events
      .map((e) => ({ ...e, shown: e.propertyIds.filter((id) => !hidden.has(clientOf.get(id) ?? '')) }))
      .filter((e) => e.shown.length > 0 || e.id === focusEventId);
  }, [data, hidden, focusEventId]);

  const affected = useMemo(() => new Set(visibleEvents.filter((e) => e.status === 'active').flatMap((e) => e.shown)).size, [visibleEvents]);

  return (
    <div className="mapwrap">
      <aside className="sidebar">
        {error && <div className="flash error">{error}</div>}
        <section>
          <h2>Affected right now</h2>
          <div className="stats">
            <div>
              <strong>{affected.toLocaleString()}</strong>properties
            </div>
            <div>
              <strong>{visibleEvents.filter((e) => e.status === 'active').length}</strong>active alerts
            </div>
          </div>
        </section>
        <section>
          <h2>Alerts, worst first</h2>
          {data && visibleEvents.length === 0 && <p className="muted">No active alerts affect your properties.</p>}
          {!data && !error && <p className="muted">Loading…</p>}
          {visibleEvents.map((e) => (
            <button
              key={e.id}
              type="button"
              className={`alert-item${selected === e.id ? ' sel' : ''}`}
              style={{ borderLeftColor: SEVERITY_COLORS[e.severity] }}
              onClick={() => setSelected(selected === e.id ? null : e.id)}
            >
              <div className="t">
                {e.name}
                {e.status !== 'active' && <span className="muted"> ({e.status})</span>}
              </div>
              <div className="small">
                {SEVERITY_LABELS[e.severity]} · {HAZARD_LABELS[e.hazardType] ?? e.hazardType} · {e.shown.length}{' '}
                propert{e.shown.length === 1 ? 'y' : 'ies'}
              </div>
              {selected === e.id && (
                <div className="small" style={{ marginTop: 6 }}>
                  {e.headline && <div>{e.headline}</div>}
                  {e.area && <div className="muted">Area: {e.area}</div>}
                  {e.endsAt && <div className="muted">Until {new Date(e.endsAt).toLocaleString()}</div>}
                  <div className="muted">Source: National Weather Service</div>
                  {e.sourceUrl && (
                    <a href={e.sourceUrl} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
                      Official alert
                    </a>
                  )}
                </div>
              )}
            </button>
          ))}
        </section>
        <section>
          <h2>Clients</h2>
          {data?.clients.map((c) => (
            <label className="check" key={c.id} style={{ marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={!hidden.has(c.id)}
                onChange={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(c.id)) next.delete(c.id);
                    else next.add(c.id);
                    return next;
                  })
                }
              />
              <span className="swatch" style={{ background: c.color, marginRight: 0 }} />
              {c.name} <span className="muted">({counts.get(c.id) ?? 0})</span>
            </label>
          ))}
          {data && data.clients.length === 0 && <p className="muted">No clients yet.</p>}
        </section>
        <p className="small muted">{DISCLAIMER}</p>
      </aside>
      <div className="map">
        <div className="basemap-toggle">
          {(['Map', 'Satellite'] as const).map((label) => (
            <button
              key={label}
              type="button"
              className={(label === 'Satellite') === satellite ? 'on' : ''}
              onClick={() => {
                const next = label === 'Satellite';
                setSat(next);
                if (mapRef.current) setSatellite(mapRef.current, next);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div ref={container} className="canvas" />
      </div>
    </div>
  );
}
