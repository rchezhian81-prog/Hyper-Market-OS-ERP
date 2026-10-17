// D-5 (roadmap v2.1 addendum, ratified R2) — reason-coded shrink / waste and its analytics.
//
// Acceptance, in the addendum's words: "Waste is captured against a closed reason taxonomy; analytics aggregate by
// SKU/dept/reason; a bare (reasonless) waste event is rejected".
//
// ── One closed list, not a second vocabulary ────────────────────────────────────────────────────────────────
//
// The shop already had ONE closed list of why stock is wasted: the sustainability record's `WasteSource` (M28-FR-04 —
// expiry, damage, shrinkage, preparation, customer return, recall). A write-off (M28-FR-01) carried a closed LOSS TYPE
// (what happened to the stock: wasted, damaged, expired, donated, destroyed) but its reason was free text, so "leaking",
// "broken", "Leaking " and "past date" were four reasons and no report could add them up. D-5 makes the write-off's
// reason a code from the SAME list the waste record already uses, so both kinds of waste event speak one taxonomy and
// the analytics below can group them. Anything outside the list is refused by name — never stored as a new reason.
//
// A reason missing altogether (absent, empty, spaces) is a BARE waste event and is refused before anything is written.
//
// ── The analytics ───────────────────────────────────────────────────────────────────────────────────────────
//
// `aggregateWaste` folds waste events into three breakdowns — by SKU (product), by department, by reason — each line
// with its value, its quantity and its share. Nothing is dropped to make a total tidy (P-08): an event stored before
// D-5 (or by another path) with a reason outside the list is counted under `unclassified`, by name, with how many; an
// event whose product the master places in no department is counted under `in no department`, never folded away.
//
// Pure and deterministic: no I/O, no clock.

import type { WasteSource } from './sustainability';

/** The closed waste reason taxonomy (D-5) — exactly the shop's existing waste sources, in that order. */
export const WASTE_REASON_CODES: readonly WasteSource[] = Object.freeze(['expiry', 'damage', 'shrinkage', 'preparation', 'customer_return', 'recall']);

export type WasteReason = WasteSource;

/** Words a person reads for each reason (English and Tamil) — the capture screen and the report show these. */
export const WASTE_REASON_WORDS: Readonly<Record<WasteReason, { readonly en: string; readonly ta: string }>> = Object.freeze({
  expiry: { en: 'Past its date', ta: 'காலாவதியானது' },
  damage: { en: 'Damaged', ta: 'சேதமடைந்தது' },
  shrinkage: { en: 'Missing (shrinkage)', ta: 'காணாமல் போனது' },
  preparation: { en: 'Lost in preparation', ta: 'தயாரிப்பில் வீணானது' },
  customer_return: { en: 'Customer return, not saleable', ta: 'வாடிக்கையாளர் திருப்பியது, விற்க முடியாது' },
  recall: { en: 'Recalled', ta: 'திரும்பப் பெறப்பட்டது' },
});

export const isWasteReason = (v: unknown): v is WasteReason =>
  typeof v === 'string' && (WASTE_REASON_CODES as readonly string[]).includes(v);

/** What a reason sent with a waste event reads as. */
export type WasteReasonCheck =
  | { readonly ok: true; readonly reason: WasteReason }
  | { readonly ok: false; readonly why: 'bare' | 'not_in_taxonomy' };

/** Read a reason from an untrusted body: missing/blank is BARE; anything not on the closed list is refused by name. */
export function checkWasteReason(v: unknown): WasteReasonCheck {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return { ok: false, why: 'bare' };
  if (!isWasteReason(v)) return { ok: false, why: 'not_in_taxonomy' };
  return { ok: true, reason: v };
}

/** Thrown by the write-off engine when the reason is not on the closed list (D-5). */
export class UnknownWasteReasonError extends Error {
  constructor(id: string, reason: string) {
    super(`Write-off "${id}" names reason "${reason}", which is not on the waste reason list (${WASTE_REASON_CODES.join(', ')}) (D-5).`);
    this.name = 'UnknownWasteReasonError';
  }
}

// ── analytics ──────────────────────────────────────────────────────────────────────────────────────────────

/** One waste event, from either a write-off or a sustainability waste record. */
export interface WasteEvent {
  readonly eventId: string;
  readonly productId: string;
  /** `null` when the product master places the product in no department. */
  readonly departmentId: string | null;
  /** The reason exactly as stored — a code from the list, or (before D-5 / another path) something else. */
  readonly reason: string;
  readonly valueMinor: number;
  /** Units removed, where the event carries them (a waste record may carry only grams). */
  readonly qty?: number;
  readonly at: string;
}

export const UNCLASSIFIED = 'unclassified';
export const NO_DEPARTMENT = 'in no department';

export interface WasteLine {
  readonly key: string;
  readonly valueMinor: number;
  readonly qty: number;
  readonly events: number;
  /** Share of the total value, in basis points (whole). */
  readonly shareBps: number;
}

export interface WasteAnalytics {
  readonly events: number;
  readonly totalValueMinor: number;
  readonly bySku: readonly WasteLine[];
  readonly byDepartment: readonly WasteLine[];
  readonly byReason: readonly WasteLine[];
  /** Events whose stored reason is not on the list — counted under `unclassified`, never dropped. */
  readonly unclassified: { readonly events: number; readonly reasonsSeen: readonly string[] };
}

function linesBy(events: readonly WasteEvent[], keyOf: (e: WasteEvent) => string, total: number): WasteLine[] {
  const by = new Map<string, { valueMinor: number; qty: number; events: number }>();
  for (const e of events) {
    const k = keyOf(e);
    const held = by.get(k) ?? { valueMinor: 0, qty: 0, events: 0 };
    held.valueMinor += Math.abs(e.valueMinor);
    held.qty += e.qty ?? 0;
    held.events += 1;
    by.set(k, held);
  }
  return [...by.entries()]
    .map(([key, v]) => ({ key, ...v, shareBps: total === 0 ? 0 : Math.round((v.valueMinor * 10_000) / total) }))
    .sort((a, b) => b.valueMinor - a.valueMinor || a.key.localeCompare(b.key));
}

/** Aggregate waste events by SKU, by department and by reason (D-5). */
export function aggregateWaste(events: readonly WasteEvent[]): WasteAnalytics {
  const total = events.reduce((s, e) => s + Math.abs(e.valueMinor), 0);
  const reasonKey = (e: WasteEvent): string => (isWasteReason(e.reason) ? e.reason : UNCLASSIFIED);
  const odd = events.filter((e) => !isWasteReason(e.reason));
  return {
    events: events.length,
    totalValueMinor: total,
    bySku: linesBy(events, (e) => e.productId, total),
    byDepartment: linesBy(events, (e) => e.departmentId ?? NO_DEPARTMENT, total),
    byReason: linesBy(events, reasonKey, total),
    unclassified: { events: odd.length, reasonsSeen: [...new Set(odd.map((e) => e.reason))].sort() },
  };
}
