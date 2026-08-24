// API-04 Space productivity & supplier display contracts (M04-FR-04 · D02-FR-06 · M23) — tested since the
// module was written, wired into the ERP screen, and on NO cloud route. Two questions a 14,000 sq ft shop
// usually answers by feel, and gets wrong:
//
//   1. IS THIS SPACE EARNING ITS KEEP? Every square foot given to one category is taken from another, and
//      the honest comparison is MARGIN per square foot, not turnover — a big-turnover thin-margin aisle can
//      be the worst use of space in the building while looking like the best. `spacePerformance` ranks by
//      it and flags an area whose share of MARGIN sits materially below its share of SPACE. A ratio that
//      cannot be computed says so (`not_meaningful`) rather than returning a fabricated zero (P-08).
//
//   2. IS THE SUPPLIER ACTUALLY PAYING FOR THE END-CAP THEY ARE STANDING ON? Display funding is agreed in a
//      conversation and forgotten by finance. `reviewDisplayContracts` names the space, the money and the
//      dates and flags the ones that cost money: **expired but the display is still on the floor** (free
//      premium space), **unapproved** (a commercial term with no Finance sign-off — §28), **no space named**
//      (nobody can check it), and **funding not received** (the space is used, the money is not in — M23).
//
// The engines are the tested `spacePerformance`/`reviewDisplayContracts` in `@sre/merchandising` (the
// `services-run-on-their-tested-engine` guardrail). Space performance is a pure compute over supplied
// analysis facts; a display contract is recorded append-only and the review folds the stored contracts
// against supplied finance-received + floor-occupancy facts (M23). Gated `merchandising.space.read` to
// read/review, `merchandising.display.manage` to record a contract.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  spacePerformance, reviewDisplayContracts,
  type SpaceArea, type DisplayContract,
} from '../../../packages/merchandising/src/index';
import type { Money, CurrencyCode } from '../../../packages/contracts/src/money';

