// API-04 Sale blocks (Wave 3 · SF-08, owner decision 9 Oct 2026 "C (R3) and 1", M10-FR-02, M10-FR-04, M08-FR-02,
// P-01, P-08). The recall register and the quality-hold register decided which BATCHES must not be sold — and nothing
// carried that to the till. The till refuses a `recallBlock` product even offline, but the only thing that set it was a
// flag a person ticked on the product master.
//
// This is the join: head office's own list of what must not be sold — every batch under an OPEN recall and every batch
// on quality HOLD, each named to its product — which the signed catalogue pack folds in, so the product is
// `recallBlock` on the next pack and the lane refuses it with no network.
//
// Owner decision "C": the till blocks the WHOLE PRODUCT while any of its batches is recalled or held (the till does not
// capture the batch at the scan yet); blocking only the bad batch is deferred to release R3, in writing. A product
// comes back when every recall on it is closed with evidence and every hold on it released.
//
// No silent failure (P-08): this route says, for each block, whether the CURRENT published pack already carries it —
// a block that is not yet on a pack is not yet at any till, and the reply says to publish. A recalled batch head office
// cannot name to a product (no receipt, no stock movement ever carried it) is shown as such: it cannot be blocked at
// the till until it can be named, and nothing pretends otherwise.

import type { Route } from '../../kernel/src/index';
import type { SignedPack } from '../../catalogue/src/pack';

export interface SaleBlock {
  /** Null when head office cannot name the batch's product — such a block cannot reach a till (said, not hidden). */
  readonly productId: string | null;
  readonly batchId: string;
  readonly kind: 'recall' | 'quality_hold';
  readonly since: string;
  readonly reason: string;
}

export interface SaleBlockDeps {
  /** Every open recall and every held batch, each named to its product where head office can. */
  readonly blocks: (tenantId: string) => Promise<readonly SaleBlock[]> | readonly SaleBlock[];
  readonly currentPack: (tenantId: string) => Promise<SignedPack | undefined> | SignedPack | undefined;
}

/**
 * The products the till must refuse — any product with at least one open block on it (decision "C") — and, for each,
 * WHICH batches are blocked (SF-08 · OB-139 "A", release R3). A plain barcode still blocks the whole product; a barcode
 * that carries its batch (a GS1 2D code) is refused only for these. It is a `Set` of product ids, so every reader that
 * asks "is this product blocked?" reads exactly as before; the pack assembly also asks `batchesOf`.
 */
export interface BlockedProducts extends ReadonlySet<string> {
  /** The blocked batches of a product, sorted — empty when the product is not blocked. */
  batchesOf(productId: string): readonly string[];
}

class BlockedProductSet extends Set<string> implements BlockedProducts {
  private readonly batches = new Map<string, string[]>();
  constructor(blocks: readonly SaleBlock[]) {
    super();
    for (const b of blocks) {
      if (b.productId === null) continue;
      this.add(b.productId);
      const list = this.batches.get(b.productId) ?? [];
      if (!list.includes(b.batchId)) list.push(b.batchId);
      this.batches.set(b.productId, list);
    }
  }
  batchesOf(productId: string): readonly string[] {
    return [...(this.batches.get(productId) ?? [])].sort();
  }
}

export function blockedProductIds(blocks: readonly SaleBlock[]): BlockedProducts {
  return new BlockedProductSet(blocks);
}

/** True when a set of blocked products also says which batches (`blockedProductIds`) — a bare set of ids does not. */
export function knowsBlockedBatches(set: ReadonlySet<string>): set is BlockedProducts {
  return typeof (set as Partial<BlockedProducts>).batchesOf === 'function';
}

export function saleBlockRoutes(deps: SaleBlockDeps): readonly Route[] {
  return [
    {
      // What must not be sold, and whether each block has reached the tills yet (on the current signed pack).
      api: 'API-04', method: 'GET', path: '/v1/quality/sale-blocks',
      permission: 'quality.recall.read',
      handler: async (ctx) => {
        const blocks = [...(await deps.blocks(ctx.tenantId))].sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
        const pack = await deps.currentPack(ctx.tenantId);
        // SF-08 · R3: a block is on the pack when the pack blocks its product AND either names this batch or blocks the whole
        // product (a recall flag on the product itself). A pack that blocks the product for other batches only has not got it.
        const packed = new Map((pack?.snapshot.products ?? []).filter((p) => p.recallBlock === true).map((p) => [p.productId, p] as const));
        const reaches = (b: SaleBlock): boolean => {
          const p = b.productId === null ? undefined : packed.get(b.productId);
          return p !== undefined && (p.blockedBatches === undefined || p.blockedBatches.includes(b.batchId));
        };
        const rows = blocks.map((b) => ({
          ...b,
          state: b.productId === null ? 'product_unknown' as const : reaches(b) ? 'on_pack' as const : 'not_yet_on_pack' as const,
          // OB-139 "A": how the tills refuse it — a plain barcode refuses the whole product; a barcode carrying the batch
          // refuses only this batch, and sells its sibling batches.
          ...(b.productId === null ? {} : { atTheTill: 'plain_barcode_blocks_whole_product_2d_barcode_blocks_this_batch' as const }),
        }));
        const waiting = rows.filter((r) => r.state === 'not_yet_on_pack').length;
        const unknown = rows.filter((r) => r.state === 'product_unknown').length;
        return {
          status: 200,
          body: {
            blocks: rows,
            blockedProducts: [...blockedProductIds(blocks)].sort(),
            // SF-08 · R3: each blocked product's blocked batches.
            blockedBatches: Object.fromEntries([...blockedProductIds(blocks)].sort().map((p) => [p, blockedProductIds(blocks).batchesOf(p)])),
            packVersion: pack?.snapshot.version ?? null,
            packPublishedAt: pack?.publishedAt ?? null,
            notYetOnPack: waiting,
            productUnknown: unknown,
            detail: waiting > 0
              ? `${waiting} block(s) are not on the published catalogue yet, so no till refuses them — publish the catalogue now.`
              : unknown > 0
                ? `${unknown} recalled batch(es) cannot be named to a product, so no till can refuse them — record the batch's receipt.`
                : 'Every block is on the published catalogue the tills trust.',
          },
        };
      },
    },
  ];
}
