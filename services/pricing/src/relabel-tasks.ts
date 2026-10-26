// API-02 Shelf RELABEL tasks when a price changes (D11-FR-03 "task board, replenishment, price-change and handover"; §27
// "price tasks"; audit-4: "on a price activation, raise an assigned relabel task per branch and shelf, closed with
// evidence; tie it into the D-7 price-integrity check").
//
// When a price is set for a store — a price change, or a price-list entry from the day it takes effect — the shelf edge
// label is wrong until somebody changes it. Head office raises one task per store and per shelf place the product has on
// the store's plan (and one "find the label" task when the product has no shelf place on the plan, so it is never silently
// skipped). A task is closed by a person at that store who changed the label, with a photo, saying the price the label now
// shows; that is ALSO recorded as a shelf price-integrity observation (D-7), so the ageing report clears on its own. A
// label showing another price is refused — the task stays open.
//
// OB-358 (owner, 24 Oct 2026, in writing): each task GOES TO the floor champion of the department that owns the product at
// that store (the category the product sits in, as the department's categories say); if the department has no champion
// named — or none owns the product there, or the champion has left — it goes to the STORE MANAGER of that store. The
// assignment is decided when the task is raised and kept on it (a fact, never re-guessed); the list says who it is for,
// and whether it is the reader's. A store manager role nobody holds is said ("nobody holds it — not set"), never hidden.
// Append-only: raising is idempotent per product, store, shelf place, price and day.
//
// OB-370 (owner, 24–25 Oct 2026, in writing): a task may be CLOSED only by the person it is assigned to (the floor
// champion it was given) or by a STORE MANAGER of that store — and it still needs the photo and the price the label shows.
// Anyone else is refused by name and the task stays open; the list says, per task, whether the reader may close it.

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError, notFound, scopeOf } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

/** OB-358: who a relabel task goes to, decided when it is raised. */
export type RelabelAssignee =
  | { readonly to: 'floor_champion'; readonly departmentId: string; readonly employeeId: string }
  | { readonly to: 'store_manager'; readonly departmentId: string | null; readonly because: 'no_department_owns_it' | 'no_champion_named' | 'champion_left' };

export interface RelabelTask {
  readonly taskId: string;
  readonly branchId: string;
  readonly productId: string;
  /** The shelf place on the store's plan; null when the product has no place on the plan. */
  readonly locationId: string | null;
  readonly priceMinor: number;
  /** When the new price takes effect — the label should show it from then. */
  readonly dueAt: string;
  readonly because: 'price_change' | 'price_list_entry';
  readonly sourceRef: string;
  readonly raisedAt: string;
  /** OB-358: who it goes to. Absent on a task raised before the decision (shown "not assigned"). */
  readonly assignee?: RelabelAssignee;
}

export interface RelabelDone {
  readonly taskId: string;
  readonly doneBy: string;
  readonly doneAt: string;
  readonly evidenceRef: string;
  readonly shelfPriceMinor: number;
}

