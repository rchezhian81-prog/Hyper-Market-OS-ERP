// What a self-checkout basket leaves behind for loss prevention (R8-3 · R8-7 · M15 · D04-FR-06 · OB-302 · P-08).
//
// When a customer-operated basket is paid, the lane hands its store computer ONE record: the bill, its total, every time a
// colleague was needed and how it was settled (by whom, with their own PIN), how many lines were taken off, and the
// basket's risk figure. The store computer keeps it on its own disk and carries it to head office, where the
// loss-prevention office reads it beside the till's voids and the camera events. It is evidence, never money: the sale
// itself already went through the till's own path (hard rule #1), and nothing here can move stock, a price or a payment.
//
//   • The CUSTOMER never sees this record or the risk figure — only neutral words at the lane (the engine's rule).
//   • The risk figure and the random audit are "not set" (null) until the owner sets the watch numbers (P-08): no number
//     the owner has not given is ever invented.
//   • A weighed item is never priced by a keyed weight (OB-302): its outcome is "sent to the scale" or "not sold".
//
// Pure: reading and shaping only.

/** Why a colleague was needed at a self-checkout lane. */
export type LaneInterventionKind =
  | 'age_check'
  | 'pack_date_check'
  | 'weighed_item'
  | 'item_refused'
  | 'not_found'
  | 'random_audit'
  | 'high_value_produce_pattern'
  | 'void_pattern'
  | 'payment';

export const LANE_INTERVENTION_KINDS: readonly LaneInterventionKind[] = Object.freeze([
  'age_check', 'pack_date_check', 'weighed_item', 'item_refused', 'not_found', 'random_audit', 'high_value_produce_pattern', 'void_pattern', 'payment',
]);

/** How a colleague settled it. */
export type LaneInterventionOutcome =
  | 'old_enough' | 'not_old_enough'
  | 'date_good' | 'date_passed'
  | 'sent_to_scale' | 'not_sold'
  | 'item_taken_back'
  | 'checked' | 'noted'
  | 'approved' | 'declined' | 'no_answer';

export const LANE_INTERVENTION_OUTCOMES: readonly LaneInterventionOutcome[] = Object.freeze([
  'old_enough', 'not_old_enough', 'date_good', 'date_passed', 'sent_to_scale', 'not_sold', 'item_taken_back', 'checked', 'noted', 'approved', 'declined', 'no_answer',
]);

/** The decisions a colleague may take for each kind — nothing else is offered, and nothing else is accepted. */
export const DECISIONS_FOR: Readonly<Record<LaneInterventionKind, readonly LaneInterventionOutcome[]>> = Object.freeze({
  age_check: ['old_enough', 'not_old_enough'],
  pack_date_check: ['date_good', 'date_passed'],
  // OB-302: never a keyed weight — the item goes to a verified scale for its own label, or it is not sold here.
  weighed_item: ['sent_to_scale', 'not_sold'],
  item_refused: ['item_taken_back'],
  not_found: ['item_taken_back'],
  random_audit: ['checked'],
  high_value_produce_pattern: ['noted'],
  void_pattern: ['noted'],
  payment: ['approved', 'declined', 'no_answer'],
});

export interface SettledIntervention {
  readonly kind: LaneInterventionKind;
  readonly blocking: boolean;
  readonly outcome: LaneInterventionOutcome;
  /** The colleague who settled it, as the store computer verified them (their own PIN). */
  readonly settledBy: string;
  readonly at: string;
  readonly productId?: string;
}

export interface SelfCheckoutBasketEvidence {
  readonly format: 'sre-sco-basket/1';
  readonly lines: number;
  readonly voids: number;
  readonly interventions: readonly SettledIntervention[];
  /** The engine's basket risk in basis points — null while the owner's watch numbers are not set. */
  readonly riskBps: number | null;
  /** Whether the basket was drawn for a random audit — null while the owner's audit rate is not set. */
  readonly auditSelected: boolean | null;
}

export const MAX_INTERVENTIONS = 60;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 120;
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Read a basket's evidence as the lane sent it, or undefined when any part cannot be read (refused by name upstream). */
export function readBasketEvidence(v: unknown): SelfCheckoutBasketEvidence | undefined {
  if (!isObj(v) || v['format'] !== 'sre-sco-basket/1' || !whole(v['lines']) || !whole(v['voids']) || !Array.isArray(v['interventions'])) return undefined;
  if (v['interventions'].length > MAX_INTERVENTIONS) return undefined;
  const riskBps = v['riskBps'];
  const audit = v['auditSelected'];
  if (!(riskBps === null || (whole(riskBps) && riskBps <= 10_000)) || !(audit === null || typeof audit === 'boolean')) return undefined;
  const interventions: SettledIntervention[] = [];
  for (const raw of v['interventions'] as unknown[]) {
    if (!isObj(raw)) return undefined;
    const kind = raw['kind'];
    const outcome = raw['outcome'];
    if (typeof kind !== 'string' || !(LANE_INTERVENTION_KINDS as readonly string[]).includes(kind)) return undefined;
    if (typeof outcome !== 'string' || !DECISIONS_FOR[kind as LaneInterventionKind].includes(outcome as LaneInterventionOutcome)) return undefined;
    if (typeof raw['blocking'] !== 'boolean' || !isStr(raw['settledBy']) || !isTime(raw['at']) || (raw['productId'] !== undefined && !isStr(raw['productId']))) return undefined;
    interventions.push({
      kind: kind as LaneInterventionKind, blocking: raw['blocking'], outcome: outcome as LaneInterventionOutcome,
      settledBy: (raw['settledBy'] as string).trim(), at: new Date(Date.parse(raw['at'] as string)).toISOString(),
      ...(isStr(raw['productId']) ? { productId: (raw['productId'] as string).trim() } : {}),
    });
  }
  return { format: 'sre-sco-basket/1', lines: v['lines'], voids: v['voids'], interventions, riskBps: riskBps as number | null, auditSelected: audit as boolean | null };
}

/** The office's one-line reading of a basket: what needed a colleague, in plain words. */
export function basketSummary(e: SelfCheckoutBasketEvidence): string {
  const needed = e.interventions.filter((i) => i.kind !== 'payment');
  const risk = e.riskBps === null ? 'risk figure not set (the owner has not set the watch numbers)' : `risk ${e.riskBps} bps`;
  if (needed.length === 0) return `${e.lines} line(s), ${e.voids} taken off, no colleague needed beyond the payment — ${risk}`;
  const words = needed.map((i) => `${i.kind.replace(/_/g, ' ')} → ${i.outcome.replace(/_/g, ' ')} (${i.settledBy})`).join('; ');
  return `${e.lines} line(s), ${e.voids} taken off; ${words} — ${risk}`;
}
