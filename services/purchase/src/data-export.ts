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
export function buildExportDomains(sources: {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
  readonly importCommits: (tenantId: string) => Promise<readonly ImportCommitRecord[]> | readonly ImportCommitRecord[];
}): readonly ExportDomainSource[] {
  return [
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
