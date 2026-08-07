// Suspend and recall a bill (M12-FR-02 / D04 / §31.1).
//
// A cashier suspends a basket a dozen times a day: the customer forgot the milk, the
// card is in the car, the queue behind is growing. It looks trivial. It is one of the
// commonest ways a till loses money, for four separate reasons — and each one is a
// deliberate decision here rather than an accident of implementation.
//
//   • **IT MUST SURVIVE THE LANE RESTART.** A basket held in the running program is
//     gone the moment the till reboots, the browser reloads or the power blinks. The
//     customer comes back to a lane that has forgotten them, and the cashier re-scans
//     forty items from memory. So a suspension is **serialised state**, not a live
//     object — that is the whole requirement, and it is the acceptance test.
//
//   • **RESUMING IS A CLAIM, NOT A READ.** If two lanes can recall the same bill, the
//     customer is billed twice and both cashiers are certain they did it right. A
//     resume therefore transitions the bill once and refuses the second attempt,
//     naming the lane that already has it.
//
//   • **A PARKED BILL HOLDS NO STOCK.** Reserving stock for a suspended basket feels
//     careful and is the opposite: a basket abandoned at 11am starves the shelf all
//     day, and the shop stops selling something it physically has. Nothing here
//     touches the ledger — suspension is a note about intent, not a movement.
//
//   • **A PARKED BILL AGES.** A price change, a promotion ending, or an MRP update
//     between park and resume means the quoted total is now wrong — in one direction
//     or the other. Beyond the tenant's window the lane is told to **re-price**, not
//     quietly charged yesterday's money.
//
// And abandonment is **never a delete** (hard rule #6). A bill nobody came back for is
// evidence: a cashier who parks and abandons baskets repeatedly is a loss-prevention
// pattern (M15-FR-01), and a deleted record has no pattern to find.
//
// Synchronous and pure: the store is injected and local, so suspending and recalling
// work with the network cable out (hard rule #1). No clock — the time is passed in.

/** One basket line, flattened to primitives so it can be written to disk and read back. */
export interface SuspendedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  /** Integer minor units — never a float, and never a live Money object (§29.1). */
  readonly unitPriceMinor: number;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly taxBps: number;
  readonly group?: string;
  readonly voided: boolean;
  readonly voidReason?: string;
}

export type SuspendedState = 'suspended' | 'resumed' | 'abandoned';

export interface SuspendedBill {
  readonly billId: string;
  readonly tenantId: string;
  readonly storeId: string;
  /** The lane that suspended it — cross-lane recall is a policy decision, not a default. */
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly currency: string;
  readonly lines: readonly SuspendedLine[];
  readonly suspendedAt: string;
  readonly reason?: string;
  /** Customer reference where one was captured — never a name or a phone number (PRV). */
  readonly customerRef?: string;
  readonly state: SuspendedState;
  readonly resumedAt?: string;
  readonly resumedBy?: string;
  readonly resumedOnLaneId?: string;
  readonly abandonedAt?: string;
  readonly abandonedBy?: string;
  readonly abandonReason?: string;
}

/**
 * Durable local storage for suspended bills. Synchronous by design — a lane must be
 * able to suspend and recall with no network (hard rule #1) — and durable by contract:
 * an implementation that only holds bills in memory fails the requirement that a bill
 * survive a lane restart.
 */
export interface SuspendedBillStore {
  put(bill: SuspendedBill): void;
  get(billId: string): SuspendedBill | undefined;
  list(): readonly SuspendedBill[];
}

/**
 * Reference implementation over a plain string map — the shape a real edge store
 * (embedded SQL, IndexedDB, a file) implements. `serialise`/`hydrate` are the whole
 * point: what goes in is text, so what comes back after a restart is the same bill.
 */
export class SerialisedSuspendedBillStore implements SuspendedBillStore {
  constructor(private readonly rows = new Map<string, string>()) {}

  put(bill: SuspendedBill): void {
    this.rows.set(bill.billId, JSON.stringify(bill));
  }

