// COD reconciliation at shift end (M19-FR-04). Cash-on-delivery is collected TO THE
// PAISA and must reconcile against each order's expected amount, feeding finance
// reconciliation (M23). COD is cash/UPI ONLY — never card data (hard rule #3): a
// card method is refused. Every mismatch is an owned, valued exception (short / over
// / uncollected / unexpected), never a silent loss (P-08). Pure and deterministic.

export type CodMethod = 'cash' | 'upi';

export interface CodExpectation {
  readonly orderId: string;
  readonly expectedMinor: number;
}

export interface CodCollection {
  readonly orderId: string;
  readonly collectedMinor: number;
  /** cash or upi only — a card method is refused (hard rule #3). */
  readonly method: string;
}

export interface CodMatch {
  readonly orderId: string;
  readonly amountMinor: number;
}

export type CodExceptionKind = 'short' | 'over' | 'uncollected' | 'unexpected';

export interface CodException {
  readonly orderId: string;
  readonly kind: CodExceptionKind;
  readonly expectedMinor?: number;
  readonly collectedMinor?: number;
  readonly varianceMinor?: number;
}

export interface CodReconResult {
  readonly matched: readonly CodMatch[];
  readonly exceptions: readonly CodException[];
  readonly matchedCount: number;
  readonly exceptionCount: number;
}

export class CardDataError extends Error {
  constructor() {
    super('COD is cash/UPI only — a card method is not allowed (hard rule #3).');
    this.name = 'CardDataError';
  }
}

const ALLOWED_METHODS: readonly string[] = ['cash', 'upi'];

/**
 * Reconcile COD collections against expectations at shift end. Matches by order,
 * flagging short/over collections (with variance), uncollected expectations and
 * unexpected collections. Refuses any card method. Deterministic: exceptions ordered
 * by order id.
 */
export function reconcileCod(
  expectations: readonly CodExpectation[],
  collections: readonly CodCollection[],
): CodReconResult {
  const expectedByOrder = new Map<string, number>();
  for (const e of expectations) expectedByOrder.set(e.orderId, e.expectedMinor);

  const collectedByOrder = new Map<string, number>();
  for (const c of collections) {
    if (!ALLOWED_METHODS.includes(c.method)) {
      throw new CardDataError();
    }
    collectedByOrder.set(c.orderId, (collectedByOrder.get(c.orderId) ?? 0) + c.collectedMinor);
  }

  const matched: CodMatch[] = [];
  const exceptions: CodException[] = [];

  const orderIds = new Set<string>([...expectedByOrder.keys(), ...collectedByOrder.keys()]);
  for (const orderId of [...orderIds].sort()) {
    const expected = expectedByOrder.get(orderId);
    const collected = collectedByOrder.get(orderId);

    if (expected === undefined && collected !== undefined) {
      exceptions.push({ orderId, kind: 'unexpected', collectedMinor: collected });
    } else if (expected !== undefined && collected === undefined) {
      exceptions.push({ orderId, kind: 'uncollected', expectedMinor: expected });
    } else if (expected !== undefined && collected !== undefined) {
      if (collected === expected) {
        matched.push({ orderId, amountMinor: expected });
      } else {
        exceptions.push({
          orderId,
          kind: collected < expected ? 'short' : 'over',
          expectedMinor: expected,
          collectedMinor: collected,
          varianceMinor: collected - expected,
        });
      }
    }
  }

  return { matched, exceptions, matchedCount: matched.length, exceptionCount: exceptions.length };
}
