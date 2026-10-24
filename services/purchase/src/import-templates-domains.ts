// The further import templates (OB-315, owner, 23 Oct 2026, in writing — "import all domains" · M30-FR-01/03/04 ·
// audit-4 D-4 "C").
//
// Invoices and products already load (`import-templates.ts`). These five complete the list the owner named, each on the
// SAME pipeline — validate (and a kept dry run) → a second person's approval → one atomic commit → a rollback by
// compensating records — and each held to its own domain's rules, over head office's own registers:
//
//   • `supplier-v1`        NEW suppliers into the supplier master, PROPOSED (finance approves each, maker ≠ approver,
//                          M06-FR-01). A GSTIN is checked by the same rule the org setup uses; a shared name or GSTIN
//                          is SAID (possible duplicates), never silently merged. No bank details by file — ever.
//   • `price-list-v1`      a store's selling prices, judged by the price guard: above the MRP is refused (a legal
//                          ceiling); below cost or below the store's own margin floor is refused by file (it needs its own
//                          price change with an approver's reason); a store with no margin floor set is refused.
//   • `opening-stock-v1`   OPENING stock — an opening receipt at its cost, the FIRST fact about a product at a place. A
//                          product that already has stock movements there is refused: that is corrected by a count, never
//                          by an opening (never an overwrite).
//   • `customer-v1`        customers carried from the old ERP into the loyalty register — ONLY with the customer's own
//                          recorded "yes" and its date (no consent, no member, M16-FR-02). The mobile number is never kept
//                          (P-04): the member code and the last four digits, as the service desk keeps them; a name, when
//                          given, is sealed to the member. Each arrives with NO marketing consent (re-consent is a
//                          campaign, not a field).
//   • `loyalty-opening-v1` a member's OPENING points balance — an earn movement marked as the opening, the first fact on the
//                          member's points ledger. A member who already has points movements is refused (corrected by an
//                          adjustment, never by an opening).
//
// Every row the rules refuse is an exception by line, with the reason in words, and the WHOLE job commits nothing while
// any remains (the engine's gate). Nothing here writes: the registers are ports, and the API adapter writes the records.

import type { RowError, TemplateSpec } from '../../../packages/import/src/import-job';
import { checkPrice } from '../../../packages/price-guard/src/price-guard';
import { money } from '../../../packages/contracts/src/money';
import { validateGstin, InvalidGstinError } from '../../../packages/org/src/hierarchy';
import { normaliseMobile, memberRefFor } from '../../../packages/loyalty/src/index';
import type { PriceEntry } from '../../../packages/price-list/src/price-list';
import { readableMemberName, type MemberRecord } from '../../customer/src/loyalty-members';
import type { RecordedPointsMovement } from '../../customer/src/index';
import type { Movement } from '../../inventory/src/index';
import type { SupplierRecord } from './supplier-master';
import { templateView, type RegisteredTemplate, type ApplyContext, type ImportEffectRef, type TemplateView } from './import-templates';

type Row = Readonly<Record<string, string>>;
const err = (line: number, column: string, message: string): RowError => ({ line, column, kind: 'target_rule', message });
const cell = (row: Row, k: string): string => (row[k] ?? '').trim();
const opt = (row: Row, k: string): string | undefined => (cell(row, k) === '' ? undefined : cell(row, k));
const lineOf = (lineNumbers: readonly number[], i: number): number => lineNumbers[i] ?? i + 2;
const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const last4 = (mobile: string): string => mobile.slice(-4);

// ── supplier-v1 ────────────────────────────────────────────────────────────────────────────────────────────────────

