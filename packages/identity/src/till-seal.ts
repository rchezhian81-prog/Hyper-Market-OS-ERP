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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const LABEL = 'sre-till-seal-v1';

/** What a seal is on: a sale, a refund (any kind), a till cash movement, a till close, a manager's approval, or a decision
 *  a person made on a back-office screen the box serves (2b-vi-c-3). */
export type TillSealFact = 'sale' | 'return' | 'cash_movement' | 'shift_close' | 'approval' | 'decision';

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
  readonly fact: Exclude<TillSealFact, 'approval' | 'decision'>;
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

// ── A DECISION made on a back-office screen the box serves (2b-vi-c-3 · ADR-0023 amended · audit PA-03) ─────────────────
//
// An approval decided on the manager's screen, a supplier bill captured on the buyer's, a checklist signed, a migration
// exception resolved or total signed — each reaches head office through the box's relay, naming the person who decided.
// The box can vouch for that person only when it KNOWS who is at the screen: a till operator session (their own staff ID
// and PIN) or, on the hosted copy, the person the front's sign-in verified. Then it seals the decision — which kind, which
// record, who, how, and a digest of EVERYTHING the decision says — so a decision changed after the box sealed it (another
// outcome, another reason, another line) no longer matches. Head office checks the seal and flags what it cannot confirm.

/** The field a relayed decision carries the box's stamp in. Never part of what the seal covers. */
export const DECIDER_STAMP_FIELD = 'deciderVerified';

/** The kinds of decision a box seals. Each kind is its own namespace: a seal for one never fits another. */
export type DecisionKind = 'approval_decision' | 'supplier_invoice' | 'checklist' | 'migration_exception' | 'migration_total';

/** The box's stamp on the person who made a decision, as it travels on the relayed record. */
export interface DeciderStamp {
  readonly userId: string;
  readonly via: string;
  readonly laneId: string;
  readonly seal: string;
}

/** Canonical JSON (keys sorted at every depth) — both sides digest the same bytes whatever order the keys arrived in. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** What the seal covers of a decision: the whole record as relayed, without the stamp itself. */
export function decisionDigest(record: unknown): string {
  const body = record !== null && typeof record === 'object' && !Array.isArray(record) ? { ...(record as Record<string, unknown>) } : {};
  delete body[DECIDER_STAMP_FIELD];
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

const decisionSubject = (input: { readonly tenantId: string; readonly kind: DecisionKind; readonly recordId: string; readonly record: unknown; readonly laneId: string; readonly userId: string; readonly via: string }): TillSealSubject => ({
  fact: 'decision', tenantId: input.tenantId, recordId: `${input.kind}:${input.recordId}:${decisionDigest(input.record)}`,
  laneId: input.laneId, userId: input.userId, via: input.via, amountMinor: 0,
});

/** The box's stamp on a decision it saw the named person make (the record is sealed WITHOUT the stamp field). */
export function sealDecision(key: Buffer, input: {
  readonly tenantId: string; readonly kind: DecisionKind; readonly recordId: string; readonly record: unknown;
  readonly laneId: string; readonly userId: string; readonly via: string;
}): DeciderStamp {
  return { userId: input.userId, via: input.via, laneId: input.laneId, seal: sealTillFact(key, decisionSubject(input)) };
}

/**
 * Check the box's stamp on a relayed decision. `named` is who the record says decided; the stamp must name that same
 * person, and its seal must match this shop, this kind, this record and every word of the decision.
 */
export function checkDeciderStamp(key: Buffer, input: {
  readonly tenantId: string; readonly kind: DecisionKind; readonly recordId: string; readonly named: string; readonly record: unknown;
}): SealCheck {
  const body = input.record !== null && typeof input.record === 'object' ? input.record as Record<string, unknown> : {};
  const s = (body[DECIDER_STAMP_FIELD] !== null && typeof body[DECIDER_STAMP_FIELD] === 'object' ? body[DECIDER_STAMP_FIELD] : {}) as Record<string, unknown>;
  const userId = text(s['userId']); const via = text(s['via']); const laneId = text(s['laneId']);
  if (userId === undefined || via === undefined || laneId === undefined || s['seal'] === undefined) return 'missing';
  if (userId !== input.named.trim()) return 'does_not_match';
  return tillSealMatches(key, decisionSubject({ ...input, laneId, userId, via }), s['seal']) ? 'verified' : 'does_not_match';
}
