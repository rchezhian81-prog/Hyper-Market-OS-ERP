// MG-05 — the ACTUAL load: a checked, mapped, cleaned extract of the store's real master data goes into a
// named, non-demo, empty tenant through the SAME routes a person uses on the screens — never by writing
// rows into tables. Until this file existed, `POST /v1/migration/trial-loads` was a timing projection
// over declared counts and the only path into the system was one record at a time (the honest gap
// recorded in docs/pilot/STEP-1-REAL-DATA-PLAN.md §4 item 1).
//
// Two pure functions, so every refusal and every step is testable without I/O:
//
//   • `planLoad`    — the guards (hard rule #7, gate G4, MG-02, MG-04, "target prepared empty", a named
//                     operator) and, when they pass, the ORDERED list of route calls with their idempotency
//                     keys: tax classes → products → barcodes → prices → suppliers → customers → one opening
//                     goods receipt. Nothing here is a default: a row the routes would refuse is a PROBLEM
//                     named up front, never a guessed value (P-08).
//   • `executeLoad` — runs a plan through an injected client (the test harness, or the operator's script on
//                     the box) and records what landed, step by step. A failed step is a visible line in the
//                     report, never a silent skip; a re-run replays the same keys and dedups.
//
// Who runs it: a NAMED HUMAN, on a rehearsal target (hard rule #5 — the AI prepares and checks; a person
// loads). The demo tenant is refused by id (G4: demo data cannot mix with real data).

import { assertNonProduction, type LoadTarget } from './trial';
import { validateProduct, CategoryNotFoundError, type Category, type ProductRecord, type RegulatedKind } from '../../product/src/product';
import { validateGstin, InvalidGstinError } from '../../org/src/hierarchy';

const REGULATED: readonly RegulatedKind[] = ['food', 'packed', 'weighed', 'age_restricted', 'drug', 'hazardous'];

// ── The extract, as the CSV mapper hands it over (money and quantities already in minor units) ────────

export interface ExtractCategory {
  readonly categoryId: string;
  readonly name: string;
  readonly parentId: string | null;
  /** food | packed | weighed | age_restricted | drug | hazardous — drives the product engine's safety rules. */
  readonly regulated?: readonly string[];
}

export interface ExtractTaxRate {
  readonly hsnCode: string;
  /** YYYY-MM-DD. */
  readonly effectiveFrom: string;
  /** Basis points: 500 = 5%. */
  readonly rateBps: number;
}

export type BarcodeKind = 'gtin' | 'ean' | 'upc' | 'internal' | 'case' | 'embedded';

export interface ExtractProduct {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly baseUom: string;
  readonly primaryCategoryId: string;
  /** HSN / tax class — must name one of the extract's tax rates. */
  readonly taxClass: string;
  readonly lifecycle: 'new' | 'active' | 'clearance';
  readonly brand?: string;
  /** The product engine's safety content: food needs allergens (an EMPTY list = "declared none") + country of
   *  origin; packed/weighed need net quantity; packed needs packer details; age-restricted needs a minimum age. */
  readonly safety?: {
    readonly ingredients?: string;
    readonly allergens?: readonly string[];
    readonly countryOfOrigin?: string;
    readonly storageConditions?: string;
    readonly netQuantity?: string;
    readonly packerDetails?: string;
    readonly minimumAge?: number;
  };
  readonly barcodes: readonly { readonly code: string; readonly kind: BarcodeKind }[];
  readonly priceMinor: number;
  readonly mrpMinor: number;
  readonly costMinor: number;
  /** 0–9999; the price route refuses a price below cost + floor without an approver. */
  readonly marginFloorBps: number;
}

export interface ExtractSupplier {
  readonly partnerId: string;
  readonly name: string;
  readonly gstin?: string;
}

export interface ExtractCustomer {
  readonly customerId: string;
  /** Opening loyalty balance; 0 or absent appends no points movement. */
  readonly loyaltyPoints?: number;
}

export interface ExtractStockRow {
  readonly productId: string;
  /** GT-05 (MG-08 "stock by location") — the store / warehouse / back-store location the stock sits at. Absent → the load's
   *  `stockLocationId`. Each location gets its OWN opening goods receipt, so its on-hand is that location's, never pooled. */
  readonly locationId?: string;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly unitCostMinor: number;
  readonly batchId?: string;
  /** YYYY-MM-DD. A batch WITHOUT an expiry cannot be received as a batch (the receiving gate refuses it). */
  readonly expiry?: string;
}

/** GT-05 (MG-08 "loyalty/gift balances") — a gift card or store-credit balance still unspent at cutover. */
export interface ExtractStoredValue {
  readonly instrumentId: string;
  readonly kind: 'gift_card' | 'store_credit';
  /** The customer it belongs to — one of the extract's customers. */
  readonly customerId: string;
  /** The UNSPENT balance at the opening date, in paise (never the face value it was sold at). */
  readonly balanceMinor: number;
  /** YYYY-MM-DD, when the instrument carries one. */
  readonly expiresOn?: string;
}

/** GT-05 (MG-08 "outstanding") — a credit customer's invoice still unpaid at cutover (the receivables ledger, M18). */
export interface ExtractReceivable {
  readonly customerId: string;
  readonly invoiceId: string;
  /** The invoice number the customer knows it by. */
  readonly number: string;
  readonly issuedOn: string;
  readonly dueOn: string;
  /** What is still OUTSTANDING on it, in paise. */
  readonly outstandingMinor: number;
}

/** GT-05 (MG-08 "outstanding … accounting openings") — a supplier bill still unpaid at cutover (the supplier account). */
export interface ExtractPayable {
  readonly supplierId: string;
  /** A stable id for the bill in the old system — one opening per id, so a re-run doubles nothing. */
  readonly openingId: string;
  readonly billNumber: string;
  readonly billDate: string;
  readonly dueOn?: string;
  /** What is still OUTSTANDING on it, in paise. */
  readonly outstandingMinor: number;
}

