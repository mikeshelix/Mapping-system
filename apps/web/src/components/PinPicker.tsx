'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { BASE_STYLE_URL, addSatelliteLayer, setSatellite } from './basemap';

/**
 * Small map for placing a property by hand. Clicking sets the pin and fills
 * the hidden `lon` / `lat` form fields.
 */
export function PinPicker({ initial }: { initial?: { lon: number; lat: number } | null }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const [pin, setPin] = useState<{ lon: number; lat: number } | null>(initial ?? null);
  const [satellite, setSat] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: BASE_STYLE_URL,
      center: initial ? [initial.lon, initial.lat] : [-96, 38.5],
      zoom: initial ? 14 : 3.2,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    if (initial) {
      markerRef.current = new maplibregl.Marker({ color: '#dc2626' }).setLngLat([initial.lon, initial.lat]).addTo(map);
    }
    map.on('load', () => addSatelliteLayer(map));
    map.on('click', (e) => {
      const next = { lon: Number(e.lngLat.lng.toFixed(6)), lat: Number(e.lngLat.lat.toFixed(6)) };
      markerRef.current?.remove();
      markerRef.current = new maplibregl.Marker({ color: '#dc2626' }).setLngLat([next.lon, next.lat]).addTo(map);
      setPin(next);
    });
    return () => map.remove();
    // The map is created once; `initial` only seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="pinpicker">
        <div className="basemap-toggle">
          {(['Map', 'Satellite'] as const).map((label) => {
            const on = (label === 'Satellite') === satellite;
            return (
              <button
                key={label}
                type="button"
                className={on ? 'on' : ''}
                onClick={() => {
                  const next = label === 'Satellite';
                  setSat(next);
                  if (mapRef.current) setSatellite(mapRef.current, next);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      </div>
      <input type="hidden" name="lon" value={pin?.lon ?? ''} />
      <input type="hidden" name="lat" value={pin?.lat ?? ''} />
      <div className="small muted" style={{ marginTop: 4 }}>
        {pin ? (
          <>
            Pin at {pin.lat}, {pin.lon}.{' '}
            <button type="button" className="link" onClick={() => {
                markerRef.current?.remove();
                markerRef.current = null;
                setPin(null);
              }}
            >
              Clear pin
            </button>
          </>
        ) : (
          'Click the map to drop a pin. A pin overrides the address lookup.'
        )}
      </div>
    </div>
  );
}
