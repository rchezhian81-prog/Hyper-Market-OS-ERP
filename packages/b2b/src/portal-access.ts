// The B2B customer portal's access record (M22-FR-04 · §35 · hard rule #6).
//
// `scopeToCustomer` decides whether a portal login may see a row. This module keeps what that decision
// produced when the answer was "no, and that was a probe": a refusal is RECORDED, never silently emptied,
// and a pattern of refusals is named — one caterer asking for another caterer's statement is a mis-click
// once and somebody trying doors the third time. Pure and deterministic; the caller persists the entries.
import type { B2BAccessOutcome } from './collections';

export interface B2BPortalRefusal {
  /** The customer the login is bound to — whose door was used. */
  readonly customerId: string;
  readonly userId: string;
  /** What was asked for and refused. */
  readonly requestedCustomerId: string;
  readonly action: string;
  readonly outcome: B2BAccessOutcome;
  readonly at: string;
}

export interface B2BProbePattern {
  readonly customerId: string;
  readonly userId: string;
  readonly attempts: number;
  /** How many DIFFERENT customers were asked for — a wider spread is a more deliberate probe. */
  readonly distinctTargets: number;
  readonly detail: string;
}

/** Portal logins whose cross-customer refusals reach the threshold (default 3) — worst first. */
export function findB2BProbing(refusals: readonly B2BPortalRefusal[], threshold = 3): readonly B2BProbePattern[] {
  const byLogin = new Map<string, B2BPortalRefusal[]>();
  for (const r of refusals) {
    if (r.outcome !== 'not_your_data') continue;
    const key = `${r.customerId}|${r.userId}`;
    byLogin.set(key, [...(byLogin.get(key) ?? []), r]);
  }
  return [...byLogin]
    .filter(([, rows]) => rows.length >= threshold)
    .map(([key, rows]) => {
      const [customerId = '', userId = ''] = key.split('|');
      const distinctTargets = new Set(rows.map((r) => r.requestedCustomerId)).size;
      return {
        customerId, userId, attempts: rows.length, distinctTargets,
        detail: `${rows.length} attempts to reach another customer's data (${distinctTargets} different customer${distinctTargets === 1 ? '' : 's'}) — one is a mis-click, ${rows.length} is somebody trying doors`,
      };
    })
    .sort((a, b) => (b.attempts - a.attempts) || (b.distinctTargets - a.distinctTargets) || a.userId.localeCompare(b.userId));
}
