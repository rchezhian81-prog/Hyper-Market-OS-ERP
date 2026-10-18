// Card and UPI payment disputes — the register, the reply-by date and the owner's exception (R3 · C14 · NPCI UPI dispute
// rules · RBI Payment Aggregator Directions).
//
// When a customer disputes a card or UPI payment with their bank, the shop's bank sends a notice and the shop must answer
// by a date, or lose the money by default. Signed sentence: "A UPI or card dispute is recorded with its received date and a
// response due date (UPI: 15 days). A dispute not answered by the due date is an owner exception. A lost dispute posts as a
// compensating entry." So:
//
//   • a dispute is RECORDED with the day the notice was received and the day the answer is due — for UPI, 15 days after
//     receipt (computed here, never typed); for a card, the reply-by date the acquiring bank's notice states;
//   • a dispute still unanswered AFTER its due date is an OWNER EXCEPTION, by name and amount (P-03, P-08);
//   • a dispute LOST posts a compensating entry — the money the shop gives back — beside the sale; nothing about the sale
//     is ever edited (hard rule #2). A dispute won posts nothing.
//
// The provider's reference is a case or transaction reference, never a card number, CVV or expiry (hard rule #3) — the
// caller refuses one that looks like card data. Pure and deterministic: no clock, no I/O.

/** NPCI: the shop answers a UPI P2M dispute within 15 days of receiving it. */
export const UPI_DISPUTE_RESPONSE_DAYS = 15;

export type DisputeInstrument = 'upi' | 'card';
export const DISPUTE_INSTRUMENTS: readonly DisputeInstrument[] = ['upi', 'card'];

export interface DisputeRecord {
  readonly disputeId: string;
  readonly instrument: DisputeInstrument;
  /** The bill the disputed payment paid, when known. */
  readonly saleId: string | null;
  /** The provider's case or transaction reference (never card data). */
  readonly providerRef: string;
  readonly amountMinor: number;
  /** The day the shop received the dispute notice, YYYY-MM-DD. */
  readonly receivedOn: string;
  /** The day the answer is due, YYYY-MM-DD — UPI: receivedOn + 15 days; card: the date on the bank's notice. */
  readonly respondBy: string;
  readonly reason: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface DisputeResponse {
  readonly disputeId: string;
  readonly respondedOn: string;
  /** What was sent — the reference of the evidence pack (bill copy, delivery proof) as the provider received it. */
  readonly evidenceRef: string;
  readonly by: string;
  readonly at: string;
}

/** The money the shop gives back on a lost dispute — two lines, balanced, posted once; the sale is never edited. */
export interface DisputeLossEntry {
  readonly entryId: string;
  readonly disputeId: string;
  readonly saleId: string | null;
  readonly amountMinor: number;
  readonly postedOn: string;
  readonly lines: readonly [{ readonly account: 'chargeback_loss'; readonly debitMinor: number }, { readonly account: 'card_upi_settlement_receivable'; readonly creditMinor: number }];
}

export interface DisputeOutcome {
  readonly disputeId: string;
  readonly outcome: 'won' | 'lost';
  readonly decidedOn: string;
  readonly by: string;
  readonly at: string;
  readonly lossEntry: DisputeLossEntry | null;
}

export type DisputeState = 'open' | 'answered' | 'won' | 'lost';

export interface DisputeView extends DisputeRecord {
  readonly state: DisputeState;
  readonly response: DisputeResponse | null;
  readonly outcome: DisputeOutcome | null;
  /** Unanswered and past its due date at `asOf`. */
  readonly overdue: boolean;
  readonly daysOverdue: number;
  /** Answered, but after the due date. */
  readonly answeredLate: boolean;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;
const DAY = 86_400_000;
export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY);

/**
 * The answer-by date: UPI — 15 days after the notice was received, whatever was typed; a card — the date the acquiring
 * bank's notice states, which must be given and cannot be before the notice. Null with the reason when it cannot be set.
 */
export function respondByFor(input: { readonly instrument: DisputeInstrument; readonly receivedOn: string; readonly statedRespondBy?: string }): { readonly respondBy: string } | { readonly problem: string } {
  if (!isIsoDate(input.receivedOn)) return { problem: 'the day the notice was received must be a date (YYYY-MM-DD)' };
  if (input.instrument === 'upi') return { respondBy: addDays(input.receivedOn, UPI_DISPUTE_RESPONSE_DAYS) };
  if (input.statedRespondBy === undefined || !isIsoDate(input.statedRespondBy)) return { problem: 'a card dispute needs the reply-by date the acquiring bank\'s notice states (respondBy, YYYY-MM-DD)' };
  if (input.statedRespondBy < input.receivedOn) return { problem: 'the reply-by date cannot be before the notice was received' };
  return { respondBy: input.statedRespondBy };
}

/** The compensating entry a lost dispute posts. */
export function lossEntryFor(d: Pick<DisputeRecord, 'disputeId' | 'saleId' | 'amountMinor'>, decidedOn: string): DisputeLossEntry {
  return {
    entryId: `dispute-loss-${d.disputeId}`, disputeId: d.disputeId, saleId: d.saleId, amountMinor: d.amountMinor, postedOn: decidedOn,
    lines: [{ account: 'chargeback_loss', debitMinor: d.amountMinor }, { account: 'card_upi_settlement_receivable', creditMinor: d.amountMinor }],
  };
}

/** Each dispute with its answer, its outcome and whether it is overdue at `asOf`. */
export function disputeViews(input: {
  readonly disputes: readonly DisputeRecord[];
  readonly responses: readonly DisputeResponse[];
  readonly outcomes: readonly DisputeOutcome[];
  readonly asOf: string;
}): readonly DisputeView[] {
  return input.disputes.map((d): DisputeView => {
    const response = input.responses.find((r) => r.disputeId === d.disputeId) ?? null;
    const outcome = input.outcomes.find((o) => o.disputeId === d.disputeId) ?? null;
    const state: DisputeState = outcome !== null ? outcome.outcome : response !== null ? 'answered' : 'open';
    const overdue = response === null && outcome === null && input.asOf > d.respondBy;
    return {
      ...d, state, response, outcome, overdue, daysOverdue: overdue ? daysBetween(d.respondBy, input.asOf) : 0,
      answeredLate: response !== null && response.respondedOn > d.respondBy,
    };
  }).sort((a, b) => a.respondBy.localeCompare(b.respondBy) || a.disputeId.localeCompare(b.disputeId));
}

export interface DisputeException {
  readonly disputeId: string;
  readonly instrument: DisputeInstrument;
  readonly amountMinor: number;
  readonly respondBy: string;
  readonly daysOverdue: number;
  readonly headline: string;
}

/** The OWNER's exceptions: every dispute not answered by its due date, most overdue first. */
export function disputeExceptions(views: readonly DisputeView[]): readonly DisputeException[] {
  return views.filter((v) => v.overdue).sort((a, b) => b.daysOverdue - a.daysOverdue || b.amountMinor - a.amountMinor)
    .map((v) => ({
      disputeId: v.disputeId, instrument: v.instrument, amountMinor: v.amountMinor, respondBy: v.respondBy, daysOverdue: v.daysOverdue,
      headline: `${v.instrument.toUpperCase()} dispute ${v.providerRef} for ₹${(v.amountMinor / 100).toFixed(2)} was due an answer by ${v.respondBy} — ${v.daysOverdue} day(s) late and still not answered`,
    }));
}