export const SUPPLIER_SPEC: TemplateSpec = Object.freeze({
  id: 'supplier-v1', domain: 'supplier',
  columns: [
    { name: 'supplierId', type: 'text', required: true },
    { name: 'name', type: 'text', required: true },
    { name: 'gstin', type: 'text' },
    { name: 'phone', type: 'text' },
    { name: 'email', type: 'text' },
    { name: 'address', type: 'text' },
    { name: 'paymentTermsDays', type: 'integer' },
  ],
  keyColumns: ['supplierId'],
}) as TemplateSpec;
export const SUPPLIER_LABEL = 'New suppliers (one row per supplier; each arrives proposed, for finance to approve)';

export interface SupplierImportDeps {
  readonly suppliers: (tenantId: string) => Promise<readonly SupplierRecord[]>;
  /** Why this supplier can no longer be taken back out (approved, ordered from, billed), or undefined. */
  readonly supplierInUse: (tenantId: string, supplierId: string, jobId: string) => Promise<string | undefined>;
}

/** The suppliers sharing this one's name or GSTIN — said, never merged (the master's own rule, M06-FR-01). */
function possibleDuplicates(supplierId: string, name: string, gstin: string | null, others: readonly { supplierId: string; name: string; gstin: string | null }[]): string[] {
  const n = name.trim().toLowerCase();
  return others.filter((o) => o.supplierId !== supplierId && (o.name.trim().toLowerCase() === n || (gstin !== null && o.gstin === gstin))).map((o) => o.supplierId).sort();
}

export function supplierTemplate(deps: SupplierImportDeps): RegisteredTemplate {
  const gstinOf = (row: Row): string | null => (opt(row, 'gstin') === undefined ? null : validateGstin(cell(row, 'gstin')));
  return {
    spec: SUPPLIER_SPEC, label: SUPPLIER_LABEL, financial: false,
    makerPermission: 'purchase.supplier.manage',
    references: async () => ({}),
    check: async (tenantId, rows, lineNumbers) => {
      const errors: RowError[] = [];
      const master = new Set((await deps.suppliers(tenantId)).map((s) => s.supplierId));
      const gstinInFile = new Map<string, number>();
      rows.forEach((row, i) => {
        const line = lineOf(lineNumbers, i);
        if (master.has(cell(row, 'supplierId'))) errors.push(err(line, 'supplierId', `Supplier ${cell(row, 'supplierId')} is already in the supplier master. A file loads NEW suppliers; change an existing one on its own screen.`));
        if (opt(row, 'gstin') !== undefined) {
          try {
            const g = validateGstin(cell(row, 'gstin'));
            const first = gstinInFile.get(g);
            if (first !== undefined) errors.push(err(line, 'gstin', `GSTIN ${g} is also on line ${first} — one GSTIN names one supplier.`));
            else gstinInFile.set(g, line);
          } catch (e) {
            if (e instanceof InvalidGstinError) errors.push(err(line, 'gstin', `The GSTIN is not valid: ${e.message}.`));
            else throw e;
          }
        }
        const terms = opt(row, 'paymentTermsDays');
        // Not a whole number is already said by the engine; a negative one is said here.
        if (terms !== undefined && Number.isInteger(Number(terms)) && Number(terms) < 0) errors.push(err(line, 'paymentTermsDays', `Payment terms are whole days, nought or more; "${terms}" is not.`));
      });
      return errors;
    },
    effects: async (tenantId, rows, ctx: ApplyContext) => {
      const others = (await deps.suppliers(tenantId)).map((s) => ({ supplierId: s.supplierId, name: s.name, gstin: s.gstin }));
      const inFile = rows.map((r) => ({ supplierId: cell(r, 'supplierId'), name: cell(r, 'name'), gstin: gstinOf(r) }));
      return rows.map((row) => {
        const supplierId = cell(row, 'supplierId'); const name = cell(row, 'name'); const gstin = gstinOf(row);
        const supplier: SupplierRecord = {
          supplierId, name, gstin, phone: opt(row, 'phone') ?? null, email: opt(row, 'email') ?? null, address: opt(row, 'address') ?? null,
          paymentTermsDays: opt(row, 'paymentTermsDays') === undefined ? null : Number(cell(row, 'paymentTermsDays')),
          // Bank details and documents are never loaded by file: each is verified by a person on the supplier's own screen.
          documents: [], status: 'proposed', createdBy: ctx.uploadedBy, createdAt: ctx.at, updatedBy: ctx.uploadedBy, updatedAt: ctx.at,
          approvedBy: null, approvedAt: null, possibleDuplicates: possibleDuplicates(supplierId, name, gstin, [...others, ...inFile]), version: 1,
        };
        return { kind: 'supplier' as const, supplier };
      });
    },
    blocksRollback: async (tenantId, effects: readonly ImportEffectRef[], jobId) => {
      const reasons: string[] = [];
      for (const e of effects) {
        if (e.kind !== 'supplier') continue;
        const why = await deps.supplierInUse(tenantId, e.ref, jobId ?? '');
        if (why !== undefined) reasons.push(`supplier ${e.ref} ${why}`);
      }
      return reasons;
    },
  };
}

