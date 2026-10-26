// API-03 Supplier scorecards, contracts & the numbers that contradict the relationship (M06-FR-03 ·
// D03-FR-03 · D-10). Buyers judge suppliers on the relationship; the numbers usually say something different,
// and the gap is expensive — a supplier who ships 82% of what you order is not 5% cheaper, they are the
// reason the shelf is empty on a Saturday.
//
//   • D-10 (R4, OB-227): the scorecard is BUILT from the supplier's own purchase orders, the goods receipts against
//     them and the invoices the three-way match checked — never from a typed figure. It shows fill rate, on time in
//     full (the share of order lines delivered complete by the agreed date), lead-time reliability, invoice accuracy
//     (invoiced against the agreed price) and rejection rate, through the tested `deriveSupplierScorecard`. A supplier
//     with no delivery in the period reads `not_rated`, never a score. A corrected receipt replaces its figure (each
//     receipt at its latest state; a later disposition of a quarantined line replaces the dock's first figure) and is
//     never counted twice. The old typed delivery-outcome door answers 410 by name.
//   • a supplier CONTRACT is recorded (agreed lead time, term, approver); `reviewContracts` surfaces the
//     expiring / expired / UNAPPROVED ones worst-first — an expired contract means every order since has
//     been placed on no agreed terms, and an unapproved one has no §28 sign-off on the terms. The contract's lead time
//     is the agreed date on-time-in-full is measured against.
//
// The rules are the tested engine in `@sre/purchasing` (`services-run-on-their-tested-engine`); this file
// is the HTTP skin. Recording a contract is gated `purchase.contract.manage`; reads are `purchase.commitment.read`.

import type { Route } from '../../kernel/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { apiError, notFound } from '../../kernel/src/index';
import {
  reviewContracts, deriveSupplierScorecard,
  type ReceiptFact, type SupplierContract, type ScorecardWeights,
  type ScorecardOrder, type ScorecardReceipt, type ScorecardMatchedInvoice,
} from '../../../packages/purchasing/src/index';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

/** D-10: what the scorecard is built from — the registers, never a typed figure. */
export interface SupplierFacts {
  readonly orders: readonly ScorecardOrder[];
  readonly receipts: readonly ScorecardReceipt[];
  readonly invoices: readonly ScorecardMatchedInvoice[];
  /** The shop's own today (its days are the shop's calendar, OB-198) — the default end of the period. */
  readonly today?: string;
}