export interface RelabelTaskDeps {
  readonly tasks: (tenantId: string) => Promise<readonly RelabelTask[]>;
  readonly done: (tenantId: string) => Promise<readonly RelabelDone[]>;
  readonly recordTask: (tenantId: string, t: RelabelTask) => Promise<void>;
  readonly recordDone: (tenantId: string, d: RelabelDone) => Promise<void>;
  /** The shelf places a product has on the store's plan now. */
  readonly shelfPlaces: (tenantId: string, storeId: string, productId: string) => Promise<readonly string[]>;
  /** OB-358: who a product's relabel task at a store goes to — its department's floor champion, else the store manager. */
  readonly assigneeFor?: (tenantId: string, storeId: string, productId: string) => Promise<RelabelAssignee>;
  /** OB-358: who holds the store manager role at a store now (a task for "the store manager" is theirs). */
  readonly storeManagersAt?: (tenantId: string, storeId: string) => Promise<readonly string[]>;
  /** The price-integrity observation route's own handler (D-7), run as the person who changed the label. */
  readonly recordObservationAs: (ctx: RequestContext) => Promise<HandlerResult>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** The tasks a new price raises at these stores (one per shelf place, or one "not on the plan"). */
export async function relabelTasksFor(deps: Pick<RelabelTaskDeps, 'shelfPlaces' | 'now' | 'assigneeFor'>, tenantId: string, input: {
  readonly productId: string; readonly priceMinor: number; readonly storeIds: readonly string[]; readonly dueAt: string;
  readonly because: RelabelTask['because']; readonly sourceRef: string;
}): Promise<readonly RelabelTask[]> {
  const out: RelabelTask[] = [];
  const day = shopDateIn(input.dueAt); // R1c: the shop's day
  for (const branchId of [...new Set(input.storeIds)].sort()) {
    const places = [...new Set(await deps.shelfPlaces(tenantId, branchId, input.productId))].sort();
    // OB-358: one answer per store for the product — its department's floor champion, else the store manager.
    const assignee = deps.assigneeFor === undefined ? undefined : await deps.assigneeFor(tenantId, branchId, input.productId);
    for (const locationId of places.length === 0 ? [null] : places) {
      out.push({
        taskId: `relabel-${branchId}-${input.productId}-${locationId ?? 'not-on-plan'}-${input.priceMinor}-${day}`,
        branchId, productId: input.productId, locationId, priceMinor: input.priceMinor, dueAt: input.dueAt,
        because: input.because, sourceRef: input.sourceRef, raisedAt: deps.now(),
        ...(assignee === undefined ? {} : { assignee }),
      });
    }
  }
  return out;
}

/** Raise them (idempotent: a task id already raised is not raised again). Returns those newly raised. */
export async function raiseRelabelTasks(deps: RelabelTaskDeps, tenantId: string, tasks: readonly RelabelTask[]): Promise<readonly RelabelTask[]> {
  const held = new Set((await deps.tasks(tenantId)).map((t) => t.taskId));
  const fresh = tasks.filter((t) => !held.has(t.taskId));
  for (const t of fresh) await deps.recordTask(tenantId, t);
  return fresh;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function relabelTaskRoutes(deps: RelabelTaskDeps): readonly Route[] {
  /** The tasks a reader sees, each saying who it is for (OB-358); `mineOnly` keeps the reader's own. */
  const list = async (ctx: RequestContext, mineOnly: boolean): Promise<HandlerResult> => {
    const scope = scopeOf(ctx);
    const branchId = isStr(ctx.query['branchId']) ? ctx.query['branchId'].trim() : undefined;
    const [tasks, done] = await Promise.all([deps.tasks(ctx.tenantId), deps.done(ctx.tenantId)]);
    const doneOf = new Map(done.map((d) => [d.taskId, d] as const));
    const now = deps.now();
    const managers = new Map<string, readonly string[]>();
    const managersAt = async (b: string): Promise<readonly string[] | null> => {
      if (deps.storeManagersAt === undefined) return null;
      if (!managers.has(b)) managers.set(b, [...await deps.storeManagersAt(ctx.tenantId, b)].sort());
      return managers.get(b)!;
    };
    const seen = tasks.filter((t) => (scope === 'all' || scope.includes(t.branchId)) && (branchId === undefined || t.branchId === branchId));
    const rows = [];
    for (const t of seen) {
      const storeManagers = t.assignee?.to === 'store_manager' ? await managersAt(t.branchId) : null;
      const assignedToMe = t.assignee === undefined ? false
        : t.assignee.to === 'floor_champion' ? t.assignee.employeeId === ctx.userId : (storeManagers ?? []).includes(ctx.userId);
      if (mineOnly && !assignedToMe) continue;
      // OB-370: the assignee, or a store manager of this store, may close it.
      const managersHere = await managersAt(t.branchId);
      const mayClose = (t.assignee?.to === 'floor_champion' && t.assignee.employeeId === ctx.userId) || (managersHere ?? []).includes(ctx.userId);
      rows.push({
        ...t, assignee: t.assignee ?? null, assignedToMe, mayClose,
        ...(storeManagers === null ? {} : { storeManagers }),
        done: doneOf.get(t.taskId) ?? null, dueNow: Date.parse(t.dueAt) <= Date.parse(now),
      });
    }
    rows.sort((a, b) => Number(a.done !== null) - Number(b.done !== null) || a.dueAt.localeCompare(b.dueAt) || a.taskId.localeCompare(b.taskId));
    return { status: 200, body: { tasks: rows, open: rows.filter((r) => r.done === null).length, asAt: now } };
  };
  return [
    {
      // The store's relabel tasks: open first (oldest due first), then the ones done. ?branchId= narrows; ?mine=1 keeps
      // only the tasks that go to the reader (OB-358: their department's champion, or the store manager they are).
      api: 'API-02', method: 'GET', path: '/v1/pricing/relabel-tasks',
      permission: 'workforce.task.read',
      handler: (ctx) => list(ctx, ctx.query['mine'] === '1' || ctx.query['mine'] === 'true'),
    },
    {
      // OB-358: MY relabel tasks — the ones that go to me as my department's floor champion, or as the store manager. Read
      // with the permission a person completes their own tasks with (as the My tasks page reads its tasks).
      api: 'API-02', method: 'GET', path: '/v1/pricing/relabel-tasks/mine',
      permission: 'workforce.task.complete.own',
      handler: (ctx) => list(ctx, true),
    },
    {
      // Done: the label changed. Body: { evidenceRef (the photo), shelfPriceMinor (what the label now shows) }. OB-370: by the
      // assignee or a store manager of the task's store only.
      api: 'API-02', method: 'POST', path: '/v1/pricing/relabel-tasks/:taskId/done',
      permission: 'workforce.task.complete.own', idempotent: true,
      handler: async (ctx) => {
        const taskId = (ctx.params['taskId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const task = (await deps.tasks(ctx.tenantId)).find((t) => t.taskId === taskId);
        if (task === undefined) throw notFound(`relabel task ${taskId}`);
        const scope = scopeOf(ctx);
        if (scope !== 'all' && !scope.includes(task.branchId)) {
          throw apiError(403, { code: 'outside_your_branches', whatHappened: `This task is at ${task.branchId}, which your sign-in does not reach.`, wasItSaved: 'not_saved', nextSafeAction: 'A person at that store closes it. Nothing was changed.' });
        }
        // OB-370: only the person it was given to, or a store manager of this store, closes it.
        const managers = deps.storeManagersAt === undefined ? [] : await deps.storeManagersAt(ctx.tenantId, task.branchId);
        const isAssignee = task.assignee?.to === 'floor_champion' && task.assignee.employeeId === ctx.userId;
        if (!isAssignee && !managers.includes(ctx.userId)) {
          throw apiError(403, {
            code: 'not_your_relabel_task',
            whatHappened: task.assignee?.to === 'floor_champion'
              ? `This label task is for ${task.assignee.employeeId} (the floor champion of ${task.assignee.departmentId}) or a store manager of ${task.branchId}; you are neither (OB-370).`
              : `This label task is for a store manager of ${task.branchId}; you are not one (OB-370).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Tell the person it is for, or the store manager. The task stays open.',
          });
        }
        if (!isStr(b['evidenceRef']) || !Number.isInteger(b['shelfPriceMinor']) || (b['shelfPriceMinor'] as number) < 0) {
          throw apiError(400, { code: 'not_readable_as_relabel_done', whatHappened: 'Closing a relabel task needs { evidenceRef } — the photo of the new label — and { shelfPriceMinor }, the price the label now shows.', wasItSaved: 'not_saved', nextSafeAction: 'Send both. Nothing was changed.' });
        }
        const prior = (await deps.done(ctx.tenantId)).find((d) => d.taskId === taskId);
        if (prior !== undefined) return { status: 200, body: { done: prior, alreadyDone: true } };
        if (b['shelfPriceMinor'] !== task.priceMinor) {
          throw apiError(422, { code: 'label_shows_another_price', whatHappened: `The label shows ₹${((b['shelfPriceMinor'] as number) / 100).toFixed(2)}; the price is ₹${(task.priceMinor / 100).toFixed(2)}.`, wasItSaved: 'not_saved', nextSafeAction: 'Print the label at the new price and put it up, then close the task. It stays open.' });
        }
        const d: RelabelDone = { taskId, doneBy: ctx.userId, doneAt: deps.now(), evidenceRef: (b['evidenceRef'] as string).trim(), shelfPriceMinor: b['shelfPriceMinor'] as number };
        // D-7: the person saw the shelf show the price — that is a shelf observation on the price-integrity register.
        await deps.recordObservationAs({
          ...ctx, params: { observationId: `relabel-${taskId}` },
          body: { branchId: task.branchId, productId: task.productId, surface: 'shelf_label', priceMinor: d.shelfPriceMinor, observedAt: d.doneAt, ...(task.locationId === null ? {} : { shelfAddress: task.locationId }) },
        });
        await deps.recordDone(ctx.tenantId, d);
        await deps.recordAudit?.(ctx.tenantId, { actorId: ctx.userId, action: 'pricing.relabel.done', objectType: 'relabel_task', objectId: taskId, at: d.doneAt, origin: { tenantId: ctx.tenantId, branchId: task.branchId }, before: null, after: { productId: task.productId, locationId: task.locationId ?? '', priceMinor: String(task.priceMinor), evidenceRef: d.evidenceRef }, correlationId: taskId });
        return { status: 201, body: { done: d } };
      },
    },
  ];
}
