import { SEVERITY_COLORS, SEVERITY_LABELS, type Severity } from '@hazard/core';

export type Search = Promise<Record<string, string | undefined>>;

export async function Flash({ search }: { search: Search }) {
  const { error, notice } = await search;
  return (
    <>
      {error && <div className="flash error">{error}</div>}
      {notice && <div className="flash notice">{notice}</div>}
    </>
  );
}

export function SeverityPill({ severity }: { severity: Severity }) {
  return (
    <span className="pill" style={{ background: SEVERITY_COLORS[severity] }}>
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

export function when(date: Date | string | null): string {
  if (!date) return '';
  return new Date(date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
