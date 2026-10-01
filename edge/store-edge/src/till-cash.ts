// The till's cash, as the store BOX holds it — M14-FR-01, M14-FR-02, §28, §31, hard rules #1 #2 #10 (SP-4c · F10).
//
// ── What was wrong ───────────────────────────────────────────────────────────
//
// Until SP-4c the till kept its cash in the browser: a float or a pickup went into an in-memory ledger and an
// in-memory outbox that nothing drained, and the Close button sent the session an input missing the four money
// figures it demanded — so the till could not close, and a float or pickup died with the page (audit finding F10).
//
// ── What this is ─────────────────────────────────────────────────────────────
//
// The box is the one thing on the shop PC that survives a reload and owns a disk, so the box holds the till's cash
// chain: every float, loan, pickup and safe drop, and every shift close, as records on its own append-only log,
// durable BEFORE the till is told "recorded", and queued for head office by the pipeline every other seam uses.
//
// This file is the PURE part of that: how the log is read back into the till's state (who holds it, what it holds,
// when the shift opened), how the shift's figures are worked out from what the box itself recorded (the float and
// pickups from this log, the cash taken and the cash refunded from the sale and return logs), and how a record
// becomes the event head office receives. It decides nothing about permissions and touches no file — `main.ts`
// composes it over the real logs and the lane socket carries the till's requests to it.
//
// **The cashier never supplies a figure but the count.** The expected cash is worked out here from records the till
// cannot edit, and it is never handed to the till before the count (the blind count is structural, as it is for
// stock). The till's Close button therefore sends exactly what a cashier knows: which shift, when, what was counted,
// and — when the box says the difference is material — why.

import { assessCashMovement, type StoredCashMovement } from '../../../packages/cash/src/assess-cash';
import type { CashMovementKind } from '../../../packages/cash/src/cash';
import { assessShiftClose } from '../../../packages/till/src/assess-shift';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';

const KINDS: readonly CashMovementKind[] = ['float_issue', 'loan', 'pickup', 'safe_drop', 'float_return'];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

/** One movement of cash on this till, as the box recorded it. */
export interface TillCashMovementRecord {
  readonly kind: 'movement';
  readonly movementId: string;
  readonly tillId: string;
  readonly laneId: string;
  readonly movementKind: CashMovementKind;
  /** Magnitude, minor units, > 0. */
  readonly amountMinor: number;
  /** Signed effect on the drawer (the kind's sign × the amount). */
  readonly deltaMinor: number;
  readonly currency: string;
  /** Who holds (or is being given) the till. */
  readonly custodianId: string;
  /** Who recorded it at the till — the signed-in cashier. */
  readonly performedBy: string;
  readonly tradingDay: string;
  readonly at: string;
}

/** A denomination line of the blind count, as the cloud's shift-close route reads it. */
export interface CountedDenomination {
  readonly denominationMinor: number;
  readonly count: number;
}

/** One shift close on this till, as the box decided and recorded it. */
export interface TillShiftCloseRecord {
  readonly kind: 'close';
  readonly shiftId: string;
  readonly tillId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  /** When custody opened (the float was taken) — the start of the window the figures cover. */
  readonly openedAt: string;
  readonly closedAt: string;
  readonly openingFloatMinor: number;
  readonly cashSalesMinor: number;
  readonly pickupsMinor: number;
  readonly cashRefundsMinor: number;
  readonly countedMinor: number;
  readonly expectedMinor: number;
  readonly varianceMinor: number;
  readonly exceptionRaised: boolean;
  readonly reasonCode: string | null;
  readonly toleranceMinor: number;
  /** False when the store pack named no cash tolerance and the box applied its default — said, never silent. */
  readonly toleranceKnown: boolean;
  readonly currency: string;
  readonly denominations?: readonly CountedDenomination[];
}

export type TillCashRecord = TillCashMovementRecord | TillShiftCloseRecord;

