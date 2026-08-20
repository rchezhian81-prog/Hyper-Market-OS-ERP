// API-03 Supplier rebates & schemes (M06-FR-03 · D03-FR-03 · M23) — the money the shop has already
// EARNED and not yet collected. A rebate is agreed in a meeting, accrued nowhere, and claimed late or
// never; the gap between what has accrued and what finance has actually received is the number nobody
// tracks. This is the cloud surface that makes it visible:
//
//   • a rebate SCHEME is recorded (basis, rate, threshold, term, approver);
//   • an ACCRUAL is posted for a measured period — the tested `accrueRebate` computes it: nothing
//     accrues below the threshold (and it says how far short); a growth scheme measures against its
//     baseline, never the raw total; and the OUTSTANDING (accrued − received) is the earned-not-claimed
//     figure. Accrual is deliberately separate from receipt (M23) — an accrued rebate is money already
//     made, and reconciling it to what finance received is the whole point.
//
// The rule is the tested `accrueRebate` in `@sre/purchasing` (the `services-run-on-their-tested-engine`
// guardrail); this file is the persistence + HTTP skin. Recording is gated `purchase.contract.manage`;
// reads are `purchase.commitment.read`. The finance-side claim APPROVAL of a rebate payment (FR-03 /
// M23) is a separate flow — this surface records what is earned and what has been received against it.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  accrueRebate,
  type RebateScheme, type RebateBasis, type RebateAccrual,
} from '../../../packages/purchasing/src/index';
import { isCurrencyCode, type Money } from '../../../packages/contracts/src/money';

export interface RebateDeps {
  /** One scheme by id (latest version), or undefined. */
  readonly scheme: (tenantId: string, schemeId: string) => Promise<RebateScheme | undefined> | RebateScheme | undefined;
  /** Every scheme. */
  readonly schemes: (tenantId: string) => Promise<readonly RebateScheme[]> | readonly RebateScheme[];
  /** Every posted accrual for a scheme (latest per accrual id). */
  readonly accruals: (tenantId: string, schemeId: string) => Promise<readonly RebateAccrual[]> | readonly RebateAccrual[];
  /** Record a scheme. Latest per scheme id. */
  readonly recordScheme: (tenantId: string, scheme: RebateScheme) => Promise<void> | void;
  /** Record a posted accrual. Latest per accrual id (a re-measure supersedes). */
  readonly recordAccrual: (tenantId: string, schemeId: string, accrualId: string, accrual: RebateAccrual) => Promise<void> | void;
  readonly now: () => string;
}

