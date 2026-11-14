// CR-01 OI-13-A14 (OB-763 B, owner 14 Nov 2026) — the cash-office variance explainer's rule.
//
// At day close, when a till is short or over (M14, the blind count against what the till should hold), this lays out the
// likely causes FROM THE RECORDS, most specific first, each naming the record it came from — a sale or refund of exactly
// the difference on another tender (paid one way, recorded another), a round sum (a pickup or safe drop not entered, or
// cash put in and not entered), or a difference inside the till's tolerance. When nothing in the records explains it, it
// says so and asks for a recount with a second person. It never guesses.
//
// It lists RECORDS, NOT PEOPLE: no cashier is named and no word of blame is used — a difference is not a finding against
// anyone. It DRAFTS: it signs off nothing, writes nothing off and never changes a cash balance; the manager decides
// through the ordinary over/short sign-off (hard rule 5, P-05). Writing off a shortage is never auto-approved.
//
// Pure and deterministic — no clock, no I/O.

/** One closed till shift, as head office recorded it — no person in it. */
export interface TillCloseFacts {
  readonly shiftId: string;
  readonly tillId: string;
  readonly storeId?: string;
  readonly tradingDay: string;
  readonly expectedMinor: number;
  readonly countedMinor: number;
  /** Counted minus expected: below zero is short, above is over. */
  readonly varianceMinor: number;
  readonly toleranceMinor?: number;
  readonly pickupsMinor?: number;
  /** True when the blind count was entered note by note. */
  readonly denominationsGiven: boolean;
  /** True when a person already signed the over/short off. */
  readonly reviewed: boolean;
}

/** A payment on this till in the shift: a sale's tender, or a refund paid out. */
export interface TillPaymentFact {
  /** The bill or refund number. */
  readonly ref: string;
  readonly kind: 'sale' | 'refund';
  /** 'cash', 'upi', 'card', … */
  readonly tender: string;
  readonly amountMinor: number;
  readonly at: string;
}

export type TillReasonCode =
  | 'cash_sale_may_be_upi_or_card'
  | 'non_cash_sale_may_be_cash'
  | 'non_cash_refund_may_be_cash'
  | 'cash_refund_may_be_non_cash'
  | 'round_sum_short'
  | 'round_sum_over'
  | 'within_tolerance'
  | 'count_not_broken_down'
  | 'no_cause_found';

export interface TillReason {
  readonly code: TillReasonCode;
  /** The record the reason came from (a bill or refund number), when there is one. */
  readonly recordRef?: string;
  readonly values: Readonly<Record<string, string | number>>;
  readonly sentence: string;
}

export interface TillVarianceExplanation {
  readonly shiftId: string;
  readonly tillId: string;
  readonly tradingDay: string;
  readonly direction: 'short' | 'over';
  readonly differenceMinor: number;
  readonly reasons: readonly TillReason[];
  readonly summary: string;
}

