// Catalogue snapshot builder (M03 → M05 → the lane, §31) — produces the versioned
// snapshot a lane holds offline. It is the bridge between the master data and
// `CatalogueCache`: for every product it resolves the price the lane should charge
// using the SAME effective-dated precedence engine the rest of the system uses
// (`packages/price-list`: customer > channel > zone > store), attaches the tax class
// rate, and carries the recall flag and status through so the lane can refuse a
// scan safely offline.
//
// Two honesty rules matter here (P-08):
//   • a product with NO resolvable price is EXCLUDED from the snapshot and reported
//     with a reason — it is never shipped priced at zero or at a guessed price;
//   • a product whose price exceeds its MRP is excluded and reported — a lane must
//     never be able to charge above the legal ceiling (M05-FR-02).
// Draft/discontinued products are INCLUDED (marked), so scanning one tells the
// cashier "not sellable" rather than the misleading "unknown barcode".
//
// Pure and deterministic: the caller supplies `asOf` and the snapshot `version`,
// so the same inputs always build the same snapshot (rebuildable, auditable).

import { resolvePrice, type PriceEntry } from '../../price-list/src/price-list';
import type {
  CatalogueBarcode,
  CatalogueProduct,
  CatalogueSnapshot,
  EmbeddedBarcodeRule,
  ProductStatus,
} from './catalogue';

/** A product master record as the builder reads it (a slice of M03). */
export interface MasterProduct {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly baseUom: string;
  readonly taxClassId: string;
  readonly status: ProductStatus;
  readonly mrpMinor?: number;
  readonly recallBlock?: boolean;
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
}

/** Tax classes (HSN/GST) keyed by id, in basis points. */
export type TaxClassRates = Readonly<Record<string, number>>;

/** Where this snapshot is for — drives price precedence (M05-FR-01). */
export interface SnapshotScope {
  readonly tenantId: string;
  readonly storeId: string;
  readonly zoneId?: string;
  readonly channel?: string;
}

export interface BuildSnapshotInput {
  readonly scope: SnapshotScope;
  /** Monotonic snapshot version the lane will report. */
  readonly version: number;
  /** ISO-8601 UTC: both the build stamp and the price-effectiveness instant. */
  readonly asOf: string;
  readonly products: readonly MasterProduct[];
  readonly barcodes: readonly CatalogueBarcode[];
  readonly priceEntries: readonly PriceEntry[];
  readonly taxClasses: TaxClassRates;
  readonly embeddedRules?: readonly EmbeddedBarcodeRule[];
}

export type ExclusionReason = 'no_price' | 'no_tax_class' | 'price_above_mrp';

export interface ExcludedProduct {
  readonly productId: string;
  readonly sku: string;
  readonly reason: ExclusionReason;
}

export interface BuildSnapshotResult {
  readonly snapshot: CatalogueSnapshot;
  /** Products deliberately left out, each with its reason — never silent (P-08). */
  readonly excluded: readonly ExcludedProduct[];
  readonly includedCount: number;
  /** Barcodes dropped because their product was excluded or unknown. */
  readonly droppedBarcodes: number;
}

/**
 * Build the lane's catalogue snapshot. Resolves each product's price through the
 * effective-dated precedence engine at `asOf`, attaches its tax rate, and carries
 * status/recall/age flags. Products that cannot be priced safely are excluded and
 * reported. Barcodes for excluded (or unknown) products are dropped, so a lane can
 * never scan into a product it doesn't hold.
 */
export function buildCatalogueSnapshot(input: BuildSnapshotInput): BuildSnapshotResult {
  const products: CatalogueProduct[] = [];
  const excluded: ExcludedProduct[] = [];

  for (const master of input.products) {
    const taxBps = input.taxClasses[master.taxClassId];
    if (taxBps === undefined) {
      excluded.push({ productId: master.productId, sku: master.sku, reason: 'no_tax_class' });
      continue;
    }

    const priceEntry = resolvePrice(input.priceEntries, {
      productId: master.productId,
      at: input.asOf,
      storeId: input.scope.storeId,
      zoneId: input.scope.zoneId,
      channel: input.scope.channel,
    });
    if (priceEntry === null) {
      // No effective price for this lane — never ship a guessed or zero price.
      excluded.push({ productId: master.productId, sku: master.sku, reason: 'no_price' });
      continue;
    }

    const unitPriceMinor = priceEntry.price.minor;
    if (master.mrpMinor !== undefined && unitPriceMinor > master.mrpMinor) {
      // A lane must never be able to charge above MRP (M05-FR-02).
      excluded.push({ productId: master.productId, sku: master.sku, reason: 'price_above_mrp' });
      continue;
    }

    products.push({
      productId: master.productId,
      sku: master.sku,
      name: master.name,
      baseUom: master.baseUom,
      unitPriceMinor,
      taxBps,
      mrpMinor: master.mrpMinor,
      status: master.status,
      recallBlock: master.recallBlock,
      regulatedFlags: master.regulatedFlags,
    });
  }

  // Keep only barcodes whose product made it into the snapshot.
  const includedIds = new Set(products.map((p) => p.productId));
  const barcodes = input.barcodes.filter((b) => includedIds.has(b.productId));

  return {
    snapshot: {
      tenantId: input.scope.tenantId,
      version: input.version,
      builtAt: input.asOf,
      products,
      barcodes,
      embeddedRules: input.embeddedRules,
    },
    excluded,
    includedCount: products.length,
    droppedBarcodes: input.barcodes.length - barcodes.length,
  };
}
