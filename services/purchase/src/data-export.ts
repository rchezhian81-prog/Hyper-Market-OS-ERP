// Domain data export — your data is yours, on the cloud API (M30-FR-02 / NFR-12 / OD-09 / P-06).
//
// The promise is that there is **no proprietary-only route to retrieve business data**: every
// authorised domain exports to an open, self-describing format (CSV + a JSON schema any spreadsheet
// or other system can read). The tested engine (`packages/export`) already enforces the three
// controls that make an export safe rather than a data leak:
//   • PERMISSION — default-deny via the same RBAC engine that guards every action; a user without
//     the domain's export permission gets nothing (P-04);
//   • SCOPE — rows outside the caller's branch scope are filtered out (§28);
//   • CLASSIFICATION — a column marked sensitive (PII / payment) is REDACTED, not dropped, unless
//     the caller additionally holds `export.sensitive` — so the file's shape never lies (PRV).
// None of it was reachable on the API. This wires it:
//
//   • LIST (`GET /v1/export`) — the catalogue of exportable domains and their columns (which are
//     sensitive), so a person knows what they can take and in what shape. No data.
//   • EXPORT (`POST /v1/export/:domain`) — run the engine for one domain: the caller's own
//     authority decides whether it is allowed, which branch's rows come back, and whether sensitive
//     columns are shown or redacted. Every export is LOGGED — an append-only record of who took
//     what, when, how many rows, and which columns were redacted for them (M30-FR-02, hard rule #6),
//     because the audit record is the only evidence afterwards of who extracted the shop's data.
//   • LOG (`GET /v1/exports`) — that export audit trail, newest first.
//
// All three gated `export.read`; the domain's own permission and `export.sensitive` are enforced
// underneath by the engine, per domain and per caller. No AI exports anything (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  exportDomain, type ExportSpec, type ExportContext, type ExportAudit, type ExportResult,
} from '../../../packages/export/src/export';
import { AccessControl, AccessDeniedError } from '../../../packages/rbac/src/rbac';
import type { ProductRecord } from '../../../packages/product/src/product';
import type { ImportCommitRecord } from './data-import';

type Row = Readonly<Record<string, string>>;

/** One exportable domain: its open schema, and where its rows come from (a store fold). */
export interface ExportDomainSource {
  readonly spec: ExportSpec;
  readonly rows: (tenantId: string) => Promise<readonly Row[]> | readonly Row[];
}

