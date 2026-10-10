// The import templates head office SUPPORTS (Wave 4 · SF-06-a · OB-23 "C" · M30-FR-01/03/04).
//
// The audit reproduced it: a manager loaded one product row, the import said "committed, 1 row applied", and the product
// master held nothing — the import stored a job record and changed no real record, and the template, the reference lists
// and the "already exists" list all came from the caller. Here each supported template is head office's OWN: its columns,
// the target module's rules it is checked against, the references read from head office's own registers, and the real
// records an approved load writes. A template that is not on this list is refused by name — nothing is "applied" that has
// no target.
//
// Supported now (owner, 9 Oct 2026, OB-23 "C": invoices first, then products):
//   • `supplier-invoice-v1` — one row per invoice LINE, the invoice's own header repeated on each row (the shape a
//     supplier's or a billing program's CSV export takes). Each invoice in the file becomes a captured supplier invoice
//     — the same record the buyer's capture screen writes (SP-7a), so it goes on to the three-way match and the
//     supplier's account. Undone by withdrawing the invoices, only while none of them has been matched.
//   • `product-v1` (SF-06-b, OB-24 "A") — one row per NEW product, judged by the same tested product engine the publish
//     route runs, against head office's OWN category list (a food item needs its allergens and origin, a packed item its
//     net quantity and packer, an age-restricted item its minimum age). An approved load publishes the products to the
//     product master. Undone by discontinuing them (a new version — the products stay as evidence), only while none has
//     a barcode or a price yet.
//
// Pure of storage: the registers are ports; the API adapter supplies head office's own folds.