  get(billId: string): SuspendedBill | undefined {
    const raw = this.rows.get(billId);
    return raw === undefined ? undefined : (JSON.parse(raw) as SuspendedBill);
  }

  list(): readonly SuspendedBill[] {
    return [...this.rows.values()].map((raw) => JSON.parse(raw) as SuspendedBill);
  }

  /** Everything on disk — what a restart would read back. */
  serialise(): readonly [string, string][] {
    return [...this.rows.entries()];
  }

  /** Rebuild a store from what was on disk. This is the lane restart. */
  static hydrate(rows: readonly (readonly [string, string])[]): SerialisedSuspendedBillStore {
    return new SerialisedSuspendedBillStore(new Map(rows.map(([k, v]) => [k, v])));
  }
}

/** Per-tenant choices. Every one of these is configuration, never a hard-coded number. */
export interface SuspensionPolicy {
  /**
   * May a bill be recalled on a lane other than the one that suspended it? Default
   * false: a bill recalled on another lane is the shape of a "helpful" double-bill.
   */
  readonly allowCrossLaneRecall?: boolean;
  /**
   * Minutes after which the prices on a parked bill are no longer trusted and the
   * lane must re-price. Default 240 (four hours) — long enough for a customer to go
   * to the car park, short enough that a promotion ending at noon is not honoured at
   * six. Recorded as OC-29.
   */
  readonly repriceAfterMinutes?: number;
  /** Bills older than this are reported as abandoned. Default 1440 (one day). */
  readonly abandonAfterMinutes?: number;
  /** Must a cashier give a reason when suspending? Default false. */
  readonly reasonRequired?: boolean;
  /** Maximum bills one lane may hold at once. Default 10. */
  readonly maxPerLane?: number;
}

const DEFAULTS = {
  allowCrossLaneRecall: false,
  repriceAfterMinutes: 240,
  abandonAfterMinutes: 1440,
  reasonRequired: false,
  maxPerLane: 10,
} as const;

function resolve(policy: SuspensionPolicy = {}): Required<SuspensionPolicy> {
  return {
    allowCrossLaneRecall: policy.allowCrossLaneRecall ?? DEFAULTS.allowCrossLaneRecall,
    repriceAfterMinutes: policy.repriceAfterMinutes ?? DEFAULTS.repriceAfterMinutes,
    abandonAfterMinutes: policy.abandonAfterMinutes ?? DEFAULTS.abandonAfterMinutes,
    reasonRequired: policy.reasonRequired ?? DEFAULTS.reasonRequired,
    maxPerLane: policy.maxPerLane ?? DEFAULTS.maxPerLane,
  };
}

export type SuspendRefusal =
  | 'suspended'
  | 'empty_basket'
  | 'already_exists'
  | 'reason_required'
  | 'lane_limit_reached';

export interface SuspendResult {
  readonly billId: string;
  readonly suspended: boolean;
  readonly outcome: SuspendRefusal;
  readonly detail: string;
  readonly bill?: SuspendedBill;
}

export interface SuspendInput {
  readonly billId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly currency: string;
  readonly lines: readonly SuspendedLine[];
  readonly at: string;
  readonly reason?: string;
  readonly customerRef?: string;
}

/**
 * Suspend a basket. The bill is written to the local store as serialised state, so a
 * lane restart cannot lose it — that is the requirement, not an optimisation.
 */