/** Read a raw log record back strictly; anything that is not one of the two shapes is `undefined` (never repaired). */
export function readTillCashRecord(raw: unknown): TillCashRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r['kind'] === 'movement') {
    const movementKind = str(r['movementKind']);
    const movementId = str(r['movementId']); const tillId = str(r['tillId']); const laneId = str(r['laneId']);
    const amountMinor = int(r['amountMinor']); const deltaMinor = int(r['deltaMinor']);
    const custodianId = str(r['custodianId']); const performedBy = str(r['performedBy']);
    const tradingDay = str(r['tradingDay']); const at = str(r['at']);
    if (movementKind === undefined || !KINDS.includes(movementKind as CashMovementKind)) return undefined;
    if (movementId === undefined || tillId === undefined || laneId === undefined || amountMinor === undefined || deltaMinor === undefined
      || custodianId === undefined || performedBy === undefined || tradingDay === undefined || at === undefined) return undefined;
    return {
      kind: 'movement', movementId, tillId, laneId, movementKind: movementKind as CashMovementKind, amountMinor, deltaMinor,
      currency: str(r['currency']) ?? 'INR', custodianId, performedBy, tradingDay, at,
    };
  }
  if (r['kind'] === 'close') {
    const shiftId = str(r['shiftId']); const tillId = str(r['tillId']); const laneId = str(r['laneId']); const cashierId = str(r['cashierId']);
    const tradingDay = str(r['tradingDay']); const openedAt = str(r['openedAt']); const closedAt = str(r['closedAt']);
    const nums = ['openingFloatMinor', 'cashSalesMinor', 'pickupsMinor', 'cashRefundsMinor', 'countedMinor', 'expectedMinor', 'varianceMinor', 'toleranceMinor'] as const;
    if (shiftId === undefined || tillId === undefined || laneId === undefined || cashierId === undefined || tradingDay === undefined
      || openedAt === undefined || closedAt === undefined || !nums.every((k) => int(r[k]) !== undefined)) return undefined;
    const denominations = Array.isArray(r['denominations'])
      ? (r['denominations'] as unknown[]).flatMap((d): CountedDenomination[] => {
        const x = (d ?? {}) as Record<string, unknown>;
        const denominationMinor = int(x['denominationMinor']); const count = int(x['count']);
        return denominationMinor === undefined || count === undefined ? [] : [{ denominationMinor, count }];
      })
      : undefined;
    return {
      kind: 'close', shiftId, tillId, laneId, cashierId, tradingDay, openedAt, closedAt,
      openingFloatMinor: r['openingFloatMinor'] as number, cashSalesMinor: r['cashSalesMinor'] as number,
      pickupsMinor: r['pickupsMinor'] as number, cashRefundsMinor: r['cashRefundsMinor'] as number,
      countedMinor: r['countedMinor'] as number, expectedMinor: r['expectedMinor'] as number, varianceMinor: r['varianceMinor'] as number,
      exceptionRaised: r['exceptionRaised'] === true, reasonCode: str(r['reasonCode']) ?? null,
      toleranceMinor: r['toleranceMinor'] as number, toleranceKnown: r['toleranceKnown'] !== false,
      currency: str(r['currency']) ?? 'INR',
      ...(denominations === undefined ? {} : { denominations }),
    };
  }
  return undefined;
}

/** The till's cash as the box can see it, folded from its log — never stored, always derived (hard rule #2). */
export interface TillCashState {
  readonly tillId: string;
  /** Who holds the till now, or null when nobody has taken a float since the last close. */
  readonly custodian: string | null;
  /** What the drawer should hold from MOVEMENTS alone (float + loans − pickups − drops); sales are not in this figure. */
  readonly balanceMinor: number;
  /** When the current custody opened (the float was taken), or null when the till is free. */
  readonly openedAt: string | null;
  /** The movements of the current custody, in order — the chain the next movement is judged against. */
  readonly movementsSinceOpen: readonly TillCashMovementRecord[];
  /** The most recent close on this till, if any. */
  readonly lastClose: TillShiftCloseRecord | null;
  /** Every movement id and shift id the box ever recorded for this till — for the idempotent answers. */
  readonly movementIds: ReadonlySet<string>;
  readonly shiftIds: ReadonlySet<string>;
}

/**
 * Fold the till's log into its state. A close ENDS the custody: the chain restarts empty (the drawer went to the safe
 * with the close), so the next float finds a free till. A `float_return` ends custody too, movement-style.
 */
