// Batch 18b · R1 / P1 / B2 — the PRINT VIEW of a purchase order, a goods receipt and a supplier's statement
// (M31-FR-02 "business documents" · WF-03 "PO → acknowledgement" · M07-FR-01 · P-06 · P-08).
//
// Head office already issues these documents from their own records (`POST /v1/documents/templates/:id/issue`). A person
// also needs to HOLD one: hand the purchase order to the supplier, file the GRN, send the statement. These three reads give
// the page everything it prints — read from the same registers the issue engine reads, never from the caller:
//
//   GET /v1/documents/print/purchase-orders/:poId          (`purchase.commitment.read` — who reads orders)
//   GET /v1/documents/print/goods-receipts/:grnId           (`inventory.goodsreceipt.read` — who opens the GRN list)
//   GET /v1/documents/print/supplier-statements/:supplierId (`purchase.commitment.read` — who reads a supplier's account)
//   GET /v1/documents/print/supplier-returns/:returnId      (`purchase.commitment.read` — pending 5, a return-to-supplier note)
//
// Each answers `{ view }` (packages/documents/src/print-view.ts). A record that does not exist is 404; an order still
// proposed (a draft) or a receipt still waiting for a second person is 409 — a draft is never printed as the document. A
// record about a branch the caller does not hold is refused (PA-01). Reads only: nothing is issued, numbered or changed.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, assertRecordBranchInScope } from '../../kernel/src/index';
import type { PrintKind, PrintView } from '../../../packages/documents/src/print-view';

export type PrintViewOutcome =
  | { readonly outcome: 'ready'; readonly view: PrintView; readonly branchId: string | null }
  | { readonly outcome: 'missing' | 'not_final'; readonly detail: string };

export interface DocumentPrintDeps {
  readonly printView: (tenantId: string, kind: PrintKind, id: string) => Promise<PrintViewOutcome>;
}

/** One print read: the record's own words for what it is, and what head office answers. */
async function printed(deps: DocumentPrintDeps, ctx: RequestContext, kind: PrintKind, id: string, what: string): Promise<{ status: number; body: { view: PrintView } }> {
  const out = await deps.printView(ctx.tenantId, kind, id.trim());
  if (out.outcome !== 'ready') {
    if (out.outcome === 'missing') {
      throw apiError(404, { code: 'print_source_not_found', whatHappened: out.detail, wasItSaved: 'not_saved', nextSafeAction: `Check the ${what}. Nothing was printed.` });
    }
    throw apiError(409, { code: 'print_source_not_final', whatHappened: out.detail, wasItSaved: 'not_saved', nextSafeAction: `Finish the ${what} first; a draft is never printed as the document.` });
  }
  assertRecordBranchInScope(ctx, out.branchId); // PA-01: a document about a branch the caller holds
  return { status: 200, body: { view: out.view } };
}

export function documentPrintRoutes(deps: DocumentPrintDeps): readonly Route[] {
  return [
    {
      // P1: an ISSUED purchase order, as the A4 page prints it (a proposed one is a draft: 409).
      api: 'API-11', method: 'GET', path: '/v1/documents/print/purchase-orders/:poId',
      permission: 'purchase.commitment.read',
      handler: (ctx) => printed(deps, ctx, 'purchase_order', ctx.params['poId'] ?? '', 'purchase order'),
    },
    {
      // R1: a goods receipt (GRN), as the A4 page prints it (one waiting for a second person's decision: 409).
      api: 'API-11', method: 'GET', path: '/v1/documents/print/goods-receipts/:grnId',
      permission: 'inventory.goodsreceipt.read',
      handler: (ctx) => printed(deps, ctx, 'goods_receipt', ctx.params['grnId'] ?? '', 'goods receipt'),
    },
    {
      // B2: a supplier's statement of account as at today, as the A4 page prints it.
      api: 'API-11', method: 'GET', path: '/v1/documents/print/supplier-statements/:supplierId',
      permission: 'purchase.commitment.read',
      handler: (ctx) => printed(deps, ctx, 'supplier_statement', ctx.params['supplierId'] ?? '', 'supplier statement'),
    },
    {
      // Pending 5: a return of shelf stock to the supplier (RTS), with its debit note (SDN) and where that note stands.
      // Who reads a supplier's account reads it (the store manager who returned it, the accountant who matches the note).
      api: 'API-11', method: 'GET', path: '/v1/documents/print/supplier-returns/:returnId',
      permission: 'purchase.commitment.read',
      handler: (ctx) => printed(deps, ctx, 'supplier_return', ctx.params['returnId'] ?? '', 'return to the supplier'),
    },
  ];
}
