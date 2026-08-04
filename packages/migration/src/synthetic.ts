// A synthetic legacy dataset (Stage 11 preparation / MG-01…MG-12 / hard rule #7).
//
// EX-02 — lawful export access to the incumbent ERP — is owner action pending, and the owner's
// instruction of 4 August 2026 is explicit: it blocks **real-data extraction**, and it does not
// block synthetic migration testing. So this file generates a legacy dataset to rehearse
// against.
//
// The temptation with a generator like this is to produce clean data, because clean data makes
// the pipeline pass. That would be worthless. **A migration rehearsal that only handles good
// data rehearses nothing**, since the entire cost and risk of a migration lives in the mess —
// and every one of the messes below is drawn from what a fifteen-year-old standalone retail ERP
// actually contains:
//
//   • **The same product entered three times** over the years, with slightly different names,
//     because the person adding it could not find the existing one.
//   • **A barcode on two products.** Usually a weighed-item label reused, occasionally a supplier
//     reusing an EAN.
//   • **Negative stock.** Sales recorded against goods whose receipt was never entered.
//   • **Tax rates that were right in 2019.** Nobody reworked history when GST changed.
//   • **Batches with no expiry date**, entered before the field was made mandatory.
//   • **Customers duplicated by phone number** typed with and without +91.
//   • **Suppliers with the same GSTIN under three names** — the same firm, renamed twice.
//   • **Rounding that does not add up.** Line totals stored to two decimals, the invoice total
//     stored separately, and the two disagreeing by a paisa on 3% of documents.
//   • **Orphans.** Order lines whose order header was deleted years ago.
//
// The generator is **deterministic**: given the same seed it produces the same dataset, which is
// what allows a reconciliation figure to be asserted exactly rather than approximately.
//
// Pure: no I/O, no clock, no randomness beyond the seeded generator.

/** A small deterministic PRNG. Same seed, same dataset, every run, on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The exact damage this generator plants. A rehearsal asserts against these names. */
export type FaultKind =
  | 'duplicate_products'
  | 'shared_barcodes'
  | 'negative_stock'
  | 'stale_tax_codes'
  | 'missing_expiry'
  | 'duplicate_customers'
  | 'duplicate_suppliers_by_gstin'
  | 'document_total_mismatch'
  | 'orphan_lines'
  | 'unmapped_tax_code';

export interface LegacyProduct {
  readonly legacyId: string;
  readonly name: string;
  readonly barcode?: string;
  readonly uom: string;
  /** Legacy tax code, not a rate — mapping has to resolve it (MG-03). */
  readonly taxCode: string;
  readonly costMinor: number;
  readonly priceMinor: number;
  readonly departmentCode: string;
  readonly active: boolean;
}

export interface LegacyStockRow {
  readonly legacyProductId: string;
  readonly locationCode: string;
  readonly batchCode?: string;
  /** May be NEGATIVE — sales against goods whose receipt was never entered. */
  readonly qty: number;
  readonly expiryDate?: string;
  readonly valueMinor: number;
}

export interface LegacyCustomer {
  readonly legacyId: string;
  readonly name: string;
  /** Typed inconsistently: "+91 90000 00001", "9000000001", "09000000001". */
  readonly phone: string;
  readonly loyaltyPoints: number;
  readonly outstandingMinor: number;
}

export interface LegacySupplier {
  readonly legacyId: string;
  readonly name: string;
  readonly gstin?: string;
  readonly outstandingMinor: number;
}

export interface LegacyDocumentLine {
  readonly legacyLineId: string;
  readonly legacyDocumentId: string;
  readonly legacyProductId: string;
  readonly qty: number;
  readonly lineTotalMinor: number;
  readonly taxMinor: number;
}

export interface LegacyDocument {
  readonly legacyId: string;
  readonly kind: 'sale' | 'purchase' | 'return';
  readonly documentDate: string;
  readonly legacyCustomerId?: string;
  readonly legacySupplierId?: string;
  /** Stored separately from the lines, and sometimes disagreeing with them. */
  readonly totalMinor: number;
  readonly taxMinor: number;
}

export interface LegacyDataset {
  readonly seed: number;
  readonly products: readonly LegacyProduct[];
  readonly stock: readonly LegacyStockRow[];
  readonly customers: readonly LegacyCustomer[];
  readonly suppliers: readonly LegacySupplier[];
  readonly documents: readonly LegacyDocument[];
  readonly lines: readonly LegacyDocumentLine[];
  /** What was deliberately broken, so a rehearsal can assert it was FOUND. */
  readonly plantedFaults: Readonly<Record<FaultKind, number>>;
  /**
   * **Which** records were broken, not merely how many.
   *
   * Counts let a rehearsal claim *"found 14 duplicates"* while having found fourteen different
   * ones. Identifying every planted record by id is the difference between testing a detector
   * and testing a coincidence.
   */
  readonly plantedIds: Readonly<Record<FaultKind, readonly string[]>>;
}