export function foldTillCash(records: readonly TillCashRecord[], tillId: string): TillCashState {
  let custodian: string | null = null;
  let openedAt: string | null = null;
  let chain: TillCashMovementRecord[] = [];
  let lastClose: TillShiftCloseRecord | null = null;
  const movementIds = new Set<string>();
  const shiftIds = new Set<string>();
  for (const r of records) {
    if (r.tillId !== tillId) continue;
    if (r.kind === 'movement') {
      if (movementIds.has(r.movementId)) continue; // the same movement twice on the log is one movement
      movementIds.add(r.movementId);
      chain.push(r);
      if (r.movementKind === 'float_issue') { custodian = r.custodianId; openedAt = openedAt ?? r.at; }
      if (r.movementKind === 'float_return') { custodian = null; openedAt = null; chain = []; }
    } else {
      if (shiftIds.has(r.shiftId)) continue;
      shiftIds.add(r.shiftId);
      lastClose = r;
      custodian = null; openedAt = null; chain = [];
    }
  }
  const balanceMinor = chain.reduce((b, m) => b + m.deltaMinor, 0);
  return { tillId, custodian, balanceMinor, openedAt, movementsSinceOpen: chain, lastClose, movementIds, shiftIds };
}

/** The chain in the shape the shared cash guard judges. */
export function asStoredMovements(chain: readonly TillCashMovementRecord[]): StoredCashMovement[] {
  return chain.map((m) => ({ movementId: m.movementId, tillId: m.tillId, kind: m.movementKind, deltaMinor: m.deltaMinor, custodianId: m.custodianId }));
}

/** What the till asks the box to record. The box adds the lane, the till, the day and the sign. */
export interface CashMovementRequest {
  readonly movementId: string;
  readonly movementKind: CashMovementKind;
  readonly amountMinor: number;
  readonly at: string;
  readonly custodianId: string;
  readonly performedBy: string;
}

export type CashMovementDecision =
  | { readonly ok: true; readonly record: TillCashMovementRecord; readonly balanceAfterMinor: number; readonly custodianAfter: string | null }
  | { readonly ok: false; readonly refusedBecause: 'amount_not_positive' | 'till_already_assigned' | 'till_not_held_by_this_custodian' | 'insufficient_till_cash' | 'not_a_cash_movement'; readonly detail: string };

/**
 * Decide a cash movement against the till's current chain with the SAME guard head office runs (`assessCashMovement`):
 * one custodian at a time, no overdraw, a positive amount. Pure — the caller writes the record it returns.
 */
export function decideCashMovement(input: {
  readonly state: TillCashState;
  readonly request: CashMovementRequest;
  readonly laneId: string;
  readonly tradingDay: string;
  /** Cash sales less cash refunds since custody opened, from the box's own logs — so a pickup of the takings is not an "overdraw". */
  readonly tradingCashMinor: number;
}): CashMovementDecision {
  const { request, state } = input;
  if (!KINDS.includes(request.movementKind)) {
    return { ok: false, refusedBecause: 'not_a_cash_movement', detail: `"${String(request.movementKind)}" is not a kind of cash movement` };
  }
  const assessment = assessCashMovement({
    priorMovements: asStoredMovements(state.movementsSinceOpen),
    request: { movementId: request.movementId, tillId: state.tillId, kind: request.movementKind, amountMinor: request.amountMinor, custodianId: request.custodianId },
    tradingCashMinor: input.tradingCashMinor,
  });
  if (!assessment.ok) return { ok: false, refusedBecause: assessment.refusedBecause!, detail: assessment.detail };
  return {
    ok: true,
    record: {
      kind: 'movement', movementId: request.movementId, tillId: state.tillId, laneId: input.laneId,
      movementKind: request.movementKind, amountMinor: request.amountMinor, deltaMinor: assessment.deltaMinor, currency: 'INR',
      custodianId: request.custodianId, performedBy: request.performedBy, tradingDay: input.tradingDay, at: request.at,
    },
    balanceAfterMinor: assessment.balanceAfterMinor,
    custodianAfter: assessment.custodianAfter,
  };
}

/** Enough of a sale record, as the till writes it to the box's disk, to know the cash it put in the drawer. */
interface SaleLike {
  readonly laneId?: unknown;
  readonly committedAt?: unknown;
  readonly total?: unknown;
  readonly totalMinor?: unknown;
  readonly tenders?: unknown;
}

const tenderMinor = (t: unknown): { readonly kind: string; readonly minor: number } => {
  const r = (t ?? {}) as Record<string, unknown>;
  const minor = int(r['amountMinor']) ?? int((r['amount'] as Record<string, unknown> | undefined)?.['minor']) ?? 0;
  return { kind: str(r['kind']) ?? '', minor };
};

const within = (at: unknown, from: string, to: string): boolean => {
  const t = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return !Number.isNaN(t) && t >= Date.parse(from) && t <= Date.parse(to);
};