export function suspendBill(
  input: SuspendInput,
  store: SuspendedBillStore,
  policy: SuspensionPolicy = {},
): SuspendResult {
  const p = resolve(policy);
  const base = { billId: input.billId };

  const live = input.lines.filter((l) => !l.voided);
  if (live.length === 0) {
    return {
      ...base,
      suspended: false,
      outcome: 'empty_basket',
      detail: 'there is nothing to suspend — an empty basket is not a parked sale',
    };
  }
  if (store.get(input.billId) !== undefined) {
    return {
      ...base,
      suspended: false,
      outcome: 'already_exists',
      detail: `bill "${input.billId}" is already suspended — suspending again would create a second copy of the same basket`,
    };
  }
  if (p.reasonRequired && (input.reason ?? '').trim() === '') {
    return {
      ...base,
      suspended: false,
      outcome: 'reason_required',
      detail: 'this store requires a reason when a bill is parked',
    };
  }
  const onThisLane = store
    .list()
    .filter((b) => b.laneId === input.laneId && b.state === 'suspended').length;
  if (onThisLane >= p.maxPerLane) {
    return {
      ...base,
      suspended: false,
      outcome: 'lane_limit_reached',
      detail: `lane ${input.laneId} already holds ${onThisLane} parked bills — clear or abandon one before parking another`,
    };
  }

  const bill: SuspendedBill = {
    billId: input.billId,
    tenantId: input.tenantId,
    storeId: input.storeId,
    laneId: input.laneId,
    cashierId: input.cashierId,
    tradingDay: input.tradingDay,
    currency: input.currency,
    // Only live lines are parked; a voided line and its reason stay in the audit trail
    // of the session that voided it, not in the basket the customer comes back to.
    lines: live,
    suspendedAt: input.at,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.customerRef === undefined ? {} : { customerRef: input.customerRef }),
    state: 'suspended',
  };
  store.put(bill);

  return {
    ...base,
    suspended: true,
    outcome: 'suspended',
    detail: `${live.length} line(s) parked on lane ${input.laneId}`,
    bill,
  };
}

export type ResumeRefusal =
  | 'resumed'
  | 'not_found'
  | 'already_resumed'
  | 'abandoned'
  | 'other_lane'
  | 'other_store';

export interface ResumeResult {
  readonly billId: string;
  readonly resumed: boolean;
  readonly outcome: ResumeRefusal;
  readonly detail: string;
  readonly bill?: SuspendedBill;
  /**
   * True when the parked prices are older than the tenant's window. The bill still
   * resumes — refusing it would strand the customer — but the lane must re-price
   * before tendering, and it is told so explicitly rather than left to guess.
   */
  readonly repriceRequired?: boolean;
  readonly minutesParked?: number;
}

/**
 * Resume a suspended bill. This is a **claim**: it succeeds once and refuses every
 * attempt afterwards, naming who has it — because two lanes resuming one bill is a
 * double charge that both cashiers believe was correct.
 */
export function resumeBill(
  input: {
    readonly billId: string;
    readonly byUserId: string;
    readonly onLaneId: string;
    readonly storeId: string;
    readonly at: string;
  },
  store: SuspendedBillStore,
  policy: SuspensionPolicy = {},
): ResumeResult {
  const p = resolve(policy);
  const bill = store.get(input.billId);
  const base = { billId: input.billId };

  if (bill === undefined) {
    return { ...base, resumed: false, outcome: 'not_found', detail: `no parked bill "${input.billId}"` };
  }
  if (bill.state === 'resumed') {
    return {
      ...base,
      resumed: false,
      outcome: 'already_resumed',
      bill,
      detail: `this bill was already resumed on lane ${bill.resumedOnLaneId ?? 'unknown'} by ${bill.resumedBy ?? 'unknown'} — resuming again would charge the customer twice`,
    };
  }
  if (bill.state === 'abandoned') {
    return {
      ...base,
      resumed: false,
      outcome: 'abandoned',
      bill,
      detail: `this bill was abandoned${bill.abandonReason === undefined ? '' : ` (${bill.abandonReason})`} — start a new sale`,
    };
  }
  if (bill.storeId !== input.storeId) {
    // A bill belongs to the shop it was rung up in. Never another one.
    return {
      ...base,
      resumed: false,
      outcome: 'other_store',
      bill,
      detail: `this bill belongs to ${bill.storeId} and cannot be recalled at ${input.storeId}`,
    };
  }
  if (!p.allowCrossLaneRecall && bill.laneId !== input.onLaneId) {
    return {
      ...base,
      resumed: false,
      outcome: 'other_lane',
      bill,
      detail: `this bill was parked on lane ${bill.laneId}; this store does not allow recalling another lane's bill`,
    };
  }

  const minutesParked = Math.max(0, Math.round((Date.parse(input.at) - Date.parse(bill.suspendedAt)) / 60_000));
  const resumed: SuspendedBill = {
    ...bill,
    state: 'resumed',
    resumedAt: input.at,
    resumedBy: input.byUserId,
    resumedOnLaneId: input.onLaneId,
  };
  store.put(resumed);

  const stale = minutesParked > p.repriceAfterMinutes;
  return {
    ...base,
    resumed: true,
    outcome: 'resumed',
    bill: resumed,
    minutesParked,
    ...(stale ? { repriceRequired: true } : {}),
    detail: stale
      ? `parked ${minutesParked} minutes — longer than the ${p.repriceAfterMinutes}-minute price window, so the lines must be re-priced before tendering`
      : `resumed after ${minutesParked} minutes on lane ${input.onLaneId}`,
  };
}

