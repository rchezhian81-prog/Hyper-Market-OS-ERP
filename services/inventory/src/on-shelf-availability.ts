// D-14 (R3) — on-shelf availability / phantom stock on head office's API (OB-147 "A", signed sentence OB-188).
//
//   GET  /v1/inventory/on-shelf-availability                         the suspects now, each with its proposed count task
//   POST /v1/inventory/on-shelf-availability/minimum                 the owner sets the minimum days (append-only versions)
//   POST /v1/inventory/on-shelf-availability/count-tasks/:taskId     a person raises the proposed targeted count task
//   POST /v1/inventory/on-shelf-availability/count-tasks/:taskId/count  the count is recorded
//   GET  /v1/inventory/on-shelf-availability/count-tasks             the tasks and where each stands
//
// What this NEVER does: move stock. There is no movement port in these deps at all. A count that differs from the book
// figure (a count confirming zero is the phantom case) RAISES a pending stock-adjustment request on the EXISTING approval
// path (services/inventory/src/adjustment-requests.ts) — the same record a handheld raises — and only a second person's
// decision there posts the one compensating movement (hard rules #2, #5, §28). A count that matches closes the task with
// "stock confirmed" and changes nothing.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { findPhantomSuspects, osaWindowStart, InvalidOsaInputError, type OsaStockRow, type OsaSoldLine, type PhantomSuspect } from '../../../packages/replenishment/src/on-shelf-availability';
import { ADJUSTMENT_REASON_CODES, isAdjustmentReason } from '../../../packages/adjustment/src/adjustment';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import { assertLocationInScope, stockReadScope, type LocationBranches } from './location-scope';
import type { AdjustmentRequestRecord, AdjustmentRequestFlag } from './adjustment-requests';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

/** The default look-back, the same 28 days the sales-history read uses by default. */
export const OSA_DEFAULT_LOOKBACK_DAYS = 28;

export interface OsaMinimumSetting {
  readonly minimumDays: number;
  readonly setBy: string;
  readonly setAt: string;
  readonly version: number;
}

export type OsaTaskState = 'open' | 'stock_confirmed' | 'adjustment_requested';

export interface OsaCountTask {
  readonly taskId: string;
  readonly productId: string;
  readonly locationId: string;
  /** The suspect as judged when the task was raised (the evidence a person acted on). */
  readonly evidence: PhantomSuspect;
  readonly raisedBy: string;
  readonly raisedAt: string;
  readonly state: OsaTaskState;
  readonly countedMinor: number | null;
  /** The book figure at the moment the count was recorded. */
  readonly expectedMinor: number | null;
  readonly countedBy: string | null;
  readonly countedAt: string | null;
  /** The pending adjustment request raised on the existing approval path, when the count differed. */
  readonly adjustmentRequestId: string | null;
}

export interface OnShelfAvailabilityDeps {
  readonly now: () => string;
  readonly minimum: (tenantId: string) => Promise<OsaMinimumSetting | undefined> | OsaMinimumSetting | undefined;
  readonly recordMinimum: (tenantId: string, s: OsaMinimumSetting) => Promise<void> | void;
  /** On-hand per (product, place), from the M08 ledger. */
  readonly stock: (tenantId: string) => Promise<readonly OsaStockRow[]> | readonly OsaStockRow[];
  /**
   * OB-198: the first receipt (first delivery) of each product at each place, as the stock ledger holds it — the earliest
   * day stock came IN there (received from a supplier, or transferred in). The item's clock starts at the earliest of these
   * across the places of its store. Absent on a bare stub: every item is then judged from the window start, flagged.
   */
  readonly firstReceipts?: (tenantId: string) => Promise<readonly { readonly productId: string; readonly locationId: string; readonly firstReceiptDay: string }[]>;
  /** Sold lines with their stock place, for trading days in [fromDay, toDay]. */
  readonly soldLines: (tenantId: string, fromDay: string, toDay: string) => Promise<readonly OsaSoldLine[]> | readonly OsaSoldLine[];
  readonly tasks: (tenantId: string) => Promise<readonly OsaCountTask[]> | readonly OsaCountTask[];
  /** Append a state of a task (one event per state, never an edit). */
  readonly recordTask: (tenantId: string, t: OsaCountTask) => Promise<void> | void;
  /** The EXISTING approval path's read and write (adjustment-requests.ts). */
  readonly adjustmentRequest: (tenantId: string, requestId: string) => Promise<AdjustmentRequestRecord | undefined> | AdjustmentRequestRecord | undefined;
  readonly raiseAdjustmentRequest: (tenantId: string, r: AdjustmentRequestRecord) => Promise<void> | void;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly unitValueMinor: (tenantId: string, productId: string) => Promise<number | undefined> | number | undefined;
  readonly uomOf?: (tenantId: string, productId: string) => Promise<string | undefined> | string | undefined;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const bad = (code: string, whatHappened: string): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Correct the request and send it again. Nothing was changed.' });
};
/** The request id the count raises on the existing approval path — one per task, so a resend is the same request. */
export const osaAdjustmentRequestId = (taskId: string): string => `osa:${taskId}`;

