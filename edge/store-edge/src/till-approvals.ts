// A MANAGER'S APPROVAL AT THE TILL — the manager's own act, issued and spent by this store computer, offline
// (ADR-0021 · Wave 2b-v-b · audit PF-02 · M13-FR-01/03 · §28 · hard rules #1, #6).
//
// Before this, a manager "approved" a refund by having their staff code typed; the name went onto the refund record and
// nothing proved the manager was there, or stopped one name approving any number of refunds. Now:
//
//   • the cashier's till asks THIS register for an approval, with the manager's staff ID and their own till PIN (checked
//     by `TillOperators.verifyPerson`, sharing sign-in's guess limits), saying what it is for — the kind, the bill, the
//     amount — and why;
//   • the register refuses unless the asker is the live session on this till, the manager is someone else (§28), the PIN
//     matches and the manager holds `pos.return.approve` in the pack; otherwise it issues an approval bound to that kind,
//     bill, amount, cashier and till, for five minutes;
//   • when the refund record reaches the box, `checkReturn` refuses it before the disk unless no approval is needed (the
//     pack's threshold) or it carries an approval issued here that matches it and was not used by a DIFFERENT refund —
//     and spends it. The same refund re-sent after a lost reply is the same use.
//
// Every approval given and spent is on an fsync'd log, folded at start; a PIN is never written.

import { randomBytes } from 'node:crypto';
import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import type { CheckOutcome, CheckRefusal, SignInRefusal } from './till-operators';
import { judgeTillOverride, overrideReductionMinor, readTillControls, type TillOverrideRefusal } from '../../../packages/price-guard/src/till-override';

/** The permission a manager needs to approve a refund at the till — the one head office re-checks on every synced refund. */
export const APPROVAL_AUTHORITY = 'pos.return.approve';
export const APPROVAL_MINUTES = 5;

/**
 * The permission a manager needs to approve a SUPERVISOR OVERRIDE at the till — opening the drawer with no sale, or
 * changing a line's price (audit PF-07 · M12-FR-04 "override by Supervisor authority; cashier cannot self-override").
 */
export const OVERRIDE_AUTHORITY = 'pos.override.approve';

/**
 * What an approval is for. A refund and an exchange's refunded difference are against a bill; a no-receipt return is
 * not. A no-sale (the drawer opened with no sale) is against no bill and moves no value; a price override is against
 * the bill, for the amount it takes off the line (audit PF-07).
 */
export type ApprovalKind = 'refund' | 'no_receipt_return' | 'exchange_refund' | 'no_sale' | 'price_override'
  /** OB-55 / PF-06: the machine's answer for a card/UPI attempt of an EARLIER trading day, typed in late — a manager's
   *  approval for exactly that attempt (`billRef` = the attempt id) and its amount. */
  | 'late_payment_answer'
  /** OB-271 · audit A11: a card/UPI refund DONE on the shop's own machine (`billRef` = the refund's id), for its amount — a
   *  second person confirms it with their own PIN before it is recorded as paid out. */
  | 'card_refund_on_machine'
  /** OB-55: a second person's approval to close the day with named card/UPI payments carried forward. Issued and spent
   *  only by `approveDayCloseException` — never through `grant` (it is not in KINDS). */
  | 'day_close_exception';
/** OB-55: who may approve closing the day with pending payments carried forward — the day-close approval authority. */
export const DAY_CLOSE_EXCEPTION_AUTHORITY = 'till.dayclose.approve';
const KINDS: readonly ApprovalKind[] = ['refund', 'no_receipt_return', 'exchange_refund', 'no_sale', 'price_override', 'late_payment_answer', 'card_refund_on_machine'];
/** The overrides (PF-07): approved by `OVERRIDE_AUTHORITY`, spent by the till action they were given for. */
export const OVERRIDE_KINDS: readonly ApprovalKind[] = ['no_sale', 'price_override'];