import { normaliseUom, valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import type { TemplateSpec, RowError } from '../../../packages/import/src/import-job';
import type { StoredPurchaseOrder } from './purchase-orders';
import { orderForInvoice, type SupplierInvoiceRecord, type SupplierInvoiceLine, type InvoiceFlag } from './index';
import { validateProduct, publishProduct, type ProductRecord, type Category, type SafetyContent } from '../../../packages/product/src/index';

/** What an approved load writes — the real records, not a note about them. */
export type ImportEffect =
  | { readonly kind: 'supplier_invoice'; readonly invoice: SupplierInvoiceRecord }
  | { readonly kind: 'product'; readonly product: ProductRecord };

/** A short, storable account of one effect (kept on the job record — what was written, and how to undo it). */
export interface ImportEffectRef { readonly kind: ImportEffect['kind']; readonly ref: string; readonly valueMinor?: number }

export interface ApplyContext {
  readonly jobId: string;
  readonly uploadedBy: string;
  /** The second person who approved the load (head office's engine, their own session). */
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly at: string;
}

export interface RegisteredTemplate {
  readonly spec: TemplateSpec;
  readonly label: string;
  /** Carries an amount column and must reconcile to a declared total for the whole file. */
  readonly financial: boolean;
  /** The permission the uploader must ALSO hold for the target module (on top of `purchase.import.record`). */
  readonly makerPermission: string;
  /** Head office's own reference lists for the template's `referenceSet` columns — never the caller's. */
  references(tenantId: string): Promise<Readonly<Record<string, readonly string[]>>>;
  /** The target module's rules over the rows the engine found readable — errors by line. */
  check(tenantId: string, rows: readonly Readonly<Record<string, string>>[], lineNumbers: readonly number[], declaredTotalMinor: number | undefined): Promise<readonly RowError[]>;
  /** The real records an approved, clean load writes. */
  effects(tenantId: string, rows: readonly Readonly<Record<string, string>>[], ctx: ApplyContext): Promise<readonly ImportEffect[]>;
  /** Why the load can NOT be undone now (an effect already used downstream), by name — empty when it can. */
  blocksRollback(tenantId: string, effects: readonly ImportEffectRef[]): Promise<readonly string[]>;
}

export function effectRef(e: ImportEffect): ImportEffectRef {
  return e.kind === 'supplier_invoice'
    ? { kind: 'supplier_invoice', ref: e.invoice.invoiceId, valueMinor: e.invoice.totalMinor }
    : { kind: 'product', ref: e.product.productId };
}

/** What a template looks like to the screen (the store pack ships this; the server ignores anything but the id). */
export interface TemplateView {
  readonly id: string; readonly domain: string; readonly label: string; readonly financial: boolean;
  readonly columns: readonly { readonly name: string; readonly type: string }[];
  readonly keyColumns: readonly string[];
}
export const templateView = (t: Pick<RegisteredTemplate, 'spec' | 'label' | 'financial'>): TemplateView => ({
  id: t.spec.id, domain: t.spec.domain, label: t.label, financial: t.financial,
  columns: t.spec.columns.map((c) => ({ name: c.name, type: c.type })), keyColumns: t.spec.keyColumns,
});

// ── supplier-invoice-v1 ────────────────────────────────────────────────────────────────────────────────────────────

export const SUPPLIER_INVOICE_SPEC: TemplateSpec = Object.freeze({
  id: 'supplier-invoice-v1', domain: 'supplier_invoice',
  columns: [
    { name: 'invoiceId', type: 'text', required: true },
    { name: 'supplierId', type: 'text', required: true, referenceSet: 'supplier' },
    { name: 'poId', type: 'text' },
    { name: 'line', type: 'integer', required: true },
    { name: 'productId', type: 'text', required: true, referenceSet: 'product' },
    { name: 'quantity', type: 'integer', required: true },
    { name: 'unitPriceMinor', type: 'money_minor', required: true },
    { name: 'lineTotalMinor', type: 'money_minor', required: true },
    { name: 'invoiceTotalMinor', type: 'money_minor', required: true },
  ],
  keyColumns: ['invoiceId', 'line'],
  amountColumn: 'lineTotalMinor',
}) as TemplateSpec;

/** The label the screen shows (the store's words). */
export const SUPPLIER_INVOICE_LABEL = 'Supplier invoices (one row per invoice line)';

export interface SupplierInvoiceImportDeps {
  /** OB-31: the unit the product master counts a product in (a weighed product's quantity is grams, its price per kg). */
  readonly productUom?: (tenantId: string, productId: string) => Promise<string | undefined> | string | undefined;
  /** Head office's product master ids. */
  readonly productIds: (tenantId: string) => Promise<readonly string[]>;
  /** Head office's supplier master ids. */
  readonly supplierIds: (tenantId: string) => Promise<readonly string[]>;
  /** True when this invoice id was EVER captured at head office (withdrawn ones included — an id is never reused). */
  readonly invoiceIdUsed: (tenantId: string, invoiceId: string) => Promise<boolean>;
  readonly purchaseOrder: (tenantId: string, poId: string) => Promise<StoredPurchaseOrder | undefined> | StoredPurchaseOrder | undefined;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** True when the invoice has been through the three-way match (then it is in use and is not withdrawn). */
  readonly invoiceMatched: (tenantId: string, invoiceId: string) => Promise<boolean>;
}

const n = (v: string | undefined): number => Number(v ?? '');
const err = (line: number, column: string, message: string): RowError => ({ line, column, kind: 'target_rule', message });
const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

interface InvoiceGroup { readonly invoiceId: string; readonly rows: { readonly row: Readonly<Record<string, string>>; readonly line: number }[] }
function groupByInvoice(rows: readonly Readonly<Record<string, string>>[], lineNumbers: readonly number[]): InvoiceGroup[] {
  const by = new Map<string, InvoiceGroup>();
  rows.forEach((row, i) => {
    const id = (row['invoiceId'] ?? '').trim();
    if (id === '') return;
    const g = by.get(id) ?? { invoiceId: id, rows: [] };
    g.rows.push({ row, line: lineNumbers[i] ?? i + 2 });
    by.set(id, g);
  });
  return [...by.values()];
}

export function supplierInvoiceTemplate(deps: SupplierInvoiceImportDeps): RegisteredTemplate {
  return {
    spec: SUPPLIER_INVOICE_SPEC, label: SUPPLIER_INVOICE_LABEL, financial: true,
    makerPermission: 'purchase.invoice.capture',
    references: async (tenantId) => ({ product: await deps.productIds(tenantId), supplier: await deps.supplierIds(tenantId) }),
    check: async (tenantId, rows, lineNumbers, declaredTotalMinor) => {
      const errors: RowError[] = [];
      // A financial file reconciles to the total the person typed off the cover sheet (M30-FR-03) — not optional.
      if (declaredTotalMinor === undefined) errors.push(err(1, 'declared total', 'A file of invoices needs its declared total (all invoices together, in whole paise) so it can be checked.'));
      for (const { row, line } of rows.map((row, i) => ({ row, line: lineNumbers[i] ?? i + 2 }))) {
        const qty = n(row['quantity']); const unit = n(row['unitPriceMinor']); const total = n(row['lineTotalMinor']);
        if (Number.isInteger(qty) && qty <= 0) errors.push(err(line, 'quantity', `The quantity must be at least 1; it is ${row['quantity']}.`));
        // OB-31: in the product's own unit — a weighed product's quantity is grams and its price is per kg, valued once.
        const uom = deps.productUom === undefined ? undefined : await deps.productUom(tenantId, (row['productId'] ?? '').trim());
        const code = uom === undefined ? 'ea' : normaliseUom(uom) ?? 'ea';
        if (Number.isInteger(qty) && Number.isInteger(unit) && Number.isInteger(total) && valueAtUnitCost(qty, code, unit) !== total) {
          const worth = valueAtUnitCost(qty, code, unit);
          errors.push(err(line, 'lineTotalMinor', code === 'ea' ? `${qty} × ${unit} is ${worth}, but the line says ${total}.` : `${qty} ${code === 'kg' ? 'g' : code === 'L' ? 'ml' : ''} at ${unit} a ${code} is ${worth}, but the line says ${total}.`));
        }
      }
      for (const g of groupByInvoice(rows, lineNumbers)) {
        const first = g.rows[0]!;
        // The header is repeated on every line of an invoice — it must say the same thing on each.
        for (const col of ['supplierId', 'poId', 'invoiceTotalMinor'] as const) {
          for (const { row, line } of g.rows) {
            if ((row[col] ?? '') !== (first.row[col] ?? '')) errors.push(err(line, col, `Invoice ${g.invoiceId} says "${first.row[col] ?? ''}" on line ${first.line} and "${row[col] ?? ''}" here — one invoice has one ${col}.`));
          }
        }
        const sum = g.rows.reduce((s, { row }) => s + n(row['lineTotalMinor']), 0);
        const paper = n(first.row['invoiceTotalMinor']);
        if (Number.isInteger(sum) && Number.isInteger(paper) && sum !== paper) {
          for (const { line } of g.rows) errors.push(err(line, 'invoiceTotalMinor', `The lines of invoice ${g.invoiceId} add up to ${rupees(sum)}; the invoice says ${rupees(paper)}. A line is wrong or missing.`));
        }
        if (await deps.invoiceIdUsed(tenantId, g.invoiceId)) {
          for (const { line } of g.rows) errors.push(err(line, 'invoiceId', `Invoice ${g.invoiceId} is already at head office — the same bill is never loaded twice.`));
        }
      }
      return errors;
    },
    effects: async (tenantId, rows, ctx) => {
      // The invoice's checker is the import's second person when they may check invoices (`purchase.invoice.match`);
      // otherwise the invoice is captured and FLAGGED as not yet checked, exactly as an unchecked capture is (SP-7a).
      const approverMayCheck = ((await deps.permissionsOfUser(tenantId, ctx.approvedBy)) ?? []).includes('purchase.invoice.match');
      const out: ImportEffect[] = [];
      for (const g of groupByInvoice(rows, rows.map((_, i) => i + 2))) {
        const head = g.rows[0]!.row;
        const lines: SupplierInvoiceLine[] = [];
        for (const { row } of [...g.rows].sort((a, b) => n(a.row['line']) - n(b.row['line']))) {
          // OB-31: the line is recorded in the product's own unit (grams for kg), as the screen's and the API's lines are.
          const master = deps.productUom === undefined ? undefined : await deps.productUom(tenantId, row['productId']!);
          const uom = master === undefined ? undefined : normaliseUom(master);
          lines.push({ productId: row['productId']!, quantity: n(row['quantity']), unitPriceMinor: n(row['unitPriceMinor']), lineTotalMinor: n(row['lineTotalMinor']), ...(uom === undefined ? {} : { uom }) });
        }
        const poId = (head['poId'] ?? '').trim() === '' ? null : head['poId']!.trim();
        const flags: InvoiceFlag[] = [];
        if (!approverMayCheck) flags.push('no_approval');
        await orderForInvoice(deps, tenantId, poId, head['supplierId']!, flags);
        out.push({
          kind: 'supplier_invoice',
          invoice: {
            invoiceId: g.invoiceId, supplierId: head['supplierId']!, poId, lines,
            declaredTotalMinor: n(head['invoiceTotalMinor']), totalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0), currency: 'INR',
            capturedBy: ctx.uploadedBy, capturedAt: ctx.at,
            approvedBy: approverMayCheck ? ctx.approvedBy : null, approvedAt: approverMayCheck ? ctx.approvedAt : null,
            source: `import/${ctx.jobId}`, governanceFlags: flags,
          },
        });
      }
      return out;
    },
    blocksRollback: async (tenantId, effects) => {
      const reasons: string[] = [];
      for (const e of effects) {
        if (e.kind === 'supplier_invoice' && await deps.invoiceMatched(tenantId, e.ref)) {
          reasons.push(`invoice ${e.ref} has already been matched against its order and delivery`);
        }
      }
      return reasons;
    },
  };
}

