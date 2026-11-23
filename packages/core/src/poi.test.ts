import { describe, expect, it } from 'vitest';
import {
  buildPoiQuery,
  cleanPoiFilter,
  cleanPoiRow,
  filesForView,
  latestPlacesCollection,
  parseViewBox,
  placesFileFromItem,
  placesItemUrls,
  poiCategoryLabel,
  poiFilterPattern,
  type PlacesFile,
} from './poi';

const FILE = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-11-18.0/theme=places/type=place/part-00001-43e455e5-c000.zstd.parquet';
const file = (bbox: [number, number, number, number], n = 1): PlacesFile => ({ bbox, url: FILE.replace('00001', `0000${n}`) });

describe('Overture catalog', () => {
  it('finds the latest release without a hardcoded date', () => {
    expect(latestPlacesCollection({ latest: '2026-11-18.0' })).toEqual({ release: '2026-11-18.0', url: 'https://stac.overturemaps.org/2026-11-18.0/places/place/collection.json' });
    expect(latestPlacesCollection({ latest: '../../evil' })).toBeNull();
    expect(latestPlacesCollection({})).toBeNull();
    expect(latestPlacesCollection(null)).toBeNull();
  });

  it('lists item addresses on the catalog host only', () => {
    expect(
      placesItemUrls({
        links: [
          { rel: 'item', href: 'https://stac.overturemaps.org/2026-11-18.0/places/place/00000/00000.json' },
          { rel: 'item', href: 'https://evil.example/00001.json' },
          { rel: 'parent', href: 'https://stac.overturemaps.org/2026-11-18.0/places/catalog.json' },
          null,
        ],
      }),
    ).toEqual(['https://stac.overturemaps.org/2026-11-18.0/places/place/00000/00000.json']);
    expect(placesItemUrls({})).toEqual([]);
  });

  it('accepts a data file only from the Overture bucket with a clean address', () => {
    const item = (href: unknown, bbox: unknown = [-120.6, 28.4, -76.3, 34.7]) => ({ bbox, assets: { aws: { href } } });
    expect(placesFileFromItem(item(FILE))).toEqual({ bbox: [-120.6, 28.4, -76.3, 34.7], url: FILE });
    expect(placesFileFromItem(item('https://evil.example/x.parquet'))).toBeNull();
    expect(placesFileFromItem(item(`${FILE}') UNION SELECT 1 --`))).toBeNull();
    expect(placesFileFromItem(item(FILE.replace('theme=places/type=place', 'theme=addresses/type=address')))).toBeNull();
    expect(placesFileFromItem(item(FILE, [1, 2, 3]))).toBeNull();
    expect(placesFileFromItem(item(FILE, [1, 2, 3, 'x']))).toBeNull();
    expect(placesFileFromItem(null)).toBeNull();
  });
});

describe('map view', () => {
  it('accepts a street-level view and refuses anything wider or malformed', () => {
    expect(parseViewBox('-80.76,28.37,-80.72,28.40')).toEqual({ ok: true, box: { west: -80.76, south: 28.37, east: -80.72, north: 28.4 } });
    expect(parseViewBox('-125,24,-66,50')).toEqual({ ok: false, error: 'Zoom in to see businesses.' });
    for (const bad of [null, '', '1,2,3', 'a,b,c,d', '-80.72,28.37,-80.76,28.40', '-80.76,28.40,-80.72,28.37', '-181,0,-180.9,0.1', '0,89.9,0.1,90.1']) {
      expect(parseViewBox(bad)).toEqual({ ok: false, error: 'The map view is not valid.' });
    }
  });

  it('picks only the files that can overlap the view', () => {
    const files = [file([-180, -85, -74.8, 28.45], 0), file([-120.6, 28.45, -76.3, 34.78], 1), file([-74.8, 40, 4.5, 60], 2)];
    expect(filesForView(files, { west: -80.76, south: 28.37, east: -80.72, north: 28.4 }).map((f) => f.url.match(/part-(\d+)/)![1])).toEqual(['00000']);
    // A view straddling the boundary between two files needs both.
    expect(filesForView(files, { west: -80.76, south: 28.44, east: -80.72, north: 28.47 })).toHaveLength(2);
    expect(filesForView(files, { west: 100, south: 0, east: 100.1, north: 0.1 })).toEqual([]);
  });
});

