// The recall pack — M10-FR-04 "recall block propagates as priority sync; POS honours cached block", §31, P-01, P-08.
//
// Until now a recall reached the tills only when somebody remembered to publish the catalogue: the recall register said
// "not yet on the pack", and every lane kept selling the batch until a person pressed publish. This is the publish a
// recall makes ITSELF, the moment it is started.
//
// It is deliberately NOT a full rebuild of the catalogue. A full publish carries every price change made since the last
// pack, and a bulk or regulated-product publish needs its own fresh second-factor sign-in (ADR-0013 point 4); a recall
// started by the quality person must not push the buyer's price changes onto the shelf edge as a side effect. So the
// recall pack is the pack the tills ALREADY trust, with one kind of change only: products that must not be sold are
// marked so (`recallBlock`, and which batches, `blockedBatches`). Prices, barcodes, tax and offers are byte-for-byte the
// previous pack's; only the version moves forward, so every lane accepts it as newer.
//
// The change only ever ADDS a block — never lifts one. A recall closed or a hold released comes off the tills on the next
// ordinary publish, by a person (a block lifted by accident is a recalled tin on sale; a block added early is a shelf
// gap). The build time stays the previous pack's: the prices are as old as they were, and the lanes' "catalogue is N
// hours old" stays true (P-08).
//
// Signed and checked by the one `publishPack`, so every refusal that guards a published pack still applies.

import type { CatalogueProduct } from '../../../packages/catalogue/src/catalogue';
import { publishPack, type PackSigner, type SignedPack, type PublishRefusal } from './pack';

export type RecallRepublishResult =
  | { readonly outcome: 'published'; readonly pack: SignedPack; readonly newlyBlocked: readonly string[]; readonly detail: string }
  /** Every product that must not be sold is already blocked on the pack the tills hold — nothing to send. */
  | { readonly outcome: 'already_on_pack'; readonly detail: string }
  | { readonly outcome: 'refused'; readonly because: PublishRefusal; readonly detail: string };

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** One product as the recall pack carries it, or `undefined` when it is unchanged. */
function blockedVersion(p: CatalogueProduct, batches: readonly string[]): CatalogueProduct | undefined {
  // Already blocked whole (the product's own recall flag, or a block that named no batch): nothing can be added.
  if (p.recallBlock === true && (p.blockedBatches === undefined || p.blockedBatches.length === 0)) return undefined;
  if (batches.length === 0) {
    // A block that names no batch blocks the whole product.
    const whole: CatalogueProduct = { ...p, recallBlock: true };
    delete (whole as { blockedBatches?: readonly string[] }).blockedBatches;
    return whole;
  }
  const union = [...new Set([...(p.blockedBatches ?? []), ...batches])].sort();
  if (p.recallBlock === true && sameList([...(p.blockedBatches ?? [])].sort(), union)) return undefined;
  return { ...p, recallBlock: true, blockedBatches: union };
}

/**
 * The pack the tills already trust, re-signed one version on with every product in `blocked` marked not-for-sale (and,
 * where the block names batches, which batches — SF-08 · OB-139 "A"). Products not in the pack are not added: a product
 * no till carries is one no till can sell.
 */
export function republishWithBlocks(input: {
  readonly previous: SignedPack;
  readonly blocked: ReadonlySet<string>;
  /** The blocked batches of a product (empty when the block names none — the whole product is then blocked). */
  readonly batchesOf: (productId: string) => readonly string[];
  readonly signer: PackSigner;
  readonly publishedBy: string;
  readonly publishedAt: string;
}): RecallRepublishResult {
  const { previous } = input;
  const newlyBlocked: string[] = [];
  const products = previous.snapshot.products.map((p) => {
    if (!input.blocked.has(p.productId)) return p;
    const next = blockedVersion(p, input.batchesOf(p.productId));
    if (next === undefined) return p;
    newlyBlocked.push(p.productId);
    return next;
  });
  if (newlyBlocked.length === 0) {
    return { outcome: 'already_on_pack', detail: `catalogue v${previous.snapshot.version} already blocks every product that must not be sold — the tills have it` };
  }
  const result = publishPack({
    snapshot: { ...previous.snapshot, version: previous.snapshot.version + 1, products },
    previous,
    approvals: [],
    signer: input.signer,
    publishedBy: input.publishedBy,
    publishedAt: input.publishedAt,
  });
  if (!result.ok || result.pack === undefined) {
    return { outcome: 'refused', because: result.refusedBecause ?? 'empty_pack', detail: result.detail };
  }
  return {
    outcome: 'published', pack: result.pack, newlyBlocked: newlyBlocked.sort(),
    detail: `catalogue v${result.pack.snapshot.version} blocks ${newlyBlocked.length} more product(s); prices are unchanged from v${previous.snapshot.version}`,
  };
}
