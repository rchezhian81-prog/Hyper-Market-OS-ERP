// B2B credit control (M22-FR-01) — sell to businesses on terms, safely. An order
// that would push a customer's balance past their CREDIT LIMIT is BLOCKED pending
// approval (§28), never a silent override; an expired contract blocks or falls back
// per policy. The approver must be someone other than the person taking the order
// (separation from order-taking). Pure and deterministic; composes exact Money and
// the approval engine (approval produced upstream). B2B credit is evaluated online
// on fresh data (no unsafe stale credit, §31).

import { add, subtract, compare, type Money } from '../../contracts/src/money';
import type { DecidedRequest } from '../../approvals/src/approvals';

export type CreditVerdict = 'ok' | 'over_limit' | 'contract_expired';

export interface CreditCheckInput {
  /** Order id — the subjectRef an override approval must reference. */
  readonly id: string;
  readonly customerId: string;
  /** Who is taking the order (cannot self-approve an over-limit order). */
  readonly takenBy: string;
  readonly creditLimit: Money;
  /** Current outstanding AR balance for the customer. */
  readonly outstanding: Money;
  /** Value of the proposed new order. */
  readonly orderValue: Money;
  readonly contractExpired?: boolean;
  /** What to do on an expired contract: 'block' (default) or 'fallback' to base pricing. */
  readonly contractPolicy?: 'block' | 'fallback';
  /** Approval to authorise an over-limit (or expired-contract) order. */
  readonly approval?: DecidedRequest;
}

export interface CreditDecision {
  readonly verdict: CreditVerdict;
  readonly allowed: boolean;
  /** creditLimit − outstanding (negative when already over). */
  readonly availableCredit: Money;
  readonly requiresApproval: boolean;
}

function approvalValid(input: CreditCheckInput): boolean {
  const a = input.approval;
  return (
    a !== undefined &&
    a.status === 'approved' &&
    a.subjectRef === input.id &&
    a.decidedBy !== input.takenBy // separation from order-taking (§28)
  );
}

/**
 * Check a B2B order against the customer's credit limit and contract. Returns a
 * verdict and whether the order may proceed: an over-limit order or a blocked
 * expired contract proceeds only with a valid separate approval; otherwise ok.
 */
export function checkCredit(input: CreditCheckInput): CreditDecision {
  const availableCredit = subtract(input.creditLimit, input.outstanding);

  if (input.contractExpired && (input.contractPolicy ?? 'block') === 'block') {
    const ok = approvalValid(input);
    return { verdict: 'contract_expired', allowed: ok, availableCredit, requiresApproval: true };
  }

  const newBalance = add(input.outstanding, input.orderValue);
  if (compare(newBalance, input.creditLimit) > 0) {
    const ok = approvalValid(input);
    return { verdict: 'over_limit', allowed: ok, availableCredit, requiresApproval: true };
  }

  return { verdict: 'ok', allowed: true, availableCredit, requiresApproval: false };
}