const BASES: readonly RebateBasis[] = ['volume_units', 'purchase_value', 'growth_over_baseline'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isMoney = (v: unknown): v is Money =>
  isObj(v) && typeof v['minor'] === 'number' && Number.isSafeInteger(v['minor']) && typeof v['currency'] === 'string' && isCurrencyCode(v['currency']);

/** Sum a money field across accruals in the scheme's currency (defaulting to INR when empty). */
const sumMinor = (accruals: readonly RebateAccrual[], pick: (a: RebateAccrual) => Money): number =>
  accruals.reduce((s, a) => s + pick(a).minor, 0);

export function rebateRoutes(deps: RebateDeps): readonly Route[] {
  return [
    {
      // Record a rebate scheme. Body: { supplierId, basis, rateBp, thresholdMinor?, startsOn, endsOn,
      // approvedBy? }. Latest per scheme id (a renegotiated scheme is a new version, never an overwrite).
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-schemes/:schemeId',
      permission: 'purchase.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const schemeId = (ctx.params['schemeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const basis = b['basis'];
        const threshold = b['thresholdMinor'];
        const approvedBy = b['approvedBy'];
        if (schemeId === '' || !isStr(b['supplierId']) || typeof basis !== 'string' || !BASES.includes(basis as RebateBasis)
          || !isNonNegInt(b['rateBp']) || (threshold !== undefined && !isNonNegInt(threshold))
          || !isDate(b['startsOn']) || !isDate(b['endsOn']) || (approvedBy !== undefined && typeof approvedBy !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_rebate_scheme',
            whatHappened: `A rebate scheme needs a schemeId in the path and { supplierId, basis (${BASES.join(' | ')}), rateBp (whole, ≥0), thresholdMinor?, startsOn, endsOn (YYYY-MM-DD), approvedBy? } in the body.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the supplier, the basis and rate, and the term.',
          });
        }
        if ((b['endsOn'] as string) < (b['startsOn'] as string)) {
          throw apiError(422, {
            code: 'scheme_ends_before_it_starts',
            whatHappened: `The scheme's end date (${b['endsOn']}) is before its start date (${b['startsOn']}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the term and record again. Nothing was saved.',
          });
        }
        const scheme: RebateScheme = {
          schemeId,
          supplierId: b['supplierId'] as string,
          basis: basis as RebateBasis,
          rateBp: b['rateBp'] as number,
          ...(isNonNegInt(threshold) ? { thresholdMinor: threshold } : {}),
          startsOn: b['startsOn'] as string,
          endsOn: b['endsOn'] as string,
          ...(isStr(approvedBy) ? { approvedBy: approvedBy as string } : {}),
        };
        await deps.recordScheme(ctx.tenantId, scheme);
        return { status: 201, body: { scheme } };
      },
    },
    {
      // Post an accrual for a measured period. Body: { basisAmount { minor, currency }, baselineAmount?,
      // received? }. Runs the tested accrueRebate. Idempotent on the accrual id — a re-measure supersedes.
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-schemes/:schemeId/accruals/:accrualId',
      permission: 'purchase.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const schemeId = (ctx.params['schemeId'] ?? '').trim();
        const accrualId = (ctx.params['accrualId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (accrualId === '' || !isMoney(b['basisAmount'])
          || (b['baselineAmount'] !== undefined && !isMoney(b['baselineAmount']))
          || (b['received'] !== undefined && !isMoney(b['received']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_accrual',
            whatHappened: 'An accrual needs an accrualId in the path and { basisAmount { minor, currency }, baselineAmount?, received? } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the measured basis amount (and, for a growth scheme, the baseline).',
          });
        }
        const scheme = await deps.scheme(ctx.tenantId, schemeId);
        if (scheme === undefined) throw notFound(`rebate scheme ${schemeId}`);
        const accrual = accrueRebate({
          scheme,
          basisAmount: b['basisAmount'] as Money,
          ...(isMoney(b['received']) ? { received: b['received'] as Money } : {}),
          ...(isMoney(b['baselineAmount']) ? { baselineAmount: b['baselineAmount'] as Money } : {}),
        });
        await deps.recordAccrual(ctx.tenantId, schemeId, accrualId, accrual);
        return { status: 201, body: { accrual } };
      },
    },
    {
      // Every scheme (the rebate register).
      api: 'API-03', method: 'GET', path: '/v1/purchase/rebate-schemes',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const schemes = await deps.schemes(ctx.tenantId);
        return { status: 200, body: { schemes, count: schemes.length } };
      },
    },
    {
      // A scheme's accruals and the money EARNED and not yet claimed (total outstanding). 404 if unknown.
      api: 'API-03', method: 'GET', path: '/v1/purchase/rebate-schemes/:schemeId/accruals',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const schemeId = (ctx.params['schemeId'] ?? '').trim();
        const scheme = await deps.scheme(ctx.tenantId, schemeId);
        if (scheme === undefined) throw notFound(`rebate scheme ${schemeId}`);
        const accruals = await deps.accruals(ctx.tenantId, schemeId);
        return {
          status: 200,
          body: {
            accruals,
            count: accruals.length,
            totalAccruedMinor: sumMinor(accruals, (a) => a.accrued),
            totalReceivedMinor: sumMinor(accruals, (a) => a.received),
            // The headline: earned and not yet collected (M06-FR-03 / M23).
            outstandingMinor: sumMinor(accruals, (a) => a.outstanding),
          },
        };
      },
    },
  ];
}
