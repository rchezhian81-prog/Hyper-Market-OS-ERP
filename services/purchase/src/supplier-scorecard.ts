// API-03 Supplier scorecards, contracts & the numbers that contradict the relationship (M06-FR-03 ·
// D03-FR-03). Buyers judge suppliers on the relationship; the numbers usually say something different,
// and the gap is expensive — a supplier who ships 82% of what you order is not 5% cheaper, they are the
// reason the shelf is empty on a Saturday. This is the cloud surface that turns recorded delivery facts
// into an objective, weighted scorecard, and surfaces contracts about to expire before an order is
// placed on no terms at all.
//
//   • a delivery OUTCOME is recorded per PO — ordered/received/rejected quantity, the ordered and
//     received dates, agreed vs invoiced value — as a first-class fact (never an opinion). The scorecard
//     runs the tested `scoreSupplier`: fill rate, on-time (against the contracted lead time), lead-time
//     RELIABILITY (the spread, not the mean — a reliable seven days beats an average four that is
//     sometimes eleven), price adherence and quality, weighted into one overall, worst signal named
//     first in plain English. A score with no evidence reports `not_rated`, never a flattering default;
//   • a supplier CONTRACT is recorded (agreed lead time, term, approver); `reviewContracts` surfaces the
//     expiring / expired / UNAPPROVED ones worst-first — an expired contract means every order since has
//     been placed on no agreed terms, and an unapproved one has no §28 sign-off on the terms.
//
// The rules are the tested engine in `@sre/purchasing` (`services-run-on-their-tested-engine`); this file
// is the persistence + HTTP skin. Recording is gated `purchase.performance.record` /
// `purchase.contract.manage`; reads are `purchase.commitment.read`. Auto-deriving the receipt facts from
// the PO + GRN + three-way-match join (unit-reconciled) and per-tenant scorecard weights are follow-ons.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  scoreSupplier, reviewContracts,
  type ReceiptFact, type SupplierContract, type ScorecardWeights,
} from '../../../packages/purchasing/src/index';
import { isCurrencyCode, type Money } from '../../../packages/contracts/src/money';

