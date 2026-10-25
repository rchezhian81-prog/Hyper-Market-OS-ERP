// OB-288 package 3 "Commercial desks" — head office's wiring for the B2B contract register and selling desk (M22-FR-01/02),
// the buyer's supplier-submission desk (M24-FR-01/02) and the Concessions desk (M27-FR-01/04). Kept in its own file: the
// shared main.ts carries only the registration lines.
//
//   • b2bContractsAdapter        — the contract register: one tenant stream, each contract's latest record (proposed, then
//                                  approved — never rewritten after approval), append-only.
//   • commercialDeskB2BHooks     — what the document chain gains: quotation pricing from the record (contract → price list)
//                                  and the contract-aware credit gate with the owner's override (OB-290).
//   • withSupplierPartnerIndex   — the supplier-portal adapter with a partner index (so the buyer has ONE queue).
//   • commercialDesksRoutes      — the contract, desk, concession-desk and supplier-review-desk routes.
//   • commercialDesksSweep       — the ops-alert worker's pass: concession agreement / insurance / licence alerts and B2B
//                                  contracts ending soon, raised to every owner (only where each feature is switched on).

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { resolvePrice } from '../../../packages/price-list/src/price-list';
import { contractsEndingWithin, contractPosition, type StoredB2BContract } from '../../../packages/b2b/src/index';
import type { ConcessionContract } from '../../../packages/concession/src/index';
import { toMaster } from '../../catalogue/src/catalogue-preview';
import {
  STREAM, streamName, b2bCreditAdapter, b2bDocumentsAdapter, b2bOrderingAdapter, priceListAdapter, productMasterAdapter,
  approvalRequestsAdapter, concessionAdapter, supplierPortalAdapter,
} from './adapters';
import { finBridgeRaiseToOwners } from './finance-bridge-adapters';
import {
  b2bContractRoutes, b2bDeskRoutes, contractPricing, contractCreditGate, CONTRACT_WARN_DAYS, CONTRACT_URGENT_DAYS,
  type B2BContractsDeps,
} from '../../finance/src/b2b-contracts';
import type { B2BDocumentsDeps } from '../../finance/src/b2b-documents';
import { concessionDeskRoutes, raiseConcessionAlerts, type ConcessionDeskDeps } from '../../finance/src/concession-desk';
import { supplierReviewDeskRoutes } from '../../purchase/src/supplier-review-desk';
import type { SupplierPortalDeps } from '../../purchase/src/supplier-portal';

interface Base { readonly store: EventStore; readonly now: () => string }

export const B2B_CONTRACTS_STREAM = streamName(STREAM.b2b, 'contracts');
/** The customers the B2B desk has met (a quotation issued for them) — an index, so the desk can list them. */
export const B2B_DESK_CUSTOMERS_STREAM = streamName(STREAM.b2b, 'desk', 'customers');
/** The suppliers the portal has met (configured or submitted) — an index, so the buyer has one queue. */
export const SUPPLIER_PARTNER_INDEX_STREAM = streamName(STREAM.purchase, 'portal', 'partners', 'index');
/** The same index stream the concession adapter writes (`CONCESSION_CONTRACT_INDEX` in adapters.ts). */
const CONCESSION_CONTRACT_INDEX = streamName(STREAM.concession, 'contracts', 'index');

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 24);
const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

// ── the B2B contract register ────────────────────────────────────────────────────────────────────────────────────

export function b2bContractsAdapter(input: Base): Pick<B2BContractsDeps, 'contracts' | 'recordContract'> {
  const { store, now } = input;
  return {
    // Each contract's latest record wins: proposed, then approved (an approved one is never followed by another record).
    contracts: async (tenantId) => {
      const byId = new Map<string, StoredB2BContract>();
      for (const c of await payloads<StoredB2BContract>(store, tenantId, B2B_CONTRACTS_STREAM, 'B2BContractRecorded')) byId.set(`${c.customerId}/${c.contractId}`, c);
      return [...byId.values()];
    },
    recordContract: async (tenantId, contract) => {
      // Keyed on the whole record: a re-sent proposal collapses; approval (or changed proposed terms) is a new fact.
      const key = digest(JSON.stringify(contract));
      await store.append(tenantId, B2B_CONTRACTS_STREAM, makeEvent({
        id: `b2b-contract-${key}`, type: 'B2BContractRecorded', occurredAt: now(),
        idempotencyKey: `b2b-contract-${tenantId}-${key}`, source: 'api/finance', payload: contract as unknown as Record<string, unknown>,
      }));
    },
  };
}

