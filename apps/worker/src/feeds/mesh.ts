/**
 * NOAA MRMS radar-estimated hail size (MESH: Maximum Estimated Size of Hail).
 *
 * Product: MESH_Max_60min, the largest estimated hail in the past hour, on a
 * 0.01 degree grid over the continental US (7000 x 3500 cells), published every
 * two minutes as a gzipped GRIB2 file at https://mrms.ncep.noaa.gov/2D/MESH_Max_60min/.
 * Values are millimetres. The file uses GRIB2 data template 5.41 (a PNG image),
 * which is decoded here directly so no native GRIB library is needed.
 */
import { gunzipSync, inflateSync } from 'node:zlib';
import { convectiveDay, hailSeverity, type GeoJsonGeometry, type Severity, type SourceEvent } from '@hazard/core';

export interface MrmsGrid {
  ni: number;
  nj: number;
  /** Latitude / longitude of the first cell centre, degrees (longitude in -180..180). */
  lat1: number;
  lon1: number;
  /** Cell size in degrees. Rows run north to south. */
  di: number;
  dj: number;
  /** Packed values, row by row. */
  packed: Uint8Array | Uint16Array | Uint32Array;
  /** Converts a packed value to the physical value (mm). */
  unpack: (packedValue: number) => number;
  referenceTime: Date;
}

function decodePng(png: Buffer): { width: number; height: number; bytesPerPixel: number; pixels: Buffer } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('GRIB data section is not a PNG image');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels || (bitDepth !== 8 && bitDepth !== 16)) throw new Error(`Unsupported PNG format (colour ${colorType}, depth ${bitDepth})`);
  const bpp = (channels * bitDepth) / 8;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.allocUnsafe(stride * height);
  // Undo PNG row filters (PNG spec section 9).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[dst + x - bpp]! : 0;
      const b = y > 0 ? pixels[dst + x - stride]! : 0;
      const c = x >= bpp && y > 0 ? pixels[dst + x - stride - bpp]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[dst + x] = (raw[src + x]! + predictor) & 0xff;
    }
  }
  return { width, height, bytesPerPixel: bpp, pixels };
}

/** Decode a gzipped MRMS GRIB2 file (single field, regular lat/lon grid, PNG packing). */
export function decodeMrmsGrib(gzipped: Buffer): MrmsGrid {
  const d = gunzipSync(gzipped);
  if (d.toString('latin1', 0, 4) !== 'GRIB' || d[7] !== 2) throw new Error('Not a GRIB edition 2 file');
  let p = 16;
  const grid: Partial<MrmsGrid> = {};
  let R = 0;
  let E = 0;
  let D = 0;
  let png: Buffer | null = null;
  while (p < d.length - 4 && d.toString('latin1', p, p + 4) !== '7777') {
    const length = d.readUInt32BE(p);
    const section = d[p + 4];
    if (section === 1) {
      grid.referenceTime = new Date(Date.UTC(d.readUInt16BE(p + 12), d[p + 14]! - 1, d[p + 15]!, d[p + 16]!, d[p + 17]!, d[p + 18]!));
    } else if (section === 3) {
      if (d.readUInt16BE(p + 12) !== 0) throw new Error('Unsupported GRIB grid (expected regular lat/lon)');
      grid.ni = d.readUInt32BE(p + 30);
      grid.nj = d.readUInt32BE(p + 34);
      grid.lat1 = d.readInt32BE(p + 46) / 1e6;
      const lon1 = d.readInt32BE(p + 50) / 1e6;
      grid.lon1 = lon1 > 180 ? lon1 - 360 : lon1;
      grid.di = d.readUInt32BE(p + 63) / 1e6;
      grid.dj = d.readUInt32BE(p + 67) / 1e6;
      if (d[p + 71]! & 0xc0) throw new Error('Unsupported GRIB scanning mode');
    } else if (section === 5) {
      if (d.readUInt16BE(p + 9) !== 41) throw new Error('Unsupported GRIB packing (expected PNG, template 5.41)');
      R = d.readFloatBE(p + 11);
      // Scale factors are sign-magnitude 16-bit integers.
      const signed = (v: number) => (v & 0x8000 ? -(v & 0x7fff) : v);
      E = signed(d.readUInt16BE(p + 15));
      D = signed(d.readUInt16BE(p + 17));
    } else if (section === 7) {
      png = d.subarray(p + 5, p + length);
    }
    p += length;
  }
  if (!png || !grid.ni || !grid.nj) throw new Error('GRIB file is missing its grid or data section');
  const image = decodePng(png);
  if (image.width !== grid.ni || image.height !== grid.nj) throw new Error('GRIB grid and image dimensions disagree');

  const count = grid.ni * grid.nj;
  let packed: MrmsGrid['packed'];
  if (image.bytesPerPixel === 1) packed = new Uint8Array(image.pixels.buffer, image.pixels.byteOffset, count);
  else {
    packed = image.bytesPerPixel === 2 ? new Uint16Array(count) : new Uint32Array(count);
    for (let i = 0; i < count; i++) packed[i] = image.pixels.readUIntBE(i * image.bytesPerPixel, image.bytesPerPixel);
  }
  const binary = 2 ** E;
  const decimal = 10 ** D;
  return { ...(grid as MrmsGrid), packed, unpack: (x) => (R + x * binary) / decimal };
}