/** The append-only export audit ledger (who took what) — an `ExportAudit` per export. */
export interface DataExportAuditDeps {
  readonly exports: (tenantId: string) => Promise<readonly ExportAudit[]> | readonly ExportAudit[];
  readonly recordExport: (tenantId: string, record: ExportAudit, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export interface DataExportDeps extends DataExportAuditDeps {
  readonly domains: readonly ExportDomainSource[];
  /** The caller's authority for this tenant — the SAME per-tenant resolver the kernel uses. */
  readonly access: (tenantId: string) => Promise<AccessControl> | AccessControl;
}

/**
 * The production export domains, each backed by an already-folded read model:
 *   • `products` — the product master (M03), gated `catalogue.pack.read`;
 *   • `import-commits` — the M30 bulk-import audit ledger (what was loaded, by whom, approved by
 *     whom), gated `purchase.import.read`.
 * Every value is emitted as text for an open CSV; a missing optional is blank, never invented.
 */
/** A sale as the export reads it — the sales ledger's own record (SF-10). */
export interface ExportSale {
  readonly saleId: string; readonly receiptNumber: string; readonly tradingDay: string; readonly committedAt: string;
  readonly locationId?: string; readonly laneId: string; readonly cashierId: string; readonly totalMinor: number;
  readonly tenders: readonly { readonly kind: string; readonly amountMinor: number }[]; readonly customerRef?: string;
}
/** A stock position as the export reads it — the stock ledger's availability fold. */
export interface ExportStockRow { readonly productId: string; readonly locationId: string; readonly onHandMinor: number }
/** A supplier as the export reads it — the supplier master. */
export interface ExportSupplier {
  readonly supplierId: string; readonly name: string; readonly gstin: string | null; readonly phone: string | null; readonly email: string | null;
  readonly address: string | null; readonly paymentTermsDays: number | null; readonly status: string; readonly approvedBy: string | null;
}
/** One journal line as the export reads it — the finance ledger. */
export interface ExportJournal {
  readonly entryId: string; readonly period: string; readonly documentDate: string; readonly narrative: string; readonly postedBy: string;
  readonly lines: readonly { readonly accountCode: string; readonly debitMinor: number; readonly creditMinor: number }[];
}

/**
 * The EXPORT COVERAGE REGISTER (audit SF-10 · M30-FR-02 · P-06): every business-data domain, and whether the shop can
 * take it out through the governed export (`exported`) or not yet (`not_yet`, with why and where it is planned). A
 * guardrail checks that every `exported` entry is a registered domain, so the register cannot claim coverage the
 * engine does not give.
 */
export const EXPORT_COVERAGE: readonly { readonly domain: string; readonly module: string; readonly status: 'exported' | 'not_yet'; readonly exportDomain?: string; readonly why?: string }[] = [
  { domain: 'Product master', module: 'M03', status: 'exported', exportDomain: 'products' },
  { domain: 'Import loads (what was loaded, by whom)', module: 'M30', status: 'exported', exportDomain: 'import-commits' },
  { domain: 'Sales (bills and how they were paid)', module: 'M12/M13', status: 'exported', exportDomain: 'sales' },
  { domain: 'Stock on hand by store', module: 'M08', status: 'exported', exportDomain: 'stock-on-hand' },
  { domain: 'Supplier master', module: 'M06/M24', status: 'exported', exportDomain: 'suppliers' },
  { domain: 'Ledger journals', module: 'M23', status: 'exported', exportDomain: 'ledger-journals' },
  { domain: 'Purchase orders', module: 'M06', status: 'not_yet', why: 'needs the purchase-order read model on the export engine — the next adapter' },
  { domain: 'Customers and consent', module: 'M16', status: 'not_yet', why: 'personal data: a customer\'s own copy is the access/export request (FUL-06); a bulk export needs the owner\'s decision on who may take it' },
  { domain: 'Loyalty points and store credit', module: 'M17', status: 'not_yet', why: 'member codes are pseudonymous; the export shape is with the loyalty liability work' },
  { domain: 'Online orders', module: 'M18', status: 'not_yet', why: 'needs a tenant-wide order index on the export engine' },
  { domain: 'Payroll and attendance', module: 'M26', status: 'not_yet', why: 'sensitive personal data — needs a per-column classification agreed with the owner before any export' },
];

export function buildExportDomains(sources: {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
  readonly importCommits: (tenantId: string) => Promise<readonly ImportCommitRecord[]> | readonly ImportCommitRecord[];
  /** SF-10: the further governed domains. Each optional — absent, the domain is not offered (never an empty file). */
  readonly sales?: (tenantId: string) => Promise<readonly ExportSale[]>;
  readonly stock?: (tenantId: string) => Promise<readonly ExportStockRow[]>;
  readonly suppliers?: (tenantId: string) => Promise<readonly ExportSupplier[]>;
  readonly journals?: (tenantId: string) => Promise<readonly ExportJournal[]>;
}): readonly ExportDomainSource[] {
  const more: ExportDomainSource[] = [];
  if (sources.sales !== undefined) {
    const sales = sources.sales;
    more.push({
      spec: {
        domain: 'sales', requires: 'reporting.report.read', branchColumn: 'store',
        columns: [
          { name: 'saleId', type: 'text' }, { name: 'receiptNumber', type: 'text' }, { name: 'tradingDay', type: 'date' },
          { name: 'committedAt', type: 'date' }, { name: 'store', type: 'text', description: 'The store (location) the bill was rung at.' },
          { name: 'lane', type: 'text' }, { name: 'cashier', type: 'text' }, { name: 'totalMinor', type: 'integer', description: 'Bill total in paise, GST included.' },
          { name: 'tenders', type: 'text', description: 'kind:amount pairs, e.g. cash:5000;card:50000.' },
          { name: 'memberRef', type: 'text', sensitive: true, description: 'The loyalty member code (pseudonymous) — redacted without export.sensitive.' },
        ],
      },
      rows: async (t) => (await sales(t)).map((x) => ({
        saleId: x.saleId, receiptNumber: x.receiptNumber, tradingDay: x.tradingDay, committedAt: x.committedAt, store: x.locationId ?? '',
        lane: x.laneId, cashier: x.cashierId, totalMinor: String(x.totalMinor), tenders: x.tenders.map((d) => `${d.kind}:${d.amountMinor}`).join(';'),
        memberRef: x.customerRef ?? '',
      })),
    });
  }
  if (sources.stock !== undefined) {
    const stock = sources.stock;
    more.push({
      spec: {
        domain: 'stock-on-hand', requires: 'inventory.availability.read', branchColumn: 'store',
        columns: [{ name: 'productId', type: 'text' }, { name: 'store', type: 'text' }, { name: 'onHandMinor', type: 'integer', description: 'In the product\'s base unit (grams for weighed goods, OB-31).' }],
      },
      rows: async (t) => (await stock(t)).map((r) => ({ productId: r.productId, store: r.locationId, onHandMinor: String(r.onHandMinor) })),
    });
  }
  if (sources.suppliers !== undefined) {
    const suppliers = sources.suppliers;
    more.push({
      spec: {
        domain: 'suppliers', requires: 'supplier.view',
        columns: [
          { name: 'supplierId', type: 'text' }, { name: 'name', type: 'text' }, { name: 'gstin', type: 'text' },
          { name: 'phone', type: 'text', sensitive: true }, { name: 'email', type: 'text', sensitive: true }, { name: 'address', type: 'text', sensitive: true },
          { name: 'paymentTermsDays', type: 'integer' }, { name: 'status', type: 'enum', description: 'proposed | active.' }, { name: 'approvedBy', type: 'text' },
        ],
      },
      rows: async (t) => (await suppliers(t)).map((x) => ({
        supplierId: x.supplierId, name: x.name, gstin: x.gstin ?? '', phone: x.phone ?? '', email: x.email ?? '', address: x.address ?? '',
        paymentTermsDays: x.paymentTermsDays === null ? '' : String(x.paymentTermsDays), status: x.status, approvedBy: x.approvedBy ?? '',
      })),
    });
  }
  if (sources.journals !== undefined) {
    const journals = sources.journals;
    more.push({
      spec: {
        domain: 'ledger-journals', requires: 'finance.period.read',
        columns: [
          { name: 'entryId', type: 'text' }, { name: 'period', type: 'text' }, { name: 'documentDate', type: 'date' }, { name: 'account', type: 'text' },
          { name: 'debitMinor', type: 'integer' }, { name: 'creditMinor', type: 'integer' }, { name: 'narrative', type: 'text' }, { name: 'postedBy', type: 'text' },
        ],
      },
      // One row per journal LINE — the shape any accounting package imports.
      rows: async (t) => (await journals(t)).flatMap((j) => j.lines.map((l) => ({
        entryId: j.entryId, period: j.period, documentDate: j.documentDate, account: l.accountCode,
        debitMinor: String(l.debitMinor), creditMinor: String(l.creditMinor), narrative: j.narrative, postedBy: j.postedBy,
      }))),
    });
  }
  return [
    ...more,
    {
      spec: {
        domain: 'products',
        requires: 'catalogue.pack.read',
        columns: [
          { name: 'productId', type: 'text', description: 'Stable internal product id.' },
          { name: 'sku', type: 'text', description: 'Stock-keeping unit.' },
          { name: 'name', type: 'text' },
          { name: 'brand', type: 'text' },
          { name: 'manufacturer', type: 'text' },
          { name: 'category', type: 'text', description: 'Primary reporting category id.' },
          { name: 'uom', type: 'text', description: 'Base unit of measure.' },
          { name: 'taxClass', type: 'text', description: 'HSN / tax-class code.' },
          { name: 'status', type: 'enum', description: 'draft | new | active | clearance | discontinued.' },
          { name: 'recallBlocked', type: 'enum', description: 'yes when sale and purchase are blocked.' },
        ],
      },
      rows: async (t) =>
        (await sources.products(t)).map((p) => ({
          productId: p.productId,
          sku: p.sku,
          name: p.name,
          brand: p.brand ?? '',
          manufacturer: p.manufacturer ?? '',
          category: p.primaryCategoryId ?? '',
          uom: p.baseUom,
          taxClass: p.taxClass ?? '',
          status: p.lifecycle,
          recallBlocked: p.recallBlocked === true ? 'yes' : 'no',
        })),
    },
    {
      spec: {
        domain: 'import-commits',
        requires: 'purchase.import.read',
        columns: [
          { name: 'jobId', type: 'text' },
          { name: 'template', type: 'text', description: 'Import template id.' },
          { name: 'domain', type: 'text', description: 'What the file loaded into.' },
          { name: 'uploadedBy', type: 'text' },
          { name: 'approvedBy', type: 'text', description: 'The separate approver (§28).' },
          { name: 'rowsApplied', type: 'integer' },
          { name: 'reconciles', type: 'text', description: 'yes | no | blank (not a financial import).' },
          { name: 'at', type: 'date' },
        ],
      },
      rows: async (t) =>
        (await sources.importCommits(t)).map((c) => ({
          jobId: c.jobId,
          template: c.templateId,
          domain: c.domain,
          uploadedBy: c.uploadedBy,
          approvedBy: c.approvedBy,
          rowsApplied: String(c.rowsApplied),
          reconciles: c.reconciles === undefined ? '' : c.reconciles ? 'yes' : 'no',
          at: c.at,
        })),
    },
  ];
}

export function dataExportRoutes(deps: DataExportDeps): readonly Route[] {
  return [
    {
      // LIST — what can be exported, and in what shape (which columns are sensitive). No data.
      api: 'API-03', method: 'GET', path: '/v1/export',
      permission: 'export.read',
      handler: async () => ({
        status: 200,
        body: {
          domains: deps.domains.map((d) => ({
            domain: d.spec.domain,
            requires: d.spec.requires,
            columns: d.spec.columns.map((c) => ({
              name: c.name,
              type: c.type,
              sensitive: c.sensitive === true,
              ...(c.description !== undefined ? { description: c.description } : {}),
            })),
          })),
          asAt: deps.now(),
        },
      }),
    },
    {
      // EXPORT — run the engine for one domain. POST because it produces an audited artifact: the
      // caller's own authority decides allowed / which branch / sensitive-or-redacted, and the export
      // is logged. A replay of the same idempotency key returns the first export.
      api: 'API-03', method: 'POST', path: '/v1/export/:domain',
      permission: 'export.read', idempotent: true,
      handler: async (ctx) => {
        const name = ctx.params['domain'] ?? '';
        const source = deps.domains.find((d) => d.spec.domain === name);
        if (source === undefined) {
          throw apiError(404, {
            code: 'unknown_export_domain',
            whatHappened: `There is no exportable domain '${name}'.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the name against GET /v1/export.',
          });
        }
        const access = await deps.access(ctx.tenantId);
        const context: ExportContext = { userId: ctx.userId, branchId: ctx.branchId, at: deps.now() };
        const rows = await source.rows(ctx.tenantId);

        let result: ExportResult;
        try {
          // The engine is the single gate: the domain's own permission, branch scope, and
          // sensitive-column redaction all decided here against the caller's real authority.
          result = exportDomain(source.spec, rows, access, context);
        } catch (e) {
          if (e instanceof AccessDeniedError) {
            throw apiError(403, {
              code: 'export_not_permitted',
              whatHappened: `You may not export '${source.spec.domain}'.`,
              wasItSaved: 'not_saved',
              nextSafeAction: `This export needs the '${source.spec.requires}' permission.`,
            });
          }
          throw e;
        }

        // Exports are logged — the audit record is the only evidence afterwards of who took the data.
        await deps.recordExport(ctx.tenantId, result.audit, ctx.idempotencyKey ?? `${source.spec.domain}-${context.at}`);
        return {
          status: 200,
          body: { domain: source.spec.domain, csv: result.csv, schema: result.schema, audit: result.audit },
        };
      },
    },
    {
      // COVERAGE (SF-10) — every business-data domain and whether it can be taken out here yet, with why not. No data.
      api: 'API-03', method: 'GET', path: '/v1/export/coverage',
      permission: 'export.read',
      handler: () => {
        const offered = new Set(deps.domains.map((d) => d.spec.domain));
        const register = EXPORT_COVERAGE.map((c) => ({ ...c, offeredHere: c.exportDomain !== undefined && offered.has(c.exportDomain) }));
        return { status: 200, body: { coverage: register, exported: register.filter((c) => c.offeredHere).length, notYet: register.filter((c) => c.status === 'not_yet').length, asAt: deps.now() } };
      },
    },
    {
      // LOG — the export audit trail, newest first: who took what, when, how many rows, what was redacted.
      api: 'API-03', method: 'GET', path: '/v1/exports',
      permission: 'export.read',
      handler: async (ctx) => {
        const all = await deps.exports(ctx.tenantId);
        const ordered = [...all].sort((a, b) => b.at.localeCompare(a.at));
        return { status: 200, body: { exports: ordered, total: ordered.length, asAt: deps.now() } };
      },
    },
  ];
}
