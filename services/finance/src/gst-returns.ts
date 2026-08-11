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
  validateOutwardLine, gstr1Table12,
  type OutwardSupplyLine, type ClassifiedLine, type SupplyKind,
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

export interface GstReturnsDeps {
  /** Every outward-supply document recorded (deduped by id) — GSTR-1 folds over these. */
  readonly documents: (tenantId: string) => Promise<readonly StoredOutwardDoc[]> | readonly StoredOutwardDoc[];
  /** Persist a document's outward-supply lines. Idempotent per document id. */
  readonly record: (tenantId: string, doc: StoredOutwardDoc) => Promise<void> | void;
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
  ];
}
