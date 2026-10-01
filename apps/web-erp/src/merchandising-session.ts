// The merchandising and space surface (docs/design/screens/product-merchandising.md · M04 · D02 · §28).
//
// Built on the owner's decision of 6 August 2026, after shelf addresses: the range review, the
// planogram and its refill tasks, and what the floor actually earns.
//
// The rules exist and are tested — `packages/merchandising` decides a range drop, checks assortment
// integrity, compares the shelf with the plan, raises refill tasks and ranks areas by margin per
// square foot — and **not one of them was called by anything outside its own unit test.** Fourth
// instance this session.
//
// ── The prerequisite that had to be built first ─────────────────────────────
//
// `planogramCompliance` needs how many of an item are on the shelf right now, and nothing in this
// system produced it. Its `state?.onShelfMinor ?? 0` therefore turned every uncounted facing into
// an **empty** one — which is the loudest finding it has, *the sale is being lost with the stock in
// the building*. On day one, before anybody had counted anything, that fired for every product in
// the shop and sent staff to full shelves. An alarm that goes off on everything is one people learn
// to ignore, and then it is worse than no alarm at all.
//
// So `packages/merchandising/src/shelf-count.ts` was built first, and this surface never asks for
// compliance without saying how much of the plan was actually observed.
//
// ── The three things this screen must not let happen ────────────────────────
//
// **1. A refill task on a shelf nobody looked at.** Covered above, and the reason the count carries
// a time: acting on Tuesday's reading on Friday wastes a walk, and enough wasted walks and the
// whole task list stops being believed.
//
// **2. Stock made invisible by a range drop.** Deleting an item from the range while stock sits on
// the shelf means it is not counted, not replenished, not sold, and eventually written off. A drop
// with stock on hand routes to **clearance** instead, and the engine already refuses to do
// otherwise — this surface must not offer a way round it.
//
// **3. A space figure quoted without its denominator.** "Sales per square foot" over an area whose
// square footage nobody recorded is a number that decides a layout, and it would be made up.

