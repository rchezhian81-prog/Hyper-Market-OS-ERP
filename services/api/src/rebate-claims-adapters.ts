// D03-FR-03 · OB-404 (owner, 27 Oct 2026, option A) — head office's wiring for the supplier REBATE CLAIM: the claim facts on
// their own append-only stream, written under each scheme's claim guard; what was earned from the purchase register's
// accruals; what was received from finance's rebate-receipt journals; the owner's answer period; and the supplier portal's
// view of the claims sent to that supplier. Kept in its own file: main.ts carries only the registration lines.

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { RebateClaimFact } from '../../../packages/purchasing/src/index';
import type { ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { rebateClaimRoutes, supplierRebateClaims, type RebateClaimDeps, type RebateAnswerPeriodSetting } from '../../purchase/src/rebate-claims';
import type { StoredRebateAccrual } from '../../purchase/src/rebates';
import type { SupplierPortalDeps } from '../../purchase/src/supplier-portal';
import { STREAM, streamName, rebatesAdapter, approvalRequestsAdapter, orgStructureAdapter, supplierMasterAdapter } from './adapters';
import { rebateJournals } from './p3-procure-adapters';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
interface Base { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf; readonly recordAudit?: Recorder }

/** Where the claim facts live (one append-only stream per shop) and the owner's answer period. Functions: nothing is read
 *  at load time (adapters.ts and this file reach each other through the composition root). */
export const rebateClaimsStream = (): string => streamName(STREAM.purchase, 'rebate-claims');
export const rebateAnswerPeriodStream = (): string => streamName(STREAM.purchase, 'rebate-claim-answer-period');

const factId = (f: RebateClaimFact): string => `rebate-claim-${f.claimId}-${f.type}${f.type === 'matched' ? `-${f.receiptId}` : ''}`;

export function rebateClaimsAdapter(input: Base): RebateClaimDeps {
  const { store, now } = input;
  const rebates = rebatesAdapter({ store, now });
  return {
    now,
    ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    approvals: approvalRequestsAdapter({ store, now }),
    schemes: (t) => rebates.schemes(t),
    accruals: async (t, schemeId) => (await rebates.accruals(t, schemeId)) as readonly StoredRebateAccrual[],
    receipts: async (t) => (await rebateJournals(store, t)).map((j) => ({
      schemeId: j.rebateReceipt.schemeId, receiptId: j.rebateReceipt.receiptId, amountMinor: j.rebateReceipt.amountMinor,
      receivedOn: j.rebateReceipt.receivedOn, reference: j.rebateReceipt.reference,
    })),
    claimFacts: async (t) => (await store.readStream(t, rebateClaimsStream(), { type: 'RebateClaimFact' })).map((e) => e.event.payload as unknown as RebateClaimFact),
    claimsVersion: (t, schemeId) => store.guardVersion(t, `rebate-claims:${schemeId}`),
    recordFact: async (t, _schemeId, fact, guard) => {
      const id = factId(fact);
      const at = fact.type === 'raised' ? fact.raisedAt : fact.type === 'sent' ? fact.sentAt : fact.type === 'withdrawn' ? fact.withdrawnAt : fact.matchedAt;
      await store.appendBatch(t, [{ stream: rebateClaimsStream(), event: makeEvent({
        id, type: 'RebateClaimFact', occurredAt: at, idempotencyKey: `${id}-${t}`, source: 'api/purchase', payload: fact as unknown as Record<string, unknown>,
      }) }], { guard });
    },
    answerPeriods: async (t) => (await store.readStream(t, rebateAnswerPeriodStream(), { type: 'RebateClaimAnswerPeriodSet' })).map((e) => e.event.payload as unknown as RebateAnswerPeriodSetting),
    recordAnswerPeriod: async (t, setting) => {
      const id = `rebate-answer-period-${setting.setAt}-${setting.setBy}`;
      await store.append(t, rebateAnswerPeriodStream(), makeEvent({
        id, type: 'RebateClaimAnswerPeriodSet', occurredAt: setting.setAt, idempotencyKey: `${id}-${t}`, source: 'api/purchase', payload: setting as unknown as Record<string, unknown>,
      }));
    },
    shopName: async (t) => {
      const company = (await orgStructureAdapter({ store, now }).nodes(t)).find((n) => n.kind === 'company' && n.status !== 'closed');
      return company === undefined ? undefined : { name: company.name, ...(company.gstin === undefined ? {} : { gstin: company.gstin }) };
    },
    supplierName: async (t, supplierId) => (await supplierMasterAdapter({ store, now }).records(t)).find((r) => r.supplierId === supplierId)?.name,
  };
}

/** The claim routes. With no store, an in-memory one (the bare surface the guardrails and the contract documents build). */
export function rebateClaimRoutesFor(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly calendar?: ShopCalendarOf; readonly recordAudit?: Recorder }): readonly Route[] {
  return rebateClaimRoutes(rebateClaimsAdapter({ ...input, store: input.store ?? new InMemoryEventStore() }));
}

/** The supplier-portal deps with the rebate claims the shop has sent that supplier (D03-FR-03 · OB-404). */
export function withSupplierRebateClaims(deps: SupplierPortalDeps, input: Base): SupplierPortalDeps {
  const claims = rebateClaimsAdapter(input);
  return { ...deps, rebateClaimsOf: (t, partnerId) => supplierRebateClaims(claims, t, partnerId) };
}