/**
 * The cash a sale put in the drawer: what was tendered in cash, less the change handed back. Change only ever comes
 * out of the cash tendered, so it is the excess of ALL tenders over the bill, capped at the cash tendered.
 */
export function cashIntoDrawer(sale: unknown): number {
  const s = (sale ?? {}) as SaleLike;
  const tenders = Array.isArray(s.tenders) ? s.tenders.map(tenderMinor) : [];
  const cash = tenders.filter((t) => t.kind === 'cash').reduce((n, t) => n + t.minor, 0);
  const tendered = tenders.reduce((n, t) => n + t.minor, 0);
  const total = int(s.totalMinor) ?? int(s.total) ?? 0;
  const change = Math.max(0, tendered - total);
  return Math.max(0, cash - Math.min(cash, change));
}

/** A record belongs to this lane when it names it, or names no lane at all (a record from before SP-4b). */
const onLane = (record: { readonly laneId?: unknown }, laneId: string): boolean =>
  record.laneId === undefined || record.laneId === null || record.laneId === '' || record.laneId === laneId;

/**
 * The figures of a shift, from what the BOX recorded — never from the till. The window runs from the moment custody
 * opened (the float) to the moment of the close; the float and every loan open the drawer, pickups and safe drops
 * empty it, the sale log says what cash came in, the return log what cash went back to customers.
 */
export function shiftFigures(input: {
  readonly state: TillCashState;
  readonly laneId: string;
  readonly closedAt: string;
  /** Parsed sale records off the box's sale log (any shape the till has written). */
  readonly sales: readonly unknown[];
  /** Parsed return records off the box's returns log. */
  readonly returns: readonly unknown[];
}): { readonly openingFloatMinor: number; readonly pickupsMinor: number; readonly cashSalesMinor: number; readonly cashRefundsMinor: number } {
  const from = input.state.openedAt ?? input.closedAt;
  const chain = input.state.movementsSinceOpen;
  const openingFloatMinor = chain.filter((m) => m.movementKind === 'float_issue' || m.movementKind === 'loan').reduce((n, m) => n + m.amountMinor, 0);
  const pickupsMinor = chain.filter((m) => m.movementKind === 'pickup' || m.movementKind === 'safe_drop').reduce((n, m) => n + m.amountMinor, 0);
  const cashSalesMinor = input.sales
    .filter((s) => s !== null && typeof s === 'object')
    .map((s) => s as SaleLike)
    .filter((s) => onLane(s, input.laneId) && within(s.committedAt, from, input.closedAt))
    .reduce((n, s) => n + cashIntoDrawer(s), 0);
  const cashRefundsMinor = input.returns
    .filter((r) => r !== null && typeof r === 'object')
    .map((r) => r as Record<string, unknown>)
    .filter((r) => onLane(r, input.laneId) && within(r['processedAt'], from, input.closedAt))
    .reduce((n, r) => n + cashOutOfDrawer(r), 0);
  return { openingFloatMinor, pickupsMinor, cashSalesMinor, cashRefundsMinor };
}

/**
 * The cash a return took OUT of the drawer: a cash refund's amount; on an EXCHANGE (SP-9b-ii · M13-FR-03) only a balance
 * refunded in cash — the credited value never left the drawer (it paid for the replacement as `exchange_credit`, and a
 * cash top-up came IN on the replacement sale, counted with the sales above). Nothing for card/UPI/store credit.
 */
function cashOutOfDrawer(r: Record<string, unknown>): number {
  const exchange = r['exchange'];
  if (exchange !== null && typeof exchange === 'object') {
    const x = exchange as Record<string, unknown>;
    return x['balance'] === 'refund' && x['balanceTender'] === 'cash' ? (int(x['balanceMinor']) ?? 0) : 0;
  }
  return r['refundTender'] === 'cash' ? (int(r['refundMinor']) ?? 0) : 0;
}

/** The box's default when the store pack names no cash tolerance: ₹100. Applied AND said (`toleranceKnown: false`). */
export const DEFAULT_CASH_TOLERANCE_MINOR = 10_000;

/** What the till asks when the cashier closes: the shift, the moment, the count — and a reason once asked for one. */
export interface ShiftCloseRequest {
  readonly shiftId: string;
  readonly closedAt: string;
  readonly cashierId: string;
  readonly countedMinor: number;
  readonly denominations?: readonly CountedDenomination[];
  readonly reasonCode?: string;
}

