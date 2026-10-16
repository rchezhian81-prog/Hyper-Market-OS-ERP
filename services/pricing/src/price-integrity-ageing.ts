// API-02 The automated price-integrity audit (D-7, roadmap v2.1 addendum, ratified R2; pairs with B25) — "Price-of-record
// vs shelf vs POS vs app are reconciled into an ageing exception report".
//
//   • POST /v1/pricing/integrity/observations/:observationId — a price a surface was SEEN showing: a shelf walk, an ESL's
//     echo, the app reporting what it displayed. { branchId, productId, surface, priceMinor, observedAt?, shelfAddress?,
//     deviceId? }. Who saw it is the signed-in caller. Append-only; idempotent on the id. price.integrity.audit.
//   • GET  /v1/pricing/integrity/ageing?branchId=&asOf=&sinceDays=&productId= — the AGEING exception report: every product
//     seen or sold at the store in the window, its price of record (the price list, resolved for the store) against each
//     surface seen and against what the till CHARGED (read from the banked sale lines), each open exception aged from the
//     moment it began, in bands. price.integrity.audit.
//
// Nobody types a price into the audit: head office reads the price list, the observations and the sale records it holds.
// The report is derived on every read, so it needs no job to run and holds no store of exceptions that could drift; a
// mismatch fixed (the label reprinted and seen, the till charging right again) leaves the report by itself. This reads the
// sale records only — it never touches the till. No AI changes a price (hard rule #5): a person fixes the label or the list.
//
// The rules are the pure `reconcilePriceIntegrity` in `packages/self-checkout/src/price-integrity-ageing.ts`.

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope } from '../../kernel/src/index';
import {
  reconcilePriceIntegrity, OBSERVED_SURFACES,
  type PriceObservation, type ObservedSurface, type ChargedLine,
} from '../../../packages/self-checkout/src/index';
import type { PriceEntry } from '../../../packages/price-list/src/price-list';

export interface PriceIntegrityAgeingDeps {
  readonly observations: (tenantId: string, branchId: string) => Promise<readonly PriceObservation[]> | readonly PriceObservation[];
  readonly recordObservation: (tenantId: string, observation: PriceObservation) => Promise<void> | void;
  /** Whether an observation id is already on file (an id is used once). */
  readonly observation: (tenantId: string, observationId: string) => Promise<PriceObservation | undefined> | PriceObservation | undefined;
  /** Every price-list entry of these products (append-only; resolved for the store by the engine). */
  readonly priceEntries: (tenantId: string, productIds: readonly string[]) => Promise<readonly PriceEntry[]> | readonly PriceEntry[];
  /** The till's banked sale lines at this store between two moments — read from the sale records, never the till. */
  readonly chargedAt: (tenantId: string, branchId: string, fromIso: string, toIso: string) => Promise<readonly ChargedLine[]> | readonly ChargedLine[];
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const DAY_MS = 86_400_000;

export function priceIntegrityAgeingRoutes(deps: PriceIntegrityAgeingDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'POST', path: '/v1/pricing/integrity/observations/:observationId',
      permission: 'price.integrity.audit', idempotent: true,
      handler: async (ctx) => {
        const observationId = (ctx.params['observationId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const now = deps.now();
        if (observationId === '' || !isStr(b['branchId']) || !isStr(b['productId']) || !OBSERVED_SURFACES.includes(b['surface'] as ObservedSurface)
          || !Number.isInteger(b['priceMinor']) || (b['priceMinor'] as number) < 0
          || (b['observedAt'] !== undefined && (!isTime(b['observedAt']) || Date.parse(b['observedAt']) > Date.parse(now)))
          || (b['observedBy'] !== undefined && b['observedBy'] !== ctx.userId)) {
          throw apiError(400, {
            code: 'not_readable_as_a_price_observation',
            whatHappened: `A price observation needs { branchId, productId, surface (${OBSERVED_SURFACES.join(' / ')}), priceMinor (whole paise ≥ 0) } and may carry observedAt (not in the future), shelfAddress, deviceId. Who saw it is you.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send what the surface showed. Nothing was recorded.',
          });
        }
        assertBranchInScope(ctx, b['branchId']); // PA-01-r1
        const before = await deps.observation(ctx.tenantId, observationId);
        if (before !== undefined) return { status: 200, body: { observation: before, alreadyRecorded: true } };
        const obs: PriceObservation = {
          observationId, branchId: b['branchId'].trim(), productId: b['productId'].trim(), surface: b['surface'] as ObservedSurface,
          priceMinor: b['priceMinor'] as number, observedAt: isTime(b['observedAt']) ? new Date(Date.parse(b['observedAt'])).toISOString() : now,
          observedBy: ctx.userId,
          ...(isStr(b['shelfAddress']) ? { shelfAddress: b['shelfAddress'].trim() } : {}),
          ...(isStr(b['deviceId']) ? { deviceId: b['deviceId'].trim() } : {}),
        };
        await deps.recordObservation(ctx.tenantId, obs);
        return { status: 201, body: { observation: obs } };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/pricing/integrity/ageing',
      permission: 'price.integrity.audit',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const asOf = ctx.query['asOf'];
        const sinceDays = ctx.query['sinceDays'] === undefined ? 30 : Number(ctx.query['sinceDays']);
        if (!isStr(branchId) || (asOf !== undefined && !isTime(asOf)) || !Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 366) {
          throw apiError(400, {
            code: 'ageing_report_needs_a_store',
            whatHappened: 'The price-integrity ageing report needs ?branchId= (the store), and may take ?asOf= (a time) and ?sinceDays= (1-366, default 30: how far back the till\'s sales are read).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Name the store. A report reads; it never writes.',
          });
        }
        assertBranchInScope(ctx, branchId); // PA-01-r1
        const asAt = asOf === undefined ? deps.now() : new Date(Date.parse(asOf)).toISOString();
        const from = new Date(Date.parse(asAt) - sinceDays * DAY_MS).toISOString();
        const only = isStr(ctx.query['productId']) ? ctx.query['productId'] : undefined;
        const keep = <T extends { productId: string }>(xs: readonly T[]): T[] => xs.filter((x) => only === undefined || x.productId === only);
        const observations = keep(await deps.observations(ctx.tenantId, branchId));
        const charged = keep(await deps.chargedAt(ctx.tenantId, branchId, from, asAt));
        // The products checked: every one seen on a surface here, or sold here in the window (a product on sale is
        // checked even if nobody has seen its shelf — that is its own exception).
        const productIds = [...new Set([...observations.map((o) => o.productId), ...charged.map((c) => c.productId)])].sort();
        const entries = productIds.length === 0 ? [] : await deps.priceEntries(ctx.tenantId, productIds);
        const report = reconcilePriceIntegrity({ branchId, asAt, entries, observations, charged });
        return { status: 200, body: { ...report, salesReadFrom: from, count: report.exceptions.length } };
      },
    },
  ];
}
