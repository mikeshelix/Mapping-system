import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_SYSTEM,
  ASSISTANT_TOOLS,
  DEFAULT_ASSISTANT_MONTHLY_CAP,
  MAX_AREA_SQ_MILES,
  ZERO_USAGE,
  addUsage,
  buildOverpassQuery,
  checkShape,
  classifyPlace,
  cleanCommon,
  cleanInt,
  cleanUuid,
  estimateCostUsd,
  parseOverpass,
  readAreaSearchCap,
  readAssistantCap,
  ringAreaSqMiles,
  ringToPolygon,
  type LonLat,
} from './index';

describe('assistant tool list', () => {
  it('has unique names, descriptions and object schemas', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ASSISTANT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.input_schema.type).toBe('object');
      for (const key of t.input_schema.required ?? []) expect(Object.keys(t.input_schema.properties)).toContain(key);
    }
  });

  it('offers no tool that writes: every tool is a lookup or the map pointer', () => {
    expect(ASSISTANT_TOOLS.map((t) => t.name).sort()).toEqual(
      ['active_hazards', 'affected_properties', 'hazard_history', 'notification_summary', 'portfolio_summary', 'search_properties', 'show_on_map'].sort(),
    );
  });

  it('keeps the instructions free of dates so they can be cached', () => {
    expect(ASSISTANT_SYSTEM).not.toMatch(/20\d\d/);
  });
});

