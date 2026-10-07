// HEAD OFFICE CHECKS THE STORE COMPUTER'S SEAL (ADR-0023 · Wave 2b-v-d · audit PF-02 · M12-FR-04 · M13-FR-03 · M14-FR-01 ·
// hard rule #10).
//
// A fact relayed from a store — a sale, a refund, a till cash movement, a till close — names a person, and a refund may
// name a manager who approved it. The store computer verified those people at the till and sealed what it verified
// (`packages/identity/src/till-seal.ts`). Here head office checks the seal and turns what it finds into a flag on the
// fact: never a refusal, because the money already moved at the till; a person looks at the flag (P-03, P-08).
//
//   • no seal at all            → `<who>_not_verified_at_store` — an old store computer, a record that did not pass through
//                                  a till, or a body sent by someone holding the sync permission;
//   • a seal that does not match → `<who>_seal_does_not_match` — the record was changed after the store sealed it, or the
//                                  seal was copied from another record. Worse, and said so.
//
// Absent key (a composition with no pack signing key) → no check, no flag: nobody looked, and nothing is claimed.

import { checkApprovalStamp, checkOperatorStamp, type TillSealFact } from '../../../packages/identity/src/till-seal';

/** The flags a person's seal can raise. */
export type CashierSealFlag = 'cashier_not_verified_at_store' | 'cashier_seal_does_not_match';
/** The flags a manager's approval seal can raise. */
export type ApprovalSealFlag = 'approval_not_verified_at_store' | 'approval_seal_does_not_match';

/** The flag for the person a relayed fact names, or none when the store's seal is there and matches. */
export function cashierSealFlags(key: Buffer | undefined, input: {
  readonly fact: Exclude<TillSealFact, 'approval'>;
  readonly tenantId: string;
  readonly recordId: string;
  readonly amountMinor: number;
  readonly named: string;
  readonly stamp: unknown;
}): CashierSealFlag[] {
  if (key === undefined || input.named.trim() === '') return [];
  const check = checkOperatorStamp(key, input);
  return check === 'verified' ? [] : [check === 'missing' ? 'cashier_not_verified_at_store' : 'cashier_seal_does_not_match'];
}

/** The flag for the manager a relayed refund names as approver, or none (no approver named, or the seal matches). */
export function approvalSealFlags(key: Buffer | undefined, input: {
  readonly tenantId: string;
  readonly recordId: string;
  readonly amountMinor: number;
  readonly approvedBy: string | undefined;
  readonly stamp: unknown;
}): ApprovalSealFlag[] {
  const approvedBy = input.approvedBy?.trim() ?? '';
  if (key === undefined || approvedBy === '') return [];
  const check = checkApprovalStamp(key, { ...input, approvedBy });
  return check === 'verified' ? [] : [check === 'missing' ? 'approval_not_verified_at_store' : 'approval_seal_does_not_match'];
}

/** The stamp a relayed body carries under `field`, untouched (the check reads it defensively). */
export function stampIn(body: unknown, field: 'operatorVerified' | 'approvalVerified'): unknown {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
}
