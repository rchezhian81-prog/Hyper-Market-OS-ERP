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
// SP-8c-ii (F08): the count the merchandising screen takes at the shelf is RELAYED here too. The screen keeps
// it on the DURABLE device queue before it says "saved" (the same mechanism as the manager's decisions and the
// floor's indents), hands it to the store box over `/lane/outbox`, and the box relays it to the synced route
// under the store's sync credential. That route trusts the FACT (who counted what, where, when — the id is the
// device's own, so a re-sent item is one observation, §31.1), re-runs the JUDGEMENT through the same engine as
// the direct route against HEAD OFFICE's shelf map where it has one, and re-verifies the COUNTER from their
// own grants — a breach is FLAGGED on the record, never silently trusted (hard rules #4/#10); the relay (the
// box) is recorded beside them, never as the counter.
//
// The rules are the tested `recordShelfCount`/`latestCounts`/`countingWorklist` in `@sre/merchandising`
// (the `services-run-on-their-tested-engine` guardrail). Recording is gated `shelf.count.record`; the
// reads are `shelf.count.read`; the relayed count is `shelf.count.sync` (the box's hop, which grants nothing).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  recordShelfCount, latestCounts, countingWorklist,
  type ShelfCount, type CountRefusal,
} from '../../../packages/merchandising/src/index';

export type { ShelfCount } from '../../../packages/merchandising/src/index';

/** What head office found about the counter the device named — flagged on the record, never a silent trust. */
export const SHELF_COUNT_SYNC_FLAGS = Object.freeze([
  'counter_unknown', 'counter_lacks_authority',
  // Head office keeps no shelf map for this store yet, so the device's own list of shelves judged the count. Said, not hidden.
  'shelves_from_device',
] as const);
export type ShelfCountSyncFlag = (typeof SHELF_COUNT_SYNC_FLAGS)[number];

/** Who relayed a count, and from which surface — recorded BESIDE the counter, never as the counter. */
export interface ShelfCountRelay {
  readonly relayedBy: string;
  readonly source: string;
  readonly storeId: string | null;
}

/** A count as the store keeps it: the engine's observation plus its own id (so a re-sync is one row), and, for a
 *  relayed count, what head office found about the counter and who carried it here. */
export interface StoredShelfCount extends ShelfCount {
  readonly countId?: string;
  readonly governanceFlags?: readonly ShelfCountSyncFlag[];
  readonly relayed?: ShelfCountRelay;
}

/** The permission a person must hold to have COUNTED a shelf in their own name. */
const RECORD_PERMISSION = 'shelf.count.record';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
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
  readonly counts: (tenantId: string, storeId: string) => Promise<readonly StoredShelfCount[]> | readonly StoredShelfCount[];
  /** Record one observation. Idempotent on the count id (a re-sync is one observation, not two). */
  readonly recordCount: (tenantId: string, countId: string, count: StoredShelfCount, key: string) => Promise<void> | void;
  readonly now: () => string;
  /** SP-8c-ii: the counter's own grants, to re-verify a RELAYED count's counter (§28). Absent → every relayed counter is flagged unknown. */
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** SP-8c-ii: the shelves HEAD OFFICE knows for a store (its published shelf map), so a relayed count is judged against
   *  head office's own list rather than the device's. `undefined` = no map published; the device's list is used and said. */
  readonly knownShelves?: (tenantId: string, storeId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The durable domain audit trail (M34), when composed. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

export function shelfCountRoutes(deps: ShelfCountDeps): readonly Route[] {
  const alreadyRecorded = async (tenantId: string, storeId: string, countId: string): Promise<StoredShelfCount | undefined> =>
    (await deps.counts(tenantId, storeId)).find((c) => c.countId === countId);

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
      // SP-8c-ii: a count RELAYED by the store box from the merchandising screen (`ShelfCounted`). Registered BEFORE the
      // direct `/:countId` route so `synced` is never read as a count id. Body: { countId (= path), storeId, locationId,
      // productId, countedMinor, countedBy, at, knownLocationIds?[], source? }. Idempotent per countId: the same count
      // again is 200, one observation.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/shelf-counts/:countId/synced',
      permission: 'shelf.count.sync', idempotent: true,
      handler: async (ctx) => {
        const countId = (ctx.params['countId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const deviceShelves = b['knownLocationIds'] === undefined ? [] : strArray(b['knownLocationIds']);
        if (countId === '' || b['countId'] !== countId || !isStr(b['storeId']) || !isStr(b['locationId']) || !isStr(b['productId'])
          || !isInt(b['countedMinor']) || !isStr(b['countedBy']) || !isIso(b['at']) || deviceShelves === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_shelf_count',
            whatHappened: 'This payload could not be read as a shelf count from the store — it needs the countId matching the path, storeId, locationId, productId, countedMinor (whole), who counted (countedBy) and when (at).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const storeId = b['storeId'];
        const prior = await alreadyRecorded(ctx.tenantId, storeId, countId);
        if (prior !== undefined) return { status: 200, body: { countId, recorded: true, alreadyRecorded: true, flags: prior.governanceFlags ?? [], count: prior } };

        // The JUDGEMENT runs here, against head office's own shelf map where it has one (P-02); the device's list only
        // when head office has none — and that is said on the record, never hidden.
        const flags: ShelfCountSyncFlag[] = [];
        const headOfficeShelves = await deps.knownShelves?.(ctx.tenantId, storeId);
        const knownLocationIds = headOfficeShelves ?? deviceShelves;
        if (headOfficeShelves === undefined) flags.push('shelves_from_device');
        const outcome = recordShelfCount({
          storeId, locationId: b['locationId'], productId: b['productId'], countedMinor: b['countedMinor'],
          countedBy: b['countedBy'], at: b['at'], knownLocationIds,
        });
        if (!outcome.ok) {
          // Theirs to fix at the store: 4xx, which the box dead-letters visibly for a person (hard rule #6). Nothing saved.
          throw apiError(REFUSAL_STATUS[outcome.refusal], {
            code: outcome.refusal,
            whatHappened: outcome.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'A person must look at this count at the store: correct it and count again. Nothing was saved.',
          });
        }
        // The COUNTER is re-verified from THEIR grants (§28) — flagged, never a silent trust of the relay's word.
        const permissions = await deps.permissionsOfUser?.(ctx.tenantId, b['countedBy']);
        if (permissions === undefined) flags.push('counter_unknown');
        else if (!permissions.includes(RECORD_PERMISSION)) flags.push('counter_lacks_authority');

        const relayed: ShelfCountRelay = { relayedBy: ctx.userId, source: isStr(b['source']) ? b['source'] : 'unknown', storeId };
        const stored: StoredShelfCount = { ...outcome.count, countId, governanceFlags: flags, relayed };
        await deps.recordCount(ctx.tenantId, countId, stored, ctx.idempotencyKey ?? countId);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: b['countedBy'], action: 'shelf_count.record', objectType: 'shelf_count', objectId: countId, at: b['at'],
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: null,
          after: { storeId, locationId: stored.locationId, productId: stored.productId, countedMinor: String(stored.countedMinor), relayedBy: ctx.userId, source: relayed.source, flags: flags.join(',') },
          correlationId: countId,
        });
        // 202: the shelf was counted at the store; this records it and what head office found about the counter.
        return { status: 202, body: { countId, recorded: true, alreadyRecorded: false, flags, count: stored } };
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
        await deps.recordCount(ctx.tenantId, countId, { ...outcome.count, countId }, ctx.idempotencyKey ?? countId);
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