export interface ExtractBundle {
  readonly categories: readonly ExtractCategory[];
  readonly taxRates: readonly ExtractTaxRate[];
  readonly products: readonly ExtractProduct[];
  readonly suppliers: readonly ExtractSupplier[];
  readonly customers: readonly ExtractCustomer[];
  readonly openingStock: readonly ExtractStockRow[];
  /** GT-05 — unspent gift-card / store-credit balances. Optional: an extract without them loads none. */
  readonly storedValue?: readonly ExtractStoredValue[];
  /** GT-05 — credit customers' unpaid invoices. Needs the tenant's B2B feature; refused visibly otherwise. */
  readonly receivables?: readonly ExtractReceivable[];
  /** GT-05 — suppliers' unpaid bills. Recorded against the supplier master; owed once a second person signs the load off. */
  readonly payables?: readonly ExtractPayable[];
}

// ── The request: who, where, under what evidence ─────────────────────────────────────────────────────

export interface LoadRequest {
  /** The target the operator's configuration names; `kind` decides, the label never does (hard rule #7). */
  readonly target: LoadTarget;
  /** The tenant the rows go into — must be the target's tenant, and never a demo tenant (G4). */
  readonly tenantId: string;
  readonly demoTenantIds: readonly string[];
  /** The named human running the load. Blank is refused. */
  readonly operator: string;
  /** Products already in the target — a load goes into a PREPARED, EMPTY tenant (MG-05 precondition). */
  readonly targetProductCount: number;
  /** MG-02: the extract was sealed and its seal verified before anything read it. */
  readonly extractSealed: boolean;
  /** MG-04: blocking exceptions (unmatched tax code, negative stock) still undecided. */
  readonly blockingExceptionsOpen: number;
  /** One load = one idempotency namespace; a re-run with the same id replays the same keys and dedups. */
  readonly loadId: string;
  /** Where the opening stock is received (the store's own location / warehouse id). */
  readonly stockLocationId: string;
  /** YYYY-MM-DD — the physical-count date the opening stock is true at. */
  readonly receivedOnDate: string;
  readonly currency: string;
  /**
   * The tenant's receiving tolerances, SET before the opening receipt when given (`POST /v1/inventory/receipt-policy`,
   * an owner-level step). Since SP-4 (ii) the receipt route takes no policy from the body (F03): the opening stock is
   * measured against the tenant's own policy, or head office's default when none has been set (said on the record).
   */
  readonly receivingPolicy?: { readonly excessToleranceBp: number; readonly shortageToleranceBp: number; readonly nearExpiryDays: number };
}

export type LoadRefusal =
  | 'production_target'
  | 'demo_tenant'
  | 'tenant_mismatch'
  | 'no_operator'
  | 'target_not_empty'
  | 'extract_not_sealed'
  | 'blocking_exceptions_open'
  | 'malformed_rows';

export type LoadGroup = 'tax' | 'product' | 'barcode' | 'price' | 'supplier' | 'customer' | 'stock';

export interface LoadStep {
  readonly group: LoadGroup;
  readonly what: string;
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
}

export interface LoadPlanOk {
  readonly ok: true;
  readonly loadId: string;
  readonly tenantId: string;
  readonly operator: string;
  readonly steps: readonly LoadStep[];
  readonly counts: Readonly<Record<LoadGroup, number>>;
  /** Rows loaded in a reduced form, each said plainly — never silently (P-08). */
  readonly warnings: readonly string[];
}

export interface LoadPlanRefused {
  readonly ok: false;
  readonly refusedBecause: LoadRefusal;
  readonly detail: string;
  /** Every malformed row, not just the first — the operator fixes the file once. */
  readonly problems: readonly string[];
}

export type LoadPlan = LoadPlanOk | LoadPlanRefused;

const isId = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isMinor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The extract's categories in the product engine's shape (regulated kinds already checked by `validateBundle`). */
function engineCategoriesOf(bundle: ExtractBundle): readonly Category[] {
  return bundle.categories.map((c) => ({
    categoryId: c.categoryId, name: c.name, parentId: c.parentId,
    ...(c.regulated === undefined ? {} : { regulated: c.regulated.filter((r): r is RegulatedKind => (REGULATED as readonly string[]).includes(r)) }),
  }));
}

/** The product as the publish route will read it — one shape, used for the pre-check AND the step body. */
function productRecordOf(p: ExtractProduct, tenantId: string): ProductRecord {
  return {
    productId: p.productId, tenantId, sku: p.sku, name: p.name, baseUom: p.baseUom,
    primaryCategoryId: p.primaryCategoryId, taxClass: p.taxClass, lifecycle: p.lifecycle,
    ...(p.brand === undefined ? {} : { brand: p.brand }),
    ...(p.safety === undefined ? {} : { safety: p.safety }),
  };
}

/** The publish route reads the product id from the path and stamps the tenant itself — neither belongs in the body. */
function publishBodyOf(record: ProductRecord): Omit<ProductRecord, 'productId' | 'tenantId'> {
  const body: Record<string, unknown> = { ...record };
  delete body['productId'];
  delete body['tenantId'];
  return body as Omit<ProductRecord, 'productId' | 'tenantId'>;
}