export interface SupplierScorecardDeps {
  /** Every recorded delivery outcome for this supplier (latest per PO). */
  readonly receipts: (tenantId: string, supplierId: string) => Promise<readonly ReceiptFact[]> | readonly ReceiptFact[];
  /** This supplier's contracts (latest per contract id) — to pick the one to score against. */
  readonly contractsFor: (tenantId: string, supplierId: string) => Promise<readonly SupplierContract[]> | readonly SupplierContract[];
  /** Every contract — the expiry/approval review surface. */
  readonly allContracts: (tenantId: string) => Promise<readonly SupplierContract[]> | readonly SupplierContract[];
  /** Record a delivery outcome. Idempotent on the (supplier, PO) pair. */
  readonly recordReceipt: (tenantId: string, fact: ReceiptFact, key: string) => Promise<void> | void;
  /** Record a contract. Latest per contract id. */
  readonly recordContract: (tenantId: string, contract: SupplierContract, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isQty = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isMoney = (v: unknown): v is Money =>
  isObj(v) && typeof v['minor'] === 'number' && Number.isSafeInteger(v['minor']) && typeof v['currency'] === 'string' && isCurrencyCode(v['currency']);

/** The one contract to score a supplier against: the one active on `onDate`, else the latest by term end. */
function pickContract(contracts: readonly SupplierContract[], onDate: string): SupplierContract | undefined {
  const active = contracts.filter((c) => c.startsOn <= onDate && onDate <= c.endsOn);
  const pool = active.length > 0 ? active : contracts;
  return [...pool].sort((a, b) => (a.endsOn < b.endsOn ? 1 : -1))[0];
}

export function supplierScorecardRoutes(deps: SupplierScorecardDeps): readonly Route[] {
  return [
    {
      // Record a delivery outcome for scoring. Body: { orderedOn, receivedOn, orderedQtyMinor,
      // receivedQtyMinor, rejectedQtyMinor?, agreedValue{minor,currency}, invoicedValue{minor,currency} }.
      // Idempotent on the (supplier, PO) pair — a re-record supersedes rather than double-counting.
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/receipts/:poId',
      permission: 'purchase.performance.record', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const poId = (ctx.params['poId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const rejected = b['rejectedQtyMinor'];
        if (supplierId === '' || poId === '' || !isDate(b['orderedOn']) || !isDate(b['receivedOn'])
          || !isQty(b['orderedQtyMinor']) || !isQty(b['receivedQtyMinor'])
          || (rejected !== undefined && !isQty(rejected))
          || !isMoney(b['agreedValue']) || !isMoney(b['invoicedValue'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_delivery_outcome',
            whatHappened: 'A delivery outcome needs supplierId + poId in the path and { orderedOn, receivedOn (YYYY-MM-DD), orderedQtyMinor, receivedQtyMinor (whole, ≥0), optional rejectedQtyMinor, agreedValue { minor, currency }, invoicedValue { minor, currency } } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the ordered/received dates and quantities and the agreed vs invoiced value from the order and its match.',
          });
        }
        if (b['receivedOn'] < b['orderedOn']) {
          throw apiError(422, {
            code: 'received_before_ordered',
            whatHappened: `The delivery date (${b['receivedOn']}) is before the order date (${b['orderedOn']}) — a lead time cannot be negative.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the dates and record again. Nothing was saved.',
          });
        }
        const agreed = b['agreedValue'] as Money;
        const invoiced = b['invoicedValue'] as Money;
        if (agreed.currency !== invoiced.currency) {
          throw apiError(422, {
            code: 'value_currency_mismatch',
            whatHappened: `The agreed value (${agreed.currency}) and the invoiced value (${invoiced.currency}) must be in the same currency to compare.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send both values in one currency and record again.',
          });
        }
        const fact: ReceiptFact = {
          poId, supplierId,
          orderedOn: b['orderedOn'] as string,
          receivedOn: b['receivedOn'] as string,
          orderedQtyMinor: b['orderedQtyMinor'] as number,
          receivedQtyMinor: b['receivedQtyMinor'] as number,
          ...(rejected !== undefined ? { rejectedQtyMinor: rejected as number } : {}),
          agreedValue: { minor: agreed.minor, currency: agreed.currency },
          invoicedValue: { minor: invoiced.minor, currency: invoiced.currency },
        };
        await deps.recordReceipt(ctx.tenantId, fact, ctx.idempotencyKey ?? `${supplierId}:${poId}`);
        return { status: 201, body: { receipt: fact } };
      },
    },
    {
      // Record a supplier contract. Body: { supplierId, startsOn, endsOn, agreedLeadTimeDays, approvedBy? }.
      // Latest per contract id wins (a renegotiated term is a new version, never an overwrite).
      api: 'API-03', method: 'POST', path: '/v1/purchase/contracts/:contractId',
      permission: 'purchase.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const contractId = (ctx.params['contractId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lead = b['agreedLeadTimeDays'];
        const approvedBy = b['approvedBy'];
        if (contractId === '' || !isStr(b['supplierId']) || !isDate(b['startsOn']) || !isDate(b['endsOn'])
          || !isQty(lead) || (approvedBy !== undefined && typeof approvedBy !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_contract',
            whatHappened: 'A supplier contract needs a contractId in the path and { supplierId, startsOn, endsOn (YYYY-MM-DD), agreedLeadTimeDays (whole, ≥0), optional approvedBy } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the supplier, the term dates, and the agreed lead time.',
          });
        }
        if ((b['endsOn'] as string) < (b['startsOn'] as string)) {
          throw apiError(422, {
            code: 'contract_ends_before_it_starts',
            whatHappened: `The contract's end date (${b['endsOn']}) is before its start date (${b['startsOn']}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the term and record again. Nothing was saved.',
          });
        }
        const contract: SupplierContract = {
          contractId,
          supplierId: b['supplierId'] as string,
          startsOn: b['startsOn'] as string,
          endsOn: b['endsOn'] as string,
          agreedLeadTimeDays: lead as number,
          ...(isStr(approvedBy) ? { approvedBy: approvedBy as string } : {}),
        };
        await deps.recordContract(ctx.tenantId, contract, ctx.idempotencyKey ?? contractId);
        return { status: 201, body: { contract } };
      },
    },
    {
      // A supplier's scorecard, from the recorded delivery facts + its active contract. `not_rated`
      // where there is no evidence, never a flattering default (P-08).
      api: 'API-03', method: 'GET', path: '/v1/purchase/suppliers/:supplierId/scorecard',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        if (supplierId === '') throw notFound('supplier (none named)');
        const [receipts, contracts] = await Promise.all([
          Promise.resolve(deps.receipts(ctx.tenantId, supplierId)),
          Promise.resolve(deps.contractsFor(ctx.tenantId, supplierId)),
        ]);
        const contract = pickContract(contracts, deps.now().slice(0, 10));
        const scorecard = scoreSupplier({ supplierId, receipts, ...(contract !== undefined ? { contract } : {}) });
        return { status: 200, body: { scorecard } };
      },
    },
    {
      // Contract review — expiring / expired / unapproved worst-first (control by exception, P-03).
      // `?onDate=YYYY-MM-DD` overrides today; `?warnDays=` the 45-day warning window.
      api: 'API-03', method: 'GET', path: '/v1/purchase/contracts/alerts',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const onDate = isDate(ctx.query['onDate']) ? (ctx.query['onDate'] as string) : deps.now().slice(0, 10);
        const warnRaw = Number(ctx.query['warnDays']);
        const warnDays = Number.isSafeInteger(warnRaw) && warnRaw > 0 ? warnRaw : undefined;
        const alerts = reviewContracts(await deps.allContracts(ctx.tenantId), onDate, warnDays);
        const actionNeeded = alerts.filter((a) => a.finding !== 'active');
        return { status: 200, body: { alerts, count: alerts.length, actionNeededCount: actionNeeded.length, onDate } };
      },
    },
  ];
}

/** Re-export so the scorecard's per-tenant weights can be overridden by config later (follow-on). */
export type { ScorecardWeights };
