import type maplibregl from 'maplibre-gl';

/**
 * Street basemap: OpenFreeMap (free, no key, OpenStreetMap data).
 * https://openfreemap.org/quick_start/
 */
export const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Satellite imagery: USGS National Map orthoimagery. Public domain, no key.
 * Tiles are published to zoom 16; MapLibre stretches them when zoomed in further.
 * https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer
 */
const SATELLITE_TILES =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_ID = 'usgs-imagery';

/** Add the (hidden) imagery layer beneath the labels. Call once the style has loaded. */
export function addSatelliteLayer(map: maplibregl.Map): void {
  if (map.getSource(SATELLITE_ID)) return;
  map.addSource(SATELLITE_ID, {
    type: 'raster',
    tiles: [SATELLITE_TILES],
    tileSize: 256,
    maxzoom: 16,
    attribution: 'Imagery: U.S. Geological Survey, National Geospatial Program',
  });
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer(
    { id: SATELLITE_ID, type: 'raster', source: SATELLITE_ID, layout: { visibility: 'none' } },
    firstLabel,
  );
}

export function setSatellite(map: maplibregl.Map, on: boolean): void {
  if (!map.getLayer(SATELLITE_ID)) return;
  map.setLayoutProperty(SATELLITE_ID, 'visibility', on ? 'visible' : 'none');
}

/** Id of the first label layer, so data layers can be drawn beneath place names. */
export function firstLabelLayer(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}