/** Every problem in the bundle, in file order. Empty means the routes will not refuse a row for its shape. */
export function validateBundle(bundle: ExtractBundle): readonly string[] {
  const problems: string[] = [];
  const categories = new Set<string>();
  for (const c of bundle.categories) {
    if (!isId(c.categoryId) || !isId(c.name)) { problems.push(`category "${c.categoryId}": id and name are required`); continue; }
    if (categories.has(c.categoryId)) problems.push(`category "${c.categoryId}": listed twice`);
    categories.add(c.categoryId);
    for (const r of c.regulated ?? []) {
      if (!(REGULATED as readonly string[]).includes(r)) problems.push(`category "${c.categoryId}": regulated kind "${r}" is not one of ${REGULATED.join(', ')}`);
    }
  }
  for (const c of bundle.categories) {
    if (c.parentId !== null && !categories.has(c.parentId)) problems.push(`category "${c.categoryId}": parent "${c.parentId}" is not in the extract`);
  }
  const taxClasses = new Set<string>();
  for (const t of bundle.taxRates) {
    if (!isId(t.hsnCode) || !isDate(t.effectiveFrom) || !Number.isInteger(t.rateBps) || t.rateBps < 0 || t.rateBps > 10_000) {
      problems.push(`tax rate "${t.hsnCode}": needs an HSN code, an effective date (YYYY-MM-DD) and a rate in basis points 0–10000`);
      continue;
    }
    taxClasses.add(t.hsnCode);
  }
  const engineCategories = engineCategoriesOf(bundle);
  const products = new Set<string>();
  const skus = new Map<string, string>();
  const barcodes = new Map<string, string>();
  for (const p of bundle.products) {
    if (!isId(p.productId)) { problems.push('a product row has no item code'); continue; }
    if (products.has(p.productId)) problems.push(`product "${p.productId}": listed twice`);
    products.add(p.productId);
    if (!isId(p.sku)) problems.push(`product "${p.productId}": SKU is required`);
    else if (skus.has(p.sku) && skus.get(p.sku) !== p.productId) problems.push(`product "${p.productId}": SKU "${p.sku}" already belongs to "${skus.get(p.sku)}"`);
    else skus.set(p.sku, p.productId);
    if (!isId(p.name)) problems.push(`product "${p.productId}": description is required`);
    if (!isId(p.baseUom)) problems.push(`product "${p.productId}": unit of measure is required`);
    if (!categories.has(p.primaryCategoryId)) problems.push(`product "${p.productId}": category "${p.primaryCategoryId}" is not in the extract`);
    if (!taxClasses.has(p.taxClass)) problems.push(`product "${p.productId}": HSN / tax class "${p.taxClass}" has no rate in the extract — an unmapped tax code is an exception, never a default`);
    if (!['new', 'active', 'clearance'].includes(p.lifecycle)) problems.push(`product "${p.productId}": lifecycle must be new, active or clearance`);
    // The SAME tested engine the publish route runs (packages/product): mandatory fields, category attributes,
    // and a regulated department's safety content — so a food item with no allergen declaration is a
    // problem in the plan, not a 422 half-way through the load.
    if (categories.has(p.primaryCategoryId)) {
      try {
        const verdict = validateProduct(productRecordOf(p, 'plan'), engineCategories);
        for (const issue of verdict.issues) {
          if (issue.severity === 'blocks_publish') problems.push(`product "${p.productId}": ${issue.message}`);
        }
      } catch (err) {
        if (!(err instanceof CategoryNotFoundError)) throw err;
      }
    }
    if (!isMinor(p.priceMinor) || !isMinor(p.mrpMinor) || !isMinor(p.costMinor)) problems.push(`product "${p.productId}": selling price, MRP and cost must be whole non-negative minor units`);
    else if (p.priceMinor > p.mrpMinor) problems.push(`product "${p.productId}": selling price ${p.priceMinor} is above MRP ${p.mrpMinor} — MRP is a legal ceiling`);
    if (!Number.isInteger(p.marginFloorBps) || p.marginFloorBps < 0 || p.marginFloorBps > 9999) problems.push(`product "${p.productId}": margin floor must be 0–9999 basis points`);
    for (const b of p.barcodes) {
      if (!isId(b.code)) { problems.push(`product "${p.productId}": an empty barcode`); continue; }
      const owner = barcodes.get(b.code);
      if (owner !== undefined && owner !== p.productId) problems.push(`barcode "${b.code}": shared by "${owner}" and "${p.productId}" — one code names exactly one item`);
      barcodes.set(b.code, p.productId);
    }
  }
  const suppliers = new Set<string>();
  const gstins = new Map<string, string>();
  for (const s of bundle.suppliers) {
    if (!isId(s.partnerId) || !isId(s.name)) { problems.push(`supplier "${s.partnerId}": code and name are required`); continue; }
    if (suppliers.has(s.partnerId)) problems.push(`supplier "${s.partnerId}": listed twice`);
    suppliers.add(s.partnerId);
    // GT-06 (Batch 2): a supplier's GST identity is checked here — a malformed or mistyped GSTIN, or one GSTIN on two
    // supplier codes, is a named problem before anything is sent (never loaded and "fixed later").
    if (s.gstin !== undefined) {
      try {
        const gstin = validateGstin(s.gstin);
        const holder = gstins.get(gstin);
        if (holder !== undefined && holder !== s.partnerId) problems.push(`supplier "${s.partnerId}": GSTIN ${gstin} is also supplier "${holder}" — one registration is one supplier; merge them in the cleaning step first`);
        gstins.set(gstin, s.partnerId);
      } catch (err) {
        if (!(err instanceof InvalidGstinError)) throw err;
        problems.push(`supplier "${s.partnerId}": ${err.message}`);
      }
    }
  }
  const customers = new Set<string>();
  for (const c of bundle.customers) {
    if (!isId(c.customerId)) { problems.push('a customer row has no customer code'); continue; }
    if (customers.has(c.customerId)) problems.push(`customer "${c.customerId}": listed twice`);
    customers.add(c.customerId);
    if (c.loyaltyPoints !== undefined && (!Number.isInteger(c.loyaltyPoints) || c.loyaltyPoints < 0)) problems.push(`customer "${c.customerId}": loyalty points must be a whole non-negative number`);
  }
  const stockKeys = new Map<string, number>();
  bundle.openingStock.forEach((r, i) => {
    if (r.locationId !== undefined && !isId(r.locationId)) problems.push(`opening stock row ${i + 1} (${r.productId}): location, when given, must name a location`);
    // GT-05: the same product at the same location in the same batch twice would be received twice — a double count the
    // old system's figure never had. Merge the rows in the cleaning step (MG-04).
    const stockKey = `${r.productId}|${r.locationId ?? ''}|${r.batchId ?? ''}`;
    const first = stockKeys.get(stockKey);
    if (first !== undefined) problems.push(`opening stock row ${i + 1} (${r.productId}): same product, location and batch as row ${first} — receiving both would count it twice`);
    else stockKeys.set(stockKey, i + 1);
    if (!products.has(r.productId)) problems.push(`opening stock row ${i + 1}: product "${r.productId}" is not in the extract`);
    if (!Number.isInteger(r.quantityMinor) || r.quantityMinor <= 0) problems.push(`opening stock row ${i + 1} (${r.productId}): quantity must be a positive whole number of minor units`);
    if (!isMinor(r.unitCostMinor)) problems.push(`opening stock row ${i + 1} (${r.productId}): unit cost must be whole non-negative minor units`);
    if (!isId(r.uom)) problems.push(`opening stock row ${i + 1} (${r.productId}): unit of measure is required`);
    if (r.expiry !== undefined && !isDate(r.expiry)) problems.push(`opening stock row ${i + 1} (${r.productId}): expiry must be YYYY-MM-DD`);
  });
  const instruments = new Set<string>();
  (bundle.storedValue ?? []).forEach((v, i) => {
    const at = `stored value row ${i + 1} (${String(v.instrumentId)})`;
    if (!isId(v.instrumentId)) { problems.push(`stored value row ${i + 1}: an instrument id is required`); return; }
    if (instruments.has(v.instrumentId)) problems.push(`${at}: listed twice — the same card loaded twice would be value nobody paid for`);
    instruments.add(v.instrumentId);
    if (v.kind !== 'gift_card' && v.kind !== 'store_credit') problems.push(`${at}: kind must be gift_card or store_credit`);
    if (!customers.has(v.customerId)) problems.push(`${at}: customer "${v.customerId}" is not in the extract`);
    if (!Number.isSafeInteger(v.balanceMinor) || v.balanceMinor <= 0) problems.push(`${at}: the unspent balance must be whole paise above 0 (a spent card is not opened)`);
    if (v.expiresOn !== undefined && !isDate(v.expiresOn)) problems.push(`${at}: expiry must be YYYY-MM-DD`);
  });
  const receivableIds = new Set<string>();
  (bundle.receivables ?? []).forEach((r, i) => {
    const at = `receivable row ${i + 1} (${String(r.customerId)}/${String(r.invoiceId)})`;
    if (!isId(r.invoiceId) || !isId(r.customerId)) { problems.push(`receivable row ${i + 1}: customer and invoice id are required`); return; }
    const key = `${r.customerId}|${r.invoiceId}`;
    if (receivableIds.has(key)) problems.push(`${at}: listed twice`);
    receivableIds.add(key);
    if (!customers.has(r.customerId)) problems.push(`${at}: customer "${r.customerId}" is not in the extract`);
    if (!isId(r.number)) problems.push(`${at}: the invoice number is required`);
    if (!isDate(r.issuedOn) || !isDate(r.dueOn)) problems.push(`${at}: issue and due dates must be YYYY-MM-DD`);
    else if (r.dueOn < r.issuedOn) problems.push(`${at}: due ${r.dueOn} is before it was issued ${r.issuedOn}`);
    if (!Number.isSafeInteger(r.outstandingMinor) || r.outstandingMinor <= 0) problems.push(`${at}: the outstanding amount must be whole paise above 0 (a paid invoice is history, not an opening)`);
  });
  const openingIds = new Set<string>();
  (bundle.payables ?? []).forEach((p, i) => {
    const at = `payable row ${i + 1} (${String(p.supplierId)}/${String(p.openingId)})`;
    if (!isId(p.openingId) || !isId(p.supplierId)) { problems.push(`payable row ${i + 1}: supplier and opening id are required`); return; }
    if (openingIds.has(p.openingId)) problems.push(`${at}: opening id listed twice`);
    openingIds.add(p.openingId);
    if (!suppliers.has(p.supplierId)) problems.push(`${at}: supplier "${p.supplierId}" is not in the extract — a balance is owed to a supplier the master holds`);
    if (!isId(p.billNumber)) problems.push(`${at}: the bill number is required`);
    if (!isDate(p.billDate)) problems.push(`${at}: the bill date must be YYYY-MM-DD`);
    if (p.dueOn !== undefined && !isDate(p.dueOn)) problems.push(`${at}: the due date must be YYYY-MM-DD`);
    if (!Number.isSafeInteger(p.outstandingMinor) || p.outstandingMinor <= 0) problems.push(`${at}: the outstanding amount must be whole paise above 0`);
  });
  return problems;
}