import type { CurrencyCode, Money } from '../../../packages/contracts/src/money';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { deviceItemState, deviceItemReason, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';
import {
  Assortment, checkAssortmentIntegrity, countingWorklist, dropFromRange, latestCounts,
  planogramCompliance, recordShelfCount, reviewDisplayContracts, spacePerformance,
  RangeDecisionError,
  type AssortmentEntry, type AssortmentIssue, type CountAge, type ComplianceIssue,
  type ContractStatus, type DisplayContract, type DropDecision, type DropReason,
  type Planogram, type ReplenishmentTask, type ShelfCount, type CountRefusal,
  type ShelfMap, type SpaceArea, type SpacePerformanceRow,
} from '../../../packages/merchandising/src/index';

/** What this surface can see about the shop, and what it honestly cannot. */
export interface MerchandisingPorts {
  /** The shop's shelf map — `null` when nobody has addressed the shelves yet. */
  shelfMap(): ShelfMap | null;
  /** The planogram in force, or `null` when this store has never published one. */
  planogram(): Planogram | null;
  /** Every shelf count ever taken. Append-only: a recount is a new observation. */
  shelfCounts(): readonly ShelfCount[];
  /** What the stockroom actually holds — the difference between a task and a wish. */
  backstock(): Readonly<Record<string, number>>;
  /** The range, as effective-dated decisions. */
  assortment(): Assortment;
  /** Products actually sold at this store in the period, for the integrity check. */
  soldProductIds(): readonly string[];
  /** On-hand per product, for the clearance check and for a safe range drop. */
  onHand(): Readonly<Record<string, number>>;
  /** The floor, in named areas with their square footage. */
  spaceAreas(): readonly SpaceArea[];
  /** Sales and margin per area. Absent for an area means it cannot be ranked, not that it earned nothing. */
  salesByArea(): Readonly<Record<string, Money>>;
  marginByArea(): Readonly<Record<string, Money>>;
  /** Supplier display-space contracts, and what finance says actually arrived. */
  displayContracts(): readonly DisplayContract[];
  fundingReceived(): Readonly<Record<string, Money>>;
  /** Contracts whose stand is still physically on the floor — the commercial finding. */
  stillOccupying(): readonly string[];
}

export interface MerchandisingConfig {
  readonly tenantId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly currency: CurrencyCode;
  /** Today, as YYYY-MM-DD, in the shop's own calendar. Injected — no clock in here. */
  readonly today: string;
  /** Now, as an ISO-8601 instant. Every count is judged against it. */
  readonly now: string;
  /** Fill level below which a facing is worth refilling, in bp. Per-tenant. */
  readonly refillAtBp: number;
  /** How old a count may be before acting on it wastes a walk. Per-tenant. */
  readonly countStaleAfterMinutes: number;
  /** Who picks up a refill task. A task with no owner is not a task (M25). */
  readonly refillRole: string;
}

/**
 * How the shelf compares with the plan — **and how much of the plan anybody actually looked at.**
 *
 * The second half is the point. A compliance percentage over a shop nobody has counted is a number
 * somebody would put on a wall, and it would mean nothing.
 */
export interface ShelfCheck {
  readonly issues: readonly ComplianceIssue[];
  readonly tasks: readonly ReplenishmentTask[];
  /** Over the facings actually counted recently enough to act on. */
  readonly complianceBp: number;
  /** Facings nobody has counted recently enough. Never folded into the figure above. */
  readonly notObserved: number;
  /** True only when every planned facing was observed — so the figure means what it says. */
  readonly wholePlanObserved: boolean;
  /** Total facings on the plan, so the two numbers above can be read against something. */
  readonly plannedFacings: number;
}

/** Nothing to check against, and why. `null` from `check()` is never silence. */
export type NoPlanReason = 'this_store_has_no_shelf_map' | 'this_store_has_never_published_a_planogram';

// ── SP-8c-ii (F08): the two saves this screen makes leave the page ─────────────────────────────────────────────
//
// Before SP-8c-ii a count saved here changed the page and nothing else, and a refill task was a line on a list.
// Now a count is written to the DURABLE device queue before the screen says "saved" — the SAME queue the Floor
// indents screen uses (`sre.indents.outbox.<storeId>`), handed to the store computer and relayed to head office,
// which re-verifies the counter and judges the shelf against its own map. And the refill tasks become ONE indent
// on that same queue, raised through the Indents screen's own session so the ask is the same record the floor
// would have raised by hand — one ask per set of shelves per trading day, so a second tap raises nothing new.

export const SHELF_COUNTED = 'ShelfCounted';
export const shelfCountKeyFor = (countId: string): string => `shelf-count:${countId}`;
/** The id prefix of an indent this screen raised from refill tasks — how its asks are told apart on the shared queue. */
export const REFILL_INDENT_PREFIX = 'ind-refill-';

export interface ShelfCountedPayload {
  readonly countId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly productId: string;
  readonly countedMinor: number;
  readonly countedBy: string;
  readonly at: string;
  /** The shelves this device was told the shop has — judged against head office's own map when it has one. */
  readonly knownLocationIds: readonly string[];
  readonly source: 'merchandising-screen';
}

/** One count this screen saved on its device, and where it has got to (the five shared device states). */
export interface SavedShelfCount {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly countedMinor: number;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

/** The lines of the one indent the refill tasks become. */
export interface RefillLine { readonly productId: string; readonly quantityMinor: string; readonly uom: string }
export interface RefillDraft { readonly indentId: string; readonly lines: readonly RefillLine[]; readonly reason: string }

/** One ask this screen raised from refill tasks, as the shared queue holds it. */
export interface SavedRefill {
  readonly indentId: string;
  readonly detail: string;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

export interface RefillView {
  readonly tasks: readonly ReplenishmentTask[];
  /** The ask the tasks would become — null when there is nothing to fill. */
  readonly draft: RefillDraft | null;
  /** This reader may raise it from here: a link to the indent chain, the right to ask, somebody named, something to fill. */
  readonly canRaise: boolean;
  /** Already saved on this device for the draft's id (so the button says so instead of asking again). */
  readonly alreadySaved: boolean;
  readonly saved: readonly SavedRefill[];
}

export type RefillRefusal = 'no_indent_link' | 'nothing_to_fill' | 'not_permitted' | 'nobody_named' | 'no_places' | 'no_lines' | 'bad_line' | 'duplicate_product';
export type RefillOutcome = { readonly ok: true; readonly indentId: string; readonly alreadySaved: boolean } | { readonly ok: false; readonly refusal: RefillRefusal };

/** The Floor indents screen's session, as this screen may reach it: raise ONE ask on the shared queue, and read back what it saved. */
export interface RefillIndentPort {
  raise(input: RefillDraft): { readonly ok: true; readonly indentId: string } | { readonly ok: false; readonly refusal: string };
  savedWork(): readonly { readonly kind: string; readonly id: string; readonly detail: string; readonly at: string; readonly state: DeviceItemState; readonly attempts: number; readonly reason?: string }[];
  canRequest(): boolean;
}

/** What the composition root gives this screen to leave the page with: the durable queue, the box's words on it, the indent chain. */
export interface MerchandisingDevice {
  readonly outbox?: SyncOutbox;
  /** The store computer's word per queue key — shared with every session over the same queue, so "posted" is never lost. */
  readonly boxWords?: Map<string, BoxItemStatus>;
  readonly indents?: RefillIndentPort;
  /** A fresh count id on this device. Injected for tests; the browser's random id otherwise. */
  readonly freshCountId?: () => string;
}

export type CountOutcome =
  | { readonly ok: true; readonly count: ShelfCount; readonly countId: string; readonly queued: boolean }
  | { readonly ok: false; readonly refusal: CountRefusal; readonly detail: string };

/** A small, stable hash so the same set of shelves asks ONCE a day: FNV-1a over the sorted facings, as 8 hex digits. */
export function refillIndentId(today: string, tasks: readonly ReplenishmentTask[]): string {
  const facings = tasks.map((t) => `${t.locationId}|${t.productId}`).sort().join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < facings.length; i += 1) {
    h ^= facings.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${REFILL_INDENT_PREFIX}${today}-${h.toString(16).padStart(8, '0')}`;
}

/** The one indent the refill tasks become: a line per product (the same product on two shelves asks once, for both). */
export function refillDraft(today: string, tasks: readonly ReplenishmentTask[]): RefillDraft | null {
  if (tasks.length === 0) return null;
  const byProduct = new Map<string, number>();
  const where: string[] = [];
  for (const t of tasks) {
    byProduct.set(t.productId, (byProduct.get(t.productId) ?? 0) + t.quantityMinor);
    const label = t.location.label ?? t.locationId;
    if (!where.includes(label)) where.push(label);
  }
  return {
    indentId: refillIndentId(today, tasks),
    lines: [...byProduct.entries()].filter(([, q]) => q > 0).map(([productId, q]) => ({ productId, quantityMinor: String(q), uom: '' })),
    reason: `shelf refill · ${where.join(', ')}`,
  };
}

let counter = 0;
const freshId = (prefix: string, now: string): string => {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  if (uuid !== undefined) return `${prefix}-${uuid.slice(0, 8)}`;
  counter += 1;
  return `${prefix}-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${counter}`;
};

export interface MerchandisingSession {
  /** Facings that most need counting, never-counted first. */
  countingList(): readonly CountAge[];

  /** Record what somebody counted at a facing. Blind — no expected quantity is accepted. Since SP-8c-ii the count is on the
   *  DURABLE device queue before this returns ok (`queued: true`); with no queue wired it changes only the page (`queued: false`). */
  count(input: {
    readonly locationId: string;
    readonly productId: string;
    readonly countedMinor: number;
  }): CountOutcome;

  /** Every count this screen saved on its device, newest first, with the five shared device states. */
  savedCounts(): readonly SavedShelfCount[];
  /** The queue keys the store computer has taken, to ask it where they have got to. */
  handedKeys(): readonly string[];
  /** Fold in the store computer's word — "posted" is only ever its say-so (P-08). */
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;

  /** The refill tasks and the ONE indent they would become, with what this device already asked. */
  refills(): RefillView;
  /** Raise that indent on the shared durable queue — refused here before anything is saved when this reader may not. */
  raiseRefill(): RefillOutcome;

  /** The shelf against the plan, or why it cannot be checked at all. */
  check(): ShelfCheck | { readonly why: NoPlanReason };

  /** When each facing was last looked at. */
  ages(): readonly CountAge[];

  /** What this store carries today. */
  range(): readonly string[];

  /**
   * Drop an item from the range.
   *
   * With stock on hand this becomes a **clearance** listing rather than a delisting, and the engine
   * refuses to do otherwise: removing a stocked item from the range makes its stock invisible.
   */
  drop(input: {
    readonly productId: string;
    readonly reason: DropReason;
    readonly reasonNote?: string;
    readonly replacedByProductId?: string;
  }): { readonly ok: true; readonly decision: DropDecision } | { readonly ok: false; readonly detail: string };

  /** Where the range and what the shop actually did disagree. */
  rangeIssues(): readonly AssortmentIssue[];

  /** What each area of the floor earns per square foot. */
  space(): readonly SpacePerformanceRow[];

  /** Supplier display contracts, worst finding first. */
  contracts(): readonly ContractStatus[];
}

export function createMerchandisingSession(
  config: MerchandisingConfig,
  ports: MerchandisingPorts,
  device: MerchandisingDevice = {},
): MerchandisingSession {
  /** The facings the plan actually names — the only ones worth counting. */
  const plannedFacings = (): readonly { productId: string; locationId: string }[] => {
    const planogram = ports.planogram();
    if (planogram === null) return [];
    return planogram.assignments.map((a) => ({ productId: a.productId, locationId: a.locationId }));
  };
  const knownLocationIds = (): readonly string[] => ports.shelfMap()?.allLocations().map((l) => l.locationId) ?? [];
  const boxWord = device.boxWords ?? new Map<string, BoxItemStatus>();
  const nobodyNamed = config.userId.trim() === '';

  const tasksNow = (): readonly ReplenishmentTask[] => {
    const c = session.check();
    return 'why' in c ? [] : c.tasks;
  };
  const savedRefills = (): readonly SavedRefill[] => (device.indents?.savedWork() ?? [])
    .filter((w) => w.kind === 'request' && w.id.startsWith(REFILL_INDENT_PREFIX))
    .map((w) => ({ indentId: w.id, detail: w.detail, at: w.at, state: w.state, attempts: w.attempts, ...(w.reason === undefined ? {} : { reason: w.reason }) }));

  const session: MerchandisingSession = {
    countingList: () => countingWorklist({
      planned: plannedFacings(),
      counts: ports.shelfCounts(),
      asOf: config.now,
      staleAfterMinutes: config.countStaleAfterMinutes,
    }),

    ages: () => latestCounts(ports.shelfCounts(), config.now, config.countStaleAfterMinutes).ages,

    count: (input) => {
      const known = knownLocationIds();
      const outcome = recordShelfCount({
        storeId: config.storeId,
        locationId: input.locationId,
        productId: input.productId,
        countedMinor: input.countedMinor,
        // Nobody named → the engine's own refusal (`nobody_signed_this_count`): a count nobody put their name to is
        // one nobody can ask about later, and head office would only flag it as unknown.
        countedBy: config.userId,
        at: config.now,
        // A count against a shelf this shop does not have is a count nobody can act on. With no map
        // at all every shelf is unknown, which refuses every count — correct, and the screen says
        // the map is missing rather than letting somebody count into nowhere for an hour.
        knownLocationIds: known,
      });
      if (!outcome.ok) return outcome;
      const countId = device.freshCountId?.() ?? freshId('sc', config.now);
      if (device.outbox === undefined) return { ok: true, count: outcome.count, countId, queued: false };
      // QUEUED before it is called saved (SP-8c-ii): the outbox is the durable device queue the composition root opened —
      // enqueue writes it to the device before returning; the shared device → box → cloud path carries it from there.
      const payload: ShelfCountedPayload = {
        countId, storeId: config.storeId, locationId: outcome.count.locationId, productId: outcome.count.productId,
        countedMinor: outcome.count.countedMinor, countedBy: outcome.count.countedBy, at: outcome.count.at, knownLocationIds: known, source: 'merchandising-screen',
      };
      const key = shelfCountKeyFor(countId);
      device.outbox.enqueue(makeEvent({ id: key, type: SHELF_COUNTED, occurredAt: outcome.count.at, idempotencyKey: key, source: 'web-erp/merchandising', payload }));
      return { ok: true, count: outcome.count, countId, queued: true };
    },

    savedCounts: () => (device.outbox?.all() ?? [])
      .filter((item) => item.event.type === SHELF_COUNTED)
      .map((item): SavedShelfCount => {
        const p = item.event.payload as ShelfCountedPayload;
        const box = boxWord.get(item.key);
        const reason = deviceItemReason(item, box);
        return { countId: p.countId, productId: p.productId, locationId: p.locationId, countedMinor: p.countedMinor, at: p.at, state: deviceItemState(item, box), attempts: item.attempts, ...(reason === undefined ? {} : { reason }) };
      })
      .reverse(),

    handedKeys: () => (device.outbox?.all() ?? []).filter((item) => item.event.type === SHELF_COUNTED && item.state === 'acknowledged').map((item) => item.key),

    noteBoxStatus: (statuses) => { for (const st of statuses) boxWord.set(st.key, st); },

    refills: () => {
      const tasks = tasksNow();
      const draft = refillDraft(config.today, tasks);
      const saved = savedRefills();
      const alreadySaved = draft !== null && saved.some((r) => r.indentId === draft.indentId);
      const canRaise = draft !== null && device.indents !== undefined && device.indents.canRequest() && !nobodyNamed;
      return { tasks, draft, canRaise, alreadySaved, saved };
    },

    raiseRefill: () => {
      if (device.indents === undefined) return { ok: false, refusal: 'no_indent_link' };
      if (nobodyNamed) return { ok: false, refusal: 'nobody_named' };
      if (!device.indents.canRequest()) return { ok: false, refusal: 'not_permitted' };
      const draft = refillDraft(config.today, tasksNow());
      if (draft === null) return { ok: false, refusal: 'nothing_to_fill' };
      // The same set of shelves asked once today: the ask is on the queue under the same id, so nothing is raised twice —
      // the Indents session's queue would collapse it anyway (§31.1); saying so is the honest answer for the button.
      if (savedRefills().some((r) => r.indentId === draft.indentId)) return { ok: true, indentId: draft.indentId, alreadySaved: true };
      const raised = device.indents.raise(draft);
      if (!raised.ok) return { ok: false, refusal: (REFILL_REFUSALS.has(raised.refusal) ? raised.refusal : 'not_permitted') as RefillRefusal };
      return { ok: true, indentId: raised.indentId, alreadySaved: false };
    },

    check: () => {
      const map = ports.shelfMap();
      if (map === null) return { why: 'this_store_has_no_shelf_map' };
      const planogram = ports.planogram();
      if (planogram === null) return { why: 'this_store_has_never_published_a_planogram' };

      const { latest } = latestCounts(ports.shelfCounts(), config.now, config.countStaleAfterMinutes);
      const result = planogramCompliance({
        planogram,
        map,
        shelfState: latest.map((c) => ({
          productId: c.productId,
          locationId: c.locationId,
          onShelfMinor: c.countedMinor,
          observedAt: c.at,
        })),
        backstock: ports.backstock(),
        assignedRole: config.refillRole,
        refillAtBp: config.refillAtBp,
        asOf: config.now,
        staleAfterMinutes: config.countStaleAfterMinutes,
      });

      return {
        issues: result.issues,
        tasks: result.tasks,
        complianceBp: result.complianceBp,
        notObserved: result.notObserved,
        wholePlanObserved: result.wholePlanObserved,
        plannedFacings: planogram.assignments.length,
      };
    },

    range: () => ports.assortment().listedOn(config.today),

    drop: (input) => {
      try {
        return {
          ok: true,
          decision: dropFromRange({
            storeId: config.storeId,
            productId: input.productId,
            // The real figure, so a stocked item cannot be delisted by a screen that guessed zero.
            // Zero here is the dangerous default: it turns "route to clearance" into "delete", and
            // the stock on the shelf becomes invisible — uncounted, unreplenished, written off.
            onHandMinor: ports.onHand()[input.productId] ?? 0,
            reason: input.reason,
            ...(input.reasonNote === undefined ? {} : { reasonNote: input.reasonNote }),
            ...(input.replacedByProductId === undefined ? {} : { replacedByProductId: input.replacedByProductId }),
            decidedBy: config.userId,
            effectiveFrom: config.today,
          }),
        };
      } catch (e) {
        if (e instanceof RangeDecisionError) return { ok: false, detail: e.message };
        throw e;
      }
    },

    rangeIssues: () => checkAssortmentIntegrity({
      assortment: ports.assortment(),
      onDate: config.today,
      soldProductIds: ports.soldProductIds(),
      onHand: ports.onHand(),
    }),

    space: () => spacePerformance({
      areas: ports.spaceAreas(),
      sales: ports.salesByArea(),
      grossMargin: ports.marginByArea(),
      currency: config.currency,
    }),

    contracts: () => reviewDisplayContracts({
      contracts: ports.displayContracts(),
      onDate: config.today,
      received: ports.fundingReceived(),
      stillOccupying: ports.stillOccupying(),
      currency: config.currency,
    }),
  };
  return session;
}

const REFILL_REFUSALS: ReadonlySet<string> = new Set<RefillRefusal>(['no_indent_link', 'nothing_to_fill', 'not_permitted', 'nobody_named', 'no_places', 'no_lines', 'bad_line', 'duplicate_product']);

/** Re-exported so a view can render an entry without importing the package directly. */
export type { AssortmentEntry, DropReason };