export interface GeneratorOptions {
  readonly seed?: number;
  readonly products?: number;
  readonly customers?: number;
  readonly suppliers?: number;
  readonly documents?: number;
  /** Set false only to prove the pipeline is not merely reporting everything as broken. */
  readonly withFaults?: boolean;
}

/**
 * Generate a legacy dataset with **realistic damage**.
 *
 * `plantedFaults` records exactly what was broken and how many times, so a rehearsal asserts
 * *"the pipeline found all 14 duplicate products"* rather than *"the pipeline found some
 * duplicates"*. A migration test that cannot say how many faults existed cannot tell a working
 * detector from a lucky one.
 */
export function generateLegacyDataset(options: GeneratorOptions = {}): LegacyDataset {
  const seed = options.seed ?? 20260805;
  const rand = mulberry32(seed);
  const faults = options.withFaults !== false;

  const productCount = options.products ?? 240;
  const customerCount = options.customers ?? 180;
  const supplierCount = options.suppliers ?? 40;
  const documentCount = options.documents ?? 500;

  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const between = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

  const BRANDS = ['Aachi', 'Sakthi', 'Udhayam', 'Nirapara', 'Anil', 'Priya', 'MTR', 'Double Horse', 'Idhayam', 'Amul', 'Aavin', 'Heritage'];
  const NAMES = ['Rice', 'Atta', 'Sunflower Oil', 'Toor Dal', 'Sugar', 'Tea', 'Coffee', 'Salt', 'Ghee', 'Milk'];
  const GRADES = ['Ponni', 'Sona Masoori', 'Premium', 'Gold', 'Classic', 'Select'];
  const SIZES = ['1kg', '5kg', '500g', '1L', '250g', '2kg'];
  const TAX_CODES = ['T0', 'T5', 'T12', 'T18', 'T28', 'TX'];
  const DEPTS = ['GRO', 'FRE', 'DAI', 'HOU', 'CAF'];
  const LOCATIONS = ['MAIN', 'BACK', 'CAFE'];

  // Counts are DERIVED from these lists, so the two can never drift apart.
  const ids: Record<FaultKind, string[]> = {
    duplicate_products: [],
    shared_barcodes: [],
    negative_stock: [],
    stale_tax_codes: [],
    missing_expiry: [],
    duplicate_customers: [],
    duplicate_suppliers_by_gstin: [],
    document_total_mismatch: [],
    orphan_lines: [],
    unmapped_tax_code: [],
  };

  // ── products ────────────────────────────────────────────────────────────────
  //
  // Base names are DISTINCT BY CONSTRUCTION. A real catalogue names a product
  // "Aachi Rice Ponni 1kg", not "Rice 1kg", and the distinctness matters here for a reason that
  // is about the test and not about realism: if the generator emits genuine name collisions of
  // its own, a duplicate detector cannot be measured, because a finding might be a planted fault
  // or might be the generator's own accident. Every duplicate below is planted, deliberately.
  const usedNames = new Set<string>();
  const distinctName = (): string => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = `${pick(BRANDS)} ${pick(NAMES)} ${pick(GRADES)} ${pick(SIZES)}`;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
    }
    const fallback = `${pick(BRANDS)} ${pick(NAMES)} ${pick(GRADES)} ${pick(SIZES)} ${usedNames.size}`;
    usedNames.add(fallback);
    return fallback;
  };

  const products: LegacyProduct[] = [];
  for (let i = 0; i < productCount; i += 1) {
    const name = distinctName();
    const taxCode = faults && rand() < 0.04 ? 'TX' : pick(TAX_CODES.slice(0, 5));
    const legacyId = `P${String(i + 1).padStart(5, '0')}`;
    if (taxCode === 'TX') ids.unmapped_tax_code.push(legacyId);

    products.push({
      legacyId,
      name,
      barcode: rand() < 0.9 ? `89${String(between(10000000, 99999999))}` : undefined,
      uom: rand() < 0.15 ? 'KG' : 'EA',
      taxCode,
      costMinor: between(2_000, 80_000),
      priceMinor: between(2_500, 120_000),
      departmentCode: pick(DEPTS),
      active: rand() < 0.92,
    });
  }

  if (faults) {
    // The same product entered again, years later, by somebody who could not find it.
    const duplicateCount = Math.max(6, Math.floor(productCount * 0.06));
    for (let i = 0; i < duplicateCount; i += 1) {
      const source = products[between(0, products.length - 1)]!;
      const legacyId = `P${String(products.length + 1).padStart(5, '0')}`;
      products.push({
        ...source,
        legacyId,
        // Slightly different: a trailing space, a different case, an extra word.
        name: i % 3 === 0 ? `${source.name} ` : i % 3 === 1 ? source.name.toUpperCase() : `${source.name} New`,
        barcode: undefined,
      });
      ids.duplicate_products.push(legacyId);
      // The duplicate inherits the source's tax code, including an unmappable one. Recorded
      // here so the planted count is the whole truth — a rehearsal that finds MORE than was
      // planted is as much a broken test as one that finds fewer.
      if (source.taxCode === 'TX') ids.unmapped_tax_code.push(legacyId);
    }

    // A barcode on two products — a reused weighed-item label, or a supplier reusing an EAN.
    const shareCount = Math.max(4, Math.floor(productCount * 0.02));
    for (let i = 0; i < shareCount; i += 1) {
      const donor = products[between(0, productCount - 1)]!;
      if (donor.barcode === undefined) continue;
      const index = between(0, products.length - 1);
      const target = products[index]!;
      if (target.legacyId === donor.legacyId || target.barcode === donor.barcode) continue;
      products[index] = { ...target, barcode: donor.barcode };
      ids.shared_barcodes.push(target.legacyId);
    }
  }

  // ── stock ───────────────────────────────────────────────────────────────────
  const stock: LegacyStockRow[] = [];
  for (const product of products.slice(0, productCount)) {
    for (const locationCode of LOCATIONS) {
      if (rand() > 0.55) continue;
      const negative = faults && rand() < 0.03;
      const qty = negative ? -between(1, 12) : between(0, 400);
      // A stock row has no id of its own in the legacy system — product and location are its key.
      const stockKey = `${product.legacyId}@${locationCode}`;
      if (negative) ids.negative_stock.push(stockKey);

      const perishable = product.departmentCode === 'FRE' || product.departmentCode === 'DAI';
      const missingExpiry = faults && perishable && rand() < 0.18;
      if (missingExpiry) ids.missing_expiry.push(stockKey);

      stock.push({
        legacyProductId: product.legacyId,
        locationCode,
        batchCode: perishable ? `B${between(10000, 99999)}` : undefined,
        qty,
        expiryDate: perishable && !missingExpiry ? `2026-${String(between(9, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}` : undefined,
        valueMinor: Math.abs(qty) * product.costMinor,
      });
    }
  }

  // ── customers ───────────────────────────────────────────────────────────────
  const customers: LegacyCustomer[] = [];
  for (let i = 0; i < customerCount; i += 1) {
    const digits = `9${String(between(100000000, 999999999))}`;
    customers.push({
      legacyId: `C${String(i + 1).padStart(5, '0')}`,
      name: `Customer ${i + 1}`,
      phone: rand() < 0.4 ? `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` : digits,
      loyaltyPoints: between(0, 4_000),
      outstandingMinor: rand() < 0.12 ? between(1_000, 400_000) : 0,
    });
  }

  if (faults) {
    // The same person, added again, because the phone was typed differently.
    const duplicateCount = Math.max(5, Math.floor(customerCount * 0.05));
    for (let i = 0; i < duplicateCount; i += 1) {
      const source = customers[between(0, customerCount - 1)]!;
      const bare = source.phone.replace(/\D/g, '').slice(-10);
      const legacyId = `C${String(customers.length + 1).padStart(5, '0')}`;
      customers.push({
        legacyId,
        name: source.name.toUpperCase(),
        phone: i % 2 === 0 ? `0${bare}` : `+91${bare}`,
        loyaltyPoints: between(0, 500),
        outstandingMinor: 0,
      });
      ids.duplicate_customers.push(legacyId);
    }
  }

  // ── suppliers ───────────────────────────────────────────────────────────────
  const suppliers: LegacySupplier[] = [];
  for (let i = 0; i < supplierCount; i += 1) {
    suppliers.push({
      legacyId: `S${String(i + 1).padStart(4, '0')}`,
      name: `Supplier ${i + 1}`,
      gstin: rand() < 0.85 ? `33AAAAA${String(between(1000, 9999))}A1Z${between(0, 9)}` : undefined,
      outstandingMinor: rand() < 0.3 ? between(10_000, 900_000) : 0,
    });
  }

  if (faults) {
    // The same firm under three names — renamed twice, never merged.
    const duplicateCount = Math.max(3, Math.floor(supplierCount * 0.08));
    for (let i = 0; i < duplicateCount; i += 1) {
      const source = suppliers[between(0, supplierCount - 1)]!;
      if (source.gstin === undefined) continue;
      const legacyId = `S${String(suppliers.length + 1).padStart(4, '0')}`;
      suppliers.push({
        legacyId,
        name: `${source.name} & Sons`,
        gstin: source.gstin,
        outstandingMinor: between(0, 100_000),
      });
      ids.duplicate_suppliers_by_gstin.push(legacyId);
    }
  }

  // ── documents and lines ─────────────────────────────────────────────────────
  const documents: LegacyDocument[] = [];
  const lines: LegacyDocumentLine[] = [];

  for (let i = 0; i < documentCount; i += 1) {
    const legacyId = `D${String(i + 1).padStart(6, '0')}`;
    const kind = rand() < 0.75 ? 'sale' : rand() < 0.9 ? 'purchase' : 'return';
    const lineCount = between(1, 8);

    let net = 0;
    let tax = 0;
    for (let l = 0; l < lineCount; l += 1) {
      const product = products[between(0, productCount - 1)]!;
      const qty = between(1, 6);
      const lineTotalMinor = qty * product.priceMinor;
      const taxMinor = Math.round(lineTotalMinor * 0.05);
      net += lineTotalMinor;
      tax += taxMinor;
      lines.push({
        legacyLineId: `${legacyId}-${l + 1}`,
        legacyDocumentId: legacyId,
        legacyProductId: product.legacyId,
        qty,
        lineTotalMinor,
        taxMinor,
      });
    }

    // Rounding that does not add up: the header total stored separately, drifting.
    const drift = faults && rand() < 0.03 ? (rand() < 0.5 ? 1 : -1) : 0;
    if (drift !== 0) ids.document_total_mismatch.push(legacyId);

    // Some documents predate the last rate revision. Their tax was correct when it was struck
    // and is wrong against today's rate table — which is a MAPPING decision (restate or migrate
    // as-recorded), not a defect to silently fix. Only planted when faults are on, so a clean
    // dataset really is clean and the detector cannot pass by always firing.
    const preRevision = faults && rand() < 0.06;
    if (preRevision) ids.stale_tax_codes.push(legacyId);
    const year = preRevision ? between(2017, 2019) : between(2024, 2026);

    documents.push({
      legacyId,
      kind,
      documentDate: `${year}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
      legacyCustomerId: kind === 'purchase' ? undefined : customers[between(0, customers.length - 1)]!.legacyId,
      legacySupplierId: kind === 'purchase' ? suppliers[between(0, suppliers.length - 1)]!.legacyId : undefined,
      totalMinor: net + tax + drift,
      taxMinor: tax,
    });
  }

  if (faults) {
    // Orphans: lines whose header was deleted years ago.
    const orphanCount = Math.max(4, Math.floor(documentCount * 0.01));
    for (let i = 0; i < orphanCount; i += 1) {
      const product = products[between(0, productCount - 1)]!;
      const legacyLineId = `ORPH-${i + 1}`;
      lines.push({
        legacyLineId,
        legacyDocumentId: `D${String(documentCount + 1000 + i).padStart(6, '0')}`,
        legacyProductId: product.legacyId,
        qty: between(1, 3),
        lineTotalMinor: product.priceMinor,
        taxMinor: Math.round(product.priceMinor * 0.05),
      });
      ids.orphan_lines.push(legacyLineId);
    }
  }

  const plantedFaults = Object.fromEntries(
    (Object.keys(ids) as FaultKind[]).map((k) => [k, ids[k].length]),
  ) as Record<FaultKind, number>;

  return { seed, products, stock, customers, suppliers, documents, lines, plantedFaults, plantedIds: ids };
}

/**
 * A checksum over the dataset, so a rehearsal can prove **the same bytes** were loaded that were
 * extracted (MG-02, chain of custody).
 *
 * Deterministic and dependency-free — the shipped product has no runtime dependencies, and a
 * migration rehearsal is not the place to acquire one.
 */
export function datasetChecksum(dataset: LegacyDataset): string {
  const material = JSON.stringify({
    p: dataset.products.length, s: dataset.stock.length, c: dataset.customers.length,
    u: dataset.suppliers.length, d: dataset.documents.length, l: dataset.lines.length,
    seed: dataset.seed,
    // Money totals, so a truncated or reordered extract changes the checksum.
    stockValue: dataset.stock.reduce((t, r) => t + r.valueMinor, 0),
    docValue: dataset.documents.reduce((t, r) => t + r.totalMinor, 0),
    loyalty: dataset.customers.reduce((t, r) => t + r.loyaltyPoints, 0),
  });

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i += 1) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