// ── price-list-v1 ──────────────────────────────────────────────────────────────────────────────────────────────────

export const PRICE_LIST_SPEC: TemplateSpec = Object.freeze({
  id: 'price-list-v1', domain: 'price',
  columns: [
    { name: 'productId', type: 'text', required: true, referenceSet: 'product' },
    { name: 'storeId', type: 'text', required: true, referenceSet: 'store' },
    { name: 'priceMinor', type: 'money_minor', required: true },
    { name: 'mrpMinor', type: 'money_minor', required: true },
    { name: 'costMinor', type: 'money_minor', required: true },
  ],
  keyColumns: ['productId', 'storeId'],
}) as TemplateSpec;
export const PRICE_LIST_LABEL = 'Store selling prices (one row per product and store; never above MRP, never below cost or the store\'s margin floor)';

export interface PriceListImportDeps {
  readonly productIds: (tenantId: string) => Promise<readonly string[]>;
  readonly storeIds: (tenantId: string) => Promise<readonly string[]>;
  /** The margin floor the owner set in the store's rules — undefined when none is set. */
  readonly marginFloorFor: (tenantId: string, storeId: string) => Promise<number | undefined>;
  /** Every price-list entry a product has (any scope, any status). */
  readonly entries: (tenantId: string, productId: string) => Promise<readonly PriceEntry[]>;
}