/** The opening-stock rows grouped by the location each opens at — the load's own location first, then in file order. */
export function stockByLocation(bundle: ExtractBundle, defaultLocationId: string): ReadonlyMap<string, readonly ExtractStockRow[]> {
  const out = new Map<string, ExtractStockRow[]>();
  if (bundle.openingStock.some((r) => (r.locationId ?? defaultLocationId) === defaultLocationId)) out.set(defaultLocationId, []);
  for (const r of bundle.openingStock) {
    const loc = r.locationId ?? defaultLocationId;
    out.set(loc, [...(out.get(loc) ?? []), r]);
  }
  return out;
}

/** The goods-receipt id an opening location is received under — stable, so a re-run lands on the same receipt. */
export const openingGrnId = (loadId: string, locationId: string, defaultLocationId: string): string =>
  locationId === defaultLocationId ? `opening-${loadId}` : `opening-${loadId}-${locationId}`;

/**
 * The guards, then the ordered route calls. Refusals come first and each is its own reason, because
 * the operator has to fix exactly one thing.
 */
export function planLoad(bundle: ExtractBundle, req: LoadRequest): LoadPlan {
  const refuse = (refusedBecause: LoadRefusal, detail: string, problems: readonly string[] = []): LoadPlanRefused =>
    ({ ok: false, refusedBecause, detail, problems });

  const assertion = assertNonProduction(req.target);
  if (!assertion.permitted) return refuse('production_target', assertion.detail);
  if (req.demoTenantIds.includes(req.tenantId)) {
    return refuse('demo_tenant', `tenant "${req.tenantId}" is a demo tenant — real data never goes into it (pilot gate G4: demo data cannot mix with real data). Name the real tenant the written GO created.`);
  }
  if (req.tenantId !== req.target.tenantId) {
    return refuse('tenant_mismatch', `the load names tenant "${req.tenantId}" but the target "${req.target.label}" is for tenant "${req.target.tenantId}" — a load cannot point at one tenant under another's target`);
  }
  if (req.operator.trim() === '') {
    return refuse('no_operator', 'a load with nobody\'s name on it cannot be questioned when the figures come out wrong');
  }
  if (req.targetProductCount > 0) {
    return refuse('target_not_empty', `the target already holds ${req.targetProductCount} product(s) — a load goes into a PREPARED, EMPTY tenant; rehearse on a fresh one, or run the delta (MG-09) for changes since the extract`);
  }
  if (!req.extractSealed) {
    return refuse('extract_not_sealed', 'the extract has not been sealed and verified (MG-02) — nothing reads an extract whose seal cannot be checked');
  }
  if (req.blockingExceptionsOpen > 0) {
    return refuse('blocking_exceptions_open', `${req.blockingExceptionsOpen} blocking exception(s) are still undecided (MG-04) — an unmatched tax code or negative stock must be decided by the owner in writing before anything loads`);
  }
  const problems = [...validateBundle(bundle)];
  // GT-05: a batch already past its expiry on the count date is not opening stock — the receiving gate would refuse it,
  // and the old system's figure would silently not arrive. It is a cleaning decision (write it off in the old books).
  bundle.openingStock.forEach((r, i) => {
    if (r.expiry !== undefined && isDate(r.expiry) && r.expiry < req.receivedOnDate) {
      problems.push(`opening stock row ${i + 1} (${r.productId}${r.batchId === undefined ? '' : ` batch ${r.batchId}`}): expired ${r.expiry}, before the count date ${req.receivedOnDate} — write it off in the cleaning step, it cannot open as stock`);
    }
  });
  if (problems.length > 0) {
    return refuse('malformed_rows', `${problems.length} row(s) the routes would refuse — fix the file once, then plan again`, problems);
  }

  const key = (s: string): string => `${req.loadId}-${s}`;
  const steps: LoadStep[] = [];
  const warnings: string[] = [];
  const categories = engineCategoriesOf(bundle);

  for (const t of bundle.taxRates) {
    steps.push({
      group: 'tax', what: `tax rate ${t.hsnCode}@${t.effectiveFrom}`,
      path: `/v1/catalogue/tax-classes/${encodeURIComponent(t.hsnCode)}/rates/${encodeURIComponent(t.effectiveFrom)}`,
      body: { rateBps: t.rateBps }, idempotencyKey: key(`tax-${t.hsnCode}-${t.effectiveFrom}`),
    });
  }
  for (const p of bundle.products) {
    steps.push({
      group: 'product', what: `product ${p.productId}`,
      path: `/v1/catalogue/products/${encodeURIComponent(p.productId)}/publish`,
      body: { product: publishBodyOf(productRecordOf(p, req.tenantId)), categories },
      idempotencyKey: key(`product-${p.productId}`),
    });
  }
  for (const p of bundle.products) {
    for (const b of p.barcodes) {
      steps.push({
        group: 'barcode', what: `barcode ${b.code} → ${p.productId}`,
        path: `/v1/catalogue/products/${encodeURIComponent(p.productId)}/barcodes/${encodeURIComponent(b.code)}`,
        body: { kind: b.kind }, idempotencyKey: key(`barcode-${b.code}`),
      });
    }
  }
  for (const p of bundle.products) {
    steps.push({
      group: 'price', what: `price ${p.productId}`,
      path: '/v1/prices/changes',
      // SF-01: the store whose stock this load opens is the store these prices are for — so a migrated price is the one
      // that store's tills charge from the next published pack (before, it was recorded and never reached a till).
      body: { productId: p.productId, priceMinor: p.priceMinor, mrpMinor: p.mrpMinor, costMinor: p.costMinor, currency: req.currency, marginFloorBps: p.marginFloorBps, storeId: req.stockLocationId },
      idempotencyKey: key(`price-${p.productId}`),
    });
  }
  for (const s of bundle.suppliers) {
    // GT-06 (Batch 2): a migrated supplier goes into the SUPPLIER MASTER — its name and GSTIN, through the same route a buyer
    // uses — so it can be read back and chosen on a purchase order. It arrives PROPOSED: finance approves it (maker ≠
    // approver, M06-FR-01), and its bank details are verified separately. No portal grant and no login are created here:
    // those are configured later, by a person, when the supplier is onboarded to the portal (M24). Nothing lets anyone in.
    steps.push({
      group: 'supplier', what: `supplier ${s.partnerId}`,
      path: `/v1/purchase/suppliers/${encodeURIComponent(s.partnerId)}`,
      body: { name: s.name.trim(), ...(s.gstin === undefined ? {} : { gstin: validateGstin(s.gstin) }) },
      idempotencyKey: key(`supplier-${s.partnerId}`),
    });
  }
  for (const p of bundle.payables ?? []) {
    // GT-05: a supplier bill still unpaid goes into the supplier's ACCOUNT as an opening balance — owed once a second
    // person signs the load off against the old system's creditors' total (POST /v1/purchase/opening-balances/sign-off/:loadId).
    steps.push({
      group: 'supplier', what: `supplier opening ${p.supplierId}/${p.openingId}`,
      path: `/v1/purchase/suppliers/${encodeURIComponent(p.supplierId)}/opening-balances/${encodeURIComponent(p.openingId)}`,
      body: { billNumber: p.billNumber, billDate: p.billDate, ...(p.dueOn === undefined ? {} : { dueOn: p.dueOn }), amountMinor: p.outstandingMinor, openingDate: req.receivedOnDate, loadId: req.loadId },
      idempotencyKey: key(`supplier-opening-${p.openingId}`),
    });
  }
  for (const c of bundle.customers) {
    // A migrated customer arrives with NO marketing consent (docs/requirements/data-requirements.md:
    // re-consent is a campaign, not a field) — recorded as such, with the evidence stated.
    steps.push({
      group: 'customer', what: `customer ${c.customerId}`,
      path: `/v1/customers/${encodeURIComponent(c.customerId)}/consent`,
      body: { purpose: 'marketing', channel: 'sms', given: false, evidence: `migrated from the legacy ERP under load ${req.loadId}: no consent on record` },
      idempotencyKey: key(`consent-${c.customerId}`),
    });
    if (c.loyaltyPoints !== undefined && c.loyaltyPoints > 0) {
      steps.push({
        group: 'customer', what: `customer points ${c.customerId}`,
        path: `/v1/customers/${encodeURIComponent(c.customerId)}/points`,
        body: { movementId: `${req.loadId}-opening-${c.customerId}`, kind: 'earn', points: c.loyaltyPoints, sourceRef: `opening balance from the legacy ERP (load ${req.loadId})` },
        idempotencyKey: key(`points-${c.customerId}`),
      });
    }
  }
  for (const v of bundle.storedValue ?? []) {
    // GT-05: an unspent gift card / store credit opens as an instrument with its UNSPENT balance — the stored-value
    // liability the shop carries over, spendable from day one.
    steps.push({
      group: 'customer', what: `${v.kind.replace('_', ' ')} ${v.instrumentId} (${v.customerId})`,
      path: '/v1/stored-value/instruments',
      body: { instrumentId: v.instrumentId, kind: v.kind, ownerRef: v.customerId, faceValueMinor: v.balanceMinor, channel: 'store', ...(v.expiresOn === undefined ? {} : { expiresOn: v.expiresOn }) },
      idempotencyKey: key(`stored-value-${v.instrumentId}`),
    });
  }
  for (const r of bundle.receivables ?? []) {
    // GT-05: a credit customer's unpaid invoice opens on the receivables ledger at what is still outstanding — aged from its
    // own due date, so collections chase it from day one.
    steps.push({
      group: 'customer', what: `receivable ${r.customerId}/${r.invoiceId}`,
      path: `/v1/b2b/collections/${encodeURIComponent(r.customerId)}/invoices/${encodeURIComponent(r.invoiceId)}`,
      body: { number: r.number, issuedOn: r.issuedOn, dueOn: r.dueOn, grossMinor: r.outstandingMinor },
      idempotencyKey: key(`receivable-${r.customerId}-${r.invoiceId}`),
    });
  }
  if (bundle.openingStock.length > 0) {
    // One opening goods receipt through the REAL receiving gate. A product is received as batch-tracked
    // only when EVERY one of its rows carries a batch AND an expiry — the gate refuses a batch it cannot
    // identify — otherwise its rows load unbatched and each dropped batch is said here.
    const rowsOf = new Map<string, ExtractStockRow[]>();
    for (const r of bundle.openingStock) rowsOf.set(r.productId, [...(rowsOf.get(r.productId) ?? []), r]);
    const batchTracked = new Map<string, boolean>();
    for (const [productId, rows] of rowsOf) {
      const tracked = rows.every((r) => isId(r.batchId) && isDate(r.expiry));
      batchTracked.set(productId, tracked);
      if (!tracked) {
        for (const r of rows) {
          if (isId(r.batchId)) warnings.push(`opening stock ${productId} batch "${r.batchId}": loaded WITHOUT its batch — a batch needs an expiry to be received as a batch; supply the expiry to track it`);
        }
      }
    }
    if (req.receivingPolicy !== undefined) {
      steps.push({
        group: 'stock', what: 'receiving tolerance policy',
        path: '/v1/inventory/receipt-policy',
        body: { ...req.receivingPolicy },
        idempotencyKey: key('receipt-policy'),
      });
    }
    // The product rules (what is batch-tracked) and the tolerances are head office's own (F03, SP-4 (ii)) — the body
    // carries the counted lines only; the gate reads the rule from the published product master.
    // GT-05: ONE opening receipt per LOCATION (MG-08 "stock by location"), each its own ledger receipt at its own place.
    const lineNo = new Map<ExtractStockRow, number>();
    bundle.openingStock.forEach((r, i) => lineNo.set(r, i + 1));
    for (const [locationId, rows] of stockByLocation(bundle, req.stockLocationId)) {
      const own = locationId === req.stockLocationId;
      steps.push({
        group: 'stock', what: `opening stock (${rows.length} line(s)) at ${locationId}`,
        path: `/v1/inventory/goods-receipt/${encodeURIComponent(openingGrnId(req.loadId, locationId, req.stockLocationId))}`,
        body: {
          warehouseId: locationId,
          receivedOnDate: req.receivedOnDate,
          currency: req.currency,
          lines: rows.map((r) => ({
            lineId: `L${lineNo.get(r)!}`, productId: r.productId, orderedMinor: r.quantityMinor, countedMinor: r.quantityMinor,
            uom: r.uom, unitCost: { minor: r.unitCostMinor, currency: req.currency }, condition: 'good',
            ...(batchTracked.get(r.productId) === true ? { batchId: r.batchId, expiry: r.expiry } : {}),
          })),
        },
        idempotencyKey: key(own ? 'opening-stock' : `opening-stock-${locationId}`),
      });
    }
  }

  const counts: Record<LoadGroup, number> = { tax: 0, product: 0, barcode: 0, price: 0, supplier: 0, customer: 0, stock: 0 };
  for (const s of steps) counts[s.group] += 1;
  return { ok: true, loadId: req.loadId, tenantId: req.tenantId, operator: req.operator, steps, counts, warnings };
}