// ── product-v1 ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const PRODUCT_SPEC: TemplateSpec = Object.freeze({
  id: 'product-v1', domain: 'product',
  columns: [
    { name: 'productId', type: 'text', required: true },
    { name: 'sku', type: 'text', required: true },
    { name: 'name', type: 'text', required: true },
    { name: 'baseUom', type: 'text', required: true },
    { name: 'primaryCategoryId', type: 'text', required: true, referenceSet: 'category' },
    { name: 'taxClass', type: 'text', required: true },
    { name: 'brand', type: 'text' },
    // "none" declares no allergens; several are separated by "|"; blank means nobody has declared anything.
    { name: 'allergens', type: 'text' },
    { name: 'countryOfOrigin', type: 'text' },
    { name: 'netQuantity', type: 'text' },
    { name: 'packerDetails', type: 'text' },
    { name: 'minimumAge', type: 'integer' },
  ],
  keyColumns: ['productId'],
}) as TemplateSpec;

export const PRODUCT_LABEL = 'New products (one row per product)';

export interface ProductImportDeps {
  /** Head office's own category list (engine shape). */
  readonly categories: (tenantId: string) => Promise<readonly Category[]>;
  /** Head office's product master. */
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]>;
  /** Why this product is already in use (a barcode, a price), or undefined — then its load may be undone. */
  readonly productInUse: (tenantId: string, productId: string) => Promise<string | undefined>;
}

