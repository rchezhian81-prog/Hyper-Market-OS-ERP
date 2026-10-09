// PF-14 · M13-FR-02 · M12-FR-01 · M10-FR-03 — a returned unit keeps the lot it was SOLD from.
//
// A recall follows a batch forward to the customer and back. A return that loses the batch breaks that trail: the unit
// comes back as "rice" rather than "rice, batch R-07, use by 31 Dec", and a later recall of R-07 cannot find it. The
// original bill already carries each line's batch and use-by date (the lane captured them at the sale), so the return
// takes them from THERE:
//   • a batch the desk names must be one the bill sold of that product;
//   • a batch the desk does not name is the bill's, when the bill sold exactly one batch of that product;
//   • where the bill sold several batches of that product, the desk must say which — head office will not guess;
//   • a product the bill sold with no batch at all keeps whatever the return says (an untracked product).
// The use-by date rides with the batch. Pure: no clock, no I/O.

import type { ReturnRequestLine } from './assess-return';
import type { OriginalSale } from './return-register';

export interface ReturnLotProblem {
  readonly kind: 'batch_not_on_the_sale' | 'batch_not_named';
  readonly productId: string;
  /** The batch the return named (for `batch_not_on_the_sale`). */
  readonly batchId?: string;
  /** The batches the bill sold of this product. */
  readonly soldBatches: readonly string[];
}

export interface ReturnLots {
  /** The return's lines with the batch and use-by date the bill sold them from, where that is known. */
  readonly lines: readonly ReturnRequestLine[];
  readonly problems: readonly ReturnLotProblem[];
}

export function lotsOfReturn(sale: OriginalSale, lines: readonly ReturnRequestLine[]): ReturnLots {
  const problems: ReturnLotProblem[] = [];
  const out = lines.map((line): ReturnRequestLine => {
    const sold = new Map<string, string | undefined>();
    for (const l of sale.lines) {
      if (l.productId === line.productId && typeof l.batchId === 'string' && l.batchId !== '') sold.set(l.batchId, sold.get(l.batchId) ?? l.batchExpiry);
    }
    const soldBatches = [...sold.keys()];
    const named = typeof line.batchId === 'string' && line.batchId.trim() !== '' ? line.batchId.trim() : undefined;
    if (soldBatches.length === 0) return line; // sold with no batch: nothing to check against
    if (named !== undefined) {
      if (!sold.has(named)) { problems.push({ kind: 'batch_not_on_the_sale', productId: line.productId, batchId: named, soldBatches }); return line; }
      const expiry = sold.get(named);
      return { ...line, batchId: named, ...(expiry === undefined ? {} : { batchExpiry: expiry }) };
    }
    if (soldBatches.length > 1) { problems.push({ kind: 'batch_not_named', productId: line.productId, soldBatches }); return line; }
    const only = soldBatches[0]!;
    const expiry = sold.get(only);
    return { ...line, batchId: only, ...(expiry === undefined ? {} : { batchExpiry: expiry }) };
  });
  return { lines: out, problems };
}

/** A problem in words — what the desk is told. */
export function lotProblemWords(p: ReturnLotProblem): string {
  return p.kind === 'batch_not_on_the_sale'
    ? `${p.productId} batch ${p.batchId ?? ''} was not sold on this bill — it sold ${p.soldBatches.join(', ')}.`
    : `This bill sold ${p.productId} from more than one batch (${p.soldBatches.join(', ')}) — say which batch the returned unit is from.`;
}
