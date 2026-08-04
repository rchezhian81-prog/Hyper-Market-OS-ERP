// Shelf mapping, planograms and replenishment tasks (M04-FR-02/03 / D02).
//
// This module is quietly one of the highest-value things in the system, for a reason
// that is not obvious: **shelf location sequences the picker's route.**
//
// A picker filling an online order without a route walks the shop the way the order
// was typed — dairy, then rice, then back to dairy. With a route they walk it once.
// The roadmap's audit calls this out as a profitability lever, and it is: picking
// time is the largest controllable cost in online grocery, and it is decided here,
// by whether a shelf address exists and sorts sensibly.
//
// The address is ordered, not just labelled: aisle → rack → bay → shelf → position.
// Sorting by that tuple walks the shop in physical order, which is why every field is
// a number rather than a string like "A12" — "A10" sorts before "A9" as text, and a
// picker sent up and down an aisle twice never knows why.
//
// The second job is knowing when a shelf is EMPTY WHILE THE STOCKROOM IS FULL. That
// is the most expensive kind of out-of-stock: the sale is lost, the stock is paid
// for, and the system reports it as in stock. Capacity plus on-shelf quantity turns
// that into a task for a named role instead of a customer walking out.
//
// Pure and deterministic: no clock, no I/O.

/** Where something sits, in the order you walk past it. */
export interface ShelfLocation {
  readonly storeId: string;
  readonly locationId: string;
  readonly aisle: number;
  readonly rack: number;
  readonly bay: number;
  readonly shelf: number;
  /** Position along the shelf, left to right. */
  readonly position: number;
  /** Human label for the sign on the aisle, e.g. "A3". Display only. */
  readonly label?: string;
  /** Chilled, frozen, ambient — a picker collects chilled last (D05). */
  readonly zone?: 'ambient' | 'chilled' | 'frozen' | 'secure';
}

export interface ShelfAssignment {
  readonly storeId: string;
  readonly productId: string;
  readonly locationId: string;
  /** How many units fit on that shelf facing — drives replenishment quantity. */
  readonly capacityMinor: number;
  /** Exactly one primary per product per store; extras are secondary displays. */
  readonly primary: boolean;
}

export class ShelfMappingError extends Error {
  constructor(
    public readonly productId: string,
    why: string,
  ) {
    super(`Shelf mapping for "${productId}" is invalid: ${why}`);
    this.name = 'ShelfMappingError';
  }
}

/** Sort key that walks the shop once, in physical order. */
export function routeKey(location: ShelfLocation): readonly number[] {
  return [location.aisle, location.rack, location.bay, location.shelf, location.position];
}