export type ShiftCloseDecision =
  | { readonly ok: true; readonly record: TillShiftCloseRecord }
  | {
    readonly ok: false;
    readonly refusedBecause: 'no_open_shift' | 'not_the_custodian' | 'count_not_a_whole_amount' | 'material_variance_needs_a_reason';
    readonly detail: string;
    /** On a material variance the box says how far out the drawer is — the count is already made, so the figure can no longer anchor it. */
    readonly varianceMinor?: number;
  };

/**
 * Decide a shift close from the box's own figures and the cashier's count, with the SAME rule head office runs
 * (`assessShiftClose`). Only the custodian who took the float closes the till; a material variance needs a reason.
 */
export function decideShiftClose(input: {
  readonly state: TillCashState;
  readonly request: ShiftCloseRequest;
  readonly laneId: string;
  readonly tradingDay: string;
  readonly figures: { readonly openingFloatMinor: number; readonly pickupsMinor: number; readonly cashSalesMinor: number; readonly cashRefundsMinor: number };
  readonly toleranceMinor: number | undefined;
}): ShiftCloseDecision {
  const { state, request } = input;
  if (state.custodian === null || state.openedAt === null) {
    return { ok: false, refusedBecause: 'no_open_shift', detail: 'no float has been taken on this till, so there is no shift to close' };
  }
  if (state.custodian !== request.cashierId) {
    return { ok: false, refusedBecause: 'not_the_custodian', detail: `this till is held by ${state.custodian}; only they can close it` };
  }
  if (!Number.isSafeInteger(request.countedMinor) || request.countedMinor < 0) {
    return { ok: false, refusedBecause: 'count_not_a_whole_amount', detail: 'the counted cash must be a whole amount in paise, zero or more' };
  }
  const toleranceKnown = input.toleranceMinor !== undefined;
  const toleranceMinor = input.toleranceMinor ?? DEFAULT_CASH_TOLERANCE_MINOR;
  const assessment = assessShiftClose({
    ...input.figures, countedCashMinor: request.countedMinor, toleranceMinor,
    ...(request.reasonCode === undefined ? {} : { reasonCode: request.reasonCode }),
  });
  if (!assessment.ok) {
    return { ok: false, refusedBecause: 'material_variance_needs_a_reason', detail: assessment.detail, varianceMinor: assessment.varianceMinor };
  }
  return {
    ok: true,
    record: {
      kind: 'close', shiftId: request.shiftId, tillId: state.tillId, laneId: input.laneId, cashierId: request.cashierId,
      tradingDay: input.tradingDay, openedAt: state.openedAt, closedAt: request.closedAt,
      ...input.figures, countedMinor: request.countedMinor,
      expectedMinor: assessment.expectedMinor, varianceMinor: assessment.varianceMinor, exceptionRaised: assessment.exceptionRaised,
      reasonCode: assessment.reasonCode, toleranceMinor, toleranceKnown, currency: 'INR',
      ...(request.denominations === undefined ? {} : { denominations: request.denominations }),
    },
  };
}

/** The cloud payload for a movement — what `POST /v1/tills/:tillId/cash-movements/synced` reads. */
export function toCloudCashMovement(record: TillCashMovementRecord): Record<string, unknown> {
  return {
    movementId: record.movementId, tillId: record.tillId, laneId: record.laneId, kind: record.movementKind,
    amountMinor: record.amountMinor, deltaMinor: record.deltaMinor, currency: record.currency,
    custodianId: record.custodianId, performedBy: record.performedBy, tradingDay: record.tradingDay, at: record.at,
  };
}

/** The cloud payload for a close — what `POST /v1/shifts/:shiftId/close/synced` reads. */
export function toCloudShiftClose(record: TillShiftCloseRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...record };
  delete payload['kind']; // the log envelope's discriminator, not a field of the close
  return payload;
}

/**
 * The event a log record becomes on its way to head office — minted identically live and on a restart re-queue, so a
 * record re-sent after a crash dedupes at the cloud against one that may already have gone (§31.1).
 */
export function tillCashEventFactory(tenantId: string): (record: string, index: number) => DomainEvent | undefined {
  return (record) => {
    let parsed: unknown;
    try { parsed = JSON.parse(record) as unknown; } catch { return undefined; }
    const read = readTillCashRecord(parsed);
    if (read === undefined) return undefined;
    if (read.kind === 'movement') {
      return makeEvent({
        id: `edge-cash-${read.movementId}`, type: 'CashMovement', occurredAt: read.at,
        idempotencyKey: `edge-cash-${tenantId}-${read.movementId}`, source: 'edge/lane',
        payload: toCloudCashMovement(read),
      });
    }
    return makeEvent({
      id: `edge-shift-close-${read.shiftId}`, type: 'TillClosed', occurredAt: read.closedAt,
      idempotencyKey: `edge-shift-close-${tenantId}-${read.shiftId}`, source: 'edge/lane',
      payload: toCloudShiftClose(read),
    });
  };
}