export function priceListTemplate(deps: PriceListImportDeps): RegisteredTemplate {
  return {
    spec: PRICE_LIST_SPEC, label: PRICE_LIST_LABEL, financial: false,
    makerPermission: 'price.change.propose',
    references: async (tenantId) => ({ product: await deps.productIds(tenantId), store: await deps.storeIds(tenantId) }),
    check: async (tenantId, rows, lineNumbers) => {
      const errors: RowError[] = [];
      const stores = new Set(await deps.storeIds(tenantId));
      for (const [i, row] of rows.entries()) {
        const line = lineOf(lineNumbers, i);
        if (!stores.has(cell(row, 'storeId'))) continue; // an unknown store is already said by the reference check
        const price = Number(cell(row, 'priceMinor')); const mrp = Number(cell(row, 'mrpMinor')); const cost = Number(cell(row, 'costMinor'));
        if (![price, mrp, cost].every(Number.isSafeInteger)) continue; // the engine already says which is not an amount
        if (price <= 0) { errors.push(err(line, 'priceMinor', 'A selling price is more than nought.')); continue; }
        const storeId = cell(row, 'storeId');
        const floor = await deps.marginFloorFor(tenantId, storeId);
        if (floor === undefined) { errors.push(err(line, 'storeId', `No margin floor is set for store ${storeId} — a price is judged by the floor the owner set in the store's rules, never loaded without one.`)); continue; }
        const verdict = checkPrice({ id: `import-${cell(row, 'productId')}`, proposedPrice: money(price, 'INR'), mrp: money(mrp, 'INR'), cost: money(cost, 'INR'), marginFloorBps: floor, setBy: 'import' }).verdict;
        if (verdict === 'above_mrp') errors.push(err(line, 'priceMinor', `₹${(price / 100).toFixed(2)} is above the MRP ₹${(mrp / 100).toFixed(2)} — a legal ceiling nothing can lift.`));
        else if (verdict === 'below_cost') errors.push(err(line, 'priceMinor', `₹${(price / 100).toFixed(2)} is below the cost ₹${(cost / 100).toFixed(2)}. A loss-making price is set on the price screen with an approver's reason — never by file.`));
        else if (verdict === 'below_floor') errors.push(err(line, 'priceMinor', `₹${(price / 100).toFixed(2)} is below store ${storeId}'s margin floor (${(floor / 100).toFixed(2)}%). Such a price is set on the price screen with an approver's reason — never by file.`));
      }
      return errors;
    },
    effects: async (tenantId, rows, ctx: ApplyContext) => {
      const out = [];
      const versions = new Map<string, number>();
      for (const row of rows) {
        const productId = cell(row, 'productId'); const storeId = cell(row, 'storeId'); const priceMinor = Number(cell(row, 'priceMinor'));
        const k = `${productId}@${storeId}`;
        const held = versions.get(k) ?? (await deps.entries(tenantId, productId)).filter((e) => e.scope === 'store' && e.scopeRef === storeId).reduce((m, e) => Math.max(m, e.version), 0);
        versions.set(k, held + 1);
        const entry: PriceEntry = {
          id: `import-${ctx.jobId}-${storeId}`, productId, scope: 'store', scopeRef: storeId, price: money(priceMinor, 'INR'),
          effectiveFrom: ctx.at.slice(0, 10), effectiveTo: null, status: 'active', version: held + 1,
        };
        out.push({
          kind: 'price' as const, productId, storeId, entry,
          change: { id: `price-${productId}`, productId, priceMinor, currency: 'INR', setBy: ctx.uploadedBy, verdict: 'ok', approvedBy: ctx.approvedBy, reason: `price list loaded by import ${ctx.jobId}`, at: ctx.at },
        });
      }
      return out;
    },
    blocksRollback: async (tenantId, effects: readonly ImportEffectRef[], jobId) => {
      const reasons: string[] = [];
      for (const e of effects) {
        if (e.kind !== 'price') continue;
        const [productId, storeId] = e.ref.split('@') as [string, string];
        const mine = (await deps.entries(tenantId, productId)).filter((x) => x.scope === 'store' && x.scopeRef === storeId).sort((a, b) => a.version - b.version);
        const at = mine.findIndex((x) => x.id === `import-${jobId ?? ''}-${storeId}`);
        if (at < 0) continue;
        if (at !== mine.length - 1) reasons.push(`the price of ${productId} at ${storeId} was changed again after this load — undoing it would silently lose that change`);
        else if (!mine.slice(0, at).some((x) => x.status === 'active')) reasons.push(`${productId} had no price at ${storeId} before this load, so an undo would leave the till with no price — change it on the price screen`);
      }
      return reasons;
    },
  };
}

// ── opening-stock-v1 ───────────────────────────────────────────────────────────────────────────────────────────────

export const OPENING_STOCK_SPEC: TemplateSpec = Object.freeze({
  id: 'opening-stock-v1', domain: 'stock',
  columns: [
    { name: 'productId', type: 'text', required: true, referenceSet: 'product' },
    // Checked against head office's own stock places (org nodes, store settings, bins) by the rule below.
    { name: 'locationId', type: 'text', required: true },
    { name: 'quantity', type: 'integer', required: true },
    { name: 'unitCostMinor', type: 'money_minor', required: true },
    { name: 'batchId', type: 'text' },
    { name: 'expiry', type: 'text' },
  ],
  keyColumns: ['productId', 'locationId', 'batchId'],
}) as TemplateSpec;
export const OPENING_STOCK_LABEL = 'Opening stock (one row per product, place and batch — the first stock fact at that place, at its cost)';