/**
 * Abandon a parked bill. The record is **kept** with who abandoned it and why (hard
 * rule #6): repeated park-and-abandon is a loss-prevention pattern, and a deleted
 * record has no pattern in it.
 */
export function abandonBill(
  input: {
    readonly billId: string;
    readonly byUserId: string;
    readonly reason: string;
    readonly at: string;
  },
  store: SuspendedBillStore,
): { readonly abandoned: boolean; readonly detail: string; readonly bill?: SuspendedBill } {
  const bill = store.get(input.billId);
  if (bill === undefined) {
    return { abandoned: false, detail: `no parked bill "${input.billId}"` };
  }
  if (bill.state !== 'suspended') {
    return { abandoned: false, detail: `this bill is already ${bill.state}`, bill };
  }
  if (input.reason.trim() === '') {
    return { abandoned: false, detail: 'abandoning a parked bill needs a reason', bill };
  }
  const abandoned: SuspendedBill = {
    ...bill,
    state: 'abandoned',
    abandonedAt: input.at,
    abandonedBy: input.byUserId,
    abandonReason: input.reason,
  };
  store.put(abandoned);
  return { abandoned: true, detail: `abandoned by ${input.byUserId}: ${input.reason}`, bill: abandoned };
}

export interface StaleBill {
  readonly billId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly minutesParked: number;
  readonly lineCount: number;
  readonly valueMinor: number;
  readonly detail: string;
}

/**
 * The parked-bill report the manager actually needs at close (M12-FR-02 reporting):
 * what is still sitting on the lanes, how long it has been there, and what it is
 * worth. Sorted oldest first — the one most likely to be a problem is at the top.
 */
export function staleBills(
  store: SuspendedBillStore,
  at: string,
  policy: SuspensionPolicy = {},
): readonly StaleBill[] {
  const p = resolve(policy);
  return store
    .list()
    .filter((b) => b.state === 'suspended')
    .map((b): StaleBill => {
      const minutes = Math.max(0, Math.round((Date.parse(at) - Date.parse(b.suspendedAt)) / 60_000));
      return {
        billId: b.billId,
        laneId: b.laneId,
        cashierId: b.cashierId,
        minutesParked: minutes,
        lineCount: b.lines.length,
        valueMinor: b.lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantityMinor, 0),
        detail:
          minutes > p.abandonAfterMinutes
            ? `parked ${minutes} minutes — past the ${p.abandonAfterMinutes}-minute abandonment window; nobody is coming back for it`
            : minutes > p.repriceAfterMinutes
              ? `parked ${minutes} minutes — the prices on it are no longer trusted`
              : `parked ${minutes} minutes`,
      };
    })
    // Oldest first: the one most likely to be a problem is at the top.
    .sort((a, b) => b.minutesParked - a.minutesParked);
}
