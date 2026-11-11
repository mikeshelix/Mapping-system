import { describe, expect, it } from 'vitest';
import { HAZARD_TYPES, SEVERITIES, SEVERITY_FILL_OPACITY, UNGROUPED_HAZARD_TYPES, WEATHER_PATTERNS, WEATHER_PATTERN_IDS, colorForLabel, patternOf } from './index';

describe('weather patterns', () => {
  it('puts every hazard type in exactly one pattern', () => {
    expect(UNGROUPED_HAZARD_TYPES).toEqual([]);
    const all = WEATHER_PATTERNS.flatMap((p) => p.hazardTypes);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...HAZARD_TYPES].sort());
  });

  it('groups the way people expect', () => {
    expect(patternOf('hail')).toBe('storms');
    expect(patternOf('severe_thunderstorm')).toBe('storms');
    expect(patternOf('flash_flood')).toBe('flood');
    expect(patternOf('coastal')).toBe('flood');
    expect(patternOf('wildfire')).toBe('wildfire');
    expect(patternOf('fire')).toBe('wildfire');
    expect(patternOf('hurricane')).toBe('hurricane');
    expect(patternOf('tornado')).toBe('tornado');
  });

  it('never hides a hazard type it has not seen before', () => {
    expect(patternOf('volcano')).toBe('other');
  });

  it('gives every pattern its own color and label', () => {
    expect(WEATHER_PATTERNS.map((p) => p.id)).toEqual([...WEATHER_PATTERN_IDS]);
    expect(new Set(WEATHER_PATTERNS.map((p) => p.color)).size).toBe(WEATHER_PATTERNS.length);
    expect(new Set(WEATHER_PATTERNS.map((p) => p.label)).size).toBe(WEATHER_PATTERNS.length);
  });

  it('draws worse weather more solidly', () => {
    const opacities = SEVERITIES.map((s) => SEVERITY_FILL_OPACITY[s]);
    expect([...opacities].sort((a, b) => a - b)).toEqual(opacities);
  });

  it('colors the same label the same way every time', () => {
    expect(colorForLabel('Warehouse')).toBe(colorForLabel('Warehouse'));
    expect(colorForLabel('Warehouse')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