/** The full contract-route deps: the register, the approvals engine, the MRP ceiling, the account the terms reach. */
export function b2bContractsDeps(input: Base): B2BContractsDeps {
  const { now } = input;
  const credit = b2bCreditAdapter(input);
  const master = productMasterAdapter(input);
  return {
    ...b2bContractsAdapter(input),
    approvals: approvalRequestsAdapter(input),
    mrpOf: async (tenantId, productId) => {
      const record = await master.product(tenantId, productId);
      return record === undefined ? undefined : toMaster(record, now().slice(0, 10)).mrpMinor;
    },
    account: async (tenantId, customerId) => credit.account(tenantId, customerId),
    applyAccountTerms: async (tenantId, customerId, terms, at) => {
      const current = await credit.account(tenantId, customerId);
      const limit = terms.creditLimitMinor ?? current?.creditLimitMinor;
      if (limit === undefined) return; // refused before the approval was spent (the route checks)
      await credit.recordAccount(tenantId, customerId, limit, current?.currency ?? 'INR', at, terms.paymentTermsDays ?? current?.paymentTermsDays);
    },
    now,
  };
}

/**
 * What the B2B document chain gains (spread into main.ts's `b2bDocumentDeps`): a quotation priced from the record, the
 * customer remembered on the desk's index, and the contract-aware credit gate with the owner's override.
 */
export function commercialDeskB2BHooks(input: Base): Pick<B2BDocumentsDeps, 'pricing' | 'creditGate'> {
  const { store, now } = input;
  const register = b2bContractsAdapter(input);
  const prices = priceListAdapter(input);
  const credit = b2bCreditAdapter(input);
  const price = contractPricing({
    contracts: register.contracts,
    // The one price truth (P-02): the price-list engine's answer for this customer at this store — customer > store.
    listPriceOf: async (tenantId, q) => resolvePrice(await prices.entries(tenantId, q.productId), {
      productId: q.productId, at: q.at, storeId: q.storeId ?? '', customerId: q.customerId,
    })?.price.minor,
  });
  return {
    pricing: async (tenantId, q) => {
      await store.append(tenantId, B2B_DESK_CUSTOMERS_STREAM, makeEvent({
        id: `b2b-desk-customer-${digest(q.customerId)}`, type: 'B2BDeskCustomerSeen', occurredAt: now(),
        idempotencyKey: `b2b-desk-customer-${tenantId}-${digest(q.customerId)}`, source: 'api/finance', payload: { customerId: q.customerId },
      }));
      return price(tenantId, q);
    },
    creditGate: contractCreditGate({
      contracts: register.contracts,
      account: async (t, c) => credit.account(t, c),
      outstandingMinor: async (t, c) => credit.outstandingMinor(t, c),
      approvals: approvalRequestsAdapter(input),
      now,
    }),
  };
}

/** M22-FR-01: the credit check's contract state, from the register's own dates (undefined: no approved contract on record). */
export function commercialDeskContractState(input: Base): (tenantId: string, customerId: string) => Promise<{ readonly expired: boolean; readonly policy: 'block' | 'fallback' } | undefined> {
  const register = b2bContractsAdapter(input);
  return async (tenantId, customerId) => {
    const position = contractPosition(await register.contracts(tenantId), customerId, input.now().slice(0, 10));
    const c = position.inForce ?? position.lapsed;
    return c === undefined ? undefined : { expired: position.inForce === undefined, policy: c.onExpiry };
  };
}

// ── the supplier-portal partner index ────────────────────────────────────────────────────────────────────────────

const indexPartner = async (store: EventStore, now: () => string, tenantId: string, partnerId: string): Promise<void> => {
  await store.append(tenantId, SUPPLIER_PARTNER_INDEX_STREAM, makeEvent({
    id: `portal-partner-index-${digest(partnerId)}`, type: 'SupplierPartnerIndexed', occurredAt: now(),
    idempotencyKey: `portal-partner-index-${tenantId}-${digest(partnerId)}`, source: 'api/purchase', payload: { partnerId },
  }));
};

/** The supplier-portal adapter, indexing each partner it configures or receives from (the buyer's one queue reads it). */
export function withSupplierPartnerIndex(deps: SupplierPortalDeps, input: Base): SupplierPortalDeps {
  return {
    ...deps,
    recordPartner: async (tenantId, partnerId, config, at) => { await deps.recordPartner(tenantId, partnerId, config, at); await indexPartner(input.store, input.now, tenantId, partnerId); },
    recordSubmission: async (tenantId, partnerId, record) => { await deps.recordSubmission(tenantId, partnerId, record); await indexPartner(input.store, input.now, tenantId, partnerId); },
  };
}