export interface OpeningStockImportDeps {
  readonly productIds: (tenantId: string) => Promise<readonly string[]>;
  /** Is this a stock place head office knows (an open store, warehouse or bin)? */
  readonly knownPlace: (tenantId: string) => Promise<(locationId: string) => boolean>;
  /** The unit the product master counts the product in (its base unit). */
  readonly productUom: (tenantId: string, productId: string) => Promise<string | undefined>;
  /** Every stock movement head office holds, in ledger order (product, place, kind, id). */
  readonly movements: (tenantId: string) => Promise<readonly Pick<Movement, 'movementId' | 'productId' | 'locationId' | 'kind'>[]>;
}

export function openingStockTemplate(deps: OpeningStockImportDeps): RegisteredTemplate {
  return {
    spec: OPENING_STOCK_SPEC, label: OPENING_STOCK_LABEL, financial: false,
    makerPermission: 'inventory.movement.append',
    references: async (tenantId) => ({ product: await deps.productIds(tenantId) }),
    check: async (tenantId, rows, lineNumbers) => {
      const errors: RowError[] = [];
      const place = await deps.knownPlace(tenantId);
      const moved = new Set((await deps.movements(tenantId)).map((m) => `${m.productId}@${m.locationId}`));
      for (const [i, row] of rows.entries()) {
        const line = lineOf(lineNumbers, i);
        const q = Number(cell(row, 'quantity'));
        if (Number.isInteger(q) && q <= 0) errors.push(err(line, 'quantity', `An opening quantity is more than nought; it is ${cell(row, 'quantity')}.`));
        if (cell(row, 'locationId') !== '' && !place(cell(row, 'locationId'))) errors.push(err(line, 'locationId', `${cell(row, 'locationId')} is not a store, warehouse or bin head office knows (or it is closed).`));
        const where = `${cell(row, 'productId')}@${cell(row, 'locationId')}`;
        if (moved.has(where)) errors.push(err(line, 'productId', `${cell(row, 'productId')} already has stock movements at ${cell(row, 'locationId')}. Opening stock is the first fact about a product at a place — what is there now is corrected by a count, never by an opening.`));
        if (opt(row, 'batchId') !== undefined && !(opt(row, 'expiry') !== undefined && isDay(cell(row, 'expiry')))) errors.push(err(line, 'expiry', 'A batch needs its expiry date (YYYY-MM-DD), so it can be traced and sold first-expiry-first.'));
        if (opt(row, 'expiry') !== undefined && !isDay(cell(row, 'expiry'))) errors.push(err(line, 'expiry', `"${cell(row, 'expiry')}" is not a date (YYYY-MM-DD).`));
        if ((await deps.productUom(tenantId, cell(row, 'productId'))) === undefined && cell(row, 'productId') !== '') errors.push(err(line, 'productId', `The product master has no base unit for ${cell(row, 'productId')}, so its quantity cannot be read.`));
      }
      return errors;
    },
    effects: async (tenantId, rows, ctx: ApplyContext) => {
      const out = [];
      for (const [i, row] of rows.entries()) {
        const productId = cell(row, 'productId');
        const movement: Movement = {
          movementId: `import-${ctx.jobId}-opening-${i + 1}`, productId, locationId: cell(row, 'locationId'), kind: 'received',
          quantityMinor: Number(cell(row, 'quantity')), uom: (await deps.productUom(tenantId, productId))!, occurredAt: ctx.at,
          unitCostMinor: Number(cell(row, 'unitCostMinor')), enteredBy: ctx.uploadedBy, approvedBy: ctx.approvedBy,
          reason: `opening stock loaded by import ${ctx.jobId}`,
          ...(opt(row, 'batchId') === undefined ? {} : { batchId: cell(row, 'batchId'), expiry: cell(row, 'expiry') }),
        };
        out.push({ kind: 'opening_stock' as const, movement });
      }
      return out;
    },
    blocksRollback: async (tenantId, effects: readonly ImportEffectRef[]) => {
      const reasons: string[] = [];
      const all = await deps.movements(tenantId);
      for (const e of effects) {
        if (e.kind !== 'opening_stock') continue;
        const at = all.findIndex((m) => m.movementId === e.ref);
        if (at < 0) continue;
        const mine = all[at]!;
        if (all.slice(at + 1).some((m) => m.productId === mine.productId && m.locationId === mine.locationId && !m.movementId.startsWith(e.ref.replace(/-opening-\d+$/, '-opening-')))) {
          reasons.push(`${mine.productId} has moved at ${mine.locationId} since it was opened (sold, received, counted or moved) — correct it with a count`);
        }
      }
      return reasons;
    },
  };
}

