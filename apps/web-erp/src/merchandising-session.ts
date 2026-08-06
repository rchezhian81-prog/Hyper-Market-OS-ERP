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
import {
  Assortment, checkAssortmentIntegrity, countingWorklist, dropFromRange, latestCounts,
  planogramCompliance, recordShelfCount, reviewDisplayContracts, spacePerformance,
  RangeDecisionError,
  type AssortmentEntry, type AssortmentIssue, type CountAge, type ComplianceIssue,
  type ContractStatus, type DisplayContract, type DropDecision, type DropReason,
  type Planogram, type ReplenishmentTask, type ShelfCount, type ShelfCountOutcome,
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

export interface MerchandisingSession {
  /** Facings that most need counting, never-counted first. */
  countingList(): readonly CountAge[];

  /** Record what somebody counted at a facing. Blind — no expected quantity is accepted. */
  count(input: {
    readonly locationId: string;
    readonly productId: string;
    readonly countedMinor: number;
  }): ShelfCountOutcome;

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
): MerchandisingSession {
  /** The facings the plan actually names — the only ones worth counting. */
  const plannedFacings = (): readonly { productId: string; locationId: string }[] => {
    const planogram = ports.planogram();
    if (planogram === null) return [];
    return planogram.assignments.map((a) => ({ productId: a.productId, locationId: a.locationId }));
  };

  return {
    countingList: () => countingWorklist({
      planned: plannedFacings(),
      counts: ports.shelfCounts(),
      asOf: config.now,
      staleAfterMinutes: config.countStaleAfterMinutes,
    }),

    ages: () => latestCounts(ports.shelfCounts(), config.now, config.countStaleAfterMinutes).ages,

    count: (input) => recordShelfCount({
      storeId: config.storeId,
      locationId: input.locationId,
      productId: input.productId,
      countedMinor: input.countedMinor,
      countedBy: config.userId,
      at: config.now,
      // A count against a shelf this shop does not have is a count nobody can act on. With no map
      // at all every shelf is unknown, which refuses every count — correct, and the screen says
      // the map is missing rather than letting somebody count into nowhere for an hour.
      knownLocationIds: ports.shelfMap()?.allLocations().map((l) => l.locationId) ?? [],
    }),

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
}

/** Re-exported so a view can render an entry without importing the package directly. */
export type { AssortmentEntry, DropReason };
