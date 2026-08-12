// API-09 GST returns — the write path that unlocks GSTR-1 (roadmap v2.1 A5). A sale's tax-relevant lines
// (HSN, taxable value, the CGST/SGST/IGST split) are PERSISTED as append-only outward-supply facts, and
// GSTR-1 Table 12 is folded from them — so the return is computed from stored data captured at the time of
// supply, not re-derived from a catalogue that may have changed since.
//
//   • `POST /v1/finance/outward-supplies/:documentId` — record a document's lines (idempotent per
//     document; a free-text or malformed HSN is rejected before anything is stored; a B2B supply needs a
//     recipient GSTIN; the tax split must be internally consistent).
//   • `GET  /v1/finance/gstr1/table-12?from=&to=`      — the HSN-wise summary over the period, B2B/B2C split.
//
// Runs on the tested `packages/finance` GSTR-1 engine.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  validateOutwardLine, gstr1Table12, gstr1Return, toGstnGstr1,
  salesToOutwardSupplies, InvalidSalesToOutwardInput,
  type OutwardSupplyLine, type ClassifiedLine, type SupplyKind,
  type SoldTaxLine, type ProductTaxEntry, type PlaceOfSupply,
} from '../../../packages/finance/src/index';

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: readonly SupplyKind[] = ['b2b', 'b2c'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export interface StoredOutwardDoc {
  readonly documentId: string;
  readonly documentDate: string;
  readonly supplyType: SupplyKind;
  readonly recipientGstin?: string;
  readonly lines: readonly OutwardSupplyLine[];
}

/** A tax-relevant sold line from a banked sale, tagged with its supply date, for the GSTR-1-from-sales fold. */
export interface PeriodSoldLine extends SoldTaxLine {
  /** The trading day the sale was made — the GST time of supply, what the return period filters on. */
  readonly tradingDay: string;
}

export interface GstReturnsDeps {
  /** Every outward-supply document recorded (deduped by id) — GSTR-1 folds over these. */
  readonly documents: (tenantId: string) => Promise<readonly StoredOutwardDoc[]> | readonly StoredOutwardDoc[];
  /** Persist a document's outward-supply lines. Idempotent per document id. */
  readonly record: (tenantId: string, doc: StoredOutwardDoc) => Promise<void> | void;
  /**
   * Tax-relevant sold lines from banked sales whose commit falls in [fromIso, toIso). A read-only fold of
   * the sales stream — the route filters to the return period by trading day. Used by GSTR-1-from-sales.
   */
  readonly soldTaxLines: (tenantId: string, fromIso: string, toIso: string) => Promise<readonly PeriodSoldLine[]> | readonly PeriodSoldLine[];
  /**
   * The product→{HSN, rate} table read from the published catalogue (M03 master) — the DEFAULT tax mapping
   * for GSTR-1-from-sales, so the return builds without hand-keying each product's HSN. A caller-supplied
   * table still overrides it per product. Products with no HSN carried are omitted (they surface as unmapped).
   */
  readonly productTaxTable: (tenantId: string) => Promise<readonly ProductTaxEntry[]> | readonly ProductTaxEntry[];
  readonly now: () => string;
}

export function gstReturnsRoutes(deps: GstReturnsDeps): readonly Route[] {
  return [
    {
      // Persist a sale/invoice's tax lines — the write path GSTR-1 reads. Idempotent per document.
      api: 'API-09', method: 'POST', path: '/v1/finance/outward-supplies/:documentId',
      permission: 'finance.gstr.generate', idempotent: true,
      handler: async (ctx) => {
        const documentId = ctx.params['documentId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['documentDate'] !== 'string' || !DATE.test(b['documentDate']) || !KINDS.includes(b['supplyType'] as SupplyKind) || !Number.isInteger(b['annualTurnoverMinor']) || !Array.isArray(b['lines']) || b['lines'].length === 0) {
          throw apiError(400, {
            code: 'outward_needs_date_supply_turnover_lines',
            whatHappened: 'Recording outward supplies needs documentDate (YYYY-MM-DD), supplyType (b2b/b2c), annualTurnoverMinor and a non-empty lines[].',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the document date, supply type, the shop’s turnover and the tax lines.',
          });
        }
        const supplyType = b['supplyType'] as SupplyKind;
        const recipientGstin = typeof b['recipientGstin'] === 'string' ? (b['recipientGstin'] as string) : undefined;
        if (supplyType === 'b2b' && (recipientGstin === undefined || !GSTIN.test(recipientGstin))) {
          throw apiError(422, { code: 'b2b_needs_recipient_gstin', whatHappened: 'a B2B outward supply needs a valid recipient GSTIN', wasItSaved: 'not_saved', nextSafeAction: 'Send the buyer’s GSTIN, or record this as a B2C supply.' });
        }
        const turnover = b['annualTurnoverMinor'] as number;
        const lines = b['lines'] as OutwardSupplyLine[];
        const problems: string[] = [];
        lines.forEach((line, i) => {
          if (!isObj(line)) { problems.push(`line ${i} (not an object)`); return; }
          const check = validateOutwardLine(line, { annualTurnoverMinor: turnover });
          if (!check.valid) problems.push(`line ${i}: ${check.problems.join(', ')}`);
        });
        if (problems.length > 0) {
          throw apiError(422, { code: 'invalid_outward_lines', whatHappened: `outward-supply lines rejected: ${problems.join('; ')}`, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named lines — a free-text or malformed HSN is never stored.' });
        }
        const existing = (await deps.documents(ctx.tenantId)).find((d) => d.documentId === documentId);
        if (existing !== undefined) {
          return { status: 200, body: { documentId, alreadyRecorded: true, lineCount: existing.lines.length } };
        }
        await deps.record(ctx.tenantId, {
          documentId, documentDate: b['documentDate'], supplyType,
          ...(recipientGstin !== undefined ? { recipientGstin } : {}),
          lines,
        });
        return { status: 201, body: { documentId, lineCount: lines.length } };
      },
    },
    {
      // GSTR-1 Table 12 over stored outward supplies in the period.
      api: 'API-09', method: 'GET', path: '/v1/finance/gstr1/table-12',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const from = ctx.query['from'];
        const to = ctx.query['to'];
        if (from === undefined || to === undefined || !DATE.test(from) || !DATE.test(to)) {
          throw apiError(400, { code: 'table12_needs_from_to', whatHappened: 'GSTR-1 Table 12 needs ?from=YYYY-MM-DD&to=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the return period’s from and to dates.' });
        }
        const docs = (await deps.documents(ctx.tenantId)).filter((d) => d.documentDate >= from && d.documentDate <= to);
        const classified: ClassifiedLine[] = docs.flatMap((d) => d.lines.map((l) => ({ ...l, supplyKind: d.supplyType })));
        return { status: 200, body: { from, to, documentCount: docs.length, ...gstr1Table12(classified) } };
      },
    },
    {
      // GSTR-1 Table 12 folded straight from the store's own banked B2C till sales — no re-keying. The GST
      // is pulled BACK OUT of each MRP-inclusive line total against the product→{HSN, rate} table. That
      // table DEFAULTS from the published catalogue (M03 master), so the return builds with nothing to key
      // by hand; a `products[]` in the body OVERRIDES the catalogue per product (an exception the filer is
      // handling). A sold product with no mapping or a bad HSN comes back in `unmapped`, never silently off
      // the return. Read-only fold (idempotent).
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr1/from-sales/table-12',
      permission: 'finance.gstr.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const from = b['from'];
        const to = b['to'];
        if (typeof from !== 'string' || typeof to !== 'string' || !DATE.test(from) || !DATE.test(to) || to < from) {
          throw apiError(400, { code: 'from_sales_needs_period', whatHappened: 'GSTR-1 from sales needs from and to (YYYY-MM-DD), with to on or after from.', wasItSaved: 'not_saved', nextSafeAction: 'Send the return period’s from and to dates.' });
        }
        if (!Number.isInteger(b['annualTurnoverMinor'])) {
          throw apiError(400, { code: 'from_sales_needs_turnover', whatHappened: 'It needs annualTurnoverMinor (it sets the HSN digit rule).', wasItSaved: 'not_saved', nextSafeAction: 'Send the shop’s annual turnover in paise.' });
        }
        if (b['products'] !== undefined && !Array.isArray(b['products'])) {
          throw apiError(400, { code: 'products_must_be_a_table', whatHappened: 'products, when sent, must be an array of { productId, hsnCode, rateBps } overrides.', wasItSaved: 'not_saved', nextSafeAction: 'Omit products to use the catalogue’s HSN/rate mapping, or send a valid override table.' });
        }
        // Base the tax table on the published catalogue (M03), then overlay any supplied overrides per product.
        const byProduct = new Map<string, ProductTaxEntry>();
        for (const e of await deps.productTaxTable(ctx.tenantId)) byProduct.set(e.productId, e);
        const supplied = (b['products'] as unknown[] | undefined) ?? [];
        for (let i = 0; i < supplied.length; i += 1) {
          const p = supplied[i];
          if (!isObj(p) || typeof p['productId'] !== 'string' || p['productId'].trim() === ''
            || typeof p['hsnCode'] !== 'string' || !Number.isInteger(p['rateBps']) || (p['rateBps'] as number) < 0
            || (p['placeOfSupply'] !== undefined && p['placeOfSupply'] !== 'intra_state' && p['placeOfSupply'] !== 'inter_state')) {
            throw apiError(422, { code: 'invalid_product_tax_row', whatHappened: `products[${i}] must be { productId, hsnCode, rateBps (whole, non-negative), placeOfSupply? }.`, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named row — each product needs an HSN and a whole rate.' });
          }
          byProduct.set(p['productId'], {
            productId: p['productId'], hsnCode: p['hsnCode'], rateBps: p['rateBps'] as number,
            ...(p['placeOfSupply'] !== undefined ? { placeOfSupply: p['placeOfSupply'] as PlaceOfSupply } : {}),
          });
        }
        const taxTable = [...byProduct.values()];
        const pos = b['placeOfSupply'];
        if (pos !== undefined && pos !== 'intra_state' && pos !== 'inter_state') {
          throw apiError(400, { code: 'invalid_place_of_supply', whatHappened: "placeOfSupply must be 'intra_state' or 'inter_state'.", wasItSaved: 'not_saved', nextSafeAction: 'Omit it (defaults to intra-State, a counter sale) or send a valid value.' });
        }

        // Fold banked sales committed in a window generously covering the period, then filter to the return
        // period by trading day (the GST time of supply) so a late-synced sale still lands in its own month.
        const windowFrom = `${from}T00:00:00.000Z`;
        const windowTo = new Date(Date.parse(`${to}T00:00:00.000Z`) + 3 * 86_400_000).toISOString();
        const period = (await deps.soldTaxLines(ctx.tenantId, windowFrom, windowTo))
          .filter((l) => l.tradingDay >= from && l.tradingDay <= to);
        const sales: SoldTaxLine[] = period.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor, uom: l.uom, lineTotalMinor: l.lineTotalMinor }));

        try {
          const result = salesToOutwardSupplies({
            sales, taxTable, annualTurnoverMinor: b['annualTurnoverMinor'] as number,
            ...(pos !== undefined ? { placeOfSupply: pos as PlaceOfSupply } : {}),
          });
          return { status: 200, body: { from, to, soldLineCount: period.length, taxTableSize: taxTable.length, overrideCount: supplied.length, table12: result.table12, unmapped: result.unmapped, mappedLineCount: result.mappedLineCount, detail: result.detail } };
        } catch (e) {
          if (e instanceof InvalidSalesToOutwardInput) {
            throw apiError(400, { code: 'invalid_from_sales_request', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the request and re-send. Nothing was changed.' });
          }
          throw e;
        }
      },
    },
    {
      // The full GSTR-1 return for the period — B2B invoice-level, B2C rate-wise, and the HSN summary.
      api: 'API-09', method: 'GET', path: '/v1/finance/gstr1/return',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const from = ctx.query['from'];
        const to = ctx.query['to'];
        if (from === undefined || to === undefined || !DATE.test(from) || !DATE.test(to)) {
          throw apiError(400, { code: 'return_needs_from_to', whatHappened: 'The GSTR-1 return needs ?from=YYYY-MM-DD&to=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the return period’s from and to dates.' });
        }
        const docs = (await deps.documents(ctx.tenantId)).filter((d) => d.documentDate >= from && d.documentDate <= to);
        return { status: 200, body: { from, to, documentCount: docs.length, ...gstr1Return(docs) } };
      },
    },
    {
      // The GSTN portal JSON — the file the GST portal ingests. gstin + fp (MMYYYY) are supplied per export.
      api: 'API-09', method: 'GET', path: '/v1/finance/gstr1/export',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const from = ctx.query['from'];
        const to = ctx.query['to'];
        const gstin = ctx.query['gstin'];
        const fp = ctx.query['fp'];
        if (from === undefined || to === undefined || !DATE.test(from) || !DATE.test(to) || typeof gstin !== 'string' || !GSTIN.test(gstin) || typeof fp !== 'string' || !/^\d{6}$/.test(fp)) {
          throw apiError(400, { code: 'export_needs_period_gstin_fp', whatHappened: 'The GSTN export needs ?from=YYYY-MM-DD&to=YYYY-MM-DD, the supplier &gstin= and the filing period &fp=MMYYYY.', wasItSaved: 'not_saved', nextSafeAction: 'Send the period, your GSTIN and the filing month as MMYYYY.' });
        }
        const docs = (await deps.documents(ctx.tenantId)).filter((d) => d.documentDate >= from && d.documentDate <= to);
        return { status: 200, body: toGstnGstr1(gstr1Return(docs), { gstin, fp }) };
      },
    },
  ];
}