export type ApprovalRefusal =
  | SignInRefusal
  | CheckRefusal
  | 'self_approval' | 'approval_not_readable'
  | 'approval_required' | 'approval_unknown' | 'approval_expired' | 'approval_already_used' | 'approval_does_not_match'
  /** OB-500: a price cut below the product's floor, or beyond the approving manager's limit (or with no rules on the box). */
  | TillOverrideRefusal
  /** OB-500: the till's figures for a price cut do not agree with what this box works out (the amount, or the line's first price). */
  | 'cut_does_not_match';

/** OB-500: the words when the till's figures for a price cut disagree with this store computer's own (English and Tamil). */
const CUT_DOES_NOT_MATCH = {
  en: 'The till\'s figures for this price cut do not agree with what the store computer works out from the line\'s first price, the new price and the quantity. Nothing was changed — the price stays as it was. Void the line, ring it again, and ask again.',
  ta: 'இந்த விலைக் குறைப்புக்கான பில்லிங் இயந்திரத்தின் கணக்கு, வரியின் முதல் விலை, புதிய விலை மற்றும் எண்ணிக்கையிலிருந்து கடைக் கணினி கணக்கிடுவதுடன் பொருந்தவில்லை. எதுவும் மாற்றப்படவில்லை — விலை முன்பு இருந்தபடியே உள்ளது. வரியை ரத்து செய்து, மீண்டும் சேர்த்து, மீண்டும் கேளுங்கள்.',
} as const;

const WORDS: Readonly<Record<'self_approval' | 'approval_not_readable' | 'approval_required' | 'approval_unknown' | 'approval_expired' | 'approval_already_used' | 'approval_does_not_match', string>> = {
  self_approval: 'A refund must be approved by a manager who is not the person at the till. Ask another manager.',
  approval_not_readable: 'The approval needs the manager\'s staff ID, their six-digit till PIN, what is being refunded and why.',
  approval_required: 'This refund needs a manager\'s approval on this till. Nothing was saved — ask a manager to approve it with their PIN.',
  approval_unknown: 'This store computer did not give that approval. Nothing was saved — ask a manager to approve it with their PIN.',
  approval_expired: 'The manager\'s approval has expired (five minutes). Nothing was saved — ask the manager to approve it again.',
  approval_already_used: 'That approval was already used for another refund. Nothing was saved — ask the manager to approve this one.',
  approval_does_not_match: 'The manager approved a different refund (another bill, amount or cashier). Nothing was saved — ask the manager to approve this one.',
};

export type GrantOutcome =
  | { readonly approved: true; readonly approvalId: string; readonly approvedBy: string; readonly displayName: string; readonly expiresAt: string }
  | { readonly approved: false; readonly refusedBecause: ApprovalRefusal; readonly laneMessage: string; readonly laneMessageTa?: string };

export type ReturnCheck =
  | { readonly ok: true; readonly stamp?: { readonly approvalId: string; readonly approvedBy: string } }
  | { readonly ok: false; readonly refusedBecause: ApprovalRefusal; readonly laneMessage: string };

/** What a refund record is, for the purpose of approving it — read from the record the till posted. */
export interface ApprovalSubject { readonly kind: ApprovalKind; readonly billRef: string | null; readonly valueMinor: number }

interface Granted {
  readonly approvalId: string; readonly kind: ApprovalKind; readonly billRef: string | null; readonly valueMinor: number;
  readonly requestedBy: string; readonly approvedBy: string; readonly laneId: string; readonly reason: string;
  readonly at: string; readonly expiresAt: string;
  /** OB-500: a price cut is approved for exactly this product and this new unit price — spent only by that change. */
  readonly productId?: string; readonly toUnitMinor?: number;
  /** OB-500: the line, its FIRST price (before any cut) and its quantity the cut was judged on — spent only by that line. */
  readonly lineId?: string; readonly fromUnitMinor?: number; readonly quantityMinor?: number;
}
type LogRecord =
  | ({ readonly kind: 'granted' } & Omit<Granted, 'kind'> & { readonly subjectKind: ApprovalKind })
  | { readonly kind: 'used'; readonly at: string; readonly approvalId: string; readonly usedBy: string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * What the record asks to be approved for, and whether it must be: an exchange's refunded difference, a return without a
 * receipt (always), or a refund against a bill at or above the shop's threshold (`refundRequiresApproval`'s rule).
 */
