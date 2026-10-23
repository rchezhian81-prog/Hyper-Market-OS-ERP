// Separation of duties ACROSS one purchase (M06-FR-02 acceptance "SoD prevents one person completing requisition-to-pay";
// §28 Purchase User "cannot receive, match and pay same transaction"; M07-FR-04 "receiver ≠ approver of payment").
//
// Each control in the chain already has its own maker-checker (a PO's approver is not its buyer; a payment's approver is
// not its recorder). What none of them sees is the CHAIN: the same person raising the order, booking the goods in,
// matching the bill and paying it. That is the whole fraud — order from a friend, sign for goods that never came, pass the
// invoice, release the money — and every single step looks approved. So for ONE purchase order this engine knows who did
// each of the four acts, and refuses a person who already did a DIFFERENT one:
//
//   requisition — who raised the order (the PO's buyer) and the requisition it came from;
//   receipt     — who booked goods in against it (each goods receipt / receipt posting);
//   match       — who ran the three-way match on a bill against it;
//   payment     — who recorded or approved a payment that pays a bill against it.
//
// Doing the SAME act twice is not a conflict (two deliveries booked by one receiver; a re-match). An act nobody is on
// record for constrains nothing. Pure and deterministic.

export type PurchaseAct = 'requisition' | 'receipt' | 'match' | 'payment';

export const PURCHASE_ACTS: readonly PurchaseAct[] = ['requisition', 'receipt', 'match', 'payment'];

/** Who did each act on one purchase order, from head office's own records. */
export interface PurchaseActors {
  readonly poId: string;
  readonly requisition: readonly string[];
  readonly receipt: readonly string[];
  readonly match: readonly string[];
  readonly payment: readonly string[];
}

export interface SegregationConflict {
  readonly poId: string;
  readonly userId: string;
  /** The act being attempted now. */
  readonly act: PurchaseAct;
  /** The other act this person already did on the same order. */
  readonly alreadyDid: PurchaseAct;
  readonly detail: string;
}

const WORDS: Readonly<Record<PurchaseAct, string>> = {
  requisition: 'raised the order', receipt: 'booked the goods in', match: 'matched the bill', payment: 'paid the supplier',
};

/** The conflict, if this person doing `act` on this order would complete two of the four acts; undefined otherwise. */
export function segregationConflict(actors: PurchaseActors, act: PurchaseAct, userId: string): SegregationConflict | undefined {
  for (const other of PURCHASE_ACTS) {
    if (other === act) continue;
    if (!actors[other].includes(userId)) continue;
    return {
      poId: actors.poId, userId, act, alreadyDid: other,
      detail: `${userId} already ${WORDS[other]} on purchase order ${actors.poId}, so cannot also be the one who ${WORDS[act]} — one person may never complete two steps of the same purchase (§28)`,
    };
  }
  return undefined;
}

/** The first conflict across several orders and several people (a payment can pay bills on more than one order). */
export function firstSegregationConflict(
  actorsByOrder: readonly PurchaseActors[], act: PurchaseAct, userIds: readonly string[],
): SegregationConflict | undefined {
  for (const actors of actorsByOrder) {
    for (const u of userIds) {
      const c = segregationConflict(actors, act, u);
      if (c !== undefined) return c;
    }
  }
  return undefined;
}

/**
 * Which orders a supplier payment pays (for the check above). Payments are recorded against the supplier's balance, not
 * one bill, so the payment is taken to pay EVERY bill still open after the earlier payments, oldest first: the opening
 * balance first, then each matched bill in the order it was matched. Debit notes are not netted here — leaving a bill open
 * longer only widens the set checked, so the rule can only be stricter, never looser.
 */
export function ordersAPaymentPays(input: {
  readonly openingMinor: number;
  readonly bills: readonly { readonly invoiceId: string; readonly poId: string | null; readonly payableMinor: number; readonly at: string }[];
  readonly paidBeforeMinor: number;
}): readonly string[] {
  let covered = Math.max(0, input.paidBeforeMinor - Math.max(0, input.openingMinor));
  const out = new Set<string>();
  const ordered = [...input.bills].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.invoiceId < b.invoiceId ? -1 : 1));
  for (const b of ordered) {
    if (b.payableMinor <= 0) continue;
    if (covered >= b.payableMinor) { covered -= b.payableMinor; continue; }
    covered = 0;
    if (b.poId !== null) out.add(b.poId);
  }
  return [...out];
}
