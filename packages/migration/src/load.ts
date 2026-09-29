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
  readonly quantityMinor: number;
  readonly uom: string;
  readonly unitCostMinor: number;
  readonly batchId?: string;
  /** YYYY-MM-DD. A batch WITHOUT an expiry cannot be received as a batch (the receiving gate refuses it). */
  readonly expiry?: string;
}

export interface ExtractBundle {
  readonly categories: readonly ExtractCategory[];
  readonly taxRates: readonly ExtractTaxRate[];
  readonly products: readonly ExtractProduct[];
  readonly suppliers: readonly ExtractSupplier[];
  readonly customers: readonly ExtractCustomer[];
  readonly openingStock: readonly ExtractStockRow[];
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
  /** Receiving policy for the opening goods receipt. Defaults: no tolerance (ordered = counted), nothing near expiry. */
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
  for (const s of bundle.suppliers) {
    if (!isId(s.partnerId) || !isId(s.name)) { problems.push(`supplier "${s.partnerId}": code and name are required`); continue; }
    if (suppliers.has(s.partnerId)) problems.push(`supplier "${s.partnerId}": listed twice`);
    suppliers.add(s.partnerId);
  }
  const customers = new Set<string>();
  for (const c of bundle.customers) {
    if (!isId(c.customerId)) { problems.push('a customer row has no customer code'); continue; }
    if (customers.has(c.customerId)) problems.push(`customer "${c.customerId}": listed twice`);
    customers.add(c.customerId);
    if (c.loyaltyPoints !== undefined && (!Number.isInteger(c.loyaltyPoints) || c.loyaltyPoints < 0)) problems.push(`customer "${c.customerId}": loyalty points must be a whole non-negative number`);
  }
  bundle.openingStock.forEach((r, i) => {
    if (!products.has(r.productId)) problems.push(`opening stock row ${i + 1}: product "${r.productId}" is not in the extract`);
    if (!Number.isInteger(r.quantityMinor) || r.quantityMinor <= 0) problems.push(`opening stock row ${i + 1} (${r.productId}): quantity must be a positive whole number of minor units`);
    if (!isMinor(r.unitCostMinor)) problems.push(`opening stock row ${i + 1} (${r.productId}): unit cost must be whole non-negative minor units`);
    if (!isId(r.uom)) problems.push(`opening stock row ${i + 1} (${r.productId}): unit of measure is required`);
    if (r.expiry !== undefined && !isDate(r.expiry)) problems.push(`opening stock row ${i + 1} (${r.productId}): expiry must be YYYY-MM-DD`);
  });
  return problems;
}

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
  const problems = validateBundle(bundle);
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
      body: { productId: p.productId, priceMinor: p.priceMinor, mrpMinor: p.mrpMinor, costMinor: p.costMinor, currency: req.currency, marginFloorBps: p.marginFloorBps },
      idempotencyKey: key(`price-${p.productId}`),
    });
  }
  for (const s of bundle.suppliers) {
    // A migrated supplier exists with NO portal grant and NO login: those are configured later, by a
    // person, when the supplier is onboarded to the portal (M24). Nothing here lets anyone in.
    steps.push({
      group: 'supplier', what: `supplier ${s.partnerId}`,
      path: `/v1/supplier-portal/partners/${encodeURIComponent(s.partnerId)}`,
      body: { grants: [], documents: [], requiredDocuments: [], logins: [] },
      idempotencyKey: key(`supplier-${s.partnerId}`),
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
    steps.push({
      group: 'stock', what: `opening stock (${bundle.openingStock.length} line(s)) at ${req.stockLocationId}`,
      path: `/v1/inventory/goods-receipt/${encodeURIComponent(`opening-${req.loadId}`)}`,
      body: {
        warehouseId: req.stockLocationId,
        receivedOnDate: req.receivedOnDate,
        currency: req.currency,
        rules: [...batchTracked].map(([productId, tracked]) => ({ productId, batchTracked: tracked })),
        policy: req.receivingPolicy ?? { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 0 },
        lines: bundle.openingStock.map((r, i) => ({
          lineId: `L${i + 1}`, productId: r.productId, orderedMinor: r.quantityMinor, countedMinor: r.quantityMinor,
          uom: r.uom, unitCost: { minor: r.unitCostMinor, currency: req.currency }, condition: 'good',
          ...(batchTracked.get(r.productId) === true ? { batchId: r.batchId, expiry: r.expiry } : {}),
        })),
      },
      idempotencyKey: key('opening-stock'),
    });
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
