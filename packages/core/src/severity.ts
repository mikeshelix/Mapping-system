/**
 * Common severity scale used for every hazard source.
 * Order matters: index in this array is the rank used for comparisons.
 * 'unknown' is stored but never triggers a notification.
 */
export const SEVERITIES = ['unknown', 'minor', 'moderate', 'severe', 'extreme'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Severities a rule may use as its minimum threshold. */
export const NOTIFIABLE_SEVERITIES = ['minor', 'moderate', 'severe', 'extreme'] as const;

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/**
 * NWS (CAP) severity -> common scale.
 *
 *   NWS "Extreme"  -> extreme
 *   NWS "Severe"   -> severe
 *   NWS "Moderate" -> moderate
 *   NWS "Minor"    -> minor
 *   NWS "Unknown", missing, or anything unrecognized -> unknown (stored, never notified)
 */
export function mapNwsSeverity(native: string | null | undefined): Severity {
  switch ((native ?? '').trim().toLowerCase()) {
    case 'extreme':
      return 'extreme';
    case 'severe':
      return 'severe';
    case 'moderate':
      return 'moderate';
    case 'minor':
      return 'minor';
    default:
      return 'unknown';
  }
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  unknown: 'Unknown',
  minor: 'Minor',
  moderate: 'Moderate',
  severe: 'Severe',
  extreme: 'Extreme',
};

export const SEVERITY_COLORS: Record<Severity, string> = {
  unknown: '#6b7280',
  minor: '#ca8a04',
  moderate: '#ea580c',
  severe: '#dc2626',
  extreme: '#86198f',
};
