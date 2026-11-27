// One stock movement per document LINE, keyed so that a document with one line per product keeps the key it always had
// (audit 27 Nov 2026, item 7 · OB-924 · OB-925 · D-141).
//
// The local commit of a sale, a goods receipt and a return used to key each movement by `<document>:<product>`. A second
// line of the same product on one document — the same item rung twice at another price, two batches of one product in
// one delivery, one unit to resell and one damaged — got the SAME key, and the append-only ledger treated it as a replay:
// the second line's stock silently never moved (hard rule #2, hard rule #10).
//
// The fix keeps the old key for the FIRST movement of a product on the document and gives each repeat its own
// (`<product>#2`, `<product>#3`, …). Why this and not the line position (`services/pos/src/sale-stock.ts` keys head
// office's movements by position): every document that moved stock correctly before — one line per product — produces
// byte-for-byte the keys it produced before, so a document re-committed after the upgrade (a till re-syncing, an outbox
// replay, a page reloaded with an older ledger) dedupes exactly as it always did and posts nothing twice. Position keys
// would have renamed every existing movement. A key already taken on the document (a product literally named `P#2`
// beside a repeated `P`) moves on to the next free number, so two lines of one document can never share a key.
// Deterministic: the same lines in the same order always produce the same keys.

/** Hands out the per-line part of a movement key for ONE document, in the order its movements are appended. */
export interface LineKeyAllocator {
  /** The key part for the next movement of `productId`: the product id itself the first time, then `<id>#<n>`. */
  next(productId: string): string;
}

export function lineKeyAllocator(): LineKeyAllocator {
  const taken = new Set<string>();
  const seen = new Map<string, number>();
  return {
    next(productId: string): string {
      let n = seen.get(productId) ?? 0;
      let key: string;
      do {
        n += 1;
        key = n === 1 ? productId : `${productId}#${n}`;
      } while (taken.has(key));
      seen.set(productId, n);
      taken.add(key);
      return key;
    },
  };
}
