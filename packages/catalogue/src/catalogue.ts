// Local catalogue cache & barcode lookup (M03 / M12 / §31 / §32) — what the lane
// reads to turn a scan into a priced line. Three things make this the POS's
// catalogue rather than a generic map:
//
//  • SPEED — the barcode index is a Map, so a scan is O(1) regardless of catalogue
//    size (backs the sub-second scan / ≤300 ms p95 target, §32).
//  • OFFLINE TRUTH — the cache is a versioned snapshot the lane holds locally
//    (§31: "full from signed versioned local cache; retain last-known-good"), with
//    its build time exposed so staleness is visible (P-08) rather than hidden.
//  • SAFETY AT THE SCAN — a recall-blocked item cannot be scanned EVEN OFFLINE
//    (M10-FR-04), a non-sellable status is refused, and an age-restricted item is
//    flagged so the lane prompts (M12-FR-04).
//
// Variable-weight barcodes (M03-FR-02) are decoded here: a weight- or price-embedded
// barcode carries the item code and the weight/price in its digits, per rules that
// are per-tenant configuration — never hard-coded.

export type ProductStatus = 'draft' | 'active' | 'discontinued' | 'clearance';
export type BarcodeKind = 'standard' | 'weight_embedded' | 'price_embedded' | 'alternate';

/** A product as the lane needs it to price a scan (a slice of the M03 master). */
export interface CatalogueProduct {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly baseUom: string;
  /** Unit price in minor units, resolved into the snapshot for this lane (M05). */
  readonly unitPriceMinor: number;
  /** Tax rate in basis points (from the product's tax class / HSN). */
  readonly taxBps: number;
  /** Maximum retail price, minor units — the ceiling a lane may charge (M05-FR-02). */
  readonly mrpMinor?: number;
  readonly status: ProductStatus;
  /** Stops sale everywhere, honoured offline (M10-FR-04). */
  readonly recallBlock?: boolean;
  /** e.g. { minimumAge: 18 } — the lane prompts before selling (M12-FR-04). */
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
}

export interface CatalogueBarcode {
  readonly code: string;
  readonly productId: string;
  readonly kind: BarcodeKind;
}

/**
 * How a variable-weight/price barcode is laid out — per-tenant configuration
 * (choose-able), never hard-coded. Example (a common EAN-13 scheme):
 * prefix "2", item code at 1..6, value at 7..12, value = grams.
 */
export interface EmbeddedBarcodeRule {
  readonly prefix: string;
  /** Where the item code sits (0-based start, length). */
  readonly itemStart: number;
  readonly itemLength: number;
  /** Where the embedded value sits. */
  readonly valueStart: number;
  readonly valueLength: number;
  /** What the value means: a weight in the UOM's smallest unit, or a price in minor units. */
  readonly valueKind: 'weight' | 'price';
}

/** A versioned catalogue snapshot the lane holds locally (§31). */
export interface CatalogueSnapshot {
  readonly tenantId: string;
  /** Monotonic snapshot version — what the lane can show as "catalogue vN". */
  readonly version: number;
  /** ISO-8601 UTC build time — drives the staleness indicator (P-08). */
  readonly builtAt: string;
  readonly products: readonly CatalogueProduct[];
  readonly barcodes: readonly CatalogueBarcode[];
  /** Embedded-barcode rules for this tenant (may be empty). */
  readonly embeddedRules?: readonly EmbeddedBarcodeRule[];
}

export interface ScanResult {
  readonly product: CatalogueProduct;
  readonly barcodeKind: BarcodeKind;
  /** Quantity to add, in the UOM's smallest unit (1 for a plain each-item). */
  readonly quantityMinor: number;
  /** Set when the barcode carried the price (price_embedded); else undefined. */
  readonly priceOverrideMinor?: number;
  /** True when the lane must prompt for age before selling (M12-FR-04). */
  readonly requiresAgeCheck: boolean;
}

export class UnknownBarcodeError extends Error {
  constructor(code: string) {
    super(`Barcode "${code}" is not in the catalogue.`);
    this.name = 'UnknownBarcodeError';
  }
}

export class ItemNotSellableError extends Error {
  constructor(name: string, status: ProductStatus) {
    super(`"${name}" cannot be sold (status: ${status}).`);
    this.name = 'ItemNotSellableError';
  }
}

export class RecalledItemError extends Error {
  constructor(name: string) {
    super(`"${name}" is under recall and cannot be sold (M10-FR-04) — even offline.`);
    this.name = 'RecalledItemError';
  }
}

/** Statuses a lane may sell. Draft and discontinued items are refused. */
const SELLABLE: readonly ProductStatus[] = ['active', 'clearance'];

/**
 * The lane's local catalogue. Built once from a snapshot (indexing is done up
 * front), then every scan is an O(1) map lookup.
 */