// ── Execution over an injected client ────────────────────────────────────────────────────────────────

/** The one call a load needs. The integration test harness satisfies it in-process; the operator's script wraps HTTP. */
export interface LoadClient {
  request(input: {
    readonly method: 'POST';
    readonly path: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface LoadStepOutcome {
  readonly group: LoadGroup;
  readonly what: string;
  readonly ok: boolean;
  readonly status: number;
  readonly detail?: string;
}

export interface LoadReport {
  readonly loadId: string;
  readonly tenantId: string;
  readonly operator: string;
  readonly steps: readonly LoadStepOutcome[];
  readonly landed: Readonly<Record<LoadGroup, number>>;
  readonly failed: Readonly<Record<LoadGroup, number>>;
  readonly ok: boolean;
}

const OK = new Set([200, 201, 202]);

function detailOf(body: unknown): string | undefined {
  const err = (body as { error?: { code?: string; whatHappened?: string } } | undefined)?.error;
  if (err === undefined) return undefined;
  return [err.code, err.whatHappened].filter((x): x is string => typeof x === 'string' && x !== '').join(': ') || undefined;
}

/**
 * Run the plan, in order, as the named operator. Every step's outcome is recorded — a refusal from a
 * route (a regulated product missing its safety content, a price below cost with no approver, a batch
 * with no expiry) is a visible line the operator works through, never a reason to stop the rest, unless
 * `stopOnFirstFailure` is set. The report's `ok` is true only when every step landed.
 */
export async function executeLoad(
  client: LoadClient,
  plan: LoadPlanOk,
  options: { readonly stopOnFirstFailure?: boolean } = {},
): Promise<LoadReport> {
  const outcomes: LoadStepOutcome[] = [];
  const landed: Record<LoadGroup, number> = { tax: 0, product: 0, barcode: 0, price: 0, supplier: 0, customer: 0, stock: 0 };
  const failed: Record<LoadGroup, number> = { tax: 0, product: 0, barcode: 0, price: 0, supplier: 0, customer: 0, stock: 0 };
  for (const step of plan.steps) {
    const res = await client.request({ method: 'POST', path: step.path, userId: plan.operator, tenantId: plan.tenantId, body: step.body, idempotencyKey: step.idempotencyKey });
    const ok = OK.has(res.status);
    const detail = ok ? undefined : detailOf(res.body);
    outcomes.push({ group: step.group, what: step.what, ok, status: res.status, ...(detail === undefined ? {} : { detail }) });
    if (ok) landed[step.group] += 1; else failed[step.group] += 1;
    if (!ok && options.stopOnFirstFailure === true) break;
  }
  return { loadId: plan.loadId, tenantId: plan.tenantId, operator: plan.operator, steps: outcomes, landed, failed, ok: outcomes.length === plan.steps.length && outcomes.every((o) => o.ok) };
}

// ── GT-05 read-back: the opening state as the DOMAINS now report it, against the extract (MG-06 · MG-08) ─────────────
//
// A load that "returned 201" has not been proven. The proof is reading every opening back through the routes the shop runs
// on — the stock ledger's availability and valuation, the receipt's batch lines, the loyalty, stored-value and receivables
// ledgers, the supplier opening register — and comparing each figure, per location / batch / account, to the extract. Every
// line says what was expected, what the system holds and whether they agree; one disagreement fails the whole read-back.

/** A GET as the named operator — the test harness in-process, or the operator's script over HTTP. */
export interface ReadBackClient {
  request(input: {
    readonly method: 'GET';
    readonly path: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly query?: Readonly<Record<string, string>>;
  }): Promise<{ readonly status: number; readonly body: unknown }>;
}

export type OpeningDomain = 'stock_location' | 'stock_batch' | 'stock_value' | 'points' | 'stored_value' | 'receivable' | 'payable';

export interface OpeningCheckLine {
  readonly domain: OpeningDomain;
  /** What is compared: `product@location`, `product@location#batch`, a product's value, a customer, an instrument, a supplier. */
  readonly key: string;
  readonly expected: number;
  /** What the system reports — `null` when it reports nothing at all for this key (never read as zero). */
  readonly actual: number | null;
  readonly agrees: boolean;
  readonly note?: string;
}

export interface OpeningReadBack {
  readonly loadId: string;
  readonly lines: readonly OpeningCheckLine[];
  readonly differences: readonly OpeningCheckLine[];
  /** Per domain: Σ expected and Σ actual (a null actual adds 0 here — its line still disagrees). */
  readonly totals: Readonly<Partial<Record<OpeningDomain, { readonly expected: number; readonly actual: number }>>>;
  /** Every supplier opening of this load is signed off by a second person — until then they are recorded, not owed. */
  readonly payablesSignedOff: boolean;
  readonly agrees: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Read the opening state back through the API and compare it to the extract. Pure apart from the injected client. The
 * tenant should hold only this load's openings (a rehearsal / cutover tenant): any other activity shows as a difference,
 * which is the point — an opening figure nobody can explain is exactly what MG-08 exists to stop.
 */
export async function readBackOpening(
  client: ReadBackClient,
  bundle: ExtractBundle,
  req: Pick<LoadRequest, 'tenantId' | 'operator' | 'loadId' | 'stockLocationId' | 'receivedOnDate'>,
): Promise<OpeningReadBack> {
  const get = async (path: string, query?: Readonly<Record<string, string>>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await client.request({ method: 'GET', path, userId: req.operator, tenantId: req.tenantId, ...(query === undefined ? {} : { query }) });
    return { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
  };
  const lines: OpeningCheckLine[] = [];
  const line = (domain: OpeningDomain, key: string, expected: number, actual: number | null, note?: string, agrees = actual === expected): void => {
    lines.push({ domain, key, expected, actual, agrees, ...(note === undefined ? {} : { note }) });
  };

  // Stock — by location (the ledger's availability), by batch (each location's opening receipt), and by value.
  const byLocation = stockByLocation(bundle, req.stockLocationId);
  if (bundle.openingStock.length > 0) {
    const avail = await get('/v1/inventory/availability');
    const rows = (Array.isArray(avail.body['rows']) ? avail.body['rows'] : []) as { productId?: unknown; locationId?: unknown; onHandMinor?: unknown }[];
    const expectedAt = new Map<string, number>();
    for (const [loc, rs] of byLocation) for (const r of rs) expectedAt.set(`${r.productId}@${loc}`, (expectedAt.get(`${r.productId}@${loc}`) ?? 0) + r.quantityMinor);
    for (const [key, expected] of expectedAt) {
      const row = rows.find((x) => `${String(x.productId)}@${String(x.locationId)}` === key);
      line('stock_location', key, expected, row === undefined ? null : num(row.onHandMinor));
    }
    for (const [loc, rs] of byLocation) {
      const grnId = openingGrnId(req.loadId, loc, req.stockLocationId);
      const grn = await get(`/v1/inventory/goods-receipt/${encodeURIComponent(grnId)}`);
      const captured = ((grn.body['grn'] as { captured?: { lines?: unknown } } | undefined)?.captured?.lines ?? []) as {
        productId?: unknown; batchId?: unknown; sellableMinor?: unknown; quarantinedMinor?: unknown; heldMinor?: unknown;
      }[];
      for (const r of rs) {
        if (r.batchId === undefined) continue;
        const key = `${r.productId}@${loc}#${r.batchId}`;
        const got = Array.isArray(captured) ? captured.filter((l) => l.productId === r.productId && l.batchId === r.batchId) : [];
        if (grn.status !== 200 || got.length === 0) {
          line('stock_batch', key, r.quantityMinor, null, grn.status === 200 ? 'received WITHOUT its batch' : `opening receipt ${grnId} not readable (${grn.status})`);
          continue;
        }
        const inBuilding = got.reduce((s, l) => s + (num(l.sellableMinor) ?? 0) + (num(l.quarantinedMinor) ?? 0) + (num(l.heldMinor) ?? 0), 0);
        const held = got.reduce((s, l) => s + (num(l.quarantinedMinor) ?? 0), 0);
        line('stock_batch', key, r.quantityMinor, inBuilding, held > 0 ? `${held} held in quarantine on receipt (near its expiry) — counted, not sellable` : undefined);
      }
    }
    const valuation = await get('/v1/inventory/valuation');
    const vrows = (Array.isArray(valuation.body['rows']) ? valuation.body['rows'] : []) as { productId?: unknown; value?: { minor?: unknown } }[];
    const expectedValue = new Map<string, number>();
    for (const r of bundle.openingStock) expectedValue.set(r.productId, (expectedValue.get(r.productId) ?? 0) + r.quantityMinor * r.unitCostMinor);
    for (const [productId, expected] of expectedValue) {
      const mine = vrows.filter((x) => x.productId === productId);
      line('stock_value', productId, expected, mine.length === 0 ? null : mine.reduce((s, x) => s + (num(x.value?.minor) ?? 0), 0));
    }
  }

  // Loyalty points and stored value — per customer, per instrument (and the instrument must belong to that customer).
  for (const c of bundle.customers) {
    if (c.loyaltyPoints === undefined || c.loyaltyPoints === 0) continue;
    const res = await get(`/v1/customers/${encodeURIComponent(c.customerId)}/points`);
    line('points', c.customerId, c.loyaltyPoints, res.status === 200 ? num(res.body['pointsBalance']) : null);
  }
  for (const v of bundle.storedValue ?? []) {
    const res = await get(`/v1/stored-value/instruments/${encodeURIComponent(v.instrumentId)}`);
    const actual = res.status === 200 ? num(res.body['balanceMinor']) : null;
    const wrongOwner = res.status === 200 && res.body['ownerRef'] !== v.customerId;
    line('stored_value', v.instrumentId, v.balanceMinor, actual,
      wrongOwner ? `belongs to ${String(res.body['ownerRef'])}, not ${v.customerId}` : undefined, actual === v.balanceMinor && !wrongOwner);
  }

  // Receivables — per credit customer, the outstanding the ageing reports.
  const receivableBy = new Map<string, number>();
  for (const r of bundle.receivables ?? []) receivableBy.set(r.customerId, (receivableBy.get(r.customerId) ?? 0) + r.outstandingMinor);
  for (const [customerId, expected] of receivableBy) {
    const res = await get(`/v1/b2b/collections/${encodeURIComponent(customerId)}/ageing`, { asOf: req.receivedOnDate });
    line('receivable', customerId, expected, res.status === 200 ? num(res.body['totalOutstandingMinor']) : null, res.status === 200 ? undefined : `ageing not readable (${res.status})`);
  }

  // Payables — per supplier, the openings recorded under this load; and whether a second person has signed them off.
  let payablesSignedOff = true;
  const payableBy = new Map<string, number>();
  for (const p of bundle.payables ?? []) payableBy.set(p.supplierId, (payableBy.get(p.supplierId) ?? 0) + p.outstandingMinor);
  if (payableBy.size > 0) {
    const res = await get('/v1/purchase/opening-balances', { loadId: req.loadId });
    const openings = (Array.isArray(res.body['openings']) ? res.body['openings'] : []) as { supplierId?: unknown; amountMinor?: unknown; signed?: unknown }[];
    payablesSignedOff = openings.length > 0 && openings.every((o) => o.signed === true);
    for (const [supplierId, expected] of payableBy) {
      const mine = openings.filter((o) => o.supplierId === supplierId);
      line('payable', supplierId, expected, mine.length === 0 ? null : mine.reduce((s, o) => s + (num(o.amountMinor) ?? 0), 0),
        mine.some((o) => o.signed !== true) ? 'recorded, awaiting a second person\'s sign-off — not owed until then' : undefined);
    }
  }

  const totals: Partial<Record<OpeningDomain, { expected: number; actual: number }>> = {};
  for (const l of lines) {
    const t = totals[l.domain] ?? { expected: 0, actual: 0 };
    totals[l.domain] = { expected: t.expected + l.expected, actual: t.actual + (l.actual ?? 0) };
  }
  const differences = lines.filter((l) => !l.agrees);
  return { loadId: req.loadId, lines, differences, totals, payablesSignedOff, agrees: differences.length === 0 };
}
