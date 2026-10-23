// M06-FR-02 acceptance "SoD prevents one person completing requisition-to-pay" · §28 "cannot receive, match and pay same
// transaction" (OB-288 P3) — the port every step of a purchase asks, and the one refusal they all give.
//
// The rule is the tested `segregationConflict` in `@sre/purchasing`; who did what on an order is head office's own
// registers (the order, the goods receipts and receipt postings, the recorded matches, the payments) — never a body.
// An online act by a person at head office is REFUSED by name. A receipt that already happened at the store and reaches
// head office by relay is recorded and FLAGGED instead (the goods are in the building; P-01, P-08) — goods-receipt.ts.

import { apiError } from '../../kernel/src/index';
import type { PurchaseActors, SegregationConflict } from '../../../packages/purchasing/src/index';

export interface SegregationPort {
  /** Who did each of the four acts on one purchase order. An order head office does not hold has nobody on record. */
  readonly actorsOf: (tenantId: string, poId: string) => Promise<PurchaseActors>;
  /** The actors of every order a NEW payment to this supplier would pay (every bill still open, oldest first). */
  readonly ordersPaidBy: (tenantId: string, supplierId: string) => Promise<readonly PurchaseActors[]>;
}

/** The one refusal: 409, named, nothing saved, and what to do instead. */
export function segregationRefusal(c: SegregationConflict): Error {
  return apiError(409, {
    code: 'segregation_of_duties',
    whatHappened: `${c.detail}.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'A different person who holds the authority does this step. Nothing was saved.',
  });
}