function compareRoute(a: ShelfLocation, b: ShelfLocation): number {
  const left = routeKey(a);
  const right = routeKey(b);
  for (let i = 0; i < left.length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The store's shelf map: where things are, and how to walk it. */
export class ShelfMap {
  private readonly locations = new Map<string, ShelfLocation>();
  private readonly assignments: ShelfAssignment[] = [];

  constructor(
    public readonly storeId: string,
    locations: readonly ShelfLocation[] = [],
    assignments: readonly ShelfAssignment[] = [],
  ) {
    for (const location of locations) {
      if (location.storeId === storeId) this.locations.set(location.locationId, location);
    }
    for (const assignment of assignments) {
      if (assignment.storeId === storeId) this.assign(assignment);
    }
  }

  assign(assignment: ShelfAssignment): ShelfAssignment {
    if (!this.locations.has(assignment.locationId)) {
      throw new ShelfMappingError(
        assignment.productId,
        `location "${assignment.locationId}" does not exist in this store`,
      );
    }
    if (assignment.capacityMinor <= 0) {
      throw new ShelfMappingError(assignment.productId, 'a shelf facing with no capacity holds nothing');
    }
    if (assignment.primary) {
      const existing = this.assignments.find(
        (a) => a.productId === assignment.productId && a.primary && a.locationId !== assignment.locationId,
      );
      if (existing) {
        // Two primaries means the picker's route and replenishment disagree about
        // where the item lives, and both are then wrong.
        throw new ShelfMappingError(
          assignment.productId,
          `it already has a primary location (${existing.locationId}); an item lives in exactly one place`,
        );
      }
    }
    this.assignments.push(assignment);
    return assignment;
  }

  locationOf(productId: string): ShelfLocation | undefined {
    const primary = this.assignments.find((a) => a.productId === productId && a.primary);
    return primary === undefined ? undefined : this.locations.get(primary.locationId);
  }

  assignmentsFor(productId: string): readonly ShelfAssignment[] {
    return this.assignments.filter((a) => a.productId === productId);
  }

  capacityOf(productId: string): number {
    return this.assignments
      .filter((a) => a.productId === productId)
      .reduce((sum, a) => sum + a.capacityMinor, 0);
  }

  /**
   * Order a pick list so the store is walked once (M04-FR-02 acceptance). Items with
   * no shelf address go LAST and are marked — hiding them would send the picker back
   * across the shop, and dropping them would lose the line.
   */
  routeFor<T extends { readonly productId: string }>(
    lines: readonly T[],
  ): readonly (T & { readonly location?: ShelfLocation; readonly unmapped: boolean })[] {
    const decorated = lines.map((line) => {
      const location = this.locationOf(line.productId);
      return { ...line, ...(location !== undefined ? { location } : {}), unmapped: location === undefined };
    });
    return decorated.sort((a, b) => {
      if (a.unmapped !== b.unmapped) return a.unmapped ? 1 : -1;
      if (a.location === undefined || b.location === undefined) return 0;
      return compareRoute(a.location, b.location);
    });
  }
}

// --- planograms and replenishment tasks ---------------------------------------

export interface Planogram {
  readonly planogramId: string;
  readonly storeId: string;
  /** Versioned: a planogram change is a new version, never an edit (M04-FR-03). */
  readonly version: number;
  readonly effectiveFrom: string;
  readonly assignments: readonly ShelfAssignment[];
  readonly createdBy: string;
}

export type ComplianceFinding =
  | 'empty_shelf'
  | 'below_minimum'
  | 'not_on_plan'
  | 'missing_from_shelf'
  | 'over_capacity';

export interface ComplianceIssue {
  readonly productId: string;
  readonly locationId?: string;
  readonly finding: ComplianceFinding;
  readonly onShelfMinor: number;
  readonly capacityMinor: number;
  readonly detail: string;
}

export type TaskPriority = 'urgent' | 'normal' | 'low';

export interface ReplenishmentTask {
  readonly taskId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly locationId: string;
  /** How many to bring — capacity minus what is on the shelf. */
  readonly quantityMinor: number;
  /** Capped at what the stockroom actually has; never send someone for nothing. */
  readonly availableMinor: number;
  readonly priority: TaskPriority;
  /** The role that owns it — a task with no owner is not a task (M25). */
  readonly assignedRole: string;
  readonly detail: string;
  /** Where to go, so the task list can be walked in route order. */
  readonly location: ShelfLocation;
}

export interface ShelfState {
  readonly productId: string;
  readonly locationId: string;
  readonly onShelfMinor: number;
}

/**
 * Compare the shelf with the plan and raise the tasks. Compliance exceptions surface
 * for action, never silence (P-08).
 *
 * `refillAtBp` is the fill level below which a shelf is worth refilling, per tenant —
 * refilling at 90% wastes the staff's day, refilling at 0% means the customer already
 * found the gap.
 */
export function planogramCompliance(input: {
  readonly planogram: Planogram;
  readonly map: ShelfMap;
  readonly shelfState: readonly ShelfState[];
  /** Stockroom availability per product — the difference between a task and a wish. */
  readonly backstock: Readonly<Record<string, number>>;
  readonly assignedRole: string;
  readonly refillAtBp?: number;
}): {
  readonly issues: readonly ComplianceIssue[];
  readonly tasks: readonly ReplenishmentTask[];
  /** Share of planned facings that are compliant, in basis points — measurable. */
  readonly complianceBp: number;
} {
  const refillAt = input.refillAtBp ?? 5_000; // half empty, by default
  const issues: ComplianceIssue[] = [];
  const tasks: ReplenishmentTask[] = [];
  const stateFor = new Map(input.shelfState.map((s) => [`${s.productId}|${s.locationId}`, s]));
  let compliant = 0;

  for (const planned of input.planogram.assignments) {
    const key = `${planned.productId}|${planned.locationId}`;
    const state = stateFor.get(key);
    const onShelf = state?.onShelfMinor ?? 0;
    const capacity = planned.capacityMinor;
    const fillBp = capacity === 0 ? 0 : Math.round((onShelf * 10_000) / capacity);
    const location = input.map.locationOf(planned.productId);

    if (onShelf > capacity) {
      issues.push({
        productId: planned.productId,
        locationId: planned.locationId,
        finding: 'over_capacity',
        onShelfMinor: onShelf,
        capacityMinor: capacity,
        detail: 'more on the shelf than the facing holds — either the capacity is wrong or it is spilling into another facing',
      });
      continue;
    }

    if (fillBp >= refillAt) {
      compliant += 1;
      continue;
    }

    const available = input.backstock[planned.productId] ?? 0;
    const wanted = capacity - onShelf;
    const bring = Math.min(wanted, available);

    issues.push({
      productId: planned.productId,
      locationId: planned.locationId,
      finding: onShelf === 0 ? 'empty_shelf' : 'below_minimum',
      onShelfMinor: onShelf,
      capacityMinor: capacity,
      detail:
        onShelf === 0
          ? available > 0
            // The most expensive out-of-stock there is: the sale is lost, the stock
            // is already paid for, and the system reports it as in stock.
            ? `shelf is EMPTY and there are ${available} in the stockroom — the sale is being lost with the stock in the building`
            : 'shelf is empty and there is none in the stockroom either — this is a reorder, not a refill'
          : `${onShelf} of ${capacity} on the shelf`,
    });

    if (bring > 0 && location !== undefined) {
      tasks.push({
        taskId: `${input.planogram.planogramId}-${planned.productId}-${planned.locationId}`,
        storeId: input.planogram.storeId,
        productId: planned.productId,
        locationId: planned.locationId,
        quantityMinor: bring,
        availableMinor: available,
        priority: onShelf === 0 ? 'urgent' : fillBp < refillAt / 2 ? 'normal' : 'low',
        assignedRole: input.assignedRole,
        detail:
          bring < wanted
            ? `bring ${bring} (all the stockroom has; the facing holds ${wanted} more)`
            : `bring ${bring} to fill the facing`,
        location,
      });
    }
  }

  // Tasks are handed over in route order, so the shelf-filler walks the shop once too.
  const ordered = [...tasks].sort((a, b) => compareRoute(a.location, b.location));
  const planned = input.planogram.assignments.length;

  return {
    issues,
    tasks: ordered,
    complianceBp: planned === 0 ? 10_000 : Math.round((compliant * 10_000) / planned),
  };
}
