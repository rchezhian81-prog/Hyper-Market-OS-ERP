// CARD AND UPI ATTEMPTS — written down before the machine is asked, recovered against the provider, used once
// (Wave 4 · audit PF-06 · M12-FR-03 · D04-FR-02 · §4.3 · hard rules #1, #2, #3, #6).
//
// The audit reproduced it: when the card machine did not answer, the till refused the sale and wrote NOTHING. If the
// machine had in fact taken the money, the shop had no record that it ever asked, the customer was charged for goods
// they did not get, and the next attempt could charge them again. Now, on this store computer's disk:
//
//   • BEFORE the cashier asks the machine, the attempt is recorded: which bill, card or UPI, how much, who. Its id is
//     the merchant reference the provider is given, so the provider's own record can be matched to it later — a
//     reference, never a card number (hard rule #3);
//   • what the machine said is recorded on it: approved, declined, or NO ANSWER;
//   • a no-answer is never settled by hand (the tested `recoverPendingTender` rule): only the provider's record settles
//     it, through the provider port. With no provider connected it stays unresolved — and VISIBLE — and the till will not
//     ask the machine again for that bill until it is resolved, because asking again is how a customer pays twice;
//   • a sale that says it was paid by card or UPI must carry an attempt this box recorded as paid, for that amount, on
//     this till — and each paid attempt pays ONE sale. A recovered payment the customer made with no sale to show for it
//     is listed as money owed back.
//
// OB-271 (owner, 21 Oct 2026) · audit A9: in REAL TRADING, with the shop's own standalone machine, "approved" carries the
// machine's own APPROVAL / REFERENCE number, typed by the cashier from the slip (`readMachineReference`, OB-274: 4–20 letters or
// digits, never card data). It is kept on the answer and must be on the sale's tender, so the day can be matched against
// the machine's settlement slip. Off (the mirror pilot, or not set): an approval number is optional, as before.
//
// Every line is appended, never rewritten (hard rule #2); nothing is deleted (hard rule #6).

import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import { recoverPendingTender, type ProviderAuthorisation } from '../../../packages/tender/src/pending-recovery';
import { looksLikeCardNumber } from '../../../packages/ops/src/index';
import { readMachineReference, MACHINE_REF_WORDS } from '../../../packages/tender/src/machine-reference';

export type AttemptKind = 'card' | 'upi';
export type AttemptState = 'asked' | 'approved' | 'declined' | 'no_answer' | 'recovered_paid' | 'recovered_not_paid';

/**
 * The payment provider's record for one merchant reference (the acquirer / UPI switch adapter). `statementComplete` is
 * load-bearing: nothing found on an INCOMPLETE record is not a decline. No live provider is connected in this build —
 * the port is where one plugs in (an external gate: credentials and certification).
 */
export interface PaymentProviderPort {
  lookup(reference: string): Promise<{ readonly authorisations: readonly ProviderAuthorisation[]; readonly statementComplete: boolean }>;
}

export interface Attempt {
  readonly attemptId: string;
  readonly laneId: string;
  readonly billRef: string;
  readonly kind: AttemptKind;
  readonly amountMinor: number;
  readonly askedBy: string;
  readonly askedAt: string;
  readonly state: AttemptState;
  readonly answeredBy?: string;
  readonly answeredAt?: string;
  /** OB-271: the approval / reference number the shop's own machine showed for an approved payment. */
  readonly machineRef?: string;
  readonly recoveredAt?: string;
  readonly recoveryDetail?: string;
  /** What the customer is owed back when the provider took more than the bill. */
  readonly owedToCustomerMinor?: number;
  readonly appliedToSaleId?: string;
}

type LogRecord =
  | { readonly kind: 'asked'; readonly attemptId: string; readonly laneId: string; readonly billRef: string; readonly tender: AttemptKind; readonly amountMinor: number; readonly by: string; readonly at: string }
  | { readonly kind: 'answered'; readonly attemptId: string; readonly outcome: 'approved' | 'declined' | 'no_answer'; readonly by: string; readonly at: string; readonly machineRef?: string }
  | { readonly kind: 'recovered'; readonly attemptId: string; readonly paid: boolean; readonly owedToCustomerMinor: number; readonly detail: string; readonly at: string }
  | { readonly kind: 'applied'; readonly attemptId: string; readonly saleId: string; readonly at: string };