async function judge(deps: OnShelfAvailabilityDeps, ctx: RequestContext, asOf: string, lookbackDays: number) {
  const min = await deps.minimum(ctx.tenantId);
  const from = osaWindowStart(asOf, lookbackDays);
  const scope = await stockReadScope(ctx, deps.locationBranches);
  const rows = (await deps.stock(ctx.tenantId)).filter((r) => scope.covers(r.locationId));
  // OB-198: each row's first receipt AT ITS STORE — the earliest receipt at any place of the same store (floor or back).
  const branchOf = deps.locationBranches === undefined ? (l: string) => l : await deps.locationBranches(ctx.tenantId);
  const firstAt = new Map<string, string>();
  for (const r of (await deps.firstReceipts?.(ctx.tenantId)) ?? []) {
    const k = `${r.productId}\u001f${branchOf(r.locationId)}`;
    const held = firstAt.get(k);
    if (held === undefined || r.firstReceiptDay < held) firstAt.set(k, r.firstReceiptDay);
  }
  const stock: OsaStockRow[] = rows.map((r) => ({ ...r, firstReceiptDay: firstAt.get(`${r.productId}\u001f${branchOf(r.locationId)}`) ?? null }));
  const sales = (await deps.soldLines(ctx.tenantId, from, asOf)).filter((s) => scope.covers(s.locationId));
  try {
    return { min, result: findPhantomSuspects({ asOf, lookbackDays, ownerMinimumDays: min?.minimumDays, stock, sales }) };
  } catch (e) {
    if (e instanceof InvalidOsaInputError) return bad('invalid_on_shelf_availability_query', e.message);
    throw e;
  }
}

function readWindow(ctx: RequestContext, now: string): { asOf: string; lookbackDays: number } {
  const asOf = ctx.query['asOf'] ?? shopDateIn(now); // R1c: the shop's today
  if (!DAY.test(asOf)) bad('invalid_on_shelf_availability_query', 'asOf must be a YYYY-MM-DD day.');
  const lb = ctx.query['lookbackDays'];
  const lookbackDays = lb === undefined ? OSA_DEFAULT_LOOKBACK_DAYS : Number(lb);
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 366) bad('invalid_on_shelf_availability_query', 'lookbackDays must be a whole number from 1 to 366.');
  return { asOf, lookbackDays };
}

const latestTasks = (tasks: readonly OsaCountTask[]): OsaCountTask[] => {
  const by = new Map<string, OsaCountTask>();
  for (const t of tasks) by.set(t.taskId, t);
  return [...by.values()];
};