describe('assistant input clean-up', () => {
  it('drops anything outside the allowed values', () => {
    const f = cleanCommon({ hazard_types: ['hail', 'hail', 'volcano', 7], min_severity: 'catastrophic', state: 'texas', client: '  Acme  ', limit: 100000 });
    expect(f).toEqual({ hazardTypes: ['hail'], minSeverity: null, client: 'Acme', state: null, limit: 200 });
  });

  it('accepts good values and normalizes the state', () => {
    const f = cleanCommon({ hazard_types: ['tornado', 'flood'], min_severity: 'severe', state: 'tx', limit: 5 });
    expect(f).toEqual({ hazardTypes: ['tornado', 'flood'], minSeverity: 'severe', client: null, state: 'TX', limit: 5 });
  });

  it('survives input that is not an object', () => {
    expect(cleanCommon(null).limit).toBe(50);
    expect(cleanCommon('DROP TABLE').hazardTypes).toEqual([]);
  });

  it('clamps numbers and validates ids', () => {
    expect(cleanInt('400', 1, 365, 30)).toBe(365);
    expect(cleanInt(-3, 1, 365, 30)).toBe(1);
    expect(cleanInt('abc', 1, 365, 30)).toBe(30);
    expect(cleanUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(cleanUuid("1' OR '1'='1")).toBeNull();
  });
});

describe('assistant metering', () => {
  it('adds usage across requests', () => {
    const total = addUsage(addUsage(ZERO_USAGE, { inputTokens: 1000, outputTokens: 200 }), { inputTokens: 500, cacheReadTokens: 3000, cacheWriteTokens: 100 });
    expect(total).toEqual({ inputTokens: 1500, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 100 });
  });

  it('prices a question from the model price list', () => {
    // 1M input at $4, 1M output at $20, 1M cache read at $0.20, 1M cache write at $5.
    expect(estimateCostUsd('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 })).toBe(29.2);
    expect(estimateCostUsd('claude-opus-5-5', { inputTokens: 12000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0.066);
    expect(estimateCostUsd('claude-opus-5-5', ZERO_USAGE)).toBe(0);
  });

  it('gives no dollar figure for a model without a known price', () => {
    expect(estimateCostUsd('some-future-model', { ...ZERO_USAGE, inputTokens: 1000 })).toBeNull();
  });

  it('reads caps from settings, falling back to defaults', () => {
    expect(readAssistantCap({})).toBe(DEFAULT_ASSISTANT_MONTHLY_CAP);
    expect(readAssistantCap({ assistantMonthlyCap: 0 })).toBe(0);
    expect(readAssistantCap({ assistantMonthlyCap: -5 })).toBe(DEFAULT_ASSISTANT_MONTHLY_CAP);
    expect(readAreaSearchCap({ areaSearchDailyCap: 12.9 })).toBe(12);
    expect(readAreaSearchCap(null)).toBe(200);
  });
});

// About one mile on a side, in Shelton, WA.
const SQUARE: LonLat[] = [
  [-123.11, 47.21],
  [-123.0887, 47.21],
  [-123.0887, 47.2245],
  [-123.11, 47.2245],
];

describe('drawn areas', () => {
  it('measures area on the sphere', () => {
    // 1 degree x 1 degree at the equator is about 4,773 square miles.
    const deg = ringAreaSqMiles([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(deg).toBeGreaterThan(4760);
    expect(deg).toBeLessThan(4790);
    expect(ringAreaSqMiles(SQUARE)).toBeGreaterThan(0.95);
    expect(ringAreaSqMiles(SQUARE)).toBeLessThan(1.05);
    // Direction of drawing does not matter.
    expect(ringAreaSqMiles([...SQUARE].reverse())).toBeCloseTo(ringAreaSqMiles(SQUARE), 9);
  });

  it('accepts a closed or open ring and returns it open', () => {
    const closed = checkShape([...SQUARE, SQUARE[0]]);
    expect(closed.ok && closed.ring).toEqual(SQUARE);
    const open = checkShape(SQUARE);
    expect(open.ok && open.ring).toEqual(SQUARE);
    expect(ringToPolygon(SQUARE).coordinates[0]).toHaveLength(5);
  });

  it('drops repeated points, as a double-click leaves behind', () => {
    const r = checkShape([SQUARE[0], SQUARE[1], SQUARE[1], SQUARE[2]]);
    expect(r.ok && r.ring).toHaveLength(3);
  });

  it('rejects shapes that cannot be searched', () => {
    expect(checkShape(undefined).ok).toBe(false);
    expect(checkShape([[0, 0], [1, 1]]).ok).toBe(false);
    expect(checkShape([[0, 0], [1, 0], [200, 5]]).ok).toBe(false);
    expect(checkShape([[0, 0], ['x', 0], [1, 1]]).ok).toBe(false);
    const big = checkShape([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(big.ok).toBe(false);
    expect(!big.ok && big.error).toContain(String(MAX_AREA_SQ_MILES));
  });
});

describe('business query', () => {
  it('puts the shape in latitude-longitude order and asks only for named features', () => {
    const q = buildOverpassQuery(SQUARE, 'food');
    expect(q).toContain('(poly:"47.210000 -123.110000 47.210000 -123.088700 47.224500 -123.088700 47.224500 -123.110000")');
    expect(q.startsWith('[out:json][timeout:25];')).toBe(true);
    expect(q).toContain('nwr["name"]["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|biergarten)$"]');
    expect(q).not.toContain('["shop"]');
    expect(q).toMatch(/out center tags \d+;$/);
  });

  it('covers every category when searching everything', () => {
    const q = buildOverpassQuery(SQUARE, 'all');
    for (const key of ['["shop"]', '["office"]', '["craft"]', '["healthcare"]', '"tourism"', '"leisure"', 'fuel']) expect(q).toContain(key);
  });
});

describe('business results', () => {
  const reply = {
    elements: [
      { type: 'node', id: 1, lat: 47.214, lon: -123.1, tags: { name: 'DQ Grill & Chill', amenity: 'fast_food', 'addr:housenumber': '223', 'addr:street': 'North 1st Street', 'addr:city': 'Shelton', 'addr:state': 'WA', 'addr:postcode': '98584-3548', phone: '+1-360-426-7277', website: 'https://www.dairyqueen.com/x' } },
      { type: 'way', id: 2, center: { lat: 47.215, lon: -123.101 }, tags: { name: 'Ace Hardware', shop: 'hardware', website: 'acehardware.com' } },
      { type: 'node', id: 3, lat: 47.215, lon: -123.109, tags: { amenity: 'parking' } },
      { type: 'node', id: 4, lat: 47.215, lon: -123.109, tags: { name: 'City Park', leisure: 'park' } },
      { type: 'node', id: 5, lat: 47.215, lon: -123.109, tags: { name: 'First Church', amenity: 'place_of_worship' } },
      { type: 'node', id: 6, tags: { name: 'No Position Cafe', amenity: 'cafe' } },
      { type: 'node', id: 7, lat: 47.2, lon: -123.1, tags: { name: 'Bad Link Tyres', shop: 'tyres', website: 'javascript:alert(1)' } },
      { type: 'node', id: 1, lat: 47.214, lon: -123.1, tags: { name: 'DQ Grill & Chill', amenity: 'fast_food' } },
    ],
  };

  it('keeps named, placed businesses and reads their details', () => {
    const places = parseOverpass(reply);
    expect(places.map((p) => p.name)).toEqual(['Ace Hardware', 'Bad Link Tyres', 'DQ Grill & Chill']);
    const dq = places[2]!;
    expect(dq).toMatchObject({ id: 'node/1', category: 'food', kind: 'fast food', address: '223 North 1st Street', city: 'Shelton', state: 'WA', zip: '98584-3548', lat: 47.214, lon: -123.1, url: 'https://www.openstreetmap.org/node/1' });
    // A way is placed at its center; a bare domain gets a scheme.
    expect(places[0]).toMatchObject({ id: 'way/2', category: 'retail', lat: 47.215, website: 'https://acehardware.com/' });
  });

  it('never passes on a link that is not http or https', () => {
    expect(parseOverpass(reply).find((p) => p.name === 'Bad Link Tyres')!.website).toBe('');
  });

  it('filters to one category', () => {
    expect(parseOverpass(reply, 'automotive').map((p) => p.name)).toEqual(['Bad Link Tyres']);
  });

  it('rejects a reply that is not in the expected form', () => {
    expect(() => parseOverpass({ error: 'rate limited' })).toThrow();
  });

  it('classifies by what a place is', () => {
    expect(classifyPlace({ shop: 'supermarket' })).toBe('retail');
    expect(classifyPlace({ shop: 'car_repair' })).toBe('automotive');
    expect(classifyPlace({ amenity: 'pharmacy' })).toBe('health');
    expect(classifyPlace({ amenity: 'bank' })).toBe('office');
    expect(classifyPlace({ office: 'insurance' })).toBe('office');
    expect(classifyPlace({ craft: 'roofer' })).toBe('trades');
    expect(classifyPlace({ tourism: 'hotel' })).toBe('lodging');
    expect(classifyPlace({ tourism: 'viewpoint' })).toBeNull();
    expect(classifyPlace({ amenity: 'school' })).toBeNull();
    expect(classifyPlace({ shop: 'vacant' })).toBeNull();
  });
});
