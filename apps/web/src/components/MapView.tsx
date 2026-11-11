'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  DISCLAIMER,
  HAZARD_LABELS,
  SEVERITY_COLORS,
  SEVERITY_FILL_OPACITY,
  SEVERITY_LABELS,
  SOURCE_NAMES,
  WEATHER_PATTERNS,
  WEATHER_PATTERN_COLORS,
  colorForLabel,
  patternOf,
  type HazardType,
  type LonLat,
  type Place,
  type Severity,
  type SourceId,
  type WeatherPatternId,
} from '@hazard/core';
import type { MapAction } from '@hazard/db';
import { AreaSearchPanel } from './AreaSearchPanel';
import { AssistantPanel } from './AssistantPanel';
import { LocationCard, type LocationDetail } from './LocationCard';
import { BASE_STYLE_URL, addSatelliteLayer, firstLabelLayer, setSatellite } from './basemap';

interface Client {
  id: string;
  name: string;
  color: string;
}
interface HazardEvent {
  id: string;
  source: SourceId;
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
type ColorBy = 'client' | 'type' | 'status';
type Scope = 'mine' | 'all';
type Drawer = 'ask' | 'area' | 'location' | null;

/**
 * Radar: NOAA MRMS base reflectivity mosaic, served by NOAA as WMS. Free, no key.
 * https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows
 */
const radarTiles = (stamp: number) =>
  'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows?service=WMS&version=1.1.1&request=GetMap' +
  '&layers=conus_bref_qcd&styles=&format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256' +
  `&bbox={bbox-epsg-3857}&_=${stamp}`;
/** Radar updates about every two minutes; a new stamp makes the map fetch fresh tiles. */
const radarStamp = () => Math.floor(Date.now() / 120_000);

const REFRESH_MS = 60_000;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const NO_TYPE = 'Type not set';
const NOT_AFFECTED_COLOR = '#16a34a';
const ALL_PATTERNS = WEATHER_PATTERNS.map((p) => p.id);

const match = (property: string, colors: Record<string, string | number>, fallback: string | number) =>
  ['match', ['get', property], ...Object.entries(colors).flat(), fallback] as unknown as maplibregl.ExpressionSpecification;

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

function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
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

  // ---- what to show
  const [patternsOn, setPatternsOn] = useState<Set<WeatherPatternId>>(new Set(ALL_PATTERNS));
  const [scope, setScope] = useState<Scope>('mine');
  const [weather, setWeather] = useState<GeoJSON.FeatureCollection | null>(null);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [radar, setRadar] = useState(false);
  const [colorBy, setColorBy] = useState<ColorBy>('client');
  const [hiddenClients, setHiddenClients] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [affectedOnly, setAffectedOnly] = useState(false);
  const [search, setSearch] = useState('');

  // ---- what is selected or open
  const [selected, setSelected] = useState<string | null>(focusEventId);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [location, setLocation] = useState<{ id: string; detail: LocationDetail | null; failed: boolean } | null>(null);
  // What the assistant asked to be shown, the shape being drawn, and the businesses found in it.
  const [action, setAction] = useState<MapAction | null>(null);
  const [ring, setRing] = useState<LonLat[]>([]);
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  const [places, setPlaces] = useState<Place[]>([]);