/** Rupees the Indian way: ₹1,23,456.78. */
function rupees(minor: number): string {
  const abs = Math.abs(Math.trunc(minor));
  const whole = String(Math.floor(abs / 100));
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `₹${rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`}.${String(abs % 100).padStart(2, '0')}`;
}

const isCash = (tender: string): boolean => tender.trim().toLowerCase() === 'cash';

/**
 * Explain one till's over/short — or null when it balanced or a person already signed it off.
 * `roundStepMinor` is the step a pickup or safe drop is taken in (default ₹100).
 */
export function explainTillVariance(input: {
  readonly close: TillCloseFacts;
  readonly payments: readonly TillPaymentFact[];
  readonly roundStepMinor?: number;
}): TillVarianceExplanation | null {
  const c = input.close;
  if (c.varianceMinor === 0 || c.reviewed) return null;
  const short = c.varianceMinor < 0;
  const diff = Math.abs(c.varianceMinor);
  const amount = rupees(diff);
  const word = short ? 'shortage' : 'excess';
  const step = input.roundStepMinor ?? 10_000;
  const reasons: TillReason[] = [];

  // 1. A payment of exactly the difference, on the tender that would explain it — the most specific cause.
  const exact = [...input.payments].filter((p) => p.amountMinor === diff).sort((a, b) => a.at.localeCompare(b.at) || a.ref.localeCompare(b.ref));
  for (const p of exact.filter((x) => x.kind === 'sale')) {
    if (short && isCash(p.tender)) {
      reasons.push({ code: 'cash_sale_may_be_upi_or_card', recordRef: p.ref, values: { ref: p.ref, amount }, sentence: `Bill ${p.ref} was recorded as cash for ${amount} — exactly the ${word}. Check whether it was really paid by UPI or card.` });
    } else if (!short && !isCash(p.tender)) {
      reasons.push({ code: 'non_cash_sale_may_be_cash', recordRef: p.ref, values: { ref: p.ref, amount, tender: p.tender }, sentence: `Bill ${p.ref} was recorded as ${p.tender.toUpperCase()} for ${amount} — exactly the ${word}. Check whether it was really paid in cash.` });
    }
  }
  for (const p of exact.filter((x) => x.kind === 'refund')) {
    if (short && !isCash(p.tender)) {
      reasons.push({ code: 'non_cash_refund_may_be_cash', recordRef: p.ref, values: { ref: p.ref, amount, tender: p.tender }, sentence: `Refund ${p.ref} was recorded as going back by ${p.tender.toUpperCase()} for ${amount} — exactly the ${word}. Check whether it was really paid out in cash.` });
    } else if (!short && isCash(p.tender)) {
      reasons.push({ code: 'cash_refund_may_be_non_cash', recordRef: p.ref, values: { ref: p.ref, amount }, sentence: `Refund ${p.ref} was recorded as paid in cash for ${amount} — exactly the ${word}. Check whether it really went back by UPI or card.` });
    }
  }

  // 2. A round sum — a cash movement that was not entered.
  if (diff % step === 0) {
    reasons.push(short
      ? { code: 'round_sum_short', values: { amount, pickups: rupees(c.pickupsMinor ?? 0) }, sentence: `The shortage is a round ${amount}. Check whether a cash pickup or safe drop of that amount was taken and not entered (${rupees(c.pickupsMinor ?? 0)} of pickups are entered on this till).` }
      : { code: 'round_sum_over', values: { amount }, sentence: `The excess is a round ${amount}. Check whether cash of that amount (a float top-up or change) was put in the drawer and not entered.` });
  }

  // 3. Inside the till's own tolerance — change given wrongly, most likely; worth a look only if it repeats.
  if (c.toleranceMinor !== undefined && diff <= c.toleranceMinor) {
    reasons.push({ code: 'within_tolerance', values: { amount, tolerance: rupees(c.toleranceMinor) }, sentence: `The ${word} of ${amount} is inside this till's tolerance of ${rupees(c.toleranceMinor)} — most often change given wrongly. Look further only if it repeats.` });
  }

  const explained = reasons.length > 0;
  if (!c.denominationsGiven) {
    reasons.push({ code: 'count_not_broken_down', values: {}, sentence: 'The count was entered as a total only. A recount note by note shows which notes or coins are missing or extra.' });
  }
  if (!explained) {
    reasons.push({ code: 'no_cause_found', values: {}, sentence: 'No record on this till explains the difference. Recount the drawer with a second person before deciding anything.' });
  }

  const likely = reasons.filter((r) => r.code !== 'count_not_broken_down' && r.code !== 'no_cause_found').length;
  const summary = `Till ${c.tillId} on ${c.tradingDay} is ${amount} ${short ? 'short' : 'over'}. `
    + (likely === 0 ? 'No record explains it yet — a manager recounts with a second person and decides.' : `${likely} likely cause(s) from the records — a manager checks them and decides.`);
  return { shiftId: c.shiftId, tillId: c.tillId, tradingDay: c.tradingDay, direction: short ? 'short' : 'over', differenceMinor: diff, reasons, summary };
}