const CURRENCIES: readonly CurrencyCode[] = ['INR', 'USD', 'EUR', 'GBP'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCurrency = (v: unknown): v is CurrencyCode => typeof v === 'string' && (CURRENCIES as readonly string[]).includes(v);
const isDate = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
const isMoney = (v: unknown): v is Money => isObj(v) && isInt(v['minor']) && isCurrency(v['currency']);
// A { key: Money } map, every value a valid Money.
const moneyMap = (v: unknown): Readonly<Record<string, Money>> | undefined =>
  v === undefined ? {} : (isObj(v) && Object.values(v).every(isMoney) ? (v as Record<string, Money>) : undefined);

interface RawArea { readonly areaId: string; readonly storeId: string; readonly name: string; readonly squareFeet: number; readonly locationIds?: readonly string[] }
const isArea = (v: unknown): v is RawArea =>
  isObj(v) && isStr(v['areaId']) && isStr(v['storeId']) && isStr(v['name']) && isNum(v['squareFeet']) && (v['squareFeet'] as number) >= 0
  && (v['locationIds'] === undefined || strArray(v['locationIds']) !== undefined);

export interface SpacePerformanceDeps {
  /** Every display contract recorded for the tenant — append-only, folded latest-per-contractId. */
  readonly contracts: (tenantId: string) => Promise<readonly DisplayContract[]> | readonly DisplayContract[];
  readonly recordContract: (tenantId: string, contractId: string, contract: DisplayContract, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function spacePerformanceRoutes(deps: SpacePerformanceDeps): readonly Route[] {
  return [
    {
      // Rank the store's areas by MARGIN per square foot and flag the ones taking more space than they
      // earn. A pure compute over supplied facts (the analysis context holds them) — it writes nothing,
      // but it is a POST because the areas + figures are a body, not a query. Body: { areas[], sales{},
      // grossMargin{}, currency, toleranceBp? }.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/space/performance',
      permission: 'merchandising.space.read', idempotent: true,
      handler: (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const areas = b['areas'];
        const sales = moneyMap(b['sales']);
        const grossMargin = moneyMap(b['grossMargin']);
        if (!Array.isArray(areas) || areas.length === 0 || !areas.every(isArea) || !isCurrency(b['currency'])
          || sales === undefined || grossMargin === undefined
          || (b['toleranceBp'] !== undefined && (!isInt(b['toleranceBp']) || (b['toleranceBp'] as number) < 0))) {
          throw apiError(400, {
            code: 'not_readable_as_a_space_request',
            whatHappened: 'Space performance needs { areas[] (each { areaId, storeId, name, squareFeet }), sales{ areaId: money }, grossMargin{ areaId: money }, currency, toleranceBp? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the areas with their floor space and the sales and margin against each.',
          });
        }
        const rows = spacePerformance({
          areas: areas as RawArea[] as readonly SpaceArea[], sales, grossMargin, currency: b['currency'] as CurrencyCode,
          ...(isInt(b['toleranceBp']) ? { toleranceBp: b['toleranceBp'] as number } : {}),
        });
        return { status: 200, body: { rows, count: rows.length, underperforming: rows.filter((r) => r.underperforming).length } };
      },
    },
    {
      // Review the supplier display contracts against the dates, the finance received figure and what is
      // still on the floor. STATIC path — registered BEFORE `/:contractId` so it is not read as a contract
      // called "review". Body: { onDate, currency, storeId?, received?, stillOccupying?[], warnDays? }.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/display-contracts/review',
      permission: 'merchandising.space.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const received = moneyMap(b['received']);
        const stillOccupying = strArray(b['stillOccupying'] ?? []);
        if (!isDate(b['onDate']) || !isCurrency(b['currency']) || received === undefined || stillOccupying === undefined
          || (b['storeId'] !== undefined && !isStr(b['storeId']))
          || (b['warnDays'] !== undefined && (!isInt(b['warnDays']) || (b['warnDays'] as number) < 0))) {
          throw apiError(400, {
            code: 'not_readable_as_a_review',
            whatHappened: 'A display-contract review needs { onDate (YYYY-MM-DD), currency, storeId?, received?{ contractId: money }, stillOccupying?[], warnDays? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the date to judge against, and optionally what finance has received and which displays are still up.',
          });
        }
        const all = await deps.contracts(ctx.tenantId);
        const contracts = isStr(b['storeId']) ? all.filter((c) => c.storeId === b['storeId']) : all;
        const statuses = reviewDisplayContracts({
          contracts, onDate: b['onDate'] as string, received, stillOccupying, currency: b['currency'] as CurrencyCode,
          ...(isInt(b['warnDays']) ? { warnDays: b['warnDays'] as number } : {}),
        });
        // The commercially actionable findings — free space and money not in — surfaced by exception (P-03).
        const flagged = statuses.filter((s) => s.finding !== 'active').length;
        return { status: 200, body: { statuses, count: statuses.length, flagged } };
      },
    },
    {
      // Record a supplier display contract: the space it buys, the money and the dates. Append-only,
      // latest-per-contractId (a correction supersedes). Body: { storeId, supplierId, description,
      // fundingAmount, startsOn, endsOn, locationIds[], areaId?, approvedBy? }.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/display-contracts/:contractId',
      permission: 'merchandising.display.manage', idempotent: true,
      handler: async (ctx) => {
        const contractId = (ctx.params['contractId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const locationIds = strArray(b['locationIds']);
        if (contractId === '' || !isStr(b['storeId']) || !isStr(b['supplierId']) || !isStr(b['description'])
          || !isMoney(b['fundingAmount']) || !isDate(b['startsOn']) || !isDate(b['endsOn']) || locationIds === undefined
          || (b['areaId'] !== undefined && !isStr(b['areaId'])) || (b['approvedBy'] !== undefined && typeof b['approvedBy'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_display_contract',
            whatHappened: 'A display contract needs a contractId in the path and { storeId, supplierId, description, fundingAmount (money), startsOn, endsOn (YYYY-MM-DD), locationIds[], areaId?, approvedBy? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the supplier, the space it buys, the money and the dates.',
          });
        }
        const contract: DisplayContract = {
          contractId, storeId: b['storeId'] as string, supplierId: b['supplierId'] as string,
          description: b['description'] as string, fundingAmount: b['fundingAmount'] as Money,
          startsOn: b['startsOn'] as string, endsOn: b['endsOn'] as string, locationIds,
          ...(isStr(b['areaId']) ? { areaId: b['areaId'] } : {}),
          ...(isStr(b['approvedBy']) ? { approvedBy: b['approvedBy'] } : {}),
        };
        await deps.recordContract(ctx.tenantId, contractId, contract, ctx.idempotencyKey ?? contractId);
        return { status: 201, body: { contractId, storeId: contract.storeId, supplierId: contract.supplierId, approved: contract.approvedBy !== undefined } };
      },
    },
  ];
}
