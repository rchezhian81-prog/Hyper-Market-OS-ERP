// Tender settlement (M12-FR-03) — how a bill total is covered by one or more
// tenders (cash / card / UPI / store credit / split). Two rules matter most:
// split tenders must balance to the total, and there is NEVER a fake approval —
// a tender that is only 'pending' or 'uncertain' does NOT count as paid, so a sale
// cannot be marked settled on an unconfirmed card/UPI authorization (§4.3 / §31).
// Pure and deterministic; composes the Money primitive.

import { add, subtract, zero, compare, type Money } from '../../contracts/src/money';
import type { TenderKind, TenderStatus } from '../../contracts/src/enums';

export interface Tender {
  readonly kind: TenderKind;
  readonly amount: Money;
  readonly status: TenderStatus;
}

/** Statuses that count as actually paid. 'pending'/'uncertain'/'declined' do not. */
const SETTLED_STATUSES: readonly TenderStatus[] = ['authorized', 'settled'];

export interface Settlement {
  /** Sum of authorized/settled tenders — the amount genuinely paid. */
  readonly settled: Money;
  /** Sum of pending/uncertain tenders — not yet paid (shown honestly). */
  readonly pending: Money;
  /** total − settled (positive = still owed; zero/negative = covered). */
  readonly outstanding: Money;
  /** True only when settled ≥ total. */
  readonly fullyPaid: boolean;
  /** settled − total when overpaid (e.g. cash), else zero. */
  readonly changeDue: Money;
}

/**
 * Compute how a total is covered by the given tenders. Only authorized/settled
 * tenders count toward payment (no fake approval). All tenders must be in the
 * total's currency (`add` enforces it).
 */
export function settle(total: Money, tenders: readonly Tender[]): Settlement {
  let settled = zero(total.currency);
  let pending = zero(total.currency);
  for (const tender of tenders) {
    if (SETTLED_STATUSES.includes(tender.status)) {
      settled = add(settled, tender.amount);
    } else if (tender.status === 'pending' || tender.status === 'uncertain') {
      pending = add(pending, tender.amount);
    }
    // 'declined' contributes nothing.
  }
  const coversTotal = compare(settled, total);
  return {
    settled,
    pending,
    outstanding: subtract(total, settled),
    fullyPaid: coversTotal >= 0,
    changeDue: coversTotal > 0 ? subtract(settled, total) : zero(total.currency),
  };
}
