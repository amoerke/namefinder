import type { DomainCheck, NameSuggestion } from '../../shared/types';

/** Schreibweise ohne TLD, z. B. "sonnen-plan" */
export const label = (c: DomainCheck) => c.domain.replace(/\.(de|com)$/i, '');

/** Gruppiert Checks nach Schreibweise (ohne / mit Bindestrich) */
export function groupChecks(checks: DomainCheck[]) {
  const map = new Map<string, DomainCheck[]>();
  for (const c of checks) {
    const k = label(c);
    map.set(k, [...(map.get(k) ?? []), c]);
  }
  return [...map.entries()]
    .sort((a, b) => Number(a[0].includes('-')) - Number(b[0].includes('-')))
    .map(([spelling, cs]) => ({ spelling, checks: cs.sort((a, b) => a.tld.localeCompare(b.tld)) }));
}

export function bothFree(checks: DomainCheck[]) {
  return groupChecks(checks).some(g =>
    g.checks.some(c => c.tld === 'de' && c.status === 'free') &&
    g.checks.some(c => c.tld === 'com' && c.status === 'free'));
}

export const isPending = (checks: DomainCheck[]) => checks.some(c => c.status === 'pending');

export function mergeCheck(s: NameSuggestion, c: DomainCheck): NameSuggestion {
  const i = s.checks.findIndex(x => x.domain === c.domain);
  const checks = i === -1 ? [...s.checks, c] : s.checks.map((x, j) => (j === i ? c : x));
  return { ...s, checks };
}

export const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–';