const opt = (v: string | undefined): string | undefined => ((v ?? '').trim() === '' ? undefined : v!.trim());

/** A file row as the product engine reads it — draft, so the engine's own publish moves it on. */
export function productOfRow(row: Readonly<Record<string, string>>, tenantId: string): ProductRecord {
  const allergensRaw = opt(row['allergens']);
  const safety: SafetyContent = {
    ...(allergensRaw === undefined ? {} : { allergens: allergensRaw.toLowerCase() === 'none' ? [] : allergensRaw.split('|').map((a) => a.trim()).filter((a) => a !== '') }),
    ...(opt(row['countryOfOrigin']) === undefined ? {} : { countryOfOrigin: opt(row['countryOfOrigin'])! }),
    ...(opt(row['netQuantity']) === undefined ? {} : { netQuantity: opt(row['netQuantity'])! }),
    ...(opt(row['packerDetails']) === undefined ? {} : { packerDetails: opt(row['packerDetails'])! }),
    ...(opt(row['minimumAge']) === undefined ? {} : { minimumAge: Number(row['minimumAge']) }),
  };
  return {
    productId: (row['productId'] ?? '').trim(), tenantId, sku: (row['sku'] ?? '').trim(), name: (row['name'] ?? '').trim(),
    baseUom: (row['baseUom'] ?? '').trim(), primaryCategoryId: opt(row['primaryCategoryId']) ?? null, taxClass: opt(row['taxClass']) ?? null,
    lifecycle: 'draft',
    ...(opt(row['brand']) === undefined ? {} : { brand: opt(row['brand'])! }),
    ...(Object.keys(safety).length === 0 ? {} : { safety }),
  };
}