export class CatalogueCache {
  private readonly byBarcode = new Map<string, CatalogueBarcode>();
  private readonly byProductId = new Map<string, CatalogueProduct>();
  private readonly bySku = new Map<string, CatalogueProduct>();
  private readonly rules: readonly EmbeddedBarcodeRule[];

  constructor(private readonly snapshot: CatalogueSnapshot) {
    for (const product of snapshot.products) {
      this.byProductId.set(product.productId, product);
      this.bySku.set(product.sku, product);
    }
    for (const barcode of snapshot.barcodes) {
      this.byBarcode.set(barcode.code, barcode);
    }
    this.rules = snapshot.embeddedRules ?? [];
  }

  /** Snapshot version the lane is running (shown on the lane's about/health view). */
  version(): number {
    return this.snapshot.version;
  }

  /** When this snapshot was built — the input to the staleness indicator (P-08). */
  builtAt(): string {
    return this.snapshot.builtAt;
  }

  /** Age of the cache in seconds at `asOf`; the caller decides what is too old. */
  ageSeconds(asOf: string): number {
    const now = Date.parse(asOf);
    const built = Date.parse(this.snapshot.builtAt);
    if (Number.isNaN(now) || Number.isNaN(built)) {
      throw new RangeError('Catalogue staleness needs valid ISO-8601 timestamps.');
    }
    return Math.max(0, Math.round((now - built) / 1000));
  }

  /** True when the cache is older than the tenant's freshness threshold. */
  isStale(asOf: string, maxAgeSeconds: number): boolean {
    return this.ageSeconds(asOf) > maxAgeSeconds;
  }

  productCount(): number {
    return this.byProductId.size;
  }

  findBySku(sku: string): CatalogueProduct | undefined {
    return this.bySku.get(sku);
  }

  /** Decode an embedded barcode against the tenant's rules, if one matches. */
  private decodeEmbedded(
    code: string,
  ): { rule: EmbeddedBarcodeRule; itemCode: string; value: number } | undefined {
    for (const rule of this.rules) {
      if (!code.startsWith(rule.prefix)) continue;
      const itemCode = code.slice(rule.itemStart, rule.itemStart + rule.itemLength);
      const valueDigits = code.slice(rule.valueStart, rule.valueStart + rule.valueLength);
      if (itemCode.length !== rule.itemLength || valueDigits.length !== rule.valueLength) continue;
      const value = Number(valueDigits);
      if (!Number.isSafeInteger(value)) continue;
      return { rule, itemCode, value };
    }
    return undefined;
  }

  private assertSellable(product: CatalogueProduct): void {
    // Recall is checked first: it blocks the sale regardless of status (M10-FR-04).
    if (product.recallBlock) {
      throw new RecalledItemError(product.name);
    }
    if (!SELLABLE.includes(product.status)) {
      throw new ItemNotSellableError(product.name, product.status);
    }
  }

  private ageCheck(product: CatalogueProduct): boolean {
    const minimumAge = product.regulatedFlags?.['minimumAge'];
    return typeof minimumAge === 'number' && minimumAge > 0;
  }

  /**
   * Resolve a scanned barcode to a priced line. Handles plain barcodes and
   * variable-weight/price barcodes (the embedded value becomes the quantity or the
   * line price). Refuses an unknown code, a non-sellable status, or a recalled item
   * — offline included. O(1).
   */
  scan(code: string): ScanResult {
    const trimmed = code.trim();

    // 1. A direct barcode hit (the common case) — one map lookup.
    const direct = this.byBarcode.get(trimmed);
    if (direct !== undefined) {
      const product = this.byProductId.get(direct.productId);
      if (product === undefined) {
        throw new UnknownBarcodeError(trimmed);
      }
      this.assertSellable(product);
      return {
        product,
        barcodeKind: direct.kind,
        quantityMinor: 1,
        requiresAgeCheck: this.ageCheck(product),
      };
    }

    // 2. A variable-weight / price-embedded barcode, per the tenant's rules.
    const embedded = this.decodeEmbedded(trimmed);
    if (embedded !== undefined) {
      // The item code inside the barcode is matched as a barcode or an SKU.
      const viaBarcode = this.byBarcode.get(embedded.itemCode);
      const product =
        (viaBarcode ? this.byProductId.get(viaBarcode.productId) : undefined) ??
        this.bySku.get(embedded.itemCode);
      if (product !== undefined) {
        this.assertSellable(product);
        const isWeight = embedded.rule.valueKind === 'weight';
        return {
          product,
          barcodeKind: isWeight ? 'weight_embedded' : 'price_embedded',
          // A weight barcode carries the quantity; a price barcode is one unit at that price.
          quantityMinor: isWeight ? embedded.value : 1,
          priceOverrideMinor: isWeight ? undefined : embedded.value,
          requiresAgeCheck: this.ageCheck(product),
        };
      }
    }

    throw new UnknownBarcodeError(trimmed);
  }
}