export interface SupplierScorecardDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  /** Head office's maker-checker engine (ADR-0024): a contract's approver gave it in their own session. Optional on a
   *  bare stub (then every approval is unknown, and a contract records unapproved); the running system provides it. */
  readonly approvals?: ApprovalPort;
  /**
   * D-10 (R4): the supplier's own purchase orders, goods receipts (each at its latest state) and matched invoices — what
   * the scorecard is built from. Absent on a bare stub: every figure then reads `not_rated` (no delivery known).
   */
  readonly facts?: (tenantId: string, supplierId: string) => Promise<SupplierFacts>;
  /** The RETIRED typed delivery-outcome register (before D-10). Read by no route; kept so its history stays readable. */
  readonly receipts: (tenantId: string, supplierId: string) => Promise<readonly ReceiptFact[]> | readonly ReceiptFact[];
  /** This supplier's contracts (latest per contract id) — to pick the one to score against. */
  readonly contractsFor: (tenantId: string, supplierId: string) => Promise<readonly SupplierContract[]> | readonly SupplierContract[];
  /** Every contract — the expiry/approval review surface. */
  readonly allContracts: (tenantId: string) => Promise<readonly SupplierContract[]> | readonly SupplierContract[];
  /** The retired typed register's writer (before D-10). No route calls it. */
  readonly recordReceipt: (tenantId: string, fact: ReceiptFact, key: string) => Promise<void> | void;
  /** Record a contract. Latest per contract id. */
  readonly recordContract: (tenantId: string, contract: SupplierContract, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isQty = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The one contract to score a supplier against: the one active on `onDate`, else the latest by term end. */
function pickContract(contracts: readonly SupplierContract[], onDate: string): SupplierContract | undefined {
  const active = contracts.filter((c) => c.startsOn <= onDate && onDate <= c.endsOn);
  const pool = active.length > 0 ? active : contracts;
  return [...pool].sort((a, b) => (a.endsOn < b.endsOn ? 1 : -1))[0];
}

export function supplierScorecardRoutes(deps: SupplierScorecardDeps): readonly Route[] {
  return [
    {
      // D-10 (R4, OB-227): RETIRED. A delivery outcome is no longer typed in — the scorecard is built from the supplier's
      // own purchase orders, goods receipts and matched invoices ("with no typed figures"). The path answers 410 by name
      // so an old screen or script learns why, and nothing it sends is saved.
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/receipts/:poId',
      permission: 'purchase.performance.record', idempotent: true,
      handler: async () => {
        throw apiError(410, {
          code: 'typed_delivery_outcome_retired',
          whatHappened: 'A supplier scorecard is built from the purchase orders, the goods receipts and the matched invoices themselves (D-10). A typed delivery outcome is no longer accepted.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Receive the delivery on the goods-receipt page and match its invoice; the scorecard follows from them.',
        });
      },
    },
    {
      // Record a supplier contract. Body: { supplierId, startsOn, endsOn, agreedLeadTimeDays, approvalId? }.
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
            whatHappened: 'A supplier contract needs a contractId in the path and { supplierId, startsOn, endsOn (YYYY-MM-DD), agreedLeadTimeDays (whole, ≥0), optional approvalId } in the body.',
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
        // The terms' approver (ADR-0024 · 2b-vi-c-1 · audit PA-03): an approval someone who may approve suppliers GAVE in
        // their own session for exactly these terms (kind `purchase_contract`). A typed "approved by" is refused by name;
        // before, any name cleared the contract's `unapproved` alert. No approval: recorded, and the alert stays.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: approvedBy,
          kind: 'purchase_contract', subjectRef: contractId, details: actionDetails(ctx.body, { contractId }), valueMinor: null,
          maker: ctx.userId, usedBy: `purchase-contract:${contractId}`, now: deps.now(),
        });
        const contract: SupplierContract = {
          contractId,
          supplierId: b['supplierId'] as string,
          startsOn: b['startsOn'] as string,
          endsOn: b['endsOn'] as string,
          agreedLeadTimeDays: lead as number,
          ...(opened === undefined ? {} : { approvedBy: opened.decision.decidedBy }),
        };
        await opened?.spend();
        await deps.recordContract(ctx.tenantId, contract, ctx.idempotencyKey ?? contractId);
        return { status: 201, body: { contract } };
      },
    },
    {
      // D-10 (R4): a supplier's scorecard BUILT from its own purchase orders, goods receipts and matched invoices — fill
      // rate, on time in full, lead-time reliability, invoice accuracy and rejection rate. `?from=&to=` (YYYY-MM-DD) is the
      // period; the trailing 90 days by default. `not_rated` where there is no delivery, never a flattering default (P-08).
      api: 'API-03', method: 'GET', path: '/v1/purchase/suppliers/:supplierId/scorecard',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        if (supplierId === '') throw notFound('supplier (none named)');
        const facts: SupplierFacts = deps.facts === undefined ? { orders: [], receipts: [], invoices: [] } : await deps.facts(ctx.tenantId, supplierId);
        const today = facts.today ?? await shopToday(deps, ctx.tenantId);
        const to = ctx.query['to'] ?? today;
        const from = ctx.query['from'] ?? (isDate(to) ? new Date(Date.parse(`${to}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10) : '');
        if (!isDate(from) || !isDate(to) || from > to) {
          throw apiError(400, {
            code: 'not_readable_as_a_period',
            whatHappened: 'The scorecard period needs ?from= and ?to= as YYYY-MM-DD dates, with from on or before to.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the dates. Nothing was changed; this only reads.',
          });
        }
        const contract = pickContract(await deps.contractsFor(ctx.tenantId, supplierId), today);
        const scorecard = deriveSupplierScorecard({
          supplierId, from, to, orders: facts.orders, receipts: facts.receipts, invoices: facts.invoices,
          ...(contract === undefined ? {} : { agreedLeadTimeDays: contract.agreedLeadTimeDays }),
        });
        return { status: 200, body: { scorecard, contractId: contract?.contractId ?? null, typedFigures: false } };
      },
    },
    {
      // Contract review — expiring / expired / unapproved worst-first (control by exception, P-03).
      // `?onDate=YYYY-MM-DD` overrides today; `?warnDays=` the 45-day warning window.
      api: 'API-03', method: 'GET', path: '/v1/purchase/contracts/alerts',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const onDate = isDate(ctx.query['onDate']) ? (ctx.query['onDate'] as string) : await shopToday(deps, ctx.tenantId);
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