// ── What the box answers the till ──────────────────────────────────────────────
//
// Deliberately WITHOUT a balance or an expected figure: the till never learns what the drawer should hold before the
// count is made (M14-FR-02 — the blind count is structural, here as at the stock count).

/** Why a cash movement or a close was refused at the box — the till translates the ones it has words for. */
export type TillCashRefusal =
  | 'no_lane' | 'not_readable' | 'not_a_cash_movement' | 'amount_not_positive' | 'till_already_assigned'
  | 'till_not_held_by_this_custodian' | 'insufficient_till_cash' | 'no_open_shift' | 'not_the_custodian'
  | 'count_not_a_whole_amount' | 'material_variance_needs_a_reason' | 'could_not_write_durably' | 'no_room_left'
  | 'no_store_box' | 'lane_unreachable';

export type CashMovementOutcome =
  | {
    readonly committed: true;
    readonly movementId: string;
    readonly kind: CashMovementKind;
    /** Who holds the till after this movement (null once the float is returned). */
    readonly custodian: string | null;
    readonly tradingDay: string;
    /** A retry after a lost reply lands here: the box already held it, one effect (§31.1). */
    readonly alreadyRecorded?: true;
    readonly laneMessage: string;
  }
  | { readonly committed: false; readonly refusedBecause: TillCashRefusal; readonly laneMessage: string };

export type ShiftCloseOutcome =
  | {
    readonly closed: true;
    readonly shiftId: string;
    readonly tradingDay: string;
    readonly countedMinor: number;
    /** counted − expected: positive = over, negative = short. Known only once the count is made. */
    readonly varianceMinor: number;
    readonly exceptionRaised: boolean;
    readonly reasonCode: string | null;
    readonly alreadyClosed?: true;
    readonly laneMessage: string;
  }
  | {
    readonly closed: false;
    readonly refusedBecause: TillCashRefusal;
    readonly laneMessage: string;
    /** On `material_variance_needs_a_reason`: how far out the drawer is, so the cashier can say why. */
    readonly varianceMinor?: number;
  };

/** Where the till's cash stands, for the screen after a reload — never a figure. */
export interface TillCashStatus {
  readonly tillId: string | null;
  readonly laneId: string | null;
  readonly custodian: string | null;
  readonly openedAt: string | null;
  readonly shiftOpen: boolean;
}

/** The cashier's words for each refusal — an instruction, not an error name (P-08, pos-cashier.md). */
export const TILL_CASH_WORDS: Readonly<Record<TillCashRefusal, string>> = Object.freeze({
  no_lane: 'This till has no lane id. Do not move money — ask the installer to set the lane on this store computer.',
  not_readable: 'The store computer could not read that request. Nothing was recorded. Try again.',
  not_a_cash_movement: 'That is not a kind of cash movement this till records.',
  amount_not_positive: 'The amount must be more than zero.',
  till_already_assigned: 'This till already has a float out. Close the till before another float is taken.',
  till_not_held_by_this_custodian: 'You do not hold this till. Take the float first, or ask the cashier who did.',
  insufficient_till_cash: 'The drawer does not hold that much. Count what is there and tell the manager before moving any cash.',
  no_open_shift: 'No float has been taken on this till, so there is no shift to close. Take the float first.',
  not_the_custodian: 'This till is held by another cashier. Only the cashier who took the float can close it.',
  count_not_a_whole_amount: 'The count must be a whole amount, zero or more.',
  material_variance_needs_a_reason: 'The drawer is out by more than the shop allows. Say why before the till can close.',
  could_not_write_durably: 'The store computer could not save this. The cash is NOT recorded — do not move it. Tell the manager.',
  no_room_left: 'The store computer has no room left to record this. The cash is NOT recorded — do not move it. Tell the manager now.',
  no_store_box: 'This till is not connected to its store computer, so cash cannot be recorded. Tell the manager.',
  lane_unreachable: 'The store computer did not answer. The cash is NOT recorded yet — do not move it. Try again in a moment.',
});