  const openLocation = useCallback((id: string) => {
    setDrawer('location');
    setLocation({ id, detail: null, failed: false });
    fetch(`/api/property/${id}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((detail: LocationDetail) => setLocation((cur) => (cur?.id === id ? { id, detail, failed: false } : cur)))
      .catch(() => setLocation((cur) => (cur?.id === id ? { id, detail: null, failed: true } : cur)));
  }, []);
  const openLocationRef = useRef(openLocation);
  openLocationRef.current = openLocation;

  // ---- map setup (once)
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: BASE_STYLE_URL, center: [-96, 38.5], zoom: 3.4 });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    map.on('load', () => {
      addSatelliteLayer(map);
      const below = firstLabelLayer(map);
      map.addSource('radar', { type: 'raster', tiles: [radarTiles(radarStamp())], tileSize: 256, attribution: 'Radar: NOAA MRMS' });
      map.addLayer({ id: 'radar', type: 'raster', source: 'radar', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.65 } }, below);

      // Weather: colored by pattern, more solid the worse it is.
      map.addSource('hazards', { type: 'geojson', data: EMPTY });
      map.addLayer(
        {
          id: 'hazard-fill',
          type: 'fill',
          source: 'hazards',
          paint: { 'fill-color': match('pattern', WEATHER_PATTERN_COLORS, '#6b7280'), 'fill-opacity': match('severity', SEVERITY_FILL_OPACITY, 0.15) },
        },
        below,
      );
      map.addLayer(
        {
          id: 'hazard-line',
          type: 'line',
          source: 'hazards',
          // Weather touching your own locations gets a heavier outline.
          paint: { 'line-color': match('pattern', WEATHER_PATTERN_COLORS, '#6b7280'), 'line-width': ['case', ['==', ['get', 'mine'], true], 2.5, 1] },
        },
        below,
      );
      map.addLayer({ id: 'hazard-selected', type: 'line', source: 'hazards', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#111827', 'line-width': 3.5 } });
      map.addLayer({
        id: 'hazard-assistant',
        type: 'line',
        source: 'hazards',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-color': '#7c3aed', 'line-width': 3, 'line-dasharray': [2, 1] },
      });

      // Locations: nearby pins merge into a numbered bubble until you zoom in.
      map.addSource('properties', {
        type: 'geojson',
        data: EMPTY,
        cluster: true,
        clusterRadius: 42,
        clusterMaxZoom: 9,
        clusterProperties: { affected: ['+', ['case', ['!=', ['get', 'impact'], 'none'], 1, 0]] },
      });
      map.addLayer({
        id: 'cluster',
        type: 'circle',
        source: 'properties',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#1e293b',
          'circle-radius': ['step', ['get', 'point_count'], 15, 10, 19, 50, 24, 200, 30],
          // A red edge means at least one location inside is affected.
          'circle-stroke-color': ['case', ['>', ['get', 'affected'], 0], '#dc2626', '#ffffff'],
          'circle-stroke-width': ['case', ['>', ['get', 'affected'], 0], 4, 2],
        },
      });
      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'properties',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-allow-overlap': true },
        paint: { 'text-color': '#ffffff' },
      });
      map.addLayer({
        id: 'property-impact',
        type: 'circle',
        source: 'properties',
        filter: ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'impact'], 'none']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 8, 12, 14],
          'circle-color': match('impact', SEVERITY_COLORS, '#000000'),
          'circle-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'property-dot',
        type: 'circle',
        source: 'properties',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4.5, 12, 8],
          'circle-color': ['get', 'pinColor'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });

      // Assistant results: a ring around each location it points to.
      map.addSource('assistant', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'assistant-ring',
        type: 'circle',
        source: 'assistant',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 10, 12, 17],
          'circle-color': 'rgba(124,58,237,0.15)',
          'circle-stroke-color': '#7c3aed',
          'circle-stroke-width': 2.5,
        },
      });
      // Area search: the drawn shape and the businesses found inside it.
      map.addSource('draw', { type: 'geojson', data: EMPTY });
      map.addSource('places', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#0369a1', 'line-width': 2, 'line-dasharray': [3, 2] } });
      map.addLayer({
        id: 'draw-corner',
        type: 'circle',
        source: 'draw',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#0369a1', 'circle-stroke-width': 2 },
      });
      map.addLayer({
        id: 'place-dot',
        type: 'circle',
        source: 'places',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 15, 6], 'circle-color': '#0369a1', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
      });

      // While drawing, every click adds a corner and nothing else reacts to it.
      map.on('click', (e) => {
        if (!drawingRef.current) return;
        setRing((prev) => {
          // The second click of a double-click lands on the corner just added: skip it.
          const last = prev[prev.length - 1];
          if (last && map.project(last).dist(e.point) < 6) return prev;
          return [...prev, [e.lngLat.lng, e.lngLat.lat]];
        });
      });
      map.on('dblclick', (e) => {
        if (!drawingRef.current) return;
        e.preventDefault();
        setDrawing(false);
      });
      map.on('click', 'cluster', (e) => {
        if (drawingRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const center = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        void (map.getSource('properties') as maplibregl.GeoJSONSource)
          .getClusterExpansionZoom(f.properties?.cluster_id as number)
          .then((zoom) => map.easeTo({ center, zoom: zoom + 0.5 }))
          .catch(() => map.easeTo({ center, zoom: map.getZoom() + 2 }));
      });
      map.on('click', 'property-dot', (e) => {
        if (drawingRef.current) return;
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) openLocationRef.current(id);
      });
      map.on('click', 'place-dot', (e) => {
        if (drawingRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string>;
        // Links come from public map data: only http(s) addresses are kept by the server, and all text is escaped here.
        const link = (href: string, label: string) => (/^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${label}</a>` : '');
        new maplibregl.Popup({ maxWidth: '300px' })
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(
            `<strong>${escapeHtml(p.name ?? '')}</strong><div style="color:#6b7280">${escapeHtml(p.kind ?? '')}</div>` +
              `<div>${escapeHtml([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '))}</div>` +
              (p.phone ? `<div>${escapeHtml(p.phone)}</div>` : '') +
              `<div style="margin-top:4px">${[link(p.website ?? '', 'Website'), link(p.url ?? '', 'OpenStreetMap')].filter(Boolean).join(' · ')}</div>`,
          )
          .addTo(map);
      });
      map.on('click', 'hazard-fill', (e) => {
        if (drawingRef.current) return;
        // Locations, bubbles and businesses take priority over the weather underneath.
        if (map.queryRenderedFeatures(e.point, { layers: ['property-dot', 'cluster', 'place-dot'] }).length) return;
        const props = e.features?.[0]?.properties as Record<string, string> | undefined;
        if (!props?.id) return;
        const own = dataRef.current?.events.find((ev) => ev.id === props.id);
        if (own) setSelected(props.id);
        const pattern = WEATHER_PATTERNS.find((w) => w.id === props.pattern);
        new maplibregl.Popup({ maxWidth: '320px' })
          .setLngLat(e.lngLat)
          .setHTML(
            `<strong>${escapeHtml(props.name ?? '')}</strong>` +
              `<div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${pattern?.color ?? '#6b7280'};margin-right:5px"></span>` +
              `${escapeHtml(pattern?.label ?? 'Weather')} · ${SEVERITY_LABELS[props.severity as Severity] ?? ''}</div>` +
              (props.headline && props.headline !== 'null' ? `<div style="margin-top:4px">${escapeHtml(props.headline)}</div>` : '') +
              `<div style="color:#6b7280;margin-top:4px">Source: ${escapeHtml(SOURCE_NAMES[props.source as SourceId] ?? props.source ?? '')}</div>` +
              `<div style="margin-top:4px;font-weight:600">${own ? `${own.propertyIds.length} of your locations affected` : 'None of your locations are affected'}</div>`,
          )
          .addTo(map);
      });
      for (const layer of ['property-dot', 'cluster', 'hazard-fill', 'place-dot']) {
        map.on('mouseenter', layer, () => {
          if (!drawingRef.current) map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layer, () => {
          if (!drawingRef.current) map.getCanvas().style.cursor = '';
        });
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
      setError('The map could not be refreshed. What is shown may be out of date.');
    }
  }, [focusEventId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Nationwide weather is only fetched while "Everywhere" is chosen.
  useEffect(() => {
    if (scope !== 'all') return;
    let stop = false;
    const fetchWeather = async () => {
      setWeatherBusy(true);
      try {
        const res = await fetch('/api/map/weather', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as GeoJSON.FeatureCollection;
        if (!stop) setWeather(json);
      } catch {
        if (!stop) setError('Nationwide weather could not be loaded. Showing weather at your locations only.');
      } finally {
        if (!stop) setWeatherBusy(false);
      }
    };
    void fetchWeather();
    const timer = setInterval(() => void fetchWeather(), REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [scope]);

  // ---- weather to draw: everything in scope, then only the chosen patterns
  const scopedHazards = useMemo(() => {
    const mine = data?.hazards.features ?? [];
    if (scope !== 'all' || !weather) return mine;
    // Your own hazards are kept in their sharper outline; the rest come from the nationwide set.
    const own = new Set(mine.map((f) => f.properties?.id));
    return [...weather.features.filter((f) => !own.has(f.properties?.id)), ...mine];
  }, [data, weather, scope]);

  const patternCounts = useMemo(() => {
    const counts = new Map<WeatherPatternId, number>();
    for (const f of scopedHazards) {
      const id = (f.properties?.pattern ?? 'other') as WeatherPatternId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [scopedHazards]);

  const shownHazards = useMemo(
    () => scopedHazards.filter((f) => patternsOn.has((f.properties?.pattern ?? 'other') as WeatherPatternId) || f.properties?.id === selected),
    [scopedHazards, patternsOn, selected],
  );

  // ---- locations to draw: filtered, then colored the chosen way
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of data?.properties.features ?? []) {
      const t = (f.properties?.propertyType as string | null) || NO_TYPE;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => (a[0] === NO_TYPE ? 1 : b[0] === NO_TYPE ? -1 : a[0].localeCompare(b[0])));
  }, [data]);

  const shownProperties = useMemo(() => {
    const out: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const f of data?.properties.features ?? []) {
      const p = f.properties ?? {};
      const type = (p.propertyType as string | null) || NO_TYPE;
      if (hiddenClients.has(p.clientId) || hiddenTypes.has(type)) continue;
      if (affectedOnly && p.impact === 'none') continue;
      const pinColor =
        colorBy === 'client' ? p.color : colorBy === 'type' ? (type === NO_TYPE ? '#94a3b8' : colorForLabel(type)) : p.impact === 'none' ? NOT_AFFECTED_COLOR : SEVERITY_COLORS[p.impact as Severity];
      out.push({ ...f, properties: { ...p, pinColor } });
    }
    return out;
  }, [data, hiddenClients, hiddenTypes, affectedOnly, colorBy]);

  const clientCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of data?.properties.features ?? []) counts.set(f.properties?.clientId, (counts.get(f.properties?.clientId) ?? 0) + 1);
    return counts;
  }, [data]);

  // ---- push everything into the map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('hazards') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: shownHazards });
  }, [shownHazards, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !data) return;
    (map.getSource('properties') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: shownProperties });
    if (!fitted.current && !focusEventId && data.properties.features.length) {
      fitted.current = true;
      const b = new maplibregl.LngLatBounds();
      for (const f of data.properties.features) b.extend(f.geometry.coordinates as [number, number]);
      map.fitBounds(b, { padding: 60, maxZoom: 12, duration: 0 });
    }
  }, [shownProperties, data, ready, focusEventId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (radar) (map.getSource('radar') as maplibregl.RasterTileSource).setTiles([radarTiles(radarStamp())]);
    map.setLayoutProperty('radar', 'visibility', radar ? 'visible' : 'none');
    // Radar keeps itself current alongside the data refresh.
  }, [radar, ready, data]);

  // ---- selected alert: outline it and move the map to it
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter('hazard-selected', ['==', ['get', 'id'], selected ?? '']);
    if (!selected || !data) return;
    const feature = data.hazards.features.find((f) => f.properties?.id === selected);
    const b = feature ? bounds(feature.geometry) : new maplibregl.LngLatBounds();
    if (!feature) {
      // No shape yet (zone outlines still loading): frame the affected locations instead.
      const ids = new Set(data.events.find((e) => e.id === selected)?.propertyIds ?? []);
      for (const f of data.properties.features) {
        if (ids.has(f.properties?.id)) b.extend(f.geometry.coordinates as [number, number]);
      }
    }
    if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 11 });
    // Re-run only when the selection changes, not on every data refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, ready, data === null]);

  // ---- assistant results: highlight them and move the map there
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('assistant') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (action?.points ?? []).map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { id: p.id, name: p.name } })),
    });
    map.setFilter('hazard-assistant', ['==', ['get', 'id'], action?.eventId ?? '']);
    if (!action) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of action.points) b.extend([p.lon, p.lat]);
    // With no locations to frame, frame the hazard itself.
    if (action.points.length === 0 && action.bbox) {
      b.extend([action.bbox[0], action.bbox[1]]);
      b.extend([action.bbox[2], action.bbox[3]]);
    }
    if (!b.isEmpty()) map.fitBounds(b, { padding: 80, maxZoom: 13 });
  }, [action, ready]);

  // ---- area search: the shape being drawn
  useEffect(() => {
    drawingRef.current = drawing;
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
    if (drawing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    const features: GeoJSON.Feature[] = ring.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }));
    if (ring.length >= 3) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] }, properties: {} });
    else if (ring.length === 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} });
    (map.getSource('draw') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: drawing ? features : features.filter((f) => f.geometry.type !== 'Point') });
  }, [ring, drawing, ready]);

  // ---- area search: the businesses found
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('places') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: places.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { ...p } })),
    });
    if (places.length && ring.length >= 3) {
      const b = new maplibregl.LngLatBounds();
      for (const c of ring) b.extend(c);
      map.fitBounds(b, { padding: 60, maxZoom: 16 });
    }
    // Re-frame only when a new result set arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, ready]);

  // ---- alerts on your locations, respecting the client filter
  const visibleEvents = useMemo(() => {
    if (!data) return [];
    const clientOf = new Map(data.properties.features.map((f) => [f.properties?.id as string, f.properties?.clientId as string]));
    return data.events
      .map((e) => ({ ...e, shown: e.propertyIds.filter((id) => !hiddenClients.has(clientOf.get(id) ?? '')) }))
      .filter((e) => e.shown.length > 0 || e.id === focusEventId);
  }, [data, hiddenClients, focusEventId]);
  const affected = useMemo(() => new Set(visibleEvents.filter((e) => e.status === 'active').flatMap((e) => e.shown)).size, [visibleEvents]);

  // ---- search across your own locations
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2 || !data) return [];
    return data.properties.features
      .filter((f) => `${f.properties?.name} ${f.properties?.address} ${f.properties?.clientName}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [search, data]);

  const goTo = (f: GeoJSON.Feature<GeoJSON.Point>) => {
    const p = f.properties ?? {};
    // Make sure a hidden client or type does not hide the thing just searched for.
    setHiddenClients((prev) => (prev.has(p.clientId) ? toggled(prev, p.clientId) : prev));
    const type = (p.propertyType as string | null) || NO_TYPE;
    setHiddenTypes((prev) => (prev.has(type) ? toggled(prev, type) : prev));
    setAffectedOnly((prev) => (p.impact === 'none' ? false : prev));
    setSearch('');
    mapRef.current?.flyTo({ center: f.geometry.coordinates as [number, number], zoom: Math.max(mapRef.current.getZoom(), 14) });
    openLocation(p.id as string);
  };

  const closeDrawer = () => {
    setDrawer(null);
    if (drawing) setDrawing(false);
  };
  const total = data?.properties.features.length ?? 0;

  return (
    <div className="mapwrap">
      <aside className="sidebar">
        {error && <div className="flash error">{error}</div>}

        <section className="searchbox">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a location, client or address"
            aria-label="Find a location, client or address"
          />
          {search.trim().length >= 2 && (
            <div className="results">
              {results.length === 0 && <div className="muted small" style={{ padding: 8 }}>No locations match.</div>}
              {results.map((f) => (
                <button key={f.properties?.id} type="button" onClick={() => goTo(f)}>
                  <strong>{f.properties?.name}</strong>
                  <span className="small muted">
                    {f.properties?.clientName} · {f.properties?.address}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="stats">
            <div>
              <strong>{shownProperties.length.toLocaleString()}</strong>
              {shownProperties.length === total ? 'locations' : `of ${total.toLocaleString()} locations shown`}
            </div>
            <div>
              <strong style={{ color: affected ? 'var(--danger)' : undefined }}>{affected.toLocaleString()}</strong>affected now
            </div>
          </div>
        </section>

        <section>
          <div className="section-head">
            <h2>Weather</h2>
            <button type="button" className="textlink" onClick={() => setPatternsOn(patternsOn.size ? new Set() : new Set(ALL_PATTERNS))}>
              {patternsOn.size ? 'Hide all' : 'Show all'}
            </button>
          </div>
          <div className="seg" role="group" aria-label="Which weather to show">
            <button type="button" className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>
              At my locations
            </button>
            <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
              Everywhere
            </button>
          </div>
          <div className="chips">
            {WEATHER_PATTERNS.map((w) => {
              const on = patternsOn.has(w.id);
              const count = patternCounts.get(w.id) ?? 0;
              return (
                <button key={w.id} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} title={w.includes} onClick={() => setPatternsOn((prev) => toggled(prev, w.id))}>
                  <span className="dot" style={{ background: on ? w.color : 'transparent', borderColor: w.color }} />
                  <span className="label">{w.label}</span>
                  <span className="count">{count.toLocaleString()}</span>
                </button>
              );
            })}
            <button type="button" className={`chip${radar ? ' on' : ''}`} aria-pressed={radar} title="Live rain and storm radar" onClick={() => setRadar((v) => !v)}>
              <span className="dot radar" style={{ opacity: radar ? 1 : 0.35 }} />
              <span className="label">Radar</span>
              <span className="count">live</span>
            </button>
          </div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            {scope === 'all' && weatherBusy && !weather
              ? 'Loading weather for the whole country…'
              : 'Numbers are active alerts. Darker shading means more severe.'}
          </p>
        </section>

        <section>
          <div className="section-head">
            <h2>Locations</h2>
          </div>
          <div className="small muted" style={{ marginBottom: 4 }}>Color the pins by</div>
          <div className="seg" role="group" aria-label="Color the pins by">
            {(
              [
                ['client', 'Client'],
                ['type', 'Type'],
                ['status', 'Status'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" className={colorBy === id ? 'on' : ''} onClick={() => setColorBy(id)}>
                {label}
              </button>
            ))}
          </div>
          {colorBy === 'status' && (
            <div className="legend">
              {(['extreme', 'severe', 'moderate', 'minor'] as const).map((s) => (
                <span key={s}>
                  <span className="swatch" style={{ background: SEVERITY_COLORS[s] }} />
                  {SEVERITY_LABELS[s]}
                </span>
              ))}
              <span>
                <span className="swatch" style={{ background: NOT_AFFECTED_COLOR }} />
                Not affected
              </span>
            </div>
          )}
          <label className="check" style={{ margin: '8px 0' }}>
            <input type="checkbox" checked={affectedOnly} onChange={() => setAffectedOnly((v) => !v)} />
            Only show affected locations
          </label>

          <div className="section-head sub">
            <h3>Clients</h3>
            {data && data.clients.length > 1 && (
              <button type="button" className="textlink" onClick={() => setHiddenClients(hiddenClients.size ? new Set() : new Set(data.clients.map((c) => c.id)))}>
                {hiddenClients.size ? 'Show all' : 'Hide all'}
              </button>
            )}
          </div>
          {data?.clients.map((c) => (
            <label className="check" key={c.id} style={{ marginBottom: 4 }}>
              <input type="checkbox" checked={!hiddenClients.has(c.id)} onChange={() => setHiddenClients((prev) => toggled(prev, c.id))} />
              {colorBy === 'client' && <span className="swatch" style={{ background: c.color, marginRight: 0 }} />}
              {c.name} <span className="muted">({clientCounts.get(c.id) ?? 0})</span>
            </label>
          ))}
          {data && data.clients.length === 0 && (
            <p className="muted">
              No clients yet. <a href="/clients">Add your first client</a>, then <a href="/import">import their locations</a>.
            </p>
          )}

          {types.length > 1 && (
            <>
              <div className="section-head sub">
                <h3>Location types</h3>
                <button type="button" className="textlink" onClick={() => setHiddenTypes(hiddenTypes.size ? new Set() : new Set(types.map((t) => t[0])))}>
                  {hiddenTypes.size ? 'Show all' : 'Hide all'}
                </button>
              </div>
              {types.map(([t, n]) => (
                <label className="check" key={t} style={{ marginBottom: 4 }}>
                  <input type="checkbox" checked={!hiddenTypes.has(t)} onChange={() => setHiddenTypes((prev) => toggled(prev, t))} />
                  {colorBy === 'type' && <span className="swatch" style={{ background: t === NO_TYPE ? '#94a3b8' : colorForLabel(t), marginRight: 0 }} />}
                  {t} <span className="muted">({n})</span>
                </label>
              ))}
            </>
          )}
        </section>

        <section>
          <div className="section-head">
            <h2>Alerts at your locations</h2>
          </div>
          {data && visibleEvents.length === 0 && <p className="muted">Nothing is affecting your locations right now.</p>}
          {!data && !error && <p className="muted">Loading…</p>}
          {visibleEvents.map((e) => {
            const pattern = patternOf(e.hazardType);
            return (
              <button
                key={e.id}
                type="button"
                className={`alert-item${selected === e.id ? ' sel' : ''}`}
                style={{ borderLeftColor: WEATHER_PATTERN_COLORS[pattern] }}
                onClick={() => {
                  setSelected(selected === e.id ? null : e.id);
                  // Picking an alert switches its kind of weather on, so its shape is always visible.
                  setPatternsOn((prev) => (prev.has(pattern) ? prev : toggled(prev, pattern)));
                }}
              >
                <div className="t">
                  {e.name}
                  {e.status !== 'active' && <span className="muted"> ({e.status})</span>}
                </div>
                <div className="small">
                  <span className="pill" style={{ background: SEVERITY_COLORS[e.severity] }}>
                    {SEVERITY_LABELS[e.severity]}
                  </span>{' '}
                  {HAZARD_LABELS[e.hazardType] ?? e.hazardType} · {e.shown.length} location{e.shown.length === 1 ? '' : 's'}
                </div>
                {selected === e.id && (
                  <div className="small" style={{ marginTop: 6 }}>
                    {e.headline && <div>{e.headline}</div>}
                    {e.area && <div className="muted">Area: {e.area}</div>}
                    {e.endsAt && <div className="muted">Until {new Date(e.endsAt).toLocaleString()}</div>}
                    <div className="muted">Source: {SOURCE_NAMES[e.source] ?? e.source}</div>
                    {e.sourceUrl && (
                      <a href={e.sourceUrl} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
                        Official alert
                      </a>
                    )}
                  </div>
                )}
              </button>
            );
          })}
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
        <div className="map-tools">
          <button type="button" className={drawer === 'ask' ? 'on' : ''} onClick={() => setDrawer(drawer === 'ask' ? null : 'ask')}>
            Ask a question
          </button>
          <button type="button" className={drawer === 'area' ? 'on' : ''} onClick={() => (drawer === 'area' ? closeDrawer() : setDrawer('area'))}>
            Find businesses in an area
          </button>
        </div>
        {action && (
          <div className="map-note">
            <span>
              Showing: {action.title}
              {action.points.length > 0 && ` (${action.points.length.toLocaleString()} location${action.points.length === 1 ? '' : 's'})`}
            </span>
            <button type="button" className="secondary" onClick={() => setAction(null)}>
              Clear
            </button>
          </div>
        )}
        <div ref={container} className="canvas" />
      </div>

      {/* The panels stay mounted while closed so a conversation or a result list survives. */}
      <aside className="drawer" hidden={drawer === null}>
        <div className="drawer-head">
          <h2>{drawer === 'ask' ? 'Ask a question' : drawer === 'area' ? 'Find businesses in an area' : 'Location'}</h2>
          <button type="button" className="secondary" onClick={closeDrawer} aria-label="Close panel">
            Close
          </button>
        </div>
        <div hidden={drawer !== 'ask'}>
          <AssistantPanel onMap={setAction} />
        </div>
        <div hidden={drawer !== 'area'}>
          <AreaSearchPanel
            ring={ring}
            drawing={drawing}
            onStartDrawing={() => {
              setRing([]);
              setPlaces([]);
              setDrawing(true);
            }}
            onFinishDrawing={() => setDrawing(false)}
            onClear={() => {
              setRing([]);
              setPlaces([]);
              setDrawing(false);
            }}
            onResults={setPlaces}
            onFocus={(lon, lat) => mapRef.current?.flyTo({ center: [lon, lat], zoom: Math.max(mapRef.current.getZoom(), 16) })}
          />
        </div>
        {drawer === 'location' && location && (
          <LocationCard
            detail={location.detail}
            failed={location.failed}
            onAlert={(id, hazardType) => {
              setSelected(id);
              const pattern = patternOf(hazardType);
              setPatternsOn((prev) => (prev.has(pattern) ? prev : toggled(prev, pattern)));
            }}
          />
        )}
      </aside>
    </div>
  );
}
