// Google place search, driven by a stand-in for fetch. No network, no real key.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { PLACES_SYSTEM, PLACES_TOOL, readPlacesCap } from '@hazard/core';
import { askAssistant, type CreateMessage } from './assistant';
import { GooglePlacesError, readPlacesResponse, searchGooglePlaces } from './googlePlaces';

const place = (name: string, id: string, extra: Record<string, unknown> = {}) => ({
  id,
  location: { latitude: 47.2, longitude: -123.1 },
  googleMapsLinks: { placeUrl: `https://www.google.com/maps/place//data=${id}` },
  attribution: { title: `${name} - Google Maps`, url: `https://www.google.com/maps/place//data=${id}` },
  ...extra,
});

describe('reading a Google place search response', () => {
  it('keeps the summary, the place names and a Google Maps source for each place', () => {
    const answer = readPlacesResponse({ summary: '**Tozier Bros** [0] is a hardware store.', places: [place('Tozier Bros', 'a'), place('Ace Hardware', 'b')] });
    expect(answer.summary).toContain('[0]');
    expect(answer.places.map((p) => p.name)).toEqual(['Tozier Bros', 'Ace Hardware']);
    expect(answer.sources).toEqual([
      { title: 'Tozier Bros - Google Maps', url: 'https://www.google.com/maps/place//data=a' },
      { title: 'Ace Hardware - Google Maps', url: 'https://www.google.com/maps/place//data=b' },
    ]);
  });

  it('drops places that cannot be attributed with a Google link, and never returns more than five', () => {
    const answer = readPlacesResponse({
      places: [
        place('No link', 'x', { attribution: { title: 'No link - Google Maps' }, googleMapsLinks: {} }),
        place('Bad link', 'y', { attribution: { title: 'Bad link - Google Maps', url: 'javascript:alert(1)' }, googleMapsLinks: { placeUrl: 'https://evil.example/maps' } }),
        place('No title', 'z', { attribution: { url: 'https://www.google.com/maps/place//data=z' } }),
        ...['1', '2', '3', '4', '5', '6', '7'].map((n) => place(`Shop ${n}`, n)),
      ],
    });
    // The cut to five happens first, so three unusable entries leave two.
    expect(answer.places.map((p) => p.name)).toEqual(['Shop 1', 'Shop 2']);
    expect(readPlacesResponse(null)).toEqual({ summary: '', places: [], sources: [] });
    expect(readPlacesResponse({ places: 'nope' }).places).toEqual([]);
  });
});

describe('calling Google', () => {
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key-123';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = saved;
  });

  it('sends the key in a header, stays on the five-place tier and biases to the property', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ summary: 'ok', places: [place('Ace Hardware', 'b')] }), { status: 200 });
    }) as unknown as typeof fetch;
    const answer = await searchGooglePlaces('hardware stores', { lat: 47.2151, lon: -123.1007 }, fake);
    expect(answer.places).toHaveLength(1);
    expect(seen!.url).toBe('https://mapstools.googleapis.com/v1:searchText');
    expect(seen!.url).not.toContain('test-key-123');
    expect((seen!.init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('test-key-123');
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toMatchObject({ textQuery: 'hardware stores', pageSize: 5, locationBias: { circle: { center: { latitude: 47.2151, longitude: -123.1007 } } } });
    expect(body.includeExtendedDetails).toBeUndefined();
    expect(body.locationBias.circle.radiusMeters).toBeLessThanOrEqual(50_000);
  });

  it('reports a failure without leaking the key', async () => {
    const fake = (async () => new Response('API key test-key-123 is not valid', { status: 403 })) as unknown as typeof fetch;
    const error = await searchGooglePlaces('hotels', null, fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GooglePlacesError);
    expect((error as GooglePlacesError).status).toBe(403);
    expect((error as Error).message).not.toContain('test-key-123');
  });

  it('refuses to run without a key', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    await expect(searchGooglePlaces('hotels', null, (async () => new Response('{}')) as unknown as typeof fetch)).rejects.toBeInstanceOf(GooglePlacesError);
  });
});

describe('the assistant with the Google tool', () => {
  type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
  const reply = (stop: string, content: unknown[]) =>
    ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, content, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as BetaMessage;
  const base = { model: 'claude-opus-5-5', effort: 'medium' as const, today: 'Monday, November 23, 2026 (UTC)', question: 'Hardware stores near the Shelton office?' };

  it('offers the tool only when asked to, and returns its sources once each', async () => {
    const seen: Array<Parameters<CreateMessage>[0]> = [];
    const replies = [
      reply('tool_use', [
        { type: 'tool_use', id: 't1', name: 'nearby_businesses', input: { query: 'hardware stores' } },
        { type: 'tool_use', id: 't2', name: 'nearby_businesses', input: { query: 'lumber' } },
      ]),
      reply('end_turn', [{ type: 'text', text: 'Ace Hardware is closest.' }]),
    ];
    const create: CreateMessage = async (params) => {
      seen.push(JSON.parse(JSON.stringify(params)));
      return replies[seen.length - 1]!;
    };
    const src = { title: 'Ace Hardware - Google Maps', url: 'https://www.google.com/maps/place//data=b' };
    const result = await askAssistant({
      ...base,
      create,
      runTool: async () => ({ result: { places: [{ ref: 0, name: 'Ace Hardware' }] }, sources: [src] }),
      extra: { tools: [PLACES_TOOL], system: PLACES_SYSTEM },
    });
    expect(result.answer).toBe('Ace Hardware is closest.');
    expect(result.sources).toEqual([src]);
    expect(seen[0]!.tools!.at(-1)).toMatchObject({ name: 'nearby_businesses' });
    expect(String(seen[0]!.system)).toContain('Google Maps');

    const plain: Array<Parameters<CreateMessage>[0]> = [];
    const without = await askAssistant({
      ...base,
      create: async (params) => {
        plain.push(params);
        return reply('end_turn', [{ type: 'text', text: 'I can only answer about the portfolio.' }]);
      },
      runTool: async () => ({ result: {} }),
    });
    expect(without.sources).toEqual([]);
    expect(plain[0]!.tools!.some((t) => 'name' in t && t.name === 'nearby_businesses')).toBe(false);
    expect(String(plain[0]!.system)).not.toContain('Google Maps');
  });

  it('reads the monthly cap, falling back to the default', () => {
    expect(readPlacesCap(undefined)).toBe(9000);
    expect(readPlacesCap('250')).toBe(250);
    expect(readPlacesCap('0')).toBe(0);
    expect(readPlacesCap('lots')).toBe(9000);
    expect(readPlacesCap('-5')).toBe(9000);
  });
});
