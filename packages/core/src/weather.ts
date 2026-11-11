/**
 * Weather patterns: the handful of plain-language groups people pick on the map.
 * Each stored hazard type belongs to exactly one pattern, whichever feed it came from.
 */
import { HAZARD_TYPES, type HazardType } from './nws';
import type { Severity } from './severity';

export const WEATHER_PATTERN_IDS = ['storms', 'tornado', 'flood', 'hurricane', 'wildfire', 'winter', 'heat', 'earthquake', 'other'] as const;
export type WeatherPatternId = (typeof WEATHER_PATTERN_IDS)[number];

export interface WeatherPattern {
  id: WeatherPatternId;
  label: string;
  /** What is included, for the hover text. */
  includes: string;
  color: string;
  hazardTypes: HazardType[];
}

/** Colors are spaced so neighbors on the list stay distinguishable, including for most color-blind viewers. */
export const WEATHER_PATTERNS: WeatherPattern[] = [
  { id: 'storms', label: 'Storms, hail', includes: 'Severe thunderstorms, hail, damaging wind', color: '#7c3aed', hazardTypes: ['severe_thunderstorm', 'hail', 'wind'] },
  { id: 'tornado', label: 'Tornado', includes: 'Tornado watches, warnings and reports', color: '#be123c', hazardTypes: ['tornado'] },
  { id: 'flood', label: 'Flood', includes: 'Flash floods, river flooding, coastal flooding', color: '#2563eb', hazardTypes: ['flash_flood', 'flood', 'coastal'] },
  { id: 'hurricane', label: 'Hurricane', includes: 'Hurricanes and tropical storms', color: '#0d9488', hazardTypes: ['hurricane'] },
  { id: 'wildfire', label: 'Wildfire', includes: 'Fire perimeters, satellite fire detections, fire weather', color: '#ea580c', hazardTypes: ['wildfire', 'fire'] },
  { id: 'winter', label: 'Winter', includes: 'Snow, ice and extreme cold', color: '#0891b2', hazardTypes: ['winter', 'cold'] },
  { id: 'heat', label: 'Heat', includes: 'Excessive heat', color: '#ca8a04', hazardTypes: ['heat'] },
  { id: 'earthquake', label: 'Earthquake', includes: 'Earthquakes and their felt area', color: '#854d0e', hazardTypes: ['earthquake'] },
  { id: 'other', label: 'Other', includes: 'Fog, marine, FEMA declarations and anything else', color: '#6b7280', hazardTypes: ['fog', 'marine', 'disaster_declaration', 'other'] },
];

const BY_TYPE = new Map<string, WeatherPatternId>(WEATHER_PATTERNS.flatMap((p) => p.hazardTypes.map((t) => [t, p.id] as const)));

/** The pattern a hazard type belongs to. Unknown types fall under "other" so nothing is ever hidden by accident. */
export function patternOf(hazardType: string): WeatherPatternId {
  return BY_TYPE.get(hazardType) ?? 'other';
}

export const WEATHER_PATTERN_COLORS = Object.fromEntries(WEATHER_PATTERNS.map((p) => [p.id, p.color])) as Record<WeatherPatternId, string>;

/** How solid a hazard is drawn: worse is more solid. */
export const SEVERITY_FILL_OPACITY: Record<Severity, number> = { unknown: 0.08, minor: 0.12, moderate: 0.22, severe: 0.34, extreme: 0.46 };

/** Every hazard type is covered by a pattern (checked in tests). */
export const UNGROUPED_HAZARD_TYPES = HAZARD_TYPES.filter((t) => !BY_TYPE.has(t));

/** A stable color for any label (property type, state): the same text always gets the same color. */
const LABEL_PALETTE = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f', '#9333ea', '#0f766e', '#b45309', '#475569'];
export function colorForLabel(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return LABEL_PALETTE[h % LABEL_PALETTE.length]!;
}
