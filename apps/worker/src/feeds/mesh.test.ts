import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeMrmsGrib, hailAreas, meshEvents, type MrmsGrid } from './mesh';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mesh_max_60min_20261110-195000.grib2.gz');

describe('MRMS GRIB decoding', () => {
  it('decodes a real MESH_Max_60min file', () => {
    const grid = decodeMrmsGrib(readFileSync(fixture));
    expect(grid.ni).toBe(7000);
    expect(grid.nj).toBe(3500);
    expect(grid.lat1).toBeCloseTo(54.995, 3);
    expect(grid.lon1).toBeCloseTo(-129.995, 3);
    expect(grid.di).toBeCloseTo(0.01, 6);
    expect(grid.dj).toBeCloseTo(0.01, 6);
    expect(grid.referenceTime.toISOString()).toBe('2026-11-10T19:50:00.000Z');
    expect(grid.packed.length).toBe(7000 * 3500);
    // Every value is either a "no data" flag (negative) or a plausible hail size in mm.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < grid.packed.length; i += 97) {
      const v = grid.unpack(grid.packed[i]!);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThanOrEqual(-3);
    expect(max).toBeLessThan(200);
    expect(() => hailAreas(grid)).not.toThrow();
  });

  it('rejects data that is not GRIB', () => {
    expect(() => decodeMrmsGrib(Buffer.from('not gzip'))).toThrow();
  });
});

/** A small synthetic grid: values in mm, rows north to south. */
function grid(rows: number[][]): MrmsGrid {
  const nj = rows.length;
  const ni = rows[0]!.length;
  return {
    ni,
    nj,
    lat1: 35.995,
    lon1: -97.005 + 0.01, // first cell centre at -96.995
    di: 0.01,
    dj: 0.01,
    packed: Uint16Array.from(rows.flat().map((mm) => Math.round((mm + 3) * 10))),
    unpack: (x) => x / 10 - 3,
    referenceTime: new Date('2026-05-10T21:00:00Z'),
  };
}

describe('hail areas', () => {
  it('ignores hail under 0.75 inch and no-data cells', () => {
    expect(hailAreas(grid([[-3, -1, 0, 10, 18.9]]))).toEqual([]);
  });

  it('groups cells by severity band and merges adjacent cells in a row', () => {
    // 20 mm = 0.79" (minor), 30 mm = 1.18" (moderate), 50 mm = 1.97" (severe), 75 mm = 2.95" (extreme)
    const areas = hailAreas(grid([[20, 20, 30, 0, 50], [0, 75, 0, 0, 0]]));
    const byBand = Object.fromEntries(areas.map((a) => [a.band, a]));
    expect(Object.keys(byBand).sort()).toEqual(['extreme', 'minor', 'moderate', 'severe']);
    expect(byBand.minor!.rects).toEqual([[-97, 35.99, -96.98, 36]]); // two cells merged into one rectangle
    expect(byBand.moderate!.rects).toEqual([[-96.98, 35.99, -96.97, 36]]);
    expect(byBand.extreme!.rects).toEqual([[-96.99, 35.98, -96.98, 35.99]]);
    expect(byBand.severe!.maxInches).toBeCloseTo(50 / 25.4, 3);
  });

  it('builds one accumulating event per day, tile and band', () => {
    const events = meshEvents(grid([[30, 30, 0, 0, 0]]), new Date('2026-05-10T21:05:00Z'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'mesh',
      key: '2026-05-10:35:-97:moderate',
      hazardType: 'hail',
      severity: 'moderate',
      mergeGeometry: true,
      eventName: 'Radar-estimated hail: 1 to 1.75 inches',
    });
    expect(events[0]!.geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [[[[-97, 35.99], [-96.98, 35.99], [-96.98, 36], [-97, 36], [-97, 35.99]]]],
    });
  });
});