// ── customer-v1 and loyalty-opening-v1 ─────────────────────────────────────────────────────────────────────────────

export interface MemberImportDeps {
  /** The key the member code is made with (the store computer's too). Absent: every row is refused, said. */
  readonly memberKey?: Buffer;
  readonly memberHistory: (tenantId: string, memberRef: string) => Promise<readonly MemberRecord[]>;
  /** Every points movement a member has, oldest first. */
  readonly pointsMovements: (tenantId: string, memberRef: string) => Promise<readonly RecordedPointsMovement[]>;
}

const NO_KEY = 'Head office has no member key, so it cannot turn a mobile number into a member code — nothing can be loaded until the administrator configures it.';
const refOf = (deps: MemberImportDeps, raw: string): { mobile: string; memberRef: string } | undefined => {
  const mobile = normaliseMobile(raw);
  if (mobile === undefined || deps.memberKey === undefined) return undefined;
  return { mobile, memberRef: memberRefFor(deps.memberKey, mobile)! };
};
/** P-04: what the job's record keeps of a row that read a mobile number — the member code and the last four digits. */
const withoutMobile = (deps: MemberImportDeps, row: Row, keep: readonly string[]): Row => {
  const r = refOf(deps, cell(row, 'mobile'));
  return { memberRef: r?.memberRef ?? 'not readable', mobileLast4: r === undefined ? '' : last4(r.mobile), ...Object.fromEntries(keep.map((k) => [k, cell(row, k)])) };
};

export const CUSTOMER_SPEC: TemplateSpec = Object.freeze({
  id: 'customer-v1', domain: 'customer',
  columns: [
    { name: 'mobile', type: 'text', required: true },
    // The customer's own yes to loyalty, as the old record holds it. Only "yes" loads.
    { name: 'loyaltyConsent', type: 'enum', required: true, allowed: ['yes', 'no'] },
    { name: 'consentGivenOn', type: 'text', required: true },
    { name: 'consentEvidence', type: 'text', required: true },
    { name: 'name', type: 'text' },
  ],
  keyColumns: ['mobile'],
}) as TemplateSpec;
export const CUSTOMER_LABEL = 'Customers from the old system (one row per customer; only with their recorded yes to loyalty — the number is never kept)';

