import { describe, expect, it } from 'vitest';
import { MAX_PROSPECTS_PER_ADD, cleanFoundIn, cleanProspectInput, cleanProspectInputs, isProspectStatus, telHref } from './prospects';

describe('cleanProspectInput', () => {
  it('keeps a business found on the map', () => {
    expect(
      cleanProspectInput({ id: 'abc-123', name: '  Joe\'s   Diner ', kind: 'Restaurant', address: '1 Main St', city: 'Cocoa', state: 'FL', zip: '32922', phone: '+1 321-555-0100', website: 'https://joes.example', lon: -80.74, lat: 28.38, category: 'food' }),
    ).toEqual({ name: "Joe's Diner", kind: 'Restaurant', address: '1 Main St', city: 'Cocoa', state: 'FL', zip: '32922', phone: '+1 321-555-0100', website: 'https://joes.example', lon: -80.74, lat: 28.38, sourceRef: 'abc-123' });
  });
  it('drops entries with no name and things that are not objects', () => {
    expect(cleanProspectInput({ name: '   ' })).toBeNull();
    expect(cleanProspectInput('Joe')).toBeNull();
    expect(cleanProspectInput(null)).toBeNull();
  });
  it('drops links that are not ordinary web addresses and positions that are off the map', () => {
    const p = cleanProspectInput({ name: 'X', website: 'javascript:alert(1)', lon: 500, lat: 10 })!;
    expect(p.website).toBe('');
    expect(p.lon).toBeNull();
    expect(p.lat).toBeNull();
    expect(p.sourceRef).toBeNull();
  });
  it('limits how long each field can be', () => {
    const p = cleanProspectInput({ name: 'n'.repeat(500), phone: '5'.repeat(100) })!;
    expect(p.name).toHaveLength(160);
    expect(p.phone).toHaveLength(30);
  });
});

describe('cleanProspectInputs', () => {
  it('caps the list and skips unusable entries', () => {
    const many = Array.from({ length: MAX_PROSPECTS_PER_ADD + 50 }, (_, i) => ({ name: `Shop ${i}` }));
    expect(cleanProspectInputs(many)).toHaveLength(MAX_PROSPECTS_PER_ADD);
    expect(cleanProspectInputs([{ name: 'A' }, {}, 7])).toHaveLength(1);
    expect(cleanProspectInputs('nope')).toEqual([]);
  });
});

describe('small helpers', () => {
  it('tidies the reason a prospect was added', () => {
    expect(cleanFoundIn('  Flood   Warning ')).toBe('Flood Warning');
    expect(cleanFoundIn(5)).toBe('');
  });
  it('knows the statuses', () => {
    expect(isProspectStatus('follow_up')).toBe(true);
    expect(isProspectStatus('lost')).toBe(false);
  });
  it('makes dialable phone links', () => {
    expect(telHref('+1 (321) 555-0100')).toBe('tel:+13215550100');
    expect(telHref('n/a')).toBeNull();
  });
});