export type AttemptAnswer =
  | { readonly ok: true; readonly attempt: Attempt; readonly laneMessage: string }
  | { readonly ok: false; readonly refusedBecause: string; readonly laneMessage: string; readonly attempt?: Attempt };

export type TenderCheck =
  | { readonly ok: true; readonly record: () => Promise<void> }
  | { readonly ok: false; readonly refusedBecause: string; readonly laneMessage: string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const PAID: readonly AttemptState[] = ['approved', 'recovered_paid'];

const UNRESOLVED_WORDS = 'The last card or UPI payment on this bill got no answer from the machine. Do not ask the machine again — check what happened to that payment first.';
const NO_PROVIDER = 'No payment provider is connected to this store computer, so the payment that got no answer cannot be checked here yet. It stays on the unresolved list. Do not run the card again — take cash, or ask the manager to check the machine\'s own report.';

export class PaymentAttempts {
  private readonly attempts = new Map<string, Attempt>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly unreadableRecords: number;

  private constructor(
    private readonly log: OpenFileLog,
    private readonly deps: { readonly provider: PaymentProviderPort | undefined; readonly now: () => string; readonly requireMachineRef: () => boolean },
    restored: readonly LogRecord[],
    unreadable: number,
  ) {
    this.unreadableRecords = unreadable;
    for (const r of restored) this.fold(r);
  }

  static async open(input: {
    readonly dataDir: string;
    readonly capacityBytes: number;
    readonly provider?: PaymentProviderPort;
    readonly now?: () => string;
    /** OB-271: read live — true in real trading, when an approved answer must carry the machine's number. Absent: never. */
    readonly requireMachineRef?: () => boolean;
  }): Promise<PaymentAttempts> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'payment-attempts.log' });
    const restored: LogRecord[] = [];
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        if (isObj(r) && isStr(r['attemptId']) && ['asked', 'answered', 'recovered', 'applied'].includes(r['kind'] as string)) restored.push(r as unknown as LogRecord);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new PaymentAttempts(log, { provider: input.provider, now: input.now ?? (() => new Date().toISOString()), requireMachineRef: input.requireMachineRef ?? (() => false) }, restored, unreadable);
  }

  private fold(r: LogRecord): void {
    if (r.kind === 'asked') {
      if (this.attempts.has(r.attemptId)) return;
      this.attempts.set(r.attemptId, { attemptId: r.attemptId, laneId: r.laneId, billRef: r.billRef, kind: r.tender, amountMinor: r.amountMinor, askedBy: r.by, askedAt: r.at, state: 'asked' });
      return;
    }
    const cur = this.attempts.get(r.attemptId);
    if (cur === undefined) return;
    if (r.kind === 'answered') {
      this.attempts.set(r.attemptId, { ...cur, state: r.outcome, answeredBy: r.by, answeredAt: r.at, ...(r.machineRef === undefined ? {} : { machineRef: r.machineRef }) });
    } else if (r.kind === 'recovered') {
      this.attempts.set(r.attemptId, {
        ...cur, state: r.paid ? 'recovered_paid' : 'recovered_not_paid', recoveredAt: r.at, recoveryDetail: r.detail,
        ...(r.owedToCustomerMinor > 0 ? { owedToCustomerMinor: r.owedToCustomerMinor } : {}),
      });
    } else if (cur.appliedToSaleId === undefined) {
      this.attempts.set(r.attemptId, { ...cur, appliedToSaleId: r.saleId });
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async record(r: LogRecord): Promise<void> {
    await this.log.append(JSON.stringify(r));
    this.fold(r);
  }

  /** Record the attempt BEFORE the machine is asked. Its id is the reference the provider gets. Refused while this bill has an unresolved no-answer. */
  ask(input: { readonly laneId: string; readonly by: string; readonly attemptId: unknown; readonly billRef: unknown; readonly kind: unknown; readonly amountMinor: unknown }): Promise<AttemptAnswer> {
    return this.serial(async () => {
      if (!isStr(input.attemptId) || !isStr(input.billRef) || (input.kind !== 'card' && input.kind !== 'upi')
        || typeof input.amountMinor !== 'number' || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
        return { ok: false, refusedBecause: 'attempt_not_readable', laneMessage: 'The till did not say which bill, how much and card or UPI. Nothing was recorded — do not ask the machine yet.' };
      }
      // A merchant reference, never card data (hard rule #3).
      if (looksLikeCardNumber(input.attemptId) || looksLikeCardNumber(input.billRef)) {
        return { ok: false, refusedBecause: 'reference_looks_like_card_data', laneMessage: 'That reference looks like a card number. Card numbers are never recorded. Nothing was recorded.' };
      }
      const existing = this.attempts.get(input.attemptId);
      if (existing !== undefined) {
        return existing.laneId === input.laneId && existing.billRef === input.billRef && existing.amountMinor === input.amountMinor && existing.kind === input.kind
          ? { ok: true, attempt: existing, laneMessage: 'Ask the customer to pay on the machine.' }
          : { ok: false, refusedBecause: 'attempt_id_reused', laneMessage: 'That payment reference is already used for something else. Nothing was recorded — try again.' };
      }
      const unresolved = [...this.attempts.values()].find((a) => a.laneId === input.laneId && a.billRef === input.billRef && a.state === 'no_answer');
      if (unresolved !== undefined) return { ok: false, refusedBecause: 'unresolved_payment_on_this_bill', laneMessage: UNRESOLVED_WORDS, attempt: unresolved };
      // A payment already confirmed for this bill and not yet used: use it — asking the machine again charges twice.
      const paidUnused = [...this.attempts.values()].find((a) => a.laneId === input.laneId && a.billRef === input.billRef && PAID.includes(a.state) && a.appliedToSaleId === undefined);
      if (paidUnused !== undefined) {
        return { ok: false, refusedBecause: 'already_paid_on_this_bill', laneMessage: 'This bill already has a payment the provider confirmed. Use it — do not ask the machine again.', attempt: paidUnused };
      }
      try {
        await this.record({ kind: 'asked', attemptId: input.attemptId, laneId: input.laneId, billRef: input.billRef, tender: input.kind, amountMinor: input.amountMinor, by: input.by, at: this.deps.now() });
      } catch (e) {
        return { ok: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not record the payment, so do not ask the machine. ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, attempt: this.attempts.get(input.attemptId)!, laneMessage: 'Ask the customer to pay on the machine.' };
    });
  }

  /** What the machine said. Recorded once; a different second answer is refused (the first is the evidence). */
  answer(input: { readonly laneId: string; readonly by: string; readonly attemptId: unknown; readonly outcome: unknown; readonly machineRef?: unknown }): Promise<AttemptAnswer> {
    return this.serial(async () => {
      const a = isStr(input.attemptId) ? this.attempts.get(input.attemptId) : undefined;
      if (a === undefined || a.laneId !== input.laneId) return { ok: false, refusedBecause: 'attempt_unknown', laneMessage: 'This store computer has no record of asking the machine for that payment.' };
      if (input.outcome !== 'approved' && input.outcome !== 'declined' && input.outcome !== 'no_answer') {
        return { ok: false, refusedBecause: 'outcome_not_readable', laneMessage: 'Say what the machine said: approved, declined, or no answer.' };
      }
      // OB-271 · audit A9: an approved payment's number from the machine — required in real trading, read (never card data,
      // never repeated back) whenever it is given. Declined and no-answer keep none.
      let machineRef: string | undefined;
      if (input.outcome === 'approved' && (this.deps.requireMachineRef() || (input.machineRef !== undefined && input.machineRef !== ''))) {
        const read = readMachineReference(input.machineRef);
        if (!read.ok) return { ok: false, refusedBecause: read.refusedBecause, laneMessage: `${read.laneMessage} Nothing was recorded yet — the payment is still waiting for its answer.` };
        machineRef = read.value;
      }
      if (a.state !== 'asked') {
        return a.state === input.outcome && (machineRef === undefined || a.machineRef === machineRef)
          ? { ok: true, attempt: a, laneMessage: 'Already recorded.' }
          : { ok: false, refusedBecause: 'already_answered', laneMessage: `This payment was already recorded as ${a.state.replace(/_/g, ' ')}. That record stands.`, attempt: a };
      }
      try {
        await this.record({ kind: 'answered', attemptId: a.attemptId, outcome: input.outcome, by: input.by, at: this.deps.now(), ...(machineRef === undefined ? {} : { machineRef }) });
      } catch (e) {
        return { ok: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not record what the machine said. ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, attempt: this.attempts.get(a.attemptId)!, laneMessage: input.outcome === 'no_answer' ? UNRESOLVED_WORDS : 'Recorded.' };
    });
  }

  /** Settle a no-answer against the PROVIDER'S record — never by hand. Unknown stays unknown, and says so. */
  recover(input: { readonly laneId: string; readonly attemptId: unknown; readonly allowAsked?: boolean }): Promise<AttemptAnswer> {
    return this.serial(async () => {
      const a = isStr(input.attemptId) ? this.attempts.get(input.attemptId) : undefined;
      if (a === undefined || a.laneId !== input.laneId) return { ok: false, refusedBecause: 'attempt_unknown', laneMessage: 'This store computer has no record of that payment.' };
      // OB-55: a payment carried forward at the day close while still `asked` (no answer was ever recorded) is settled by
      // the provider's record too — the box allows it only for a carried payment (`allowAsked`), never by hand.
      if (a.state !== 'no_answer' && !(input.allowAsked === true && a.state === 'asked')) return { ok: true, attempt: a, laneMessage: `This payment is already ${a.state.replace(/_/g, ' ')}.` };
      if (this.deps.provider === undefined) return { ok: false, refusedBecause: 'no_provider_connected', laneMessage: NO_PROVIDER, attempt: a };
      let evidence: Awaited<ReturnType<PaymentProviderPort['lookup']>>;
      try {
        evidence = await this.deps.provider.lookup(a.attemptId);
      } catch {
        return { ok: false, refusedBecause: 'provider_unreachable', laneMessage: 'The payment provider could not be reached. The payment stays unresolved — do not run the card again; try the check later.', attempt: a };
      }
      const at = this.deps.now();
      const ruling = recoverPendingTender({
        tender: { tenderId: a.attemptId, saleId: a.billRef, laneId: a.laneId, kind: a.kind, providerRef: a.attemptId, amountMinor: a.amountMinor, currency: 'INR', capturedAt: a.askedAt },
        authorisations: evidence.authorisations, statementComplete: evidence.statementComplete, at,
      });
      if (!ruling.resolved) return { ok: false, refusedBecause: 'still_unknown', laneMessage: `${ruling.detail}. The payment stays unresolved — do not run the card again.`, attempt: a };
      const paid = ruling.outcome === 'confirmed_paid' || ruling.outcome === 'paid_more_than_once';
      try {
        await this.record({ kind: 'recovered', attemptId: a.attemptId, paid, owedToCustomerMinor: ruling.owedBy === 'customer' ? ruling.owedMinor : 0, detail: ruling.detail, at });
      } catch (e) {
        return { ok: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not record the result. ${e instanceof Error ? e.message : String(e)}`, attempt: a };
      }
      const now = this.attempts.get(a.attemptId)!;
      return {
        ok: true, attempt: now,
        laneMessage: paid
          ? `The provider confirms the customer paid${now.owedToCustomerMinor !== undefined ? ' — more than once; the extra is owed back to them' : ''}. Use this payment for the bill — do not charge again.`
          : 'The provider confirms this payment did not go through. The customer can pay again.',
      };
    });
  }

  /**
   * Before a sale reaches the disk: each card/UPI tender must name an attempt this box recorded as paid, on this till,
   * for that amount, not already used by another sale. On `ok`, call `record()` once the sale is on the disk.
   */
  checkTenders(input: { readonly laneId: string; readonly saleId: string; readonly tenders: unknown }): TenderCheck {
    const tenders = Array.isArray(input.tenders) ? input.tenders : [];
    const uses: Attempt[] = [];
    for (const t of tenders) {
      if (!isObj(t) || (t['kind'] !== 'card' && t['kind'] !== 'upi')) continue;
      const ref = t['ref'];
      const amount = typeof t['amountMinor'] === 'number' ? t['amountMinor'] : isObj(t['amount']) ? t['amount']['minor'] : undefined;
      const a = isStr(ref) ? this.attempts.get(ref) : undefined;
      if (a === undefined || a.laneId !== input.laneId) {
        return { ok: false, refusedBecause: 'card_payment_not_recorded', laneMessage: 'This card or UPI payment was not recorded on this store computer before the machine was asked. Nothing was saved — take the payment again through the till.' };
      }
      if (!PAID.includes(a.state)) {
        return { ok: false, refusedBecause: 'card_payment_not_paid', laneMessage: `This card or UPI payment is ${a.state.replace(/_/g, ' ')}, not paid. Nothing was saved — do not hand over the goods.` };
      }
      if (amount !== a.amountMinor) {
        return { ok: false, refusedBecause: 'card_payment_amount_differs', laneMessage: 'The amount on the bill is not the amount the machine was asked for. Nothing was saved — take the payment again.' };
      }
      if (a.appliedToSaleId !== undefined && a.appliedToSaleId !== input.saleId) {
        return { ok: false, refusedBecause: 'card_payment_already_used', laneMessage: 'That card or UPI payment already paid another bill. Nothing was saved — one payment pays one bill.' };
      }
      // OB-271 · audit A9: the sale's tender carries the SAME machine number this box recorded for the payment — and in real
      // trading an approved payment has one.
      const tenderRef = t['machineRef'];
      if (a.machineRef !== undefined ? tenderRef !== a.machineRef : tenderRef !== undefined) {
        return { ok: false, refusedBecause: 'card_payment_reference_differs', laneMessage: 'The approval number on the bill is not the one recorded for this payment. Nothing was saved — take the payment again through the till.' };
      }
      if (this.deps.requireMachineRef() && a.state === 'approved' && a.machineRef === undefined) {
        return { ok: false, refusedBecause: 'machine_ref_missing', laneMessage: `${MACHINE_REF_WORDS.missing} Nothing was saved.` };
      }
      uses.push(a);
    }
    return {
      ok: true,
      record: async () => {
        for (const a of uses) {
          if (this.attempts.get(a.attemptId)?.appliedToSaleId === input.saleId) continue;
          await this.record({ kind: 'applied', attemptId: a.attemptId, saleId: input.saleId, at: this.deps.now() });
        }
      },
    };
  }

  /** The till's account: payments still unresolved, and payments made with no sale to show for them (owed back). */
  status(laneId: string): { readonly unresolved: readonly Attempt[]; readonly paidWithoutSale: readonly Attempt[]; readonly owedToCustomers: readonly Attempt[] } {
    const mine = [...this.attempts.values()].filter((a) => a.laneId === laneId);
    return {
      unresolved: mine.filter((a) => a.state === 'no_answer'),
      paidWithoutSale: mine.filter((a) => PAID.includes(a.state) && a.appliedToSaleId === undefined),
      owedToCustomers: mine.filter((a) => a.owedToCustomerMinor !== undefined),
    };
  }

  /** OB-271 · audit A9: this till's payments recorded as paid (approved, or confirmed by the provider), oldest first. */
  paid(laneId: string): readonly Attempt[] {
    return [...this.attempts.values()].filter((a) => a.laneId === laneId && PAID.includes(a.state)).sort((x, y) => x.askedAt.localeCompare(y.askedAt));
  }

  /**
   * Every attempt on this box, on any till, that still has NO final answer: asked and never answered, or no answer and
   * not yet settled by the provider (D04-FR-02 · WF-12). The day close reads this — the day's takings are not known
   * while one is open, so the day does not lock over it.
   */
  pending(): readonly Attempt[] {
    return [...this.attempts.values()].filter((a) => a.state === 'asked' || a.state === 'no_answer');
  }

  /** One attempt as this box holds it (OB-55: the late-answer guard reads when it was asked). */
  get(attemptId: unknown): Attempt | undefined {
    return isStr(attemptId) ? this.attempts.get(attemptId) : undefined;
  }

  /** The unresolved attempt on this bill, if any — the till asks before it offers the machine again. */
  unresolvedOn(laneId: string, billRef: string): Attempt | undefined {
    return [...this.attempts.values()].find((a) => a.laneId === laneId && a.billRef === billRef && a.state === 'no_answer');
  }

  async close(): Promise<void> {
    await this.log.close();
  }
}
