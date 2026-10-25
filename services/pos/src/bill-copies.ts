// API-05 Copies of a bill printed by its number (OB-373 · M12-FR-02 "digital/print receipts" · D04-FR-05 · P-03 · P-08 ·
// hard rules #2 and #6).
//
// A sale paid on a handheld queue till gets its paper bill by REPRINT at a till or the service desk, by its bill number (the
// owner's decision, 25 Oct 2026: no printer on the handheld). The store computer prints the copy offline — marked as a
// duplicate, for the person signed in at that till — and keeps a record of it on its own disk before the copy is given;
// that record is relayed here.
//
//   POST /v1/bill-copies/:copyId/synced   the store computer relays one printed copy (pos.billcopy.sync — the store
//        computer's own role). Kept once (a re-send is the same fact), stamped with the relaying box's store; the person it
//        names is RE-CHECKED against head office's own grants: one who holds no till authority is kept and FLAGGED, never
//        dropped and never silently believed.
//   GET  /v1/bill-copies?branchId=&day=   the copies printed at a store on a trading day — who, at which till, of which
//        bill (on which lane), which copy, and why. It reads; nothing is changed.

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope } from '../../kernel/src/index';

export interface BillCopyRecord {
  readonly copyId: string;
  readonly storeId: string;
  /** The till that printed the copy. */
  readonly laneId: string;
  /** The person the store computer verified at that till. */
  readonly printedBy: string;
  readonly via: string;
  /** The bill copied: its number, its sale, and the lane it was rung on (a handheld's is `device:<id>`). */
  readonly billNumber: string;
  readonly saleId: string;
  readonly billLaneId: string;
  /** 1 for the first copy of this bill, then 2, 3 … (the original is never counted). */
  readonly copyNumber: number;
  readonly reason: string;
  readonly at: string;
  readonly tradingDay: string;
  /** Head office's own grants: does the person hold till authority? false = kept and flagged (P-08). */
  readonly printerAuthorityHeld: boolean;
  readonly relayedBy: string;
}

export interface BillCopyDeps {
  readonly now: () => string;
  readonly copies: (tenantId: string) => Promise<readonly BillCopyRecord[]>;
  readonly record: (tenantId: string, r: BillCopyRecord) => Promise<void>;
  /** The permissions a person holds by head office's own grants, or undefined when nobody of that id is known. */
  readonly permissionsOf?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
}

const isStr = (v: unknown, max = 120): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function billCopyRoutes(deps: BillCopyDeps): readonly Route[] {
  return [
    {
      api: 'API-05', method: 'POST', path: '/v1/bill-copies/:copyId/synced',
      permission: 'pos.billcopy.sync', idempotent: true,
      handler: async (ctx) => {
        const copyId = (ctx.params['copyId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (copyId === '' || b['copyId'] !== copyId || !isStr(b['storeId']) || !isStr(b['laneId']) || !isStr(b['printedBy']) || !isStr(b['billNumber'])
          || !isStr(b['saleId']) || !isStr(b['billLaneId']) || typeof b['copyNumber'] !== 'number' || !Number.isSafeInteger(b['copyNumber']) || b['copyNumber'] < 1
          || !isStr(b['reason'], 300) || !isTime(b['at']) || !isDay(b['tradingDay'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_bill_copy',
            whatHappened: 'A relayed bill copy needs its copyId matching the address, the store, the till, the person, the bill number, its sale, the lane it was rung on, the copy number, the reason, when and the trading day.',
            wasItSaved: 'not_saved', nextSafeAction: 'Keep it in the store computer\'s queue and raise it. The sale and the copy already printed are unaffected.',
          });
        }
        assertBranchInScope(ctx, b['storeId'] as string);
        const prior = (await deps.copies(ctx.tenantId)).find((x) => x.copyId === copyId);
        if (prior !== undefined) return { status: 200, body: { copyId, recorded: true, alreadyRecorded: true } };
        const held = deps.permissionsOf === undefined ? undefined : await deps.permissionsOf(ctx.tenantId, (b['printedBy'] as string).trim());
        const record: BillCopyRecord = {
          copyId, storeId: (b['storeId'] as string).trim(), laneId: (b['laneId'] as string).trim(), printedBy: (b['printedBy'] as string).trim(),
          via: isStr(b['via']) ? (b['via'] as string).trim() : 'unknown', billNumber: (b['billNumber'] as string).trim(), saleId: (b['saleId'] as string).trim(),
          billLaneId: (b['billLaneId'] as string).trim(), copyNumber: b['copyNumber'] as number, reason: (b['reason'] as string).trim(),
          at: new Date(Date.parse(b['at'] as string)).toISOString(), tradingDay: b['tradingDay'] as string,
          printerAuthorityHeld: (held ?? []).includes('pos.sale.sync'), relayedBy: ctx.userId,
        };
        await deps.record(ctx.tenantId, record);
        return { status: 201, body: { copyId, recorded: true, printerAuthorityHeld: record.printerAuthorityHeld } };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/bill-copies',
      permission: 'pos.sale.read',
      handler: async (ctx) => {
        const branchId = (ctx.query['branchId'] ?? '').trim();
        const day = ctx.query['day'];
        if (branchId === '' || !isDay(day)) {
          throw apiError(400, { code: 'branch_and_day_not_given', whatHappened: 'Say which branch and which trading day (?branchId=&day=YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send both. Nothing was changed; this only reads.' });
        }
        assertBranchInScope(ctx, branchId);
        const copies = (await deps.copies(ctx.tenantId)).filter((r) => r.storeId === branchId && r.tradingDay === day).sort((a, b) => a.at.localeCompare(b.at));
        return {
          status: 200,
          body: {
            branchId, day, copies, count: copies.length,
            ofHandheldBills: copies.filter((c) => c.billLaneId.startsWith('device:')).length,
            flagged: copies.filter((c) => !c.printerAuthorityHeld).length,
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
