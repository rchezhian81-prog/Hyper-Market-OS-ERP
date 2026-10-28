// R9-A · OB-534 (owner, 28 Oct 2026) — the goods-receipt screen's "Match the bill" call and what it reads of a receipt's bills.
// Kept in its own file so the shared bundle entry (browser-entry.ts) carries only an import and a few marked lines.
//
//   • `openGrnBillMatchPort` — the authenticated POST `/v1/inventory/goods-receipt/:grnId/bill-match` under the reader's own
//     session, body exactly `{ invoiceId }` (never a cost: head office takes the bill's own prices). Head office refuses the
//     person who received the goods (`self_match`, §28), an unknown bill, a bill for another order; each is said by name. No
//     connection is `lost_link` — the match is head office's record, so nothing is queued here (P-08).
//   • `billCostsOfReceipt` — the bills head office holds matched to a receipt (`billCosts`), and how many of its lines still
//     have none — carried as-is from the GRN list, never recomputed or guessed.

import type { BillMatchPostResult, GrnBillCostView, GrnBillMatchPort } from './goods-receipt-session';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One matched line as head office sent it (`BillCost`) → the screen's view. */
function billCostOf(b: Record<string, unknown>): GrnBillCostView {
  const unit = (typeof b['unitCost'] === 'object' && b['unitCost'] !== null ? b['unitCost'] : {}) as Record<string, unknown>;
  return {
    lineId: str(b['lineId']), productId: str(b['productId']), invoiceId: str(b['invoiceId']),
    unitCostMinor: num(unit['minor']), currency: str(unit['currency']) || 'INR',
    matchedBy: str(b['matchedBy']), matchedAt: str(b['matchedAt']),
    ...(b['costWasKnown'] === true ? { costWasKnown: true } : {}),
  };
}

/** OB-534: a receipt's matched bills and its lines still waiting for one, from the GRN as head office listed it. */
export function billCostsOfReceipt(g: Record<string, unknown>): { readonly billCosts?: readonly GrnBillCostView[]; readonly unbilledLineCount: number } {
  const costs = Array.isArray(g['billCosts']) ? (g['billCosts'] as Record<string, unknown>[]).map(billCostOf) : [];
  const captured = (g['captured'] ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(captured['lines']) ? captured['lines'] as Record<string, unknown>[] : [];
  const billed = new Set(costs.map((c) => c.lineId));
  const unbilledLineCount = lines.filter((l) => !billed.has(str(l['lineId']))).length;
  return { ...(costs.length === 0 ? {} : { billCosts: costs }), unbilledLineCount };
}

/** OB-534: the bill-match write, under the reader's own session. A fresh key per press (head office answers a re-match by state). */
export function openGrnBillMatchPort(): GrnBillMatchPort {
  return {
    post: async ({ grnId, invoiceId }): Promise<BillMatchPostResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return { result: 'lost_link' };
      const key = globalThis.crypto?.randomUUID?.() ?? `grn-bill-match-${grnId}-${invoiceId}`;
      try {
        const res = await fetchFn(`/v1/inventory/goods-receipt/${encodeURIComponent(grnId)}/bill-match`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ invoiceId }),
        });
        const body = (await res.json().catch(() => ({}))) as { matched?: unknown; alreadyMatched?: boolean; whatHappened?: string; code?: string; error?: { code?: string; whatHappened?: string } };
        if (res.status >= 200 && res.status < 300) {
          const matched = Array.isArray(body.matched) ? (body.matched as Record<string, unknown>[]).map(billCostOf) : [];
          return { result: body.alreadyMatched === true ? 'already_matched' : 'matched', matched };
        }
        const code = body.error?.code ?? body.code ?? '';
        const reason = body.error?.whatHappened ?? body.whatHappened ?? 'head office did not match the bill';
        if (code === 'self_match') return { result: 'self_match', reason };
        if (code === 'bill_unknown') return { result: 'bill_unknown', reason };
        if (res.status === 401 || res.status === 403) return { result: 'not_permitted', reason };
        return { result: 'refused', reason };
      } catch {
        return { result: 'lost_link' };
      }
    },
  };
}