const MM_PER_INCH = 25.4;
/** Smallest hail that is reported at all: 0.75 inch. Below this the radar estimate is too noisy. */
export const MIN_HAIL_INCHES = 0.75;

const BAND_LABEL: Record<Severity, string> = {
  unknown: '',
  minor: '0.75 to 1 inch',
  moderate: '1 to 1.75 inches',
  severe: '1.75 to 2.75 inches',
  extreme: '2.75 inches or larger',
};

interface HailArea {
  tileLat: number;
  tileLon: number;
  band: Severity;
  maxInches: number;
  /** [west, south, east, north] rectangles, one per run of adjacent cells in a row. */
  rects: Array<[number, number, number, number]>;
}

/**
 * Find every cell with hail of at least MIN_HAIL_INCHES and group the cells by
 * 1-degree tile and severity band. Adjacent cells in a row are merged into one rectangle.
 */
export function hailAreas(grid: MrmsGrid): HailArea[] {
  const { ni, nj, lat1, lon1, di, dj, packed, unpack } = grid;
  // Classify each distinct packed value once, rather than converting 24 million cells.
  const bandOf = new Map<number, Severity | null>();
  const classifySlow = (x: number): Severity | null => {
    let band = bandOf.get(x);
    if (band === undefined) {
      const inches = unpack(x) / MM_PER_INCH;
      band = inches >= MIN_HAIL_INCHES ? hailSeverity(inches) : null;
      bandOf.set(x, band);
    }
    return band;
  };
  const tableSize = packed instanceof Uint8Array ? 256 : packed instanceof Uint16Array ? 65536 : 0;
  const table: Array<Severity | null> = Array.from({ length: tableSize }, (_, x) => classifySlow(x));
  const classify = tableSize ? (x: number) => table[x]! : classifySlow;
  const areas = new Map<string, HailArea>();
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  for (let j = 0; j < nj; j++) {
    const lat = lat1 - j * dj;
    const row = j * ni;
    let i = 0;
    while (i < ni) {
      const x = packed[row + i]!;
      const band = classify(x);
      if (!band) {
        i++;
        continue;
      }
      const start = i;
      const tileLon = Math.floor(lon1 + i * di);
      let max = unpack(x);
      i++;
      while (i < ni && Math.floor(lon1 + i * di) === tileLon) {
        const next = packed[row + i]!;
        if (classify(next) !== band) break;
        max = Math.max(max, unpack(next));
        i++;
      }
      const tileLat = Math.floor(lat);
      const key = `${tileLat}:${tileLon}:${band}`;
      let area = areas.get(key);
      if (!area) {
        area = { tileLat, tileLon, band, maxInches: 0, rects: [] };
        areas.set(key, area);
      }
      area.maxInches = Math.max(area.maxInches, max / MM_PER_INCH);
      area.rects.push([r3(lon1 + start * di - di / 2), r3(lat - dj / 2), r3(lon1 + (i - 1) * di + di / 2), r3(lat + dj / 2)]);
    }
  }
  return [...areas.values()];
}

/**
 * One event per convective day, 1-degree tile and hail-size band. The stored area
 * accumulates over the day, so it becomes the hail swath. A property whose cell moves
 * into a larger-size band is picked up by that band's event, which is how an
 * escalation reaches its contacts.
 */
export function meshEvents(grid: MrmsGrid, now = new Date()): SourceEvent[] {
  const day = convectiveDay(grid.referenceTime);
  return hailAreas(grid).map((area) => {
    const geometry: GeoJsonGeometry = {
      type: 'MultiPolygon',
      coordinates: area.rects.map(([w, s, e, n]) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]]),
    };
    return {
      source: 'mesh',
      key: `${day}:${area.tileLat}:${area.tileLon}:${area.band}`,
      hazardType: 'hail',
      eventName: `Radar-estimated hail: ${BAND_LABEL[area.band]}`,
      severity: area.band,
      nativeSeverity: `MESH ${(area.maxInches * MM_PER_INCH).toFixed(0)} mm`,
      headline: `Radar estimates hail of ${BAND_LABEL[area.band]} fell in this area. This is a radar estimate, not a ground report; actual hail size can differ.`,
      areaDesc: `Near ${area.tileLat + 0.5}, ${area.tileLon + 0.5}`,
      geometry,
      mergeGeometry: true,
      startsAt: grid.referenceTime.toISOString(),
      // Stays on the map for 12 hours after hail was last seen in this tile.
      endsAt: new Date(now.getTime() + 12 * 3_600_000).toISOString(),
      sourceUrl: 'https://mrms.ncep.noaa.gov/',
      details: { maxHailInches: Math.round(area.maxInches * 100) / 100, product: 'MESH_Max_60min' },
      raw: { file: grid.referenceTime.toISOString(), cells: area.rects.length },
    } satisfies SourceEvent;
  });
}
