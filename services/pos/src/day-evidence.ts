// API-05 The closed-day EVIDENCE PACK (M14-FR-04 "produce evidence pack (sales, tenders, cash, over/short, exceptions)").
//
// `GET /v1/pos/day-close/:dayCloseId/evidence-pack` — the store-day that close belongs to, as head office holds it: every
// sale and refund, takings and refunds per tender, each till's cash and over/short, every exception (open or resolved),
// and every close and reopen with who approved it — sealed with a SHA-256 over its content, and as one CSV for the CA.
// A read: it changes nothing. The export itself is recorded on the audit trail (who took which pack, its hash), so the
// CA's copy can always be traced back. Gated `till.dayclose.read` (owner, store manager for their store, accountant).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, assertRecordBranchInScope } from '../../kernel/src/index';
import { buildDayEvidencePack, dayEvidenceCsv, verifyDayEvidencePack, type DayEvidenceFacts } from '../../../packages/day-close/src/evidence-pack';

export interface DayEvidenceDeps {
  /** The store and trading day a recorded close names; undefined when no such close is recorded. */
  readonly closeOf: (tenantId: string, dayCloseId: string) => Promise<{ readonly storeId: string; readonly tradingDay: string } | undefined>;
  /** Every recorded fact of that store-day. */
  readonly facts: (tenantId: string, storeId: string, tradingDay: string) => Promise<DayEvidenceFacts>;
  /** The export on the audit trail. Absent on a bare stub: nothing is recorded and nothing is claimed. */
  readonly recordExport?: (tenantId: string, entry: { readonly by: string; readonly storeId: string; readonly tradingDay: string; readonly dayCloseId: string; readonly contentHash: string; readonly at: string }) => Promise<void>;
  readonly now: () => string;
}

export function dayEvidenceRoutes(deps: DayEvidenceDeps): readonly Route[] {
  return [
    {
      api: 'API-05', method: 'GET', path: '/v1/pos/day-close/:dayCloseId/evidence-pack',
      permission: 'till.dayclose.read',
      handler: async (ctx) => {
        const dayCloseId = ctx.params['dayCloseId'] ?? '';
        const close = await deps.closeOf(ctx.tenantId, dayCloseId);
        if (close === undefined) throw notFound(`closed day ${dayCloseId}`);
        assertRecordBranchInScope(ctx, close.storeId);
        const facts = await deps.facts(ctx.tenantId, close.storeId, close.tradingDay);
        if (facts.closes.length === 0) {
          throw apiError(409, { code: 'day_not_closed', whatHappened: `Head office holds no close for store ${close.storeId} on ${close.tradingDay}.`, wasItSaved: 'not_saved', nextSafeAction: 'Close the day at the store; the pack is made from a closed day.' });
        }
        const pack = buildDayEvidencePack(facts);
        const at = deps.now();
        if (deps.recordExport !== undefined) await deps.recordExport(ctx.tenantId, { by: ctx.userId, storeId: close.storeId, tradingDay: close.tradingDay, dayCloseId, contentHash: pack.contentHash, at });
        return {
          status: 200,
          body: {
            pack, verified: verifyDayEvidencePack(pack),
            csv: dayEvidenceCsv(pack),
            fileName: `day-evidence-${close.storeId}-${close.tradingDay}-${pack.contentHash.slice(0, 12)}`,
            exportedBy: ctx.userId, exportedAt: at,
            said: pack.final
              ? `Store ${close.storeId}, ${close.tradingDay}: closed and locked. ${pack.sales.count} bills, ${pack.refunds.count} refunds, ${pack.openExceptions} open exception(s). Seal ${pack.contentHash.slice(0, 12)}….`
              : `Store ${close.storeId}, ${close.tradingDay}: NOT FINAL — ${pack.notFinalBecause}`,
          },
        };
      },
    },
  ];
}
