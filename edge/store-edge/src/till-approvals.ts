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
import type { CheckOutcome, SignInRefusal } from './till-operators';

/** The permission a manager needs to approve a refund at the till — the one head office re-checks on every synced refund. */
export const APPROVAL_AUTHORITY = 'pos.return.approve';
export const APPROVAL_MINUTES = 5;

/** What an approval is for. A refund and an exchange's refunded difference are against a bill; a no-receipt return is not. */
export type ApprovalKind = 'refund' | 'no_receipt_return' | 'exchange_refund';
const KINDS: readonly ApprovalKind[] = ['refund', 'no_receipt_return', 'exchange_refund'];

export type ApprovalRefusal =
  | SignInRefusal
  | 'operator_not_signed_in' | 'operator_session_ended' | 'operator_on_another_lane' | 'operator_lost_till_authority'
  | 'self_approval' | 'approval_not_readable'
  | 'approval_required' | 'approval_unknown' | 'approval_expired' | 'approval_already_used' | 'approval_does_not_match';

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
  | { readonly approved: false; readonly refusedBecause: ApprovalRefusal; readonly laneMessage: string };

export type ReturnCheck =
  | { readonly ok: true; readonly stamp?: { readonly approvalId: string; readonly approvedBy: string } }
  | { readonly ok: false; readonly refusedBecause: ApprovalRefusal; readonly laneMessage: string };

/** What a refund record is, for the purpose of approving it — read from the record the till posted. */
export interface ApprovalSubject { readonly kind: ApprovalKind; readonly billRef: string | null; readonly valueMinor: number }

interface Granted {
  readonly approvalId: string; readonly kind: ApprovalKind; readonly billRef: string | null; readonly valueMinor: number;
  readonly requestedBy: string; readonly approvedBy: string; readonly laneId: string; readonly reason: string;
  readonly at: string; readonly expiresAt: string;
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
    return new TillApprovals(log, { operators: input.operators, approvalThresholdMinor: input.approvalThresholdMinor, now: input.now ?? (() => new Date().toISOString()) }, restored, unreadable);
  }

  private fold(r: LogRecord): void {
    if (r.kind === 'granted') {
      this.granted.set(r.approvalId, {
        approvalId: r.approvalId, kind: r.subjectKind, billRef: r.billRef, valueMinor: r.valueMinor, requestedBy: r.requestedBy,
        approvedBy: r.approvedBy, laneId: r.laneId, reason: r.reason, at: r.at, expiresAt: r.expiresAt,
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
  }): Promise<GrantOutcome> {
    const refuse = (refusedBecause: ApprovalRefusal, laneMessage: string): GrantOutcome => ({ approved: false, refusedBecause, laneMessage });
    const asker = this.deps.operators.check(input.token, input.laneId);
    if (!asker.ok) return refuse(asker.refusedBecause, asker.laneMessage);
    const kind = KINDS.find((k) => k === input.kind);
    const valueMinor = typeof input.valueMinor === 'number' && Number.isSafeInteger(input.valueMinor) && input.valueMinor > 0 ? input.valueMinor : undefined;
    const billRef = isStr(input.billRef) ? input.billRef.trim() : null;
    const managerId = input.managerId.trim();
    if (kind === undefined || valueMinor === undefined || !isStr(input.reason) || managerId === '' || (kind !== 'no_receipt_return' && billRef === null)) {
      return refuse('approval_not_readable', WORDS.approval_not_readable);
    }
    // §28: never the person asking. Said before the PIN is even looked at, so a cashier learns nothing by trying.
    if (managerId === asker.userId) return refuse('self_approval', WORDS.self_approval);
    const manager = await this.deps.operators.verifyPerson({ staffId: managerId, pin: input.pin, laneId: input.laneId, authority: APPROVAL_AUTHORITY });
    if (!manager.ok) return refuse(manager.refusedBecause, manager.laneMessage);
    const nowMs = Date.parse(this.deps.now());
    const approvalId = `apr-${randomBytes(12).toString('hex')}`;
    const expiresAt = new Date(nowMs + APPROVAL_MINUTES * 60_000).toISOString();
    await this.record({
      kind: 'granted', approvalId, subjectKind: kind, billRef: kind === 'no_receipt_return' ? null : billRef, valueMinor,
      requestedBy: asker.userId, approvedBy: manager.userId, laneId: input.laneId, reason: String(input.reason).trim().slice(0, 200),
      at: new Date(nowMs).toISOString(), expiresAt,
    });
    return { approved: true, approvalId, approvedBy: manager.userId, displayName: manager.displayName, expiresAt };
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
}