export function customerTemplate(deps: MemberImportDeps): RegisteredTemplate {
  return {
    spec: CUSTOMER_SPEC, label: CUSTOMER_LABEL, financial: false,
    makerPermission: 'loyalty.member.enrol', personalColumns: ['mobile', 'name'],
    references: async () => ({}),
    check: async (tenantId, rows, lineNumbers) => {
      const errors: RowError[] = [];
      const seen = new Map<string, number>();
      for (const [i, row] of rows.entries()) {
        const line = lineOf(lineNumbers, i);
        if (deps.memberKey === undefined) { errors.push(err(line, 'mobile', NO_KEY)); continue; }
        const r = refOf(deps, cell(row, 'mobile'));
        if (r === undefined) { errors.push(err(line, 'mobile', 'This is not a 10-digit Indian mobile number (it may start with +91 or 0).')); continue; }
        const first = seen.get(r.memberRef);
        if (first !== undefined) errors.push(err(line, 'mobile', `The number ending ${last4(r.mobile)} is also on line ${first} — one customer, one row.`));
        else seen.set(r.memberRef, line);
        if (cell(row, 'loyaltyConsent') !== 'yes') errors.push(err(line, 'loyaltyConsent', `The customer ending ${last4(r.mobile)} has no recorded yes to loyalty, so they are not loaded (no consent, no member).`));
        const on = cell(row, 'consentGivenOn');
        if (!isDay(on)) errors.push(err(line, 'consentGivenOn', 'The date the customer said yes is needed (YYYY-MM-DD).'));
        if (readableMemberName(opt(row, 'name')) === 'unreadable') errors.push(err(line, 'name', 'The name is not readable as a person\'s name (2 to 80 letters, spaces, dots, apostrophes or hyphens) — leave it empty if the old record has none.'));
        const now = (await deps.memberHistory(tenantId, r.memberRef)).at(-1);
        if (now?.status === 'member') errors.push(err(line, 'mobile', `The customer ending ${last4(r.mobile)} is already a loyalty member.`));
      }
      return errors;
    },
    storedRow: (_t, row) => withoutMobile(deps, row, ['loyaltyConsent', 'consentGivenOn', 'consentEvidence']),
    effects: async (_tenantId, rows, ctx: ApplyContext) => rows.map((row) => {
      const r = refOf(deps, cell(row, 'mobile'))!;
      const name = readableMemberName(opt(row, 'name'));
      const member: MemberRecord = {
        memberRef: r.memberRef, mobileLast4: last4(r.mobile), status: 'member', consentGivenAt: `${cell(row, 'consentGivenOn')}T00:00:00.000Z`,
        enrolledBy: ctx.uploadedBy, verifiedHow: 'carried_from_old_erp',
        ...(name === undefined || name === 'unreadable' ? {} : { fullName: name }),
      };
      return {
        kind: 'customer' as const, member,
        // Re-consent is a campaign, not a field: a carried customer has NO marketing consent until they give it (as MG-05).
        marketingConsent: { customerId: r.memberRef, purpose: 'marketing' as const, channel: 'sms' as const, given: false, recordedAt: ctx.at, evidence: `carried from the old ERP by import ${ctx.jobId}: no marketing consent on record (loyalty consent: ${cell(row, 'consentEvidence')})` },
      };
    }),
    blocksRollback: async (tenantId, effects: readonly ImportEffectRef[]) => {
      const reasons: string[] = [];
      for (const e of effects) {
        if (e.kind !== 'customer') continue;
        if ((await deps.pointsMovements(tenantId, e.ref)).length > 0) reasons.push(`member ${e.ref} has points on their ledger since — they are taken off at the service desk, not by an undo`);
      }
      return reasons;
    },
  };
}

export const LOYALTY_OPENING_SPEC: TemplateSpec = Object.freeze({
  id: 'loyalty-opening-v1', domain: 'loyalty',
  columns: [
    { name: 'mobile', type: 'text', required: true },
    { name: 'points', type: 'integer', required: true },
    { name: 'asOn', type: 'text', required: true },
  ],
  keyColumns: ['mobile'],
}) as TemplateSpec;
export const LOYALTY_OPENING_LABEL = 'Opening loyalty points (one row per member — the first fact on their points; the number is never kept)';

