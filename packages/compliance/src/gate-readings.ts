// W3 · the machine readings behind QG-04, QG-07 and QG-10 (roadmap §22) — what head office's own records say, read into
// the gate register as blockers so a GO cannot rest only on what somebody typed in (QG-12). Each reading is
// conservative: nothing on record is a blocker by name, never a pass (P-08). Pure: no clock, no I/O; structural input
// types so this package depends on nobody's runtime.

import type { GateBlocker } from './gate-decisions';
import type { Qg10ReleaseNote } from './qg10-evidence';

// ── QG-07 · "Migration, stock, financial, tax and loyalty control totals signed." ─────────────────────────────

export const QG07_DOMAINS = Object.freeze(['migration', 'stock', 'financial', 'tax', 'loyalty'] as const);
export type Qg07Domain = (typeof QG07_DOMAINS)[number];

/** A control total as head office's migration register keeps it (packages/migration ControlTotal). */
export interface SignedTotalView {
  readonly totalId: string;
  readonly kind: string;
  readonly name: string;
  readonly signature?: { readonly signedBy: string };
}

/** Per domain: no control total recorded → blocked; any total not signed → blocked, naming each one. */
export function qg07Blockers(totals: readonly SignedTotalView[]): readonly GateBlocker[] {
  const out: GateBlocker[] = [];
  for (const domain of QG07_DOMAINS) {
    const mine = totals.filter((t) => t.kind === domain);
    if (mine.length === 0) {
      out.push({ gate: 'QG-07', kind: 'check', ref: `control-totals:${domain}`, reason: `no ${domain} control total has been recorded — it cannot be signed until it exists` });
      continue;
    }
    const unsigned = mine.filter((t) => t.signature === undefined);
    if (unsigned.length > 0) {
      out.push({ gate: 'QG-07', kind: 'check', ref: `control-totals:${domain}:unsigned`, reason: `${unsigned.length} of ${mine.length} ${domain} control total(s) not signed: ${unsigned.map((t) => `${t.name} (${t.totalId})`).join(', ')}` });
    }
  }
  return out;
}

// ── QG-10 · "Health, smoke, reconciliation, monitoring and rollback verified after every release." ────────────

/**
 * Each computer's NEWEST release attempt decides for that computer: one not verified blocks QG-10, naming what was not
 * verified. No note from any computer is a blocker too — no release has shown QG-10 yet.
 */
export function qg10Blockers(notes: readonly Pick<Qg10ReleaseNote, 'release' | 'box' | 'at' | 'run' | 'attempt' | 'outcome' | 'verified' | 'notVerified'>[]): readonly GateBlocker[] {
  if (notes.length === 0) {
    return [{ gate: 'QG-10', kind: 'check', ref: 'qg10:no-release-note', reason: 'no release has left a QG-10 note yet — health, smoke, reconciliation, monitoring and rollback are not shown verified after any release' }];
  }
  const newest = new Map<string, (typeof notes)[number]>();
  for (const n of notes) {
    const cur = newest.get(n.box);
    if (cur === undefined || n.at >= cur.at) newest.set(n.box, n);
  }
  return [...newest.values()].filter((n) => !n.verified).sort((a, z) => (a.box < z.box ? -1 : 1)).map((n) => ({
    gate: 'QG-10', kind: 'check' as const, ref: `qg10:${n.box}:${n.release.slice(0, 12)}:${n.run}/${n.attempt}`,
    reason: `the newest release on ${n.box} (${n.release.slice(0, 12)}, run ${n.run} attempt ${n.attempt}, ${n.outcome.replace(/_/g, ' ')}) was not verified: ${n.notVerified.join(', ')}`,
  }));
}

// ── QG-04 · "Core sale survives internet/cloud outage; sync retries produce one business effect." ───────────────

/** One store computer's latest sync report, as head office keeps it. */
export interface StoreSyncView {
  readonly storeId: string;
  readonly domains: readonly { readonly domain: string; readonly deadLettered: number }[];
}

/**
 * The store computers' own reports: none at all → blocked (no store has shown its sync); any item a store holds in its
 * dead letter → blocked, by store and queue — a retry that could not land is not "one business effect".
 */
export function qg04SyncBlockers(latestPerStore: readonly StoreSyncView[]): readonly GateBlocker[] {
  if (latestPerStore.length === 0) {
    return [{ gate: 'QG-04', kind: 'check', ref: 'sync:no-store-report', reason: 'no store computer has reported its sync to head office yet — offline trading and its catch-up are not shown' }];
  }
  const out: GateBlocker[] = [];
  for (const s of [...latestPerStore].sort((a, z) => (a.storeId < z.storeId ? -1 : 1))) {
    for (const d of s.domains) {
      if (d.deadLettered > 0) out.push({ gate: 'QG-04', kind: 'check', ref: `sync:${s.storeId}:${d.domain}:dead-letter`, reason: `store ${s.storeId} holds ${d.deadLettered} ${d.domain} item(s) in its dead letter — sent but never landed, so not one business effect yet` });
    }
  }
  return out;
}