export function productTemplate(deps: ProductImportDeps): RegisteredTemplate {
  return {
    spec: PRODUCT_SPEC, label: PRODUCT_LABEL, financial: false,
    makerPermission: 'catalogue.pack.publish',
    references: async (tenantId) => ({ category: (await deps.categories(tenantId)).map((c) => c.categoryId) }),
    check: async (tenantId, rows, lineNumbers) => {
      const errors: RowError[] = [];
      const categories = await deps.categories(tenantId);
      const known = new Set(categories.map((c) => c.categoryId));
      const master = await deps.products(tenantId);
      const ids = new Set(master.map((p) => p.productId));
      const skuOwner = new Map(master.map((p) => [p.sku.toLowerCase(), p.productId] as const));
      const skuInFile = new Map<string, number>();
      rows.forEach((row, i) => {
        const line = lineNumbers[i] ?? i + 2;
        const product = productOfRow(row, tenantId);
        if (ids.has(product.productId)) errors.push(err(line, 'productId', `Product ${product.productId} is already in the product master. A file loads NEW products; change an existing one on its own screen.`));
        const sku = product.sku.toLowerCase();
        if (sku !== '') {
          const owner = skuOwner.get(sku);
          if (owner !== undefined && owner !== product.productId) errors.push(err(line, 'sku', `SKU ${product.sku} already belongs to product ${owner} — one SKU names one product.`));
          const first = skuInFile.get(sku);
          if (first !== undefined) errors.push(err(line, 'sku', `SKU ${product.sku} is also on line ${first} — one SKU names one product.`));
          else skuInFile.set(sku, line);
        }
        const age = opt(row['minimumAge']);
        if (age !== undefined && !(Number.isInteger(Number(age)) && Number(age) > 0)) errors.push(err(line, 'minimumAge', `The minimum age must be a whole number of years; it is "${age}".`));
        // The product engine's own rules — only once the category is one head office knows (an unknown one is already said).
        if (product.primaryCategoryId !== null && known.has(product.primaryCategoryId)) {
          for (const issue of validateProduct(product, categories).issues) {
            if (issue.severity === 'blocks_publish') errors.push(err(line, issue.field.replace(/^safety\./, ''), `${issue.message}.`));
          }
        }
      });
      return errors;
    },
    effects: async (tenantId, rows) => {
      const categories = await deps.categories(tenantId);
      return rows.map((row) => ({ kind: 'product' as const, product: publishProduct(productOfRow(row, tenantId), categories) }));
    },
    blocksRollback: async (tenantId, effects) => {
      const reasons: string[] = [];
      for (const e of effects) {
        if (e.kind !== 'product') continue;
        const why = await deps.productInUse(tenantId, e.ref);
        if (why !== undefined) reasons.push(`product ${e.ref} ${why}`);
      }
      return reasons;
    },
  };
}
