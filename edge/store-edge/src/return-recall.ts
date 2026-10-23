// A RETURNED unit under recall is held, never put back for sale — the till's rule, again, before THIS box's disk
// (M13-FR-02 "recall-blocked item handled per M10" · M10-FR-04 · SF-08 · OB-139 "A").
//
// The till holds a recalled unit coming back (`apps/pos/src/till-session.ts`, from its own copy of the signed catalogue
// pack). The store computer runs the same rule on the refund record it is about to keep, from ITS signed pack: a line the
// cashier chose to RESELL whose product is recalled becomes `quarantine`, marked `recallHeld` with what was chosen (and a
// unit of a batch head office moved to EXPIRED, M13-FR-02 · M10-FR-01, the same, marked `expiredHeld`) — so a
// page from an older till, or a record posted straight to the socket, cannot put a recalled unit back on the shelf. The
// refund itself is never refused: a recall wants the goods back (hard rule #1 — the box decides from its own disk).
//
// Pure and deterministic: the same record and pack always give the same result, so a re-sent refund hashes the same.

import { expiredOfProduct, recallOfProduct, returnLineHoldReason, type Disposition } from '../../../packages/returns/src/returns';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One product as this box's catalogue pack carries its recall facts. */
export interface PackRecallFacts {
  readonly productId: string;
  readonly recallBlock?: boolean;
  readonly blockedBatches?: readonly string[];
  /** M13-FR-02 · M10-FR-01: the batches head office moved to EXPIRED — a returned unit of one is held the same way. */
  readonly expiredBatches?: readonly { readonly batchId: string }[];
}

/** The refund record with every recalled RESELL line held, and how many were. Untouched when none is. */
export function holdRecalledReturnLines(record: Rec, products: readonly PackRecallFacts[]): { readonly record: Rec; readonly held: number } {
  const lines = record['lines'];
  if (!Array.isArray(lines) || products.length === 0) return { record, held: 0 };
  const byId = new Map(products.map((p) => [p.productId, p] as const));
  const check = recallOfProduct((id) => byId.get(id));
  const expired = expiredOfProduct((id) => byId.get(id));
  let held = 0;
  const next = lines.map((l) => {
    if (!isObj(l) || typeof l['productId'] !== 'string') return l;
    const disposition = l['disposition'];
    if (disposition !== 'resell') return l;
    const batchId = typeof l['batchId'] === 'string' && l['batchId'] !== '' ? l['batchId'] : null;
    const hold = returnLineHoldReason({ productId: l['productId'], disposition: disposition as Disposition, batchId }, check, expired);
    if (hold === null) return l;
    held += 1;
    return { ...l, disposition: 'quarantine', ...(hold === 'recall' ? { recallHeld: true } : { expiredHeld: true }), chosenDisposition: 'resell' };
  });
  return held === 0 ? { record, held } : { record: { ...record, lines: next }, held };
}