export function approvalSubjectOf(record: unknown, approvalThresholdMinor: number): { readonly subject: ApprovalSubject | null; readonly required: boolean } {
  const r = isObj(record) ? record : {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
  if (r['refundTender'] === 'exchange') {
    const ex = isObj(r['exchange']) ? r['exchange'] : {};
    if (ex['balance'] !== 'refund') return { subject: null, required: false };
    const value = num(ex['balanceMinor']);
    return { subject: { kind: 'exchange_refund', billRef: isStr(r['originalSaleId']) ? r['originalSaleId'] : null, valueMinor: value }, required: value > 0 && value >= approvalThresholdMinor };
  }
  const value = num(r['refundMinor']);
  if (r['noReceipt'] === true) return { subject: { kind: 'no_receipt_return', billRef: null, valueMinor: value }, required: true };
  return { subject: { kind: 'refund', billRef: isStr(r['originalSaleId']) ? r['originalSaleId'] : null, valueMinor: value }, required: value > 0 && value >= approvalThresholdMinor };
}

export class TillApprovals {
  private readonly granted = new Map<string, Granted>();
  private readonly usedBy = new Map<string, string>();
  readonly unreadableRecords: number;

  private constructor(
    private readonly log: OpenFileLog,
    private readonly deps: {
      readonly operators: {
        check(token: string | undefined, laneId: string): CheckOutcome;
        verifyPerson(input: { staffId: string; pin: string; laneId: string; authority: string }): Promise<
          { ok: true; userId: string; displayName: string } | { ok: false; refusedBecause: SignInRefusal; laneMessage: string }
        >;
      };
      /** The shop's approval threshold from the CURRENT pack; `null` when the pack holds no service policy (then every refund needs one). */
      readonly approvalThresholdMinor: () => number | null;
      /**
       * OB-500: the CURRENT pack's `tillControls` section (floors and price-cut limits), or undefined when the pack does not
       * carry it — then no price cut is approved. Left out of the composition only by tests that do not judge price cuts.
       */
      readonly tillControls?: () => unknown;
      /** OB-500: the product's unit of measure from THIS box's pack — so a weighed line's cut is priced as the till prices it. */
      readonly uomOf?: (productId: string) => string | undefined;
      readonly now: () => string;
    },
    restored: readonly LogRecord[],
    unreadable: number,
  ) {
    this.unreadableRecords = unreadable;
    for (const r of restored) this.fold(r);
  }

  static async open(input: {
    readonly dataDir: string;
    readonly capacityBytes: number;
    readonly operators: TillApprovals['deps']['operators'];
    readonly approvalThresholdMinor: () => number | null;
    readonly tillControls?: () => unknown;
    readonly uomOf?: (productId: string) => string | undefined;
    readonly now?: () => string;
  }): Promise<TillApprovals> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'till-approvals.log' });
    const restored: LogRecord[] = [];
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        if (isObj(r) && (r['kind'] === 'granted' || r['kind'] === 'used') && isStr(r['approvalId'])) restored.push(r as unknown as LogRecord);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new TillApprovals(log, {
      operators: input.operators, approvalThresholdMinor: input.approvalThresholdMinor,
      ...(input.tillControls === undefined ? {} : { tillControls: input.tillControls }),
      ...(input.uomOf === undefined ? {} : { uomOf: input.uomOf }), now: input.now ?? (() => new Date().toISOString()),
    }, restored, unreadable);
  }

  private fold(r: LogRecord): void {
    if (r.kind === 'granted') {
      this.granted.set(r.approvalId, {
        approvalId: r.approvalId, kind: r.subjectKind, billRef: r.billRef, valueMinor: r.valueMinor, requestedBy: r.requestedBy,
        approvedBy: r.approvedBy, laneId: r.laneId, reason: r.reason, at: r.at, expiresAt: r.expiresAt,
        ...(typeof r.productId === 'string' ? { productId: r.productId } : {}), ...(typeof r.toUnitMinor === 'number' ? { toUnitMinor: r.toUnitMinor } : {}),
        ...(typeof r.lineId === 'string' ? { lineId: r.lineId } : {}), ...(typeof r.fromUnitMinor === 'number' ? { fromUnitMinor: r.fromUnitMinor } : {}),
        ...(typeof r.quantityMinor === 'number' ? { quantityMinor: r.quantityMinor } : {}),
      });
    } else if (!this.usedBy.has(r.approvalId)) this.usedBy.set(r.approvalId, r.usedBy);
  }

  private async record(r: LogRecord): Promise<void> {
    await this.log.append(JSON.stringify(r));
    this.fold(r);
  }

  /** The shop's threshold, or 0 (every refund needs a manager) when the box holds no service policy — as the till does. */
  threshold(): number {
    return this.deps.approvalThresholdMinor() ?? 0;
  }

  /** A manager approves, at this till, with their own PIN. Nothing is spent here; the refund spends it at the disk. */
  async grant(input: {
    readonly token: string | undefined; readonly laneId: string;
    readonly managerId: string; readonly pin: string;
    readonly kind: unknown; readonly billRef: unknown; readonly valueMinor: unknown; readonly reason: unknown;
    /** OB-500: for a price cut — the product and the new unit price the manager approves. */
    readonly productId?: unknown; readonly toUnitMinor?: unknown;
    /** OB-500: and the line, its FIRST price (before any cut), its quantity and unit — this box works out the cut itself. */
    readonly lineId?: unknown; readonly fromUnitMinor?: unknown; readonly quantityMinor?: unknown; readonly uom?: unknown;
  }): Promise<GrantOutcome> {
    const refuse = (refusedBecause: ApprovalRefusal, laneMessage: string, laneMessageTa?: string): GrantOutcome => ({ approved: false, refusedBecause, laneMessage, ...(laneMessageTa === undefined ? {} : { laneMessageTa }) });
    const asker = this.deps.operators.check(input.token, input.laneId);
    if (!asker.ok) return refuse(asker.refusedBecause, asker.laneMessage);
    const kind = KINDS.find((k) => k === input.kind);
    // A no-sale moves no value (0, and nothing else); every other approval is for a positive amount.
    const valueMinor = kind === 'no_sale'
      ? (input.valueMinor === undefined || input.valueMinor === 0 ? 0 : undefined)
      : typeof input.valueMinor === 'number' && Number.isSafeInteger(input.valueMinor) && input.valueMinor > 0 ? input.valueMinor : undefined;
    const billRef = isStr(input.billRef) ? input.billRef.trim() : null;
    const managerId = input.managerId.trim();
    if (kind === undefined || valueMinor === undefined || !isStr(input.reason) || managerId === '' || (kind !== 'no_receipt_return' && kind !== 'no_sale' && billRef === null)) {
      return refuse('approval_not_readable', WORDS.approval_not_readable);
    }
    // §28: never the person asking. Said before the PIN is even looked at, so a cashier learns nothing by trying.
    if (managerId === asker.userId) return refuse('self_approval', WORDS.self_approval);
    // OB-500: a price cut is judged by the shop's own rules from THIS box's signed pack — the floor before any PIN is looked at.
    const cut = kind === 'price_override' && this.deps.tillControls !== undefined ? this.priceCutOf(input) : undefined;
    if (cut !== undefined && !cut.readable) return refuse('approval_not_readable', 'A price change approval needs the line, its first price, its quantity, the product and the new price. Nothing was changed.');
    const controls = cut === undefined ? undefined : readTillControls(this.deps.tillControls?.());
    if (cut?.readable === true) {
      const floor = judgeTillOverride({ controls, productId: cut.productId, toUnitMinor: cut.toUnitMinor, reductionMinor: 0, approverId: '' });
      if (!floor.ok) return refuse(floor.refusedBecause, floor.words.en, floor.words.ta);
      // A line already cut on this bill is measured from its FIRST price — the one its first cut here named — so a second
      // cut is judged on everything taken off the line, never on the step from a price already cut.
      const first = this.firstCutOn(billRef, input.laneId, cut.lineId);
      if (first !== undefined && first !== cut.fromUnitMinor) return refuse('cut_does_not_match', CUT_DOES_NOT_MATCH.en, CUT_DOES_NOT_MATCH.ta);
    }
    const authority = OVERRIDE_KINDS.includes(kind) ? OVERRIDE_AUTHORITY : APPROVAL_AUTHORITY;
    const manager = await this.deps.operators.verifyPerson({ staffId: managerId, pin: input.pin, laneId: input.laneId, authority });
    if (!manager.ok) return refuse(manager.refusedBecause, manager.laneMessage);
    // OB-500: and the approving manager's own price-cut limit, for what the cut takes off the WHOLE line from its first
    // price — this box's own figure from the first price, the new price and the quantity, never the amount the till sent.
    if (cut?.readable === true) {
      const judged = judgeTillOverride({ controls, productId: cut.productId, toUnitMinor: cut.toUnitMinor, reductionMinor: cut.reductionMinor, approverId: manager.userId, approverName: manager.displayName });
      if (!judged.ok) return refuse(judged.refusedBecause, judged.words.en, judged.words.ta);
      // Within the rules on this box's own figure — but a till that said a different amount is not given an approval for it.
      if (valueMinor !== cut.reductionMinor) return refuse('cut_does_not_match', CUT_DOES_NOT_MATCH.en, CUT_DOES_NOT_MATCH.ta);
    }
    const nowMs = Date.parse(this.deps.now());
    const approvalId = `apr-${randomBytes(12).toString('hex')}`;
    const expiresAt = new Date(nowMs + APPROVAL_MINUTES * 60_000).toISOString();
    await this.record({
      kind: 'granted', approvalId, subjectKind: kind, billRef: kind === 'no_receipt_return' || kind === 'no_sale' ? null : billRef, valueMinor,
      requestedBy: asker.userId, approvedBy: manager.userId, laneId: input.laneId, reason: String(input.reason).trim().slice(0, 200),
      at: new Date(nowMs).toISOString(), expiresAt,
      ...(cut?.readable === true ? { productId: cut.productId, toUnitMinor: cut.toUnitMinor, lineId: cut.lineId, fromUnitMinor: cut.fromUnitMinor, quantityMinor: cut.quantityMinor } : {}),
    });
    return { approved: true, approvalId, approvedBy: manager.userId, displayName: manager.displayName, expiresAt };
  }

  /**
   * OB-500: the price cut a request names, read defensively off the till's request — the product, the line, its FIRST price,
   * the new price and the quantity — and what it takes off the line, worked out HERE (the pack's unit of measure for the
   * product when this box knows it, so a weighed line is priced as the till prices it).
   */
  private priceCutOf(input: { readonly productId?: unknown; readonly toUnitMinor?: unknown; readonly lineId?: unknown; readonly fromUnitMinor?: unknown; readonly quantityMinor?: unknown; readonly uom?: unknown }):
    { readonly readable: true; readonly productId: string; readonly lineId: string; readonly toUnitMinor: number; readonly fromUnitMinor: number; readonly quantityMinor: number; readonly reductionMinor: number }
    | { readonly readable: false } {
    const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    const productId = isStr(input.productId) ? input.productId.trim() : undefined;
    const lineId = isStr(input.lineId) ? input.lineId.trim() : undefined;
    const { toUnitMinor: to, fromUnitMinor: from, quantityMinor: qty } = input;
    if (productId === undefined || lineId === undefined || !whole(to) || !whole(from) || to >= from || !whole(qty) || qty <= 0) return { readable: false };
    const uom = this.deps.uomOf?.(productId) ?? (isStr(input.uom) ? input.uom.trim() : undefined);
    if (uom === undefined) return { readable: false };
    return { readable: true, productId, lineId, toUnitMinor: to, fromUnitMinor: from, quantityMinor: qty, reductionMinor: overrideReductionMinor(from, to, qty, uom) };
  }

  /** OB-500: the first price the earliest price cut approved here for this line of this bill named, if any. */
  private firstCutOn(billRef: string | null, laneId: string, lineId: string): number | undefined {
    for (const g of this.granted.values()) {
      if (g.kind === 'price_override' && g.billRef === billRef && g.laneId === laneId && g.lineId === lineId && g.fromUnitMinor !== undefined) return g.fromUnitMinor;
    }
    return undefined;
  }

  /**
   * Is this refund record allowed onto the disk, as far as its approval goes? Spends the approval it carries (once, by
   * this refund). `requestedBy` is the person the box verified at the till; `returnId` is the refund's own id.
   */
  async checkReturn(input: { readonly record: unknown; readonly requestedBy: string; readonly laneId: string; readonly returnId: string }): Promise<ReturnCheck> {
    const r = isObj(input.record) ? input.record : {};
    const { subject, required } = approvalSubjectOf(r, this.threshold());
    const fail = (refusedBecause: keyof typeof WORDS): ReturnCheck => ({ ok: false, refusedBecause, laneMessage: WORDS[refusedBecause] });
    const approvalId = isStr(r['approvalId']) ? r['approvalId'] : undefined;
    const named = isStr(r['approvedBy']) ? r['approvedBy'] : undefined;
    if (approvalId === undefined) {
      // A name typed into the record with nothing this box issued behind it is not an approval (ADR-0021 §4).
      if (named !== undefined || required) return fail('approval_required');
      return { ok: true };
    }
    const g = this.granted.get(approvalId);
    if (g === undefined) return fail('approval_unknown');
    const already = this.usedBy.get(approvalId);
    if (already !== undefined && already !== input.returnId) return fail('approval_already_used');
    if (already === undefined && Date.parse(g.expiresAt) <= Date.parse(this.deps.now())) return fail('approval_expired');
    if (subject === null || g.kind !== subject.kind || g.billRef !== subject.billRef || g.valueMinor !== subject.valueMinor
      || g.requestedBy !== input.requestedBy || g.laneId !== input.laneId || (named !== undefined && named !== g.approvedBy)) {
      return fail('approval_does_not_match');
    }
    if (already === undefined) await this.record({ kind: 'used', at: this.deps.now(), approvalId, usedBy: input.returnId });
    return { ok: true, stamp: { approvalId, approvedBy: g.approvedBy } };
  }

  /**
   * OB-55 "A": a SECOND person approves, with their own staff ID and till PIN on this store computer (offline), closing the
   * day with the named card/UPI payments carried forward to head office. Issued and spent in one step by the close it is for
   * (`dayCloseId`), bound to the closer, the attempts it names and their total — one use. The same close asked again
   * re-uses its own approval (a lost reply), never a second one. Never the closer (§28); the approver must hold
   * `till.dayclose.approve`. A PIN is never written.
   */
  async approveDayCloseException(input: {
    readonly dayCloseId: string; readonly closerId: string; readonly laneId: string;
    readonly approverId: string; readonly approverPin: string; readonly reason: string;
    readonly attemptIds: readonly string[]; readonly valueMinor: number;
  }): Promise<{ readonly ok: true; readonly approvalId: string; readonly approvedBy: string } | { readonly ok: false; readonly refusedBecause: string; readonly laneMessage: string }> {
    const approverId = input.approverId.trim();
    if (approverId === '' || input.approverPin === '' || input.reason.trim() === '' || input.attemptIds.length === 0) {
      return { ok: false, refusedBecause: 'approval_not_readable', laneMessage: 'The second person must give their staff ID and their own till PIN, with a reason.' };
    }
    if (approverId === input.closerId) {
      return { ok: false, refusedBecause: 'self_approval', laneMessage: 'A second person must approve closing with a payment carried forward — never the person closing the day.' };
    }
    const who = await this.deps.operators.verifyPerson({ staffId: approverId, pin: input.approverPin, laneId: input.laneId, authority: DAY_CLOSE_EXCEPTION_AUTHORITY });
    if (!who.ok) return { ok: false, refusedBecause: who.refusedBecause, laneMessage: who.laneMessage };
    const billRef = `${input.dayCloseId}|${[...input.attemptIds].sort().join(',')}`;
    // The same close asked again (a lost reply) re-uses ITS approval: one approval per close, spent by that close.
    for (const g of this.granted.values()) {
      if (g.kind === 'day_close_exception' && this.usedBy.get(g.approvalId) === input.dayCloseId) {
        if (g.billRef === billRef && g.approvedBy === who.userId && g.requestedBy === input.closerId && g.valueMinor === input.valueMinor) {
          return { ok: true, approvalId: g.approvalId, approvedBy: g.approvedBy };
        }
        return { ok: false, refusedBecause: 'approval_already_used', laneMessage: 'This close already has a different approval. Nothing was done — start the close again.' };
      }
    }
    const at = this.deps.now();
    const approvalId = `apr-${randomBytes(12).toString('hex')}`;
    await this.record({
      kind: 'granted', approvalId, subjectKind: 'day_close_exception', billRef, valueMinor: input.valueMinor,
      requestedBy: input.closerId, approvedBy: who.userId, laneId: input.laneId, reason: input.reason.trim().slice(0, 200),
      at, expiresAt: at,
    });
    await this.record({ kind: 'used', at, approvalId, usedBy: input.dayCloseId });
    return { ok: true, approvalId, approvedBy: who.userId };
  }

  /**
   * Spend an approval on a SUPERVISOR OVERRIDE (audit PF-07): a no-sale or a price override, by the till action
   * `activityId`. It must have been issued here, for this kind, bill and amount, to this cashier on this till, not
   * expired, and not spent by a DIFFERENT action — the same action re-sent after a lost reply is the same use. An
   * override always needs one: there is no threshold below which a cashier overrides alone (§28).
   */
  async spendOverride(input: {
    readonly approvalId: unknown; readonly kind: 'no_sale' | 'price_override' | 'late_payment_answer' | 'card_refund_on_machine'; readonly billRef: string | null; readonly valueMinor: number;
    readonly requestedBy: string; readonly laneId: string; readonly activityId: string;
    /** OB-500: the product and new unit price the price change applies — must be the ones approved. */
    readonly productId?: string; readonly toUnitMinor?: number;
    /** OB-500: and the line, its first price and its quantity — must be the ones the cut was judged on. */
    readonly lineId?: string; readonly fromUnitMinor?: number; readonly quantityMinor?: number;
  }): Promise<ReturnCheck> {
    const say: Record<'approval_required' | 'approval_unknown' | 'approval_expired' | 'approval_already_used' | 'approval_does_not_match', string> = {
      approval_required: 'This needs a manager\'s approval on this till. Nothing was done — ask a manager to approve it with their PIN.',
      approval_unknown: 'This store computer did not give that approval. Nothing was done — ask a manager to approve it with their PIN.',
      approval_expired: 'The manager\'s approval has expired (five minutes). Nothing was done — ask the manager to approve it again.',
      approval_already_used: 'That approval was already used. Nothing was done — ask the manager to approve this one.',
      approval_does_not_match: 'The manager approved something else (another bill, amount, cashier or action). Nothing was done — ask the manager to approve this one.',
    };
    const fail = (refusedBecause: keyof typeof say): ReturnCheck => ({ ok: false, refusedBecause, laneMessage: say[refusedBecause] });
    if (!isStr(input.approvalId)) return fail('approval_required');
    const g = this.granted.get(input.approvalId);
    if (g === undefined) return fail('approval_unknown');
    const already = this.usedBy.get(input.approvalId);
    if (already !== undefined && already !== input.activityId) return fail('approval_already_used');
    if (already === undefined && Date.parse(g.expiresAt) <= Date.parse(this.deps.now())) return fail('approval_expired');
    if (g.kind !== input.kind || g.billRef !== input.billRef || g.valueMinor !== input.valueMinor || g.requestedBy !== input.requestedBy || g.laneId !== input.laneId
      // OB-500: an approval given for one product and price is never spent on another.
      || (g.productId !== undefined && (g.productId !== input.productId || g.toUnitMinor !== input.toUnitMinor))
      || (g.fromUnitMinor !== undefined && (g.lineId !== input.lineId || g.fromUnitMinor !== input.fromUnitMinor || g.quantityMinor !== input.quantityMinor))) {
      return fail('approval_does_not_match');
    }
    if (already === undefined) await this.record({ kind: 'used', at: this.deps.now(), approvalId: input.approvalId, usedBy: input.activityId });
    return { ok: true, stamp: { approvalId: input.approvalId, approvedBy: g.approvedBy } };
  }
}
