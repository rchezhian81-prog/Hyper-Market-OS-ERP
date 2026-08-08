// API-09 salesperson commission (M22-FR-03) — what a salesperson has EARNED, recorded exactly and
// read as a running total, never a stored balance. A commission is a basis-points rate applied to a
// commissionable base with an optional cap; the sum owed to a person is PROJECTED from the accruals,
// never overwritten (hard rule #2). The rate is the pure `computeCommission` engine in `packages/b2b`
// (exact money, no float) — this surface gives it persistence, an authorization split and a read.
//
// The rate is DECLARED on the accrual, never derived. A commission computed as a share of some
// difference agrees with any figure (the migration banking-verification control makes the same point);
// here the base and the rate are stated by the person recording the accrual, and the engine rounds
// exactly. Recording is a finance act (owner/accountant); a manager may read what the floor has earned;
// a cashier may do neither.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { computeCommission } from '../../../packages/b2b/src/commission';
import type { CurrencyCode } from '../../../packages/contracts/src/money';

const CURRENCIES: readonly CurrencyCode[] = ['INR', 'USD', 'EUR', 'GBP'];
const asCurrency = (v: unknown): CurrencyCode =>
  typeof v === 'string' && (CURRENCIES as readonly string[]).includes(v) ? (v as CurrencyCode) : 'INR';

/** One recorded commission — the base it was earned on, the declared rate, and the exact amount. */
export interface CommissionAccrual {
  readonly accrualId: string;
  readonly salespersonId: string;
  /** The commissionable base the rate was applied to, minor units. */
  readonly baseMinor: number;
  /** Basis points, 0–10000 (1000 = 10%). */
  readonly rateBps: number;
  /** An optional payout cap, minor units. Null means uncapped. */
  readonly capMinor: number | null;
  /** The exact commission, computed by the engine and rounded half-up. */
  readonly commissionMinor: number;
  readonly currency: CurrencyCode;
  /** What it was earned against — an invoice, an order, a deal. Free text. */
  readonly ref: string | null;
  readonly at: string;
}

export interface B2BCommissionDeps {
  readonly accruals: (tenantId: string, salespersonId: string) => Promise<readonly CommissionAccrual[]> | readonly CommissionAccrual[];
  readonly recordAccrual: (tenantId: string, salespersonId: string, accrual: CommissionAccrual) => Promise<void> | void;
  readonly now: () => string;
}

export function b2bCommissionRoutes(deps: B2BCommissionDeps): readonly Route[] {
  return [
    {
      // Record a commission a salesperson has earned. The server computes the amount from the base and
      // the declared rate — the caller never states the payout, so a fitted figure cannot be slipped in.
      api: 'API-09', method: 'POST', path: '/v1/b2b/commissions/:salespersonId/accruals/:accrualId',
      permission: 'b2b.commission.record', idempotent: true,
      handler: async (ctx) => {
        const salespersonId = ctx.params['salespersonId'] ?? '';
        const accrualId = ctx.params['accrualId'] ?? '';
        const b = (ctx.body ?? {}) as { baseMinor?: unknown; rateBps?: unknown; capMinor?: unknown; currency?: unknown; ref?: unknown };

        if (!Number.isInteger(b.baseMinor) || (b.baseMinor as number) < 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_commission',
            whatHappened: 'A commission needs a whole, non-negative base in minor units.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "baseMinor": …, "rateBps": … }. Nothing was recorded.',
          });
        }
        if (!Number.isInteger(b.rateBps) || (b.rateBps as number) < 0 || (b.rateBps as number) > 10_000) {
          throw apiError(400, {
            code: 'not_a_commission_rate',
            whatHappened: 'A commission rate is a whole number of basis points from 0 to 10000 (1000 = 10%).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send rateBps in the range 0–10000. Nothing was recorded.',
          });
        }
        if (b.capMinor !== undefined && (!Number.isInteger(b.capMinor) || (b.capMinor as number) < 0)) {
          throw apiError(400, {
            code: 'not_a_commission_cap',
            whatHappened: 'A commission cap, when given, is a whole, non-negative amount in minor units.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send a whole capMinor or omit it. Nothing was recorded.',
          });
        }

        const currency = asCurrency(b.currency);
        const capMinor = b.capMinor === undefined ? null : (b.capMinor as number);
        // The exact engine — half-up rounding, cap applied after the round (M22-FR-03).
        const commission = computeCommission(
          { minor: b.baseMinor as number, currency },
          b.rateBps as number,
          capMinor ?? undefined,
        );

        const accrual: CommissionAccrual = {
          accrualId, salespersonId,
          baseMinor: b.baseMinor as number, rateBps: b.rateBps as number, capMinor,
          commissionMinor: commission.minor, currency,
          ref: typeof b.ref === 'string' ? b.ref : null,
          at: deps.now(),
        };
        await deps.recordAccrual(ctx.tenantId, salespersonId, accrual);
        return { status: 201, body: { salespersonId, accrualId, commissionMinor: commission.minor, currency } };
      },
    },
    {
      // What a salesperson has earned so far — the sum of the accruals, projected, never a stored total.
      api: 'API-09', method: 'GET', path: '/v1/b2b/commissions/:salespersonId',
      permission: 'b2b.commission.read',
      handler: async (ctx) => {
        const salespersonId = ctx.params['salespersonId'] ?? '';
        const accruals = await deps.accruals(ctx.tenantId, salespersonId);
        if (accruals.length === 0) throw notFound(`commission for ${salespersonId}`);
        const totalCommissionMinor = accruals.reduce((s, a) => s + a.commissionMinor, 0);
        const totalBaseMinor = accruals.reduce((s, a) => s + a.baseMinor, 0);
        return {
          status: 200,
          body: {
            salespersonId,
            // The store trades in one currency; the accruals' currency is reported for the reader.
            currency: accruals[accruals.length - 1]?.currency ?? 'INR',
            totalCommissionMinor, totalBaseMinor, count: accruals.length,
            accruals, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
