// API-09 the B2B contract register and the B2B selling desk's reads (M22-FR-01 · M22-FR-02 · §28 · P-02 · P-03 · P-07 ·
// P-08 · hard rules #2, #5, #10). OB-288 package 3 "Commercial desks".
//
// M22-FR-01: "hold per-B2B-customer price lists, credit limits, payment terms and contracts … an order exceeding the
// credit limit is blocked pending approval; an expired contract falls back or blocks per policy … contract/credit changes
// approved; separation from order-taking." Before this, the contract was a flag a caller sent. Here:
//
//   • POST /v1/b2b/contracts/:customerId/:contractId — a person who manages contracts (`b2b.contract.manage`: the owner,
//     the accountant — not the store manager who takes orders) PROPOSES a contract: dates, price list, terms, credit
//     limit, policy on expiry. Without an approval it is recorded as PROPOSED and prices nothing. With an `approvalId`
//     (kind `b2b_contract`, asked with exactly this body and given by ANOTHER contract manager in their own session) it
//     is APPROVED and in force on its own dates; its credit limit and payment terms reach the customer's account.
//     An approved contract is never rewritten — new terms are a new contract (hard rule #2).
//   • GET /v1/b2b/contracts/:customerId and GET /v1/b2b/contracts — each contract with where it stands TODAY (worked out
//     from its dates), what is in force, and the contracts ending within 30 days (a 7-day one flagged), P-03.
//   • The pricing and the credit gate the document chain uses (`contractPricing`, `contractCreditGate`): a quotation is
//     priced from the contract in force, else from the shop's price list (the price-list engine, P-02); an expired
//     "block" contract refuses; an over-limit (or blocked expired) order goes through only with an approval of kind
//     `b2b_credit_override`, which the OWNER gives (OB-290: above a person's limit goes to the owner).
//   • GET /v1/b2b/desk and GET /v1/b2b/desk/:customerId — the desk's one read per customer: the account (limit,
//     outstanding, available, terms), the contracts, every document in the chain with what each order has delivered and
//     billed. Reads only.
//
// OB-280 (owner, 21 Oct 2026): business (B2B) bills stay on the OLD system for real trading until a new decision — the
// till refuses them. This desk is the office B2B module (M22) the roadmap requires; it does not change the till and it is
// behind the optional `b2b` feature, which stays off for a shop until the owner turns it on.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  readContractTerms, sameTerms, standingOf, contractPosition, contractsEndingWithin, priceFromRecord, checkCredit, checkChain,
  type StoredB2BContract, type LineToPrice, type PricingResult,
} from '../../../packages/b2b/src/index';
import { actionDetails, approvalNamedIn, openApproval, NO_APPROVALS, type ApprovalPort } from '../../identity/src/approval-requests';
import type { StoredB2BDocument, B2BCreditGate } from './b2b-documents';
import type { B2BAccount } from './b2b-credit';
import { shopClock, shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

export type { StoredB2BContract } from '../../../packages/b2b/src/index';

/** The approval kinds this register uses (APPROVAL_KINDS, services/identity/src/approval-requests.ts). */
export const CONTRACT_APPROVAL_KIND = 'b2b_contract';
export const CREDIT_OVERRIDE_KIND = 'b2b_credit_override';

/** Warn this many days ahead (the desk and the owner's alerts), and flag the last week. */
export const CONTRACT_WARN_DAYS = 30;
export const CONTRACT_URGENT_DAYS = 7;

export interface B2BContractsDeps {
  /** Every contract's latest record (one per contract id), all customers. */
  readonly contracts: (tenantId: string) => Promise<readonly StoredB2BContract[]>;
  readonly recordContract: (tenantId: string, contract: StoredB2BContract) => Promise<void>;
  /** Head office's maker-checker engine (ADR-0024). Optional on a bare stub (then every approval is unknown). */
  readonly approvals?: ApprovalPort;
  /** The product's printed MRP, when on record — a contract price above it is refused (a legal ceiling, no approval lifts it). */
  readonly mrpOf?: (tenantId: string, productId: string) => Promise<number | undefined>;
  /** An approved contract's credit limit / payment terms reach the customer's account (`B2BCreditLimitSet`, append-only). */
  readonly applyAccountTerms?: (tenantId: string, customerId: string, terms: { readonly creditLimitMinor?: number; readonly paymentTermsDays?: number }, at: string) => Promise<void>;
  /** The customer's credit account as it stands (payment terms alone cannot open one: a limit is needed). */
  readonly account?: (tenantId: string, customerId: string) => Promise<B2BAccount | undefined>;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
}

export interface B2BDeskDeps {
  readonly contracts: (tenantId: string) => Promise<readonly StoredB2BContract[]>;
  readonly account: (tenantId: string, customerId: string) => Promise<B2BAccount | undefined>;
  readonly outstandingMinor: (tenantId: string, customerId: string) => Promise<number>;
  readonly documents: (tenantId: string, customerId: string) => Promise<readonly StoredB2BDocument[]>;
  /** Customers the desk has met: a contract, a quotation, a quote request. */
  readonly knownCustomers: (tenantId: string) => Promise<readonly string[]>;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
}

/** R1c (M01-FR-02): "today" for a contract in force is the shop's date, never the UTC one. */
const today = (deps: { readonly now: () => string; readonly calendar?: ShopCalendarOf }, tenantId: string): Promise<string> => shopToday(deps, tenantId);

/** A contract as the desk shows it: the record and where it stands today. */
export function presentContract(c: StoredB2BContract, day: string): StoredB2BContract & { readonly standing: ReturnType<typeof standingOf> } {
  return { ...c, standing: standingOf(c, day) };
}

export function b2bContractRoutes(deps: B2BContractsDeps): readonly Route[] {
  return [
    {
      // Propose a contract, or — with a second person's approval of exactly these terms — put it in force.
      api: 'API-09', method: 'POST', path: '/v1/b2b/contracts/:customerId/:contractId',
      permission: 'b2b.contract.manage', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = (ctx.params['customerId'] ?? '').trim();
        const contractId = (ctx.params['contractId'] ?? '').trim();
        const read = readContractTerms(actionDetails(ctx.body), { customerId, contractId });
        if (!read.ok) {
          throw apiError(400, { code: 'not_readable_as_a_contract', whatHappened: read.why, wasItSaved: 'not_saved', nextSafeAction: 'Send the contract as described. Nothing was recorded.' });
        }
        const terms = read.value;
        // MRP is a legal ceiling in India — no contract and no approval may price above it.
        if (deps.mrpOf !== undefined) {
          for (const p of terms.prices) {
            const mrp = await deps.mrpOf(ctx.tenantId, p.productId);
            if (mrp !== undefined && p.priceMinor > mrp) {
              throw apiError(422, {
                code: 'contract_price_above_mrp',
                whatHappened: `${p.productId} is priced at ${p.priceMinor} paise on this contract, above its printed MRP of ${mrp} paise — a legal ceiling no approval can lift.`,
                wasItSaved: 'not_saved', nextSafeAction: 'Price it at or below the MRP. Nothing was recorded.',
              });
            }
          }
        }
        const all = await deps.contracts(ctx.tenantId);
        const before = all.find((c) => c.contractId === contractId && c.customerId === customerId);
        if (all.some((c) => c.contractId === contractId && c.customerId !== customerId)) {
          throw apiError(409, { code: 'contract_id_in_use', whatHappened: `Contract ${contractId} belongs to another customer.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new contract id. Nothing was recorded.' });
        }
        if (before?.state === 'approved') {
          if (sameTerms(before, terms)) return { status: 200, body: { contract: presentContract(before, await today(deps, ctx.tenantId)), alreadyRecorded: true } };
          throw apiError(409, {
            code: 'contract_already_approved',
            whatHappened: `Contract ${contractId} was approved by ${before.approvedBy ?? 'a second person'} on ${(before.approvedAt ?? '').slice(0, 10)} and is never rewritten. New terms are a new contract.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Propose the new terms under a new contract id (a renewal). Nothing was recorded.',
          });
        }
        const at = deps.now();
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        // The second person (ADR-0024 · §28 "contract/credit changes approved"): an approval ANOTHER contract manager gave in
        // their own session for exactly these terms. A typed `approvedBy` is refused by name.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: body['approvalId'], typedField: 'approvedBy', typedValue: body['approvedBy'],
          kind: CONTRACT_APPROVAL_KIND, subjectRef: `${customerId}/${contractId}`, details: actionDetails(ctx.body, { customerId, contractId }),
          valueMinor: null, maker: ctx.userId, usedBy: `b2b-contract:${customerId}/${contractId}`, now: at,
        });
        if (opened === undefined) {
          if (before !== undefined && sameTerms(before, terms)) return { status: 200, body: { contract: presentContract(before, await today(deps, ctx.tenantId)), alreadyRecorded: true } };
          const proposed: StoredB2BContract = { ...terms, state: 'proposed', proposedBy: ctx.userId, proposedAt: at };
          await deps.recordContract(ctx.tenantId, proposed);
          return { status: 201, body: { contract: presentContract(proposed, await today(deps, ctx.tenantId)), alreadyRecorded: false, needs: 'approval' } };
        }
        // P-08: payment terms with no credit account and no limit would set nothing — refused by name, before the approval is spent.
        if (terms.paymentTermsDays !== undefined && terms.creditLimitMinor === undefined && deps.account !== undefined
          && (await deps.account(ctx.tenantId, customerId)) === undefined) {
          throw apiError(409, {
            code: 'contract_terms_need_a_credit_limit',
            whatHappened: `${customerId} has no credit account yet, so payment terms alone cannot be applied — the contract needs its credit limit too.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Propose the contract with a creditLimitMinor (and ask for approval of those terms). Nothing was recorded; the approval was not used.',
          });
        }
        await opened.spend();
        const approved: StoredB2BContract = {
          ...terms, state: 'approved', proposedBy: before?.proposedBy ?? ctx.userId, proposedAt: before?.proposedAt ?? at,
          approvedBy: opened.decision.decidedBy, approvedAt: at, approvalId: (body['approvalId'] as string).trim(),
        };
        await deps.recordContract(ctx.tenantId, approved);
        if (deps.applyAccountTerms !== undefined && (terms.creditLimitMinor !== undefined || terms.paymentTermsDays !== undefined)) {
          await deps.applyAccountTerms(ctx.tenantId, customerId, {
            ...(terms.creditLimitMinor === undefined ? {} : { creditLimitMinor: terms.creditLimitMinor }),
            ...(terms.paymentTermsDays === undefined ? {} : { paymentTermsDays: terms.paymentTermsDays }),
          }, at);
        }
        return { status: 201, body: { contract: presentContract(approved, await today(deps, ctx.tenantId)), alreadyRecorded: false } };
      },
    },
    {
      // One customer's contracts, each with where it stands today, and what is in force.
      api: 'API-09', method: 'GET', path: '/v1/b2b/contracts/:customerId',
      permission: 'b2b.contract.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = (ctx.params['customerId'] ?? '').trim();
        const day = await today(deps, ctx.tenantId);
        const mine = (await deps.contracts(ctx.tenantId)).filter((c) => c.customerId === customerId);
        return { status: 200, body: { customerId, today: day, position: positionWords(contractPosition(mine, customerId, day)), contracts: mine.map((c) => presentContract(c, day)), asAt: deps.now() } };
      },
    },
    {
      // Every customer's contracts, and those ending within 30 days (the last 7 flagged) — control by exception (P-03).
      api: 'API-09', method: 'GET', path: '/v1/b2b/contracts',
      permission: 'b2b.contract.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const day = await today(deps, ctx.tenantId);
        const all = await deps.contracts(ctx.tenantId);
        return {
          status: 200,
          body: {
            today: day, contracts: all.map((c) => presentContract(c, day)),
            awaitingApproval: all.filter((c) => c.state === 'proposed').map((c) => c.contractId),
            endingSoon: contractsEndingWithin(all, day, CONTRACT_WARN_DAYS).map((x) => ({ contractId: x.contract.contractId, customerId: x.contract.customerId, validTo: x.contract.validTo, daysLeft: x.daysLeft, urgent: x.daysLeft <= CONTRACT_URGENT_DAYS })),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}

function positionWords(p: ReturnType<typeof contractPosition>) {
  return {
    inForce: p.inForce?.contractId ?? null, lapsed: p.lapsed?.contractId ?? null, upcoming: p.upcoming?.contractId ?? null,
    daysToExpiry: p.daysToExpiry ?? null, blocked: p.blocked, onExpiry: (p.inForce ?? p.lapsed)?.onExpiry ?? null,
  };
}

/**
 * The quotation pricing the document chain uses (M22-FR-01 · P-02): the contract in force, else the shop's price list
 * (`listPriceOf` — the price-list engine's answer for this customer at this store), else the typed price, said.
 */
export function contractPricing(input: {
  readonly contracts: (tenantId: string) => Promise<readonly StoredB2BContract[]>;
  readonly listPriceOf: (tenantId: string, q: { readonly productId: string; readonly customerId: string; readonly storeId?: string; readonly at: string }) => Promise<number | undefined>;
  readonly calendar?: ShopCalendarOf;
}): (tenantId: string, q: { readonly customerId: string; readonly locationId?: string; readonly at: string; readonly lines: readonly LineToPrice[] }) => Promise<PricingResult> {
  return async (tenantId, q) => {
    const position = contractPosition(await input.contracts(tenantId), q.customerId, await shopClock(input.calendar).dateOf(tenantId, q.at));
    const list = new Map<string, number | undefined>();
    for (const l of q.lines) {
      if (!list.has(l.productId)) list.set(l.productId, await input.listPriceOf(tenantId, { productId: l.productId, customerId: q.customerId, at: q.at, ...(q.locationId === undefined ? {} : { storeId: q.locationId }) }));
    }
    return priceFromRecord({ position, lines: q.lines, listPriceOf: (p) => list.get(p) });
  };
}

/**
 * The contract-aware credit gate (M22-FR-01 · §28): the customer's limit and projected outstanding, the contract's expiry
 * worked out from its own dates and its policy, and an override only with an approval of kind `b2b_credit_override` given
 * by someone holding `b2b.credit.override` (the owner, OB-290) — never the person taking the order.
 */
export function contractCreditGate(input: {
  readonly contracts: (tenantId: string) => Promise<readonly StoredB2BContract[]>;
  readonly account: (tenantId: string, customerId: string) => Promise<B2BAccount | undefined>;
  readonly outstandingMinor: (tenantId: string, customerId: string) => Promise<number>;
  readonly approvals?: ApprovalPort;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
}): B2BCreditGate {
  return async (tenantId, q) => {
    const account = await input.account(tenantId, q.customerId);
    if (account === undefined) {
      return { allowed: false, verdict: 'no_account', detail: `${q.customerId} has no credit account, so credit control has not cleared this order (M22-FR-01).` };
    }
    const outstanding = await input.outstandingMinor(tenantId, q.customerId);
    const at = input.now();
    const position = contractPosition(await input.contracts(tenantId), q.customerId, await shopClock(input.calendar).dateOf(tenantId, at));
    const expired = position.inForce === undefined && position.lapsed !== undefined;
    const opened = typeof q.approvalId === 'string' && q.approvalId.trim() !== ''
      ? await openApproval(input.approvals ?? NO_APPROVALS, {
        tenantId, approvalId: q.approvalId.trim(), kind: CREDIT_OVERRIDE_KIND, subjectRef: `${q.customerId}/${q.orderId}`,
        details: q.details, valueMinor: q.valueMinor, maker: q.maker, usedBy: `b2b-credit-override:${q.customerId}/${q.orderId}`, now: at,
      })
      : undefined;
    const money = (minor: number) => ({ minor, currency: account.currency });
    const decision = checkCredit({
      id: q.orderId, customerId: q.customerId, takenBy: q.maker,
      creditLimit: money(account.creditLimitMinor), outstanding: money(outstanding), orderValue: money(q.valueMinor),
      ...(expired ? { contractExpired: true, contractPolicy: position.lapsed!.onExpiry } : {}),
      ...(opened === undefined ? {} : {
        approval: {
          id: q.approvalId as string, subjectType: 'b2b_credit', subjectRef: q.orderId, requestedBy: q.maker, branchId: null,
          value: money(q.valueMinor), status: 'approved', decidedBy: opened.decision.decidedBy, reason: opened.decision.reason, decidedAt: opened.decision.decidedAt,
        },
      }),
    });
    const over = outstanding + q.valueMinor - account.creditLimitMinor;
    const detail = decision.verdict === 'contract_expired'
      ? `Contract ${position.lapsed!.contractId} ended on ${position.lapsed!.validTo} and says "block": this order needs the owner's approval, or a renewed contract.`
      : decision.verdict === 'over_limit'
        ? `This order of ${q.valueMinor} paise takes ${q.customerId} to ${outstanding + q.valueMinor} paise owed, ${over} paise over its credit limit of ${account.creditLimitMinor} paise.`
        : 'Credit control cleared this order.';
    return {
      allowed: decision.allowed, verdict: decision.verdict, detail,
      ...(opened !== undefined && decision.requiresApproval && decision.allowed ? { spend: opened.spend } : {}),
    };
  };
}

export function b2bDeskRoutes(deps: B2BDeskDeps): readonly Route[] {
  return [
    {
      // The customers the desk has met, each with where its contract and credit stand.
      api: 'API-09', method: 'GET', path: '/v1/b2b/desk',
      permission: 'b2b.document.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const day = await today(deps, ctx.tenantId);
        const contracts = await deps.contracts(ctx.tenantId);
        const ids = [...new Set([...(await deps.knownCustomers(ctx.tenantId)), ...contracts.map((c) => c.customerId)])].sort();
        const customers = [];
        for (const customerId of ids) {
          const p = contractPosition(contracts, customerId, day);
          customers.push({ customerId, contract: positionWords(p) });
        }
        return { status: 200, body: { today: day, customers, asAt: deps.now() } };
      },
    },
    {
      // One customer's desk: the account (limit, outstanding, available, terms), the contracts, and every document in its
      // chain — with what each order has delivered and billed (checkChain). Reads only.
      api: 'API-09', method: 'GET', path: '/v1/b2b/desk/:customerId',
      permission: 'b2b.document.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = (ctx.params['customerId'] ?? '').trim();
        if (customerId === '') throw notFound('a B2B customer (none named)');
        const day = await today(deps, ctx.tenantId);
        const [account, outstanding, documents, contracts] = await Promise.all([
          deps.account(ctx.tenantId, customerId), deps.outstandingMinor(ctx.tenantId, customerId), deps.documents(ctx.tenantId, customerId), deps.contracts(ctx.tenantId),
        ]);
        const mine = contracts.filter((c) => c.customerId === customerId);
        const ordered = [...documents].sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : a.issuedAt > b.issuedAt ? -1 : 0));
        const converted = new Set(documents.filter((d) => d.kind === 'sales_order' && d.derivedFrom !== undefined).map((d) => d.derivedFrom as string));
        const orders = documents.filter((d) => d.kind === 'sales_order').map((order) => {
          const challans = documents.filter((d) => d.kind === 'challan' && d.orderId === order.documentId);
          const invoices = documents.filter((d) => d.kind === 'tax_invoice' && d.orderId === order.documentId);
          return { orderId: order.documentId, number: order.number, ...checkChain({ order, challans, invoices }) };
        });
        return {
          status: 200,
          body: {
            customerId, today: day,
            // P-08: no account is said as such — never a limit of zero.
            account: account === undefined ? null : {
              creditLimitMinor: account.creditLimitMinor, currency: account.currency, outstandingMinor: outstanding,
              availableCreditMinor: account.creditLimitMinor - outstanding, paymentTermsDays: account.paymentTermsDays ?? null,
            },
            contract: positionWords(contractPosition(mine, customerId, day)),
            contracts: mine.map((c) => presentContract(c, day)),
            documents: ordered.map((d) => ({
              documentId: d.documentId, number: d.number, kind: d.kind, issuedAt: d.issuedAt, derivedFrom: d.derivedFrom ?? null, orderId: d.orderId ?? null,
              grossMinor: d.grossMinor, lines: d.lines, validUntil: d.validUntil ?? null, locationId: d.locationId ?? null, pricedFrom: d.pricedFrom ?? null,
              converted: d.kind === 'quotation' ? converted.has(d.documentId) : null,
            })),
            orders,
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
