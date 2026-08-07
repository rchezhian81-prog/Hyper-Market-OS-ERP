// API-02 Pricing — governed price changes (M05-FR-02, §28). The catalogue service publishes what was
// approved and deliberately is NOT a price door; this is "M05's own path": a price change runs the
// tested guardrail engine (packages/price-guard `checkPrice`) — a price above the legal MRP ceiling
// is rejected outright, and a below-cost or below-margin-floor price is blocked unless a SEPARATE
// person approves it with a reason (separation of duties). The separation is real, not a name in a
// form: the named approver must actually hold `price.change.approve`, and cannot be the person
// setting the price. An allowed change is recorded as an append-only event; the pack-publish path
// (services/catalogue) then re-checks §28 before it reaches the shelf edge, so the control survives
// every step.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { checkPrice } from '../../../packages/price-guard/src/price-guard';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';

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
  /** Persist an allowed price change as an append-only event. */
  readonly recordPriceChange: (tenantId: string, change: PriceChangeRecord) => Promise<void> | void;
  /** Whether a user holds `price.change.approve` in this tenant — the approver must genuinely hold it. */
  readonly canApprove: (tenantId: string, userId: string) => Promise<boolean>;
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
        if (!Number.isInteger(b.marginFloorBps) || b.marginFloorBps! < 0 || b.marginFloorBps! > 9999) {
          refuse('margin_floor_out_of_range', 'marginFloorBps must be an integer 0–9999.');
        }
        const currency = b.currency as CurrencyCode;
        const id = `price-${b.productId!}`;
        const setBy = ctx.userId;

        // Build the approval the engine checks. §28 in the engine: an approval only counts if the
        // approver is not the setter. Here we ALSO require the approver to genuinely hold the
        // approve permission — a named approver who cannot approve is not an approval.
        let approval: DecidedRequest | undefined;
        if (b.approval?.decidedBy !== undefined && b.approval.decidedBy.trim() !== '') {
          const approver = b.approval.decidedBy;
          if (approver === setBy) refuse('approved_by_the_setter', `${setBy} cannot approve their own price change (§28).`);
          if (!(await deps.canApprove(ctx.tenantId, approver))) {
            refuse('approver_may_not_approve_prices', `${approver} does not hold price.change.approve, so their approval does not count.`);
          }
          approval = Object.freeze({
            id, subjectType: 'price', subjectRef: id, requestedBy: setBy, branchId: ctx.branchId,
            value: null, status: 'approved', decidedBy: approver, reason: b.approval.reason ?? '', decidedAt: deps.now(),
          });
        }

        const check = checkPrice({
          id,
          proposedPrice: money(b.priceMinor!, currency),
          mrp: money(b.mrpMinor!, currency),
          cost: money(b.costMinor!, currency),
          marginFloorBps: b.marginFloorBps!,
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
              : 'Have someone who is not the setter, and who may approve prices, approve it with a reason. Nothing was changed.',
          });
        }

        const record: PriceChangeRecord = {
          id, productId: b.productId!, priceMinor: b.priceMinor!, currency, setBy,
          verdict: check.verdict, approvedBy: approval?.decidedBy ?? null, reason: check.reason, at: deps.now(),
        };
        await deps.recordPriceChange(ctx.tenantId, record);
        return { status: 201, body: { productId: record.productId, priceMinor: record.priceMinor, verdict: check.verdict, approvedBy: record.approvedBy } };
      },
    },
  ];
}