describe('query', () => {
  const box = { west: -80.76, south: 28.37, east: -80.72, north: 28.4 };

  it('asks for the agreed columns, bounds, confidence and limit', () => {
    const sql = buildPoiQuery([file([0, 0, 1, 1])], box, false);
    for (const part of ['names.primary AS name', 'basic_category AS category', 'confidence', 'ST_X(geometry) AS lon', 'ST_Y(geometry) AS lat']) expect(sql).toContain(part);
    expect(sql).toContain('bbox.xmin BETWEEN -80.760000 AND -80.720000');
    expect(sql).toContain('bbox.ymin BETWEEN 28.370000 AND 28.400000');
    expect(sql).toContain('confidence > 0.7');
    expect(sql).toMatch(/LIMIT 200$/);
    expect(sql).toContain(`read_parquet(['${file([0, 0, 1, 1]).url}'])`);
    expect(sql).not.toContain('$1');
    expect(sql).not.toContain('categories');
  });

  it('passes the filter as a parameter, never in the query text', () => {
    const sql = buildPoiQuery([file([0, 0, 1, 1], 1), file([0, 0, 1, 1], 2)], box, true);
    expect(sql.match(/\$1/g)).toHaveLength(2);
    expect(sql).toContain("replace(coalesce(basic_category, ''), '_', ' ') ILIKE $1");
    expect(sql.match(/\.parquet'/g)).toHaveLength(2);
    expect(poiFilterPattern("roof'; DROP")).toBe("%roof'; DROP%");
    expect(poiFilterPattern('100%_off\\')).toBe('%100\\%\\_off\\\\%');
    expect(cleanPoiFilter('  gas   station ')).toBe('gas station');
    expect(cleanPoiFilter('   ')).toBeNull();
    expect(cleanPoiFilter(null)).toBeNull();
    expect(cleanPoiFilter('x'.repeat(200))).toHaveLength(60);
  });
});

describe('rows', () => {
  const row = (o: Record<string, unknown> = {}) => ({
    id: '79357782-a33d-4daf-ac60-48e09d707af2', name: 'Kangaroo Express', category: 'convenience_store', confidence: 0.98765, lon: -80.741998, lat: 28.386115,
    address: '7175 N Hwy 1', city: 'Cocoa', region: 'US-FL', postcode: '32927', phone: '+13217354351', website: 'https://www.circlek.com/', ...o,
  });

  it('cleans a row into a business', () => {
    expect(cleanPoiRow(row())).toEqual({
      id: '79357782-a33d-4daf-ac60-48e09d707af2', name: 'Kangaroo Express', category: 'convenience_store', confidence: 0.99, lon: -80.741998, lat: 28.386115,
      address: '7175 N Hwy 1, Cocoa, FL 32927', phone: '+13217354351', website: 'https://www.circlek.com/',
    });
    expect(cleanPoiRow(row({ category: null, address: null, city: null, region: null, postcode: null, phone: null, website: null }))).toMatchObject({ category: '', address: '', phone: '', website: '' });
  });

  it('drops rows with no name or position, and links that are not ordinary web addresses', () => {
    expect(cleanPoiRow(row({ name: null }))).toBeNull();
    expect(cleanPoiRow(row({ name: '   ' }))).toBeNull();
    expect(cleanPoiRow(row({ lat: null, lon: undefined }))).toBeNull();
    expect(cleanPoiRow(row({ lat: 95 }))).toBeNull();
    expect(cleanPoiRow(row({ id: 5 }))).toBeNull();
    expect(cleanPoiRow(row({ website: 'javascript:alert(1)' }))!.website).toBe('');
    expect(cleanPoiRow(row({ website: 'https://x.example/"onmouseover="y' }))!.website).toBe('');
  });

  it('labels categories in plain words', () => {
    expect(poiCategoryLabel('gas_station')).toBe('Gas station');
    expect(poiCategoryLabel('')).toBe('Business');
  });
});
