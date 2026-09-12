// Refund entitlement — what a receipt actually allows back, from trusted data (review finding RR-F04).
//
// The at-most-once rule for a return ("you cannot return more of a line than was sold") was enforced
// against numbers the CALLER supplied — `originalQtyMinor` and a projected prior-return total. A
// second refund with a NEW id for the same unit passed simply by re-asserting `originalQtyMinor=1`
// and omitting the prior return: the guard trusted the caller's memory, and the caller forgot on
// purpose. That is not entitlement; it is the honour system.
//
// This computes entitlement from what the box itself durably knows:
//   • how much of each product a sale actually SOLD — read from this edge's own sale log, not the
//     refund request;
//   • how much has already been RETURNED against that sale — accumulated from this edge's own returns
//     log, not a number the caller passes in.
// A refund is allowed only while cumulative returned + requested stays within sold, and the returned
// side is reserved atomically as each refund commits, so two refunds of the last unit cannot both
// pass. Rebuilt from the durable logs at boot, so the accounting survives a restart.
//
// ── What it deliberately does NOT claim ─────────────────────────────────────
//
// This edge knows only the sales IT rang and the returns IT took. A refund against a sale rung on
// another lane, or with no receipt, cannot be entitlement-checked here — there is no trusted local
// record to check against. For those, `saleKnown` is false and the caller must apply an explicit
// safe policy rather than pretend a global at-most-once it cannot support offline; global
// cross-lane at-most-once needs cloud reconciliation, which is recorded as a separate gap.

/** A product and a quantity, in the product's smallest unit. */
export interface EntitlementLine {
  readonly productId: string;
  readonly quantityMinor: number;
}

export type EntitlementVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly productId: string; readonly soldMinor: number; readonly returnedMinor: number; readonly requestedMinor: number };

/** Nested map helper: saleId -> productId -> quantity. */
type Book = Map<string, Map<string, number>>;
function add(book: Book, saleId: string, productId: string, qty: number): void {
  let byProduct = book.get(saleId);
  if (byProduct === undefined) { byProduct = new Map(); book.set(saleId, byProduct); }
  byProduct.set(productId, (byProduct.get(productId) ?? 0) + qty);
}
function get(book: Book, saleId: string, productId: string): number {
  return book.get(saleId)?.get(productId) ?? 0;
}

export class ReturnEntitlement {
  private readonly sold: Book = new Map();
  private readonly returned: Book = new Map();

  /**
   * @param sales   every sale this edge rang, by id, with the quantity sold per product (trusted).
   * @param returns every return this edge has already taken, by the sale it was against.
   */
  constructor(
    sales: Iterable<{ readonly saleId: string; readonly lines: readonly EntitlementLine[] }> = [],
    returns: Iterable<{ readonly originalSaleId: string; readonly lines: readonly EntitlementLine[] }> = [],
  ) {
    for (const s of sales) {
      for (const l of s.lines) add(this.sold, s.saleId, l.productId, Math.abs(l.quantityMinor));
    }
    for (const r of returns) {
      for (const l of r.lines) add(this.returned, r.originalSaleId, l.productId, Math.abs(l.quantityMinor));
    }
  }

  /** Did this edge ring the original sale? Only then can it check entitlement from trusted data. */
  saleKnown(saleId: string): boolean {
    return this.sold.has(saleId);
  }

  /**
   * Record a sale rung during this run, so a refund taken later in the same session is checked
   * against it — not only against sales that were already on disk at boot. Called after the sale's
   * durable write, off the money-critical path; it only updates this in-memory index and cannot
   * affect the sale.
   */
  recordSale(saleId: string, lines: readonly EntitlementLine[]): void {
    for (const l of lines) add(this.sold, saleId, l.productId, Math.abs(l.quantityMinor));
  }

  /**
   * Would refunding these lines against this sale stay within what was sold, given what has already
   * been returned? Meaningful only for a `saleKnown` sale — the caller decides the safe policy for
   * the rest. Multiple lines for the same product in one request are summed.
   */
  check(saleId: string, lines: readonly EntitlementLine[]): EntitlementVerdict {
    const requestedByProduct = new Map<string, number>();
    for (const l of lines) requestedByProduct.set(l.productId, (requestedByProduct.get(l.productId) ?? 0) + Math.abs(l.quantityMinor));
    for (const [productId, requestedMinor] of requestedByProduct) {
      const soldMinor = get(this.sold, saleId, productId);
      const returnedMinor = get(this.returned, saleId, productId);
      if (returnedMinor + requestedMinor > soldMinor) {
        return { ok: false, productId, soldMinor, returnedMinor, requestedMinor };
      }
    }
    return { ok: true };
  }

  /** Atomically account these returned lines against the sale — called as a refund commits. */
  reserve(saleId: string, lines: readonly EntitlementLine[]): void {
    for (const l of lines) add(this.returned, saleId, l.productId, Math.abs(l.quantityMinor));
  }

  /** Undo a reservation when the durable write it was made for did not complete. */
  release(saleId: string, lines: readonly EntitlementLine[]): void {
    for (const l of lines) add(this.returned, saleId, l.productId, -Math.abs(l.quantityMinor));
  }
}
