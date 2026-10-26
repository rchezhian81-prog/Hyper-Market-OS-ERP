// OB-383 (owner decision, 26 Oct 2026) — a recall started by mistake (WF-09 "cancellation").
//
// "A recall started by mistake may be withdrawn only before any customer is called or any stock is disposed of; after
// that it is closed with evidence." This is that one step, beside the recall's start and its closure (`recall.ts`):
//
//   • allowed only on an OPEN recall, with a reason in words, and with the person's own statement that no customer has
//     been phoned (the shop phones customers from the call list; the system cannot see a phone call, so the person who
//     withdraws says so in writing, on the record);
//   • REFUSED BY NAME once head office holds any sign that the recall has reached a customer or the stock — a recall
//     message sent or attempted to any customer (`customers_already_contacted`), or any of the batch disposed of since
//     the recall started (`stock_already_disposed`). After that the recall is closed with evidence, as before;
//   • the withdrawal is a NEW event (`RecallWithdrawn`) on the recall's append-only stream and a sealed audit entry —
//     the recall record is kept for good, marked "withdrawn — started by mistake", never deleted (hard rules #2, #6);
//   • gated like the start and the closure (`quality.recall.initiate`, Compliance/Owner, §28): whoever may start one may
//     withdraw their mistake, and a cashier may do neither.
//
// The rule is the tested `RecallRegistry.withdraw` in `@sre/traceability`; this file is the HTTP skin. Withdrawing lifts
// the batch's block exactly as a closure does (the sale-blocks read folds only OPEN recalls).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  RecallWithdrawRefusedError, type RecallRegistry, type RecallRecord, type RecallWithdrawRefusal,
} from '../../../packages/traceability/src/index';

/** What head office knows about how far a recall has gone (OB-383's two conditions). */
export interface RecallReach {
  /** Distinct customers a recall message was sent or attempted to, for this batch. */
  readonly customersContacted: number;
  /** Quantity of this batch disposed of (written off / destroyed) since the recall started, in its own minor units. */
  readonly stockDisposed: number;
}

export interface RecallWithdrawalDeps {
  /** The tested registry rebuilt from every recall event. */
  readonly registry: (tenantId: string) => Promise<RecallRegistry> | RecallRegistry;
  /** How far the recall on this batch has gone since it started. */
  readonly reach: (tenantId: string, batchId: string, since: string) => Promise<RecallReach>;
  /** Append the withdrawal (idempotent on the caller's key). */
  readonly recordWithdrawn: (tenantId: string, record: RecallRecord, key: string) => Promise<void> | void;
  /** Seal the withdrawal on the audit trail. */
  readonly recordAudit: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const REFUSAL_CODE: Readonly<Record<RecallWithdrawRefusal, { status: number; code: string; next: string }>> = {
  no_open_recall: { status: 409, code: 'no_open_recall_to_withdraw', next: 'Check the batch code. A closed or withdrawn recall stays as it is; its record is kept.' },
  needs_a_reason: { status: 400, code: 'recall_withdrawal_needs_a_reason', next: 'Say in words why the recall was started by mistake (at least five letters). Nothing was changed.' },
  customers_already_contacted: { status: 409, code: 'recall_customers_already_contacted', next: 'Close the recall with evidence instead — what was found, who was told. Nothing was changed.' },
  stock_already_disposed: { status: 409, code: 'recall_stock_already_disposed', next: 'Close the recall with evidence instead — what was disposed of, and why. Nothing was changed.' },
};

export function recallWithdrawalRoutes(deps: RecallWithdrawalDeps): readonly Route[] {
  return [
    {
      // Withdraw a recall started by mistake. Body: { reason, noCustomerPhoned: true }.
      api: 'API-04', method: 'POST', path: '/v1/quality/recalls/:batchId/withdrawal',
      permission: 'quality.recall.initiate', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        if (batchId === '') throw notFound('recall (no batch id given)');
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reason = typeof b['reason'] === 'string' ? b['reason'] : '';
        if (b['noCustomerPhoned'] !== true) {
          throw apiError(400, {
            code: 'recall_withdrawal_needs_no_phone_call_confirmed',
            whatHappened: `A recall can be withdrawn only before any customer is called (OB-383). Head office cannot see a phone call, so the person withdrawing it must confirm that no customer has been phoned about batch "${batchId}".`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'If nobody has been phoned, tick "No customer has been phoned" and send again. If anyone has, close the recall with evidence instead.',
          });
        }
        const registry = await deps.registry(ctx.tenantId);
        const open = registry.find(batchId);
        const reach: RecallReach = open !== undefined && open.status === 'open'
          ? await deps.reach(ctx.tenantId, batchId, open.initiatedAt)
          : { customersContacted: 0, stockDisposed: 0 };
        let record: RecallRecord;
        try {
          record = registry.withdraw({ batchId, withdrawnBy: ctx.userId, reason, at: deps.now(), ...reach });
        } catch (err) {
          if (err instanceof RecallWithdrawRefusedError) {
            const r = REFUSAL_CODE[err.refusal];
            throw apiError(r.status, { code: r.code, whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: r.next });
          }
          throw err;
        }
        await deps.recordWithdrawn(ctx.tenantId, record, ctx.idempotencyKey ?? `${batchId}:withdraw`);
        await deps.recordAudit(ctx.tenantId, {
          actorId: ctx.userId, action: 'quality.recall.withdraw', objectType: 'recall', objectId: `recall:${batchId}`,
          at: record.withdrawal?.withdrawnAt ?? deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { status: 'open', initiatedBy: record.initiatedBy, initiatedAt: record.initiatedAt },
          after: { status: 'withdrawn', customersContacted: '0', stockDisposed: '0', noCustomerPhoned: 'confirmed' },
          reason: record.withdrawal?.reason ?? reason, correlationId: ctx.traceId,
        });
        return { status: 200, body: { recall: record } };
      },
    },
  ];
}