export function onShelfAvailabilityRoutes(deps: OnShelfAvailabilityDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/on-shelf-availability',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const { asOf, lookbackDays } = readWindow(ctx, deps.now());
        const { min, result } = await judge(deps, ctx, asOf, lookbackDays);
        const open = latestTasks(await deps.tasks(ctx.tenantId)).filter((t) => t.state === 'open');
        const openFor = (p: string, l: string) => open.find((t) => t.productId === p && t.locationId === l);
        const suspects = result.state === 'judged' ? result.suspects.map((s) => {
          const t = openFor(s.productId, s.locationId);
          return {
            ...s,
            // The proposal: a targeted count of this one item at this one place. A person raises it; nothing else happens.
            proposedCountTask: t === undefined ? { taskId: `osa-${s.locationId}-${s.productId}-${asOf}`, raise: `/v1/inventory/on-shelf-availability/count-tasks/osa-${s.locationId}-${s.productId}-${asOf}` } : null,
            openCountTask: t === undefined ? null : { taskId: t.taskId, raisedBy: t.raisedBy, raisedAt: t.raisedAt },
          };
        }) : [];
        return {
          status: 200,
          body: {
            ...result, suspects,
            minimum: min === undefined ? null : { minimumDays: min.minimumDays, setBy: min.setBy, setAt: min.setAt },
            changesStock: false,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/on-shelf-availability/minimum',
      permission: 'inventory.osa.configure', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const d = b['minimumDays'];
        if (!Number.isSafeInteger(d) || (d as number) < 1 || (d as number) > 365) bad('not_readable_as_an_osa_minimum', 'minimumDays must be a whole number of days from 1 to 365 (OB-147: the owner\'s minimum).');
        const prior = await deps.minimum(ctx.tenantId);
        const at = deps.now();
        const s: OsaMinimumSetting = { minimumDays: d as number, setBy: ctx.userId, setAt: at, version: (prior?.version ?? 0) + 1 };
        await deps.recordMinimum(ctx.tenantId, s);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'osa.minimum.set', objectType: 'osa_minimum', objectId: 'minimum', at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: prior === undefined ? null : { minimumDays: String(prior.minimumDays) }, after: { minimumDays: String(s.minimumDays), version: String(s.version) },
          reason: 'OB-147 owner minimum', correlationId: `osa-minimum-v${s.version}`,
        });
        return { status: 200, body: { minimum: s } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/on-shelf-availability/count-tasks/:taskId',
      permission: 'inventory.osa.task.raise', idempotent: true,
      handler: async (ctx) => {
        const taskId = (ctx.params['taskId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (taskId === '' || !isStr(b['productId']) || !isStr(b['locationId'])) bad('not_readable_as_an_osa_count_task', 'A count task needs { productId, locationId } and the task id in the path.');
        const productId = (b['productId'] as string).trim(); const locationId = (b['locationId'] as string).trim();
        await assertLocationInScope(ctx, locationId, deps.locationBranches);
        const all = latestTasks(await deps.tasks(ctx.tenantId));
        const same = all.find((t) => t.taskId === taskId);
        if (same !== undefined) {
          if (same.productId !== productId || same.locationId !== locationId) {
            throw apiError(409, { code: 'osa_task_id_taken', whatHappened: `Task ${taskId} is already raised for ${same.productId} at ${same.locationId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new task id. Nothing was changed.' });
          }
          return { status: 200, body: { task: same, alreadyRaised: true } };
        }
        const other = all.find((t) => t.state === 'open' && t.productId === productId && t.locationId === locationId);
        if (other !== undefined) {
          throw apiError(409, { code: 'osa_count_already_open', whatHappened: `Count task ${other.taskId} is already open for ${productId} at ${locationId} (raised by ${other.raisedBy}).`, wasItSaved: 'not_saved', nextSafeAction: 'Record that count first. Nothing was changed.' });
        }
        const { asOf, lookbackDays } = readWindow(ctx, deps.now());
        const { result } = await judge(deps, ctx, asOf, lookbackDays);
        if (result.state === 'minimum_not_set') {
          throw apiError(409, { code: 'osa_minimum_not_set', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Ask the owner to set the minimum days first. Nothing was changed.' });
        }
        const suspect = result.suspects.find((s) => s.productId === productId && s.locationId === locationId);
        if (suspect === undefined) {
          throw apiError(409, { code: 'not_a_suspected_phantom', whatHappened: `${productId} at ${locationId} is not a suspected phantom on ${asOf}: it has no stock on the books, or it sold within its expected gap.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to count. Nothing was changed.' });
        }
        const at = deps.now();
        const task: OsaCountTask = {
          taskId, productId, locationId, evidence: suspect, raisedBy: ctx.userId, raisedAt: at, state: 'open',
          countedMinor: null, expectedMinor: null, countedBy: null, countedAt: null, adjustmentRequestId: null,
        };
        await deps.recordTask(ctx.tenantId, task);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'osa.count_task.raise', objectType: 'osa_count_task', objectId: taskId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { productId, locationId, onHandMinor: String(suspect.onHandMinor), daysWithoutSale: String(suspect.daysWithoutSale), thresholdDays: String(suspect.thresholdDays), basis: suspect.basis },
          reason: 'suspected phantom stock (D-14)', correlationId: taskId,
        });
        return { status: 201, body: { task } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/on-shelf-availability/count-tasks/:taskId/count',
      permission: 'inventory.osa.count.record', idempotent: true,
      handler: async (ctx) => {
        const taskId = (ctx.params['taskId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const counted = b['countedMinor'];
        if (!Number.isSafeInteger(counted) || (counted as number) < 0) bad('not_readable_as_an_osa_count', 'A count needs countedMinor: a whole number, 0 or more (what is on the shelf and in the back, in the product\'s own unit).');
        const task = latestTasks(await deps.tasks(ctx.tenantId)).find((t) => t.taskId === taskId);
        if (task === undefined) throw apiError(404, { code: 'osa_count_task_unknown', whatHappened: `No count task ${taskId} is on file.`, wasItSaved: 'not_saved', nextSafeAction: 'Raise the task from the on-shelf availability list first.' });
        await assertLocationInScope(ctx, task.locationId, deps.locationBranches);
        if (task.state !== 'open') {
          if (task.countedMinor === counted) return { status: 200, body: { task, alreadyCounted: true } };
          throw apiError(409, { code: 'osa_count_task_already_counted', whatHappened: `Task ${taskId} was already counted (${task.countedMinor ?? '?'}) by ${task.countedBy ?? '?'}.`, wasItSaved: 'not_saved', nextSafeAction: 'Raise a new task if the shelf still looks wrong. Nothing was changed.' });
        }
        const expected = (await deps.stock(ctx.tenantId)).find((r) => r.productId === task.productId && r.locationId === task.locationId)?.onHandMinor ?? 0;
        const at = deps.now();
        const delta = (counted as number) - expected;
        let adjustmentRequestId: string | null = null;
        if (delta !== 0) {
          // A difference goes to the EXISTING approval path, with a reason from the fixed adjustment list.
          if (!isAdjustmentReason(b['reasonCode'])) bad('osa_count_needs_a_reason', `The count (${String(counted)}) differs from the books (${expected}), so it needs a reasonCode from ${ADJUSTMENT_REASON_CODES.join(' / ')} for the adjustment request a second person decides.`);
          const requestId = osaAdjustmentRequestId(taskId);
          if (await deps.adjustmentRequest(ctx.tenantId, requestId) === undefined) {
            const flags: AdjustmentRequestFlag[] = [];
            const perms = await deps.permissionsOfUser(ctx.tenantId, ctx.userId);
            if (perms === undefined) flags.push('requester_unknown');
            else if (!perms.includes('inventory.movement.append')) flags.push('requester_lacks_authority');
            const unit = await deps.unitValueMinor(ctx.tenantId, task.productId);
            if (unit === undefined) flags.push('value_unknown');
            const uom = (await deps.uomOf?.(ctx.tenantId, task.productId)) ?? 'EA';
            const note = typeof b['note'] === 'string' && b['note'].trim() !== '' ? b['note'].trim() : null;
            const req: AdjustmentRequestRecord = {
              requestId, productId: task.productId, locationId: task.locationId, binId: null, deltaMinor: delta, uom,
              reasonCode: b['reasonCode'] as string,
              note: `on-shelf availability count ${taskId}: counted ${String(counted)}, books ${expected}${note === null ? '' : ` — ${note}`}`,
              valueMinor: valueAtUnitCost(Math.abs(delta), uom, unit ?? 0), currency: 'INR',
              requestedBy: ctx.userId, at, storeId: null, source: 'on-shelf-availability', relayedBy: ctx.userId, recordedAt: at,
              governanceFlags: flags, status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null, movementId: null,
            };
            await deps.raiseAdjustmentRequest(ctx.tenantId, req);
            await deps.recordAudit?.(ctx.tenantId, {
              actorId: ctx.userId, action: 'adjustment.request', objectType: 'stock_adjustment_request', objectId: requestId, at,
              origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
              after: { productId: task.productId, locationId: task.locationId, deltaMinor: String(delta), reasonCode: req.reasonCode, status: 'pending', source: 'on-shelf-availability' },
              reason: req.reasonCode, correlationId: taskId,
            });
          }
          adjustmentRequestId = requestId;
        }
        const done: OsaCountTask = {
          ...task, state: delta === 0 ? 'stock_confirmed' : 'adjustment_requested',
          countedMinor: counted as number, expectedMinor: expected, countedBy: ctx.userId, countedAt: at, adjustmentRequestId,
        };
        await deps.recordTask(ctx.tenantId, done);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'osa.count_task.count', objectType: 'osa_count_task', objectId: taskId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { state: 'open' },
          after: { state: done.state, countedMinor: String(counted), expectedMinor: String(expected), adjustmentRequestId: adjustmentRequestId ?? '' },
          reason: 'on-shelf availability count', correlationId: taskId,
        });
        return {
          status: 200,
          body: {
            task: done, stockChanged: false,
            ...(adjustmentRequestId === null ? {} : { adjustmentRequest: { requestId: adjustmentRequestId, status: 'pending', decide: `/v1/inventory/adjustment-requests/${adjustmentRequestId}/decide` } }),
          },
        };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/on-shelf-availability/count-tasks',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const tasks = latestTasks(await deps.tasks(ctx.tenantId)).filter((t) => scope.covers(t.locationId))
          .sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || (a.raisedAt < b.raisedAt ? 1 : -1));
        const withDecision = await Promise.all(tasks.map(async (t) => {
          if (t.adjustmentRequestId === null) return { ...t, adjustmentStatus: null };
          const r = await deps.adjustmentRequest(ctx.tenantId, t.adjustmentRequestId);
          return { ...t, adjustmentStatus: r?.status ?? 'not_known' };
        }));
        return { status: 200, body: { tasks: withDecision, open: tasks.filter((t) => t.state === 'open').length, asAt: deps.now() } };
      },
    },
  ];
}