export function loyaltyOpeningTemplate(deps: MemberImportDeps): RegisteredTemplate {
  return {
    spec: LOYALTY_OPENING_SPEC, label: LOYALTY_OPENING_LABEL, financial: false,
    makerPermission: 'loyalty.points.write', personalColumns: ['mobile'],
    references: async () => ({}),
    check: async (tenantId, rows, lineNumbers) => {
      const errors: RowError[] = [];
      const seen = new Map<string, number>();
      for (const [i, row] of rows.entries()) {
        const line = lineOf(lineNumbers, i);
        if (deps.memberKey === undefined) { errors.push(err(line, 'mobile', NO_KEY)); continue; }
        const r = refOf(deps, cell(row, 'mobile'));
        if (r === undefined) { errors.push(err(line, 'mobile', 'This is not a 10-digit Indian mobile number (it may start with +91 or 0).')); continue; }
        const first = seen.get(r.memberRef);
        if (first !== undefined) errors.push(err(line, 'mobile', `The number ending ${last4(r.mobile)} is also on line ${first} — one opening balance per member.`));
        else seen.set(r.memberRef, line);
        const p = Number(cell(row, 'points'));
        if (Number.isInteger(p) && p <= 0) errors.push(err(line, 'points', 'An opening balance is more than nought points (a member with none needs no row).'));
        if (!isDay(cell(row, 'asOn'))) errors.push(err(line, 'asOn', 'The date the balance was true on is needed (YYYY-MM-DD).'));
        if ((await deps.memberHistory(tenantId, r.memberRef)).at(-1)?.status !== 'member') errors.push(err(line, 'mobile', `The number ending ${last4(r.mobile)} is not a loyalty member — load the customer first.`));
        else if ((await deps.pointsMovements(tenantId, r.memberRef)).length > 0) errors.push(err(line, 'points', `The member ending ${last4(r.mobile)} already has points on their ledger. An opening balance is the first fact — a correction is an adjustment at the service desk, never an opening.`));
      }
      return errors;
    },
    storedRow: (_t, row) => withoutMobile(deps, row, ['points', 'asOn']),
    effects: async (_tenantId, rows, ctx: ApplyContext) => rows.map((row) => {
      const r = refOf(deps, cell(row, 'mobile'))!;
      const movement: RecordedPointsMovement = {
        // The migration load's own opening shape (MG-05): an earn movement, the load's id in its name, the opening said.
        movementId: `import-${ctx.jobId}-opening-${r.memberRef}`, customerId: r.memberRef, delta: Number(cell(row, 'points')), reason: 'earn',
        sourceRef: `opening balance carried from the old ERP as on ${cell(row, 'asOn')} (import ${ctx.jobId})`, at: ctx.at,
      };
      return { kind: 'loyalty_opening' as const, movement };
    }),
    blocksRollback: async (tenantId, effects: readonly ImportEffectRef[]) => {
      const reasons: string[] = [];
      for (const e of effects) {
        if (e.kind !== 'loyalty_opening') continue;
        const memberRef = e.ref.replace(/^import-.*-opening-/, '');
        const moves = await deps.pointsMovements(tenantId, memberRef);
        const at = moves.findIndex((m) => m.movementId === e.ref);
        if (at >= 0 && at !== moves.length - 1) reasons.push(`member ${memberRef} has earned or spent points since the opening — correct it with an adjustment`);
      }
      return reasons;
    },
  };
}

/** What the import screen offers for the five further templates (the store pack ships these; the server ignores all but the id). */
export const DOMAIN_TEMPLATE_VIEWS: readonly TemplateView[] = Object.freeze([
  templateView({ spec: SUPPLIER_SPEC, label: SUPPLIER_LABEL, financial: false }),
  templateView({ spec: PRICE_LIST_SPEC, label: PRICE_LIST_LABEL, financial: false }),
  templateView({ spec: OPENING_STOCK_SPEC, label: OPENING_STOCK_LABEL, financial: false }),
  templateView({ spec: CUSTOMER_SPEC, label: CUSTOMER_LABEL, financial: false }),
  templateView({ spec: LOYALTY_OPENING_SPEC, label: LOYALTY_OPENING_LABEL, financial: false }),
]);
