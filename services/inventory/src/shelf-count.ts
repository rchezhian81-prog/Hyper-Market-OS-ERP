// API-04 Shelf counting (M04-FR-02/03 · D05) — the producer that never existed. `planogramCompliance`
// (M19) has been tested since the module was created, and it needs one thing nothing in this system ever
// produced: how many of an item are on the shelf right now. This is that write path, on the cloud:
//
//   • a shelf quantity is an OBSERVATION, not a fact — every count carries when it was taken and who took
//     it (server-attributed, never a client field), and the reads report how STALE each facing is against
//     a freshness window, because a Tuesday reading shown on Friday sends staff to the wrong shelf;
//   • counted BLIND — the count route takes the figure and nothing else; no expected quantity is accepted
//     or returned, so a screen cannot render one early (the same discipline as the till drawer);
//   • APPEND-ONLY — a recount is a NEW observation and the previous one stays (it is the record that
//     explains a variance); the worklist puts NEVER-COUNTED before long-ago, worst first.
//
// The rules are the tested `recordShelfCount`/`latestCounts`/`countingWorklist` in `@sre/merchandising`
// (the `services-run-on-their-tested-engine` guardrail). Recording is gated `shelf.count.record`; the
// reads are `shelf.count.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  recordShelfCount, latestCounts, countingWorklist,
  type ShelfCount, type CountRefusal,
} from '../../../packages/merchandising/src/index';

export type { ShelfCount } from '../../../packages/merchandising/src/index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

interface RawFacing { readonly productId: string; readonly locationId: string }
const isFacing = (v: unknown): v is RawFacing => isObj(v) && isStr(v['productId']) && isStr(v['locationId']);

// A refusal from the engine names the wrong input; a wrong-shape body is a 400, a valid-shape-wrong-value
// count is a 422 (nothing was saved either way).
const REFUSAL_STATUS: Readonly<Record<CountRefusal, number>> = {
  a_negative_count_is_not_a_count: 422,
  a_count_needs_a_whole_number: 422,
  nobody_signed_this_count: 422,
  this_shop_has_no_such_shelf: 422,
};

export interface ShelfCountDeps {
  /** Every count taken in a store — append-only, so a recount is a new row and the previous one stays. */
  readonly counts: (tenantId: string, storeId: string) => Promise<readonly ShelfCount[]> | readonly ShelfCount[];
  /** Record one observation. Idempotent on the count id (a re-sync is one observation, not two). */
  readonly recordCount: (tenantId: string, countId: string, count: ShelfCount, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function shelfCountRoutes(deps: ShelfCountDeps): readonly Route[] {
  return [
    {
      // The facings that most need counting, worst first (never-counted before long-ago). Body:
      // { storeId, planned[] each { productId, locationId }, staleAfterMinutes? }. Registered BEFORE the
      // `/:countId` route so this static path is matched first, not as a countId of "worklist".
      api: 'API-04', method: 'POST', path: '/v1/merchandising/shelf-counts/worklist',
      permission: 'shelf.count.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const planned = b['planned'];
        if (!isStr(b['storeId']) || !Array.isArray(planned) || !planned.every(isFacing)) {
          throw apiError(400, {
            code: 'not_readable_as_a_worklist_request',
            whatHappened: 'A worklist needs { storeId, planned[] (each with productId and locationId), staleAfterMinutes? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the store and the facings that should be counted.',
          });
        }
        const staleAfterMinutes = isInt(b['staleAfterMinutes']) && (b['staleAfterMinutes'] as number) > 0 ? b['staleAfterMinutes'] as number : 240;
        const worklist = countingWorklist({
          planned: planned as RawFacing[],
          counts: await deps.counts(ctx.tenantId, b['storeId'] as string),
          asOf: deps.now(), staleAfterMinutes,
        });
        return { status: 200, body: { worklist, count: worklist.length, staleAfterMinutes } };
      },
    },
    {
      // Record a blind shelf count. Body: { storeId, locationId, productId, countedMinor, knownLocationIds[] }.
      // The counter is the authenticated user (a count nobody signed cannot be asked about later, and it will).
      api: 'API-04', method: 'POST', path: '/v1/merchandising/shelf-counts/:countId',
      permission: 'shelf.count.record', idempotent: true,
      handler: async (ctx) => {
        const countId = (ctx.params['countId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const known = strArray(b['knownLocationIds']);
        if (countId === '' || !isStr(b['storeId']) || !isStr(b['locationId']) || !isStr(b['productId'])
          || !isInt(b['countedMinor']) || known === undefined || known.length === 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_shelf_count',
            whatHappened: 'A shelf count needs a countId in the path and { storeId, locationId, productId, countedMinor (whole), knownLocationIds[] (the shop\'s real shelves) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the facing and the whole count. The counter is taken from your login.',
          });
        }
        const outcome = recordShelfCount({
          storeId: b['storeId'] as string, locationId: b['locationId'] as string, productId: b['productId'] as string,
          countedMinor: b['countedMinor'] as number,
          countedBy: ctx.userId, // server-attributed — the count is signed by whoever is logged in
          at: deps.now(), knownLocationIds: known,
        });
        if (!outcome.ok) {
          throw apiError(REFUSAL_STATUS[outcome.refusal], {
            code: outcome.refusal,
            whatHappened: outcome.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the count and record again. Nothing was saved.',
          });
        }
        await deps.recordCount(ctx.tenantId, countId, outcome.count, ctx.idempotencyKey ?? countId);
        return { status: 201, body: { countId, count: outcome.count } };
      },
    },
    {
      // The latest count for each facing in a store, and how stale it is. `?storeId=` (required),
      // `?staleAfterMinutes=` the freshness window (default 240).
      api: 'API-04', method: 'GET', path: '/v1/merchandising/shelf-counts',
      permission: 'shelf.count.read',
      handler: async (ctx) => {
        const storeId = ctx.query['storeId'];
        if (!isStr(storeId)) throw apiError(400, { code: 'shelf_counts_need_a_store', whatHappened: 'Reading shelf counts needs ?storeId=.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store. A read never writes.' });
        const staleRaw = Number(ctx.query['staleAfterMinutes']);
        const staleAfterMinutes = Number.isInteger(staleRaw) && staleRaw > 0 ? staleRaw : 240;
        const { latest, ages } = latestCounts(await deps.counts(ctx.tenantId, storeId), deps.now(), staleAfterMinutes);
        return { status: 200, body: { latest, ages, staleAfterMinutes, asOf: deps.now() } };
      },
    },
  ];
}
