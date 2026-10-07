// THE STORE COMPUTER'S SEAL on who it verified (ADR-0023 · Wave 2b-v-d · audit PF-02 · M12-FR-04 · M13-FR-03 · M14-FR-01 ·
// §28 · hard rule #10).
//
// The store computer checks, offline, that the person a money write names is the person signed in at that till
// (ADR-0020), and that a manager's approval is one it issued for exactly that refund (ADR-0021). Until now head office
// could not tell such a record from one that never passed through a till: a body naming any cashier or approver, sent
// by anyone holding the sync permission, read exactly the same. The seal closes that: the box signs WHAT it verified —
// which fact, which shop, which record, which till, which person, how they proved it, how much — and head office checks
// the signature. A fact that arrives without the seal, or whose seal does not match it, is flagged for a person; never
// refused, because the money already moved at the till (the audit: "keep later sync flags for facts already committed").
//
// The key is derived from the pack signing key both sides already hold, under this seal's own label — so a seal can
// never be mistaken for a pack signature or a PIN verifier, and the key itself is never written beside the records.
// Deterministic (no clock, no randomness): a till re-sending the SAME record after a lost reply produces the same seal,
// so the box never calls its own replay a conflict. Pure apart from `node:crypto`.

import { createHmac, timingSafeEqual } from 'node:crypto';

const LABEL = 'sre-till-seal-v1';

/** What a seal is on: a sale, a refund (any kind), a till cash movement, a till close, or a manager's approval. */
export type TillSealFact = 'sale' | 'return' | 'cash_movement' | 'shift_close' | 'approval';

/** Everything a seal binds. Change any one of these and the seal no longer matches. */
export interface TillSealSubject {
  readonly fact: TillSealFact;
  readonly tenantId: string;
  /** The record's own id: the sale id, the return id, the movement id, the shift id. */
  readonly recordId: string;
  /** The till the box verified the person at. */
  readonly laneId: string;
  /** The person the box verified: the cashier (sale, refund, cash, close) or the approving manager (approval). */
  readonly userId: string;
  /** How they proved it: `pin`, or `verified_sign_in` on the hosted copy; for an approval, `approval`. */
  readonly via: string;
  /** The money the fact moved, in paise: the sale total, the refund, the cash amount, the counted cash. */
  readonly amountMinor: number;
  /** For an approval only: the approval the box issued and spent. */
  readonly approvalId?: string;
}

/** The seal key, derived from the pack signing key under the seal's own label. */
export function tillSealKey(packSigningKey: string): Buffer {
  if (packSigningKey.length < 32) throw new RangeError('the till seal key needs the full pack signing key');
  return createHmac('sha256', packSigningKey).update(LABEL, 'utf8').digest();
}

/** One canonical text per subject: field order fixed, every field present, so both sides sign the same bytes. */
function canonical(s: TillSealSubject): string {
  return JSON.stringify([LABEL, s.fact, s.tenantId, s.recordId, s.laneId, s.userId, s.via, s.amountMinor, s.approvalId ?? '']);
}

/** Seal a subject (hex). */
export function sealTillFact(key: Buffer, subject: TillSealSubject): string {
  return createHmac('sha256', key).update(canonical(subject), 'utf8').digest('hex');
}

/** Does this seal match this subject? Constant-time; anything that is not a well-formed seal is simply false. */
export function tillSealMatches(key: Buffer, subject: TillSealSubject, seal: unknown): boolean {
  if (typeof seal !== 'string' || !/^[0-9a-f]{64}$/.test(seal)) return false;
  return timingSafeEqual(Buffer.from(sealTillFact(key, subject), 'hex'), Buffer.from(seal, 'hex'));
}

/** The box's stamp on the person it verified, as it travels on the record. */
export interface OperatorStamp {
  readonly userId: string;
  readonly via: string;
  readonly laneId: string;
  readonly seal: string;
}

/** The box's stamp on a manager's approval it issued and spent, as it travels on a refund. */
export interface ApprovalStamp {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly laneId: string;
  readonly seal: string;
}

/** What head office makes of a stamp: the box's seal and it matches; no seal at all; or a seal that does not match. */
export type SealCheck = 'verified' | 'missing' | 'does_not_match';

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/**
 * Check the box's stamp on the person a fact names. `named` is who the fact says did it (the sale's cashier, the refund's
 * processor, the movement's custodian, the close's cashier); the stamp must name that same person and its seal must match
 * this fact, this shop, this record and this amount.
 */
export function checkOperatorStamp(key: Buffer, input: {
  readonly fact: Exclude<TillSealFact, 'approval'>;
  readonly tenantId: string;
  readonly recordId: string;
  readonly amountMinor: number;
  readonly named: string;
  readonly stamp: unknown;
}): SealCheck {
  const s = (input.stamp !== null && typeof input.stamp === 'object' ? input.stamp : {}) as Record<string, unknown>;
  const userId = text(s['userId']); const via = text(s['via']); const laneId = text(s['laneId']);
  if (userId === undefined || via === undefined || laneId === undefined || s['seal'] === undefined) return 'missing';
  if (userId !== input.named.trim()) return 'does_not_match';
  return tillSealMatches(key, {
    fact: input.fact, tenantId: input.tenantId, recordId: input.recordId, laneId, userId, via, amountMinor: input.amountMinor,
  }, s['seal']) ? 'verified' : 'does_not_match';
}

/**
 * Check the box's stamp on a refund's approval. `approvedBy` is who the refund says approved it; the stamp must name that
 * same manager and its seal must match this refund, this shop and this amount.
 */
export function checkApprovalStamp(key: Buffer, input: {
  readonly tenantId: string;
  readonly recordId: string;
  readonly amountMinor: number;
  readonly approvedBy: string;
  readonly stamp: unknown;
}): SealCheck {
  const s = (input.stamp !== null && typeof input.stamp === 'object' ? input.stamp : {}) as Record<string, unknown>;
  const approvalId = text(s['approvalId']); const approver = text(s['approvedBy']); const laneId = text(s['laneId']);
  if (approvalId === undefined || approver === undefined || laneId === undefined || s['seal'] === undefined) return 'missing';
  if (approver !== input.approvedBy.trim()) return 'does_not_match';
  return tillSealMatches(key, {
    fact: 'approval', tenantId: input.tenantId, recordId: input.recordId, laneId, userId: approver, via: 'approval',
    amountMinor: input.amountMinor, approvalId,
  }, s['seal']) ? 'verified' : 'does_not_match';
}
