// API-02 Pricing — governed price changes (M05-FR-02, §28). The catalogue service publishes what was
// approved and deliberately is NOT a price door; this is "M05's own path": a price change runs the
// tested guardrail engine (packages/price-guard `checkPrice`) — a price above the legal MRP ceiling
// is rejected outright, and a below-cost or below-margin-floor price is blocked unless a SEPARATE
// person approves it with a reason (separation of duties). The separation is real, not a name in a
// form: the named approver must actually hold `price.change.approve`, and cannot be the person
// setting the price. An allowed change is recorded as an append-only event; the pack-publish path
// (services/catalogue) then re-checks §28 before it reaches the shelf edge, so the control survives
// every step. Since 2b-vi-b (ADR-0024) the approver is an approval they GAVE in their own session, for exactly
// this price (kind `price_change`) — a name typed into `approval.decidedBy` is refused by name.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { checkPrice } from '../../../packages/price-guard/src/price-guard';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';

export interface PriceChangeRecord {
  readonly id: string;
  readonly productId: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly setBy: string;
  readonly verdict: string;
  readonly approvedBy: string | null;
  readonly reason: string | null;
  readonly at: string;
}

export interface PricingDeps {
  /**
   * Persist an allowed price change as an append-only event — and (SF-01) make it the OPERATIVE price: a store-scope
   * price-list entry, effective from today, for each of `storeIds`, in the SAME append. The catalogue pack each store's
   * lanes sell from resolves its price from that list, so the change reaches the till when the next pack is published.
   */
  readonly recordPriceChange: (tenantId: string, change: PriceChangeRecord, storeIds: readonly string[]) => Promise<void> | void;
  /**
   * SF-01 — the stores a head-office price change applies to when it names none: every store head office knows (its
   * branches, and every store a catalogue pack has been published for). Optional on a bare stub (then no store).
   */
  readonly storesToPrice?: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  /** Head office's maker-checker engine (ADR-0024): a loss-making price's approver gave it in their own session.
   *  Optional on a bare stub (then every approval is unknown); the running system provides it. */
  readonly approvals?: ApprovalPort;
  /**
   * M05: the margin floor the OWNER set for a store (its store rules, basis points) — what a head-office price is judged by.
   * Undefined when nobody has set it. Present in the running system; a bare stub without it judges by the body's figure.
   */
  readonly marginFloorFor?: (tenantId: string, storeId: string) => Promise<number | undefined> | number | undefined;
  /**
   * Seal this price change into the tamper-evident domain audit trail (M34-FR-01), attributed to the
   * acting user. Optional — the running system provides it; a bare deps stub may omit it. The actor is
   * ALWAYS the caller (`ctx.userId`), never client-supplied; a price is a public shelf figure, so it is
   * recorded in full — the "who moved this price, to what, approved by whom (§28)" record.
   */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

interface Body {
  readonly productId?: string;
  readonly priceMinor?: number;
  readonly currency?: string;
  readonly mrpMinor?: number;
  readonly costMinor?: number;
  readonly marginFloorBps?: number;
  readonly approval?: { readonly decidedBy?: string; readonly reason?: string };
  readonly approvalId?: string;
  /** SF-01 — the one store this price is for; absent → every store head office knows. */
  readonly storeId?: string;
}

const refuse = (code: string, whatHappened: string): never => {
  throw apiError(422, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
};

export function pricingRoutes(deps: PricingDeps): readonly Route[] {
  return [
    {
      // Propose (and, with a valid separate approval, apply) a price change. Idempotent: a retry
      // under the same key replays the stored result rather than recording a second change.
      api: 'API-02', method: 'POST', path: '/v1/prices/changes',
      permission: 'price.change.propose', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Body;
        if (typeof b.productId !== 'string' || b.productId.trim() === '') refuse('product_not_named', 'A price change must name the product.');
        if (!Number.isSafeInteger(b.priceMinor) || !Number.isSafeInteger(b.mrpMinor) || !Number.isSafeInteger(b.costMinor)) {
          refuse('amounts_not_whole_minor_units', 'price, mrp and cost must be whole minor units (paise).');
        }
        if (typeof b.currency !== 'string' || !isCurrencyCode(b.currency)) refuse('currency_not_recognised', 'Give a known ISO 4217 currency, e.g. INR.');
        // M05: in the running system the floor is the STORE's (its rules), never the request's; a sent figure is only read
        // when there are no store rules to read (a bare composition), and must then be readable.
        const sentFloor = b.marginFloorBps;
        if (deps.marginFloorFor === undefined && (!Number.isInteger(sentFloor) || sentFloor! < 0 || sentFloor! > 9999)) {
          refuse('margin_floor_out_of_range', 'marginFloorBps must be an integer 0–9999.');
        }
        const currency = b.currency as CurrencyCode;
        const id = `price-${b.productId!}`;
        const setBy = ctx.userId;

        // The second person (ADR-0024 · §28): an approval the approver GAVE in their own session for exactly this price —
        // the engine has already checked it is not the setter's own, was approved with a reason, is unused and unexpired,
        // and that the approver still holds `price.change.approve`. A typed `approval.decidedBy` is refused by name.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b.approvalId, typedField: 'approval.decidedBy', typedValue: b.approval?.decidedBy,
          kind: 'price_change', subjectRef: b.productId!, details: actionDetails(ctx.body), valueMinor: b.priceMinor!,
          maker: setBy, usedBy: `price-change:${b.productId!}`, now: deps.now(),
        });
        const approval: DecidedRequest | undefined = opened === undefined ? undefined : Object.freeze({
          id, subjectType: 'price', subjectRef: id, requestedBy: setBy, branchId: ctx.branchId,
          value: null, status: 'approved', decidedBy: opened.decision.decidedBy, reason: opened.decision.reason, decidedAt: opened.decision.decidedAt,
        });

        // SF-01: where the price becomes operative — the store named, else every store head office knows. A change that
        // could reach no till is refused rather than "saved" and never charged (the audit's finding).
        const storeIds = typeof b.storeId === 'string' && b.storeId.trim() !== ''
          ? [b.storeId.trim()]
          : deps.storesToPrice === undefined ? [] : [...new Set(await deps.storesToPrice(ctx.tenantId))].sort();
        if (deps.storesToPrice !== undefined && storeIds.length === 0) {
          refuse('no_store_to_price', 'Head office knows no store for this price to apply to — no branch is set up and no catalogue has been published for a store, so no till would ever charge it.');
        }
        let marginFloorBps = sentFloor as number;
        if (deps.marginFloorFor !== undefined) {
          const floors = await Promise.all(storeIds.map(async (storeId) => ({ storeId, floor: await deps.marginFloorFor!(ctx.tenantId, storeId) })));
          const unset = floors.filter((f) => f.floor === undefined).map((f) => f.storeId);
          if (unset.length > 0 || floors.length === 0) {
            refuse('margin_floor_not_set', `No margin floor has been set for ${unset.length > 0 ? unset.join(', ') : 'any store'} — a price is judged by the floor the owner set in the store's rules (POST /v1/stores/:storeId/rules), never by one sent with the price.`);
          }
          // A price for several stores is judged at the strictest of their floors.
          marginFloorBps = Math.max(...floors.map((f) => f.floor as number));
        }
        const check = checkPrice({
          id,
          proposedPrice: money(b.priceMinor!, currency),
          mrp: money(b.mrpMinor!, currency),
          cost: money(b.costMinor!, currency),
          marginFloorBps,
          setBy,
          ...(approval === undefined ? {} : { approval }),
        });

        if (!check.allowed) {
          // above_mrp is a legal ceiling no approval can lift; below_cost/below_floor needs a valid
          // separate approval that was not supplied (or did not count).
          throw apiError(422, {
            code: `price_${check.verdict}`,
            whatHappened: check.verdict === 'above_mrp'
              ? 'The price is above the printed MRP — a legal ceiling no approval can lift.'
              : `The price is ${check.verdict.replace('_', ' ')} and needs a separate approver's sign-off with a reason.`,
            wasItSaved: 'not_saved',
            nextSafeAction: check.verdict === 'above_mrp'
              ? 'Set a price at or below the MRP. Nothing was changed.'
              : 'Ask for approval (POST /v1/approvals/requests, kind price_change, with exactly this change); once someone who may approve prices approves it, send the approvalId. Nothing was changed.',
          });
        }

        // Every rule passed: the approval is spent — once — and only then is the price recorded.
        await opened?.spend();
        const record: PriceChangeRecord = {
          id, productId: b.productId!, priceMinor: b.priceMinor!, currency, setBy,
          verdict: check.verdict, approvedBy: approval?.decidedBy ?? null, reason: check.reason, at: deps.now(),
        };
        await deps.recordPriceChange(ctx.tenantId, record, storeIds);
        // Seal the price change into the audit trail — who moved this product's price, to what, and (for a
        // below-cost/below-floor change) who approved it (§28). No card or tender data is anywhere near a
        // price; the figure itself is a public shelf fact, so it is recorded in full.
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'price.change', objectType: 'product', objectId: record.productId,
          at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            priceMinor: String(record.priceMinor), currency: record.currency,
            verdict: record.verdict, approvedBy: record.approvedBy ?? '',
          },
          ...(record.reason ? { reason: record.reason } : {}),
          correlationId: record.id,
        });
        // `operativeAt` says where the price now applies (from today); the till charges it from the next published pack.
        return {
          status: 201,
          body: {
            productId: record.productId, priceMinor: record.priceMinor, verdict: check.verdict, approvedBy: record.approvedBy, operativeAt: storeIds, effectiveFrom: record.at.slice(0, 10),
            // Which floor it was judged by — the store's, said, with the figure the request sent beside it when it sent one.
            marginFloor: deps.marginFloorFor === undefined
              ? { appliedBps: marginFloorBps, source: 'request' }
              : { appliedBps: marginFloorBps, source: 'store_rules', stores: storeIds, ...(Number.isInteger(sentFloor) && sentFloor !== marginFloorBps ? { sentBpsNotUsed: sentFloor } : {}) },
          },
        };
      },
    },
  ];
}