// ── the concession desk ──────────────────────────────────────────────────────────────────────────────────────────

function concessionDeskDeps(input: Base): ConcessionDeskDeps {
  const { store, now } = input;
  const concessions = concessionAdapter(input);
  return {
    contracts: async (tenantId) => {
      const ids = [...new Set((await payloads<{ contractId: string }>(store, tenantId, CONCESSION_CONTRACT_INDEX, 'ConcessionContractIndexed')).map((x) => x.contractId))].sort();
      const out: ConcessionContract[] = [];
      for (const id of ids) { const c = await concessions.contract(tenantId, id); if (c !== undefined) out.push(c); }
      return out;
    },
    depositMovements: async (tenantId, id) => concessions.depositMovements(tenantId, id),
    raiseToOwners: (tenantId, alert, by, at) => finBridgeRaiseToOwners(store, now, tenantId, alert.alertId, `Concession ${alert.name}`, alert.detail, by, at, alert.alertId),
    now,
  };
}

// ── the routes ───────────────────────────────────────────────────────────────────────────────────────────────────

export function commercialDesksRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string }): readonly Route[] {
  const base: Base = { store: input.store ?? new InMemoryEventStore(), now: input.now };
  const register = b2bContractsAdapter(base);
  const credit = b2bCreditAdapter(base);
  const documents = b2bDocumentsAdapter(base);
  const ordering = b2bOrderingAdapter(base);
  const portal = supplierPortalAdapter(base);
  return [
    ...b2bContractRoutes(b2bContractsDeps(base)),
    ...b2bDeskRoutes({
      contracts: register.contracts,
      account: async (t, c) => credit.account(t, c),
      outstandingMinor: async (t, c) => credit.outstandingMinor(t, c),
      documents: async (t, c) => documents.documents(t, c),
      knownCustomers: async (t) => [
        ...(await payloads<{ customerId: string }>(base.store, t, B2B_DESK_CUSTOMERS_STREAM, 'B2BDeskCustomerSeen')).map((x) => x.customerId),
        ...(await ordering.quoteRequests(t)).map((r) => r.customerId),
      ],
      now: base.now,
    }),
    ...concessionDeskRoutes(concessionDeskDeps(base)),
    ...supplierReviewDeskRoutes({
      partners: async (t) => (await payloads<{ partnerId: string }>(base.store, t, SUPPLIER_PARTNER_INDEX_STREAM, 'SupplierPartnerIndexed')).map((x) => x.partnerId),
      submissions: (t, p) => portal.submissions(t, p),
      reviews: async (t, p) => (await portal.reviews?.(t, p)) ?? [],
      now: base.now,
    }),
  ];
}

// ── the ops-alert worker's pass ──────────────────────────────────────────────────────────────────────────────────

const featureOn = async (store: EventStore, tenantId: string, feature: string): Promise<boolean> => {
  let on = false;
  for (const c of await payloads<{ feature: string; enabled: boolean }>(store, tenantId, STREAM.platform, 'TenantEntitlementSet')) if (c.feature === feature) on = c.enabled;
  return on;
};

/** Concession alerts (when `dept.concession` is on) and B2B contracts ending within 30 / 7 days (when `b2b` is on). */
export function commercialDesksSweep(input: Base): (tenantId: string, at: string) => Promise<number> {
  return async (tenantId, at) => {
    let raised = 0;
    if (await featureOn(input.store, tenantId, 'dept.concession')) raised += await raiseConcessionAlerts(concessionDeskDeps(input), tenantId, at);
    if (await featureOn(input.store, tenantId, 'b2b')) {
      const ending = contractsEndingWithin(await b2bContractsAdapter(input).contracts(tenantId), at.slice(0, 10), CONTRACT_WARN_DAYS);
      for (const x of ending) {
        const step = x.daysLeft <= CONTRACT_URGENT_DAYS ? 'within_7_days' : 'within_30_days';
        const alertId = `b2b-contract-ending:${x.contract.customerId}:${x.contract.contractId}:${x.contract.validTo}:${step}`;
        const detail = `${x.contract.customerId}'s contract ${x.contract.contractId} ends on ${x.contract.validTo} (${x.daysLeft} day(s) left). After that it ${x.contract.onExpiry === 'block' ? 'blocks new quotations and orders' : 'falls back to the shop\'s ordinary prices'} until a renewal is approved.`;
        if (await finBridgeRaiseToOwners(input.store, input.now, tenantId, alertId, `B2B contract ${x.contract.contractId}`, detail, 'system:b2b-contracts', at, alertId)) raised += 1;
      }
    }
    return raised;
  };
}
