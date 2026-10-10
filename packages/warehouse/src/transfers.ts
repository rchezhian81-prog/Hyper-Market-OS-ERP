// Warehouse-to-store allocation and inter-store transfers (M09-FR-03 / WF-07).
//
// A transfer is the one stock movement that is in two places at once, and that is
// exactly where shops lose it. Stock leaves the warehouse on Monday and arrives at
// the branch on Wednesday. If the system deducts it at dispatch and adds it at
// receipt with nothing in between, then for two days it exists NOWHERE — invisible
// to counts, to availability, to the auditor. If instead it is deducted only on
// receipt, it exists TWICE.
//
// So a transfer moves through an explicit **in-transit** state held at the
// destination: visible, owned, and deliberately **not sellable** until it is
// received (M08-FR-02). The van is a place.
//
// Two refusals that matter more than they look:
//   • QUARANTINED, EXPIRED OR RECALLED STOCK IS NEVER TRANSFERRED. Moving a problem
//     to another branch does not solve it; it launders it, and the receiving branch
//     has no idea.
//   • A RECEIPT SHORTFALL IS A VALUED EXCEPTION, not a silent adjustment. Stock that
//     left one place and never arrived at another is either a miscount or a theft,
//     and both need a name against them.
//
// Allocation is advisory until approved (§28): the system proposes, a person decides.
//
// Pure and deterministic: timestamps injected, no clock.

import type { Money } from '../../contracts/src/money';
import type { StockMovement } from '../../stock/src/position';

export type TransferState =
  | 'proposed'
  | 'approved'
  | 'dispatched'
  | 'in_transit'
  | 'received'
  | 'cancelled';

export interface TransferLine {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  /** Value, so a discrepancy on arrival can be priced (P-03). */
  readonly unitCost: Money;
}

export interface Transfer {
  readonly transferId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly TransferLine[];
  readonly state: TransferState;
  readonly requestedBy: string;
  readonly approvedBy?: string;
  readonly dispatchedAt?: string;
  readonly receivedAt?: string;
  /**
   * SP-5 (F05): head office's OWN unit cost at the SOURCE for each line when it was dispatched — the sending location's
   * weighted average in minor units, `null` where that stock was unvalued. Set by the dispatching surface, never by the
   * proposer, so the value that arrives at the destination is the value that left. Index-aligned with `lines`.
   */
  readonly lineCostsMinor?: readonly (number | null)[];
  /** Batch 2: who counted it in at the destination (set by `receiveTransfer`; absent on transfers received before). */
  readonly receivedBy?: string;
  /** Batch 2: how a person resolved the transfer's receipt shortfall — absent while it is open (plain transfers). */
  readonly shortfallResolution?: ShortfallResolution;
}

// ── Batch 2: resolving a receipt shortfall (shared by plain transfers and floor-indent issues) ─────────────────

/** A valued shortfall line: dispatched and never arrived. */
export interface ShortfallLine {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly valueMinor: number;
}

/** What the resolver says turned up, per product on the shortfall (anything not named was not found). */
export interface FoundLine {
  readonly productId: string;
  readonly batchId: string | null;
  readonly foundMinor: number;
  /** Where it turned up — the destination (default) or the source (it never left). */
  readonly foundAtLocationId?: string;
}

/** One product's part of a shortfall resolution — what was missing, what turned up (where), what is accepted as lost. */
export interface ShortfallResolutionLine {
  readonly productId: string;
  readonly batchId: string | null;
  readonly missingMinor: number;
  readonly foundMinor: number;
  /** Where the found units were — the destination or the source. */
  readonly foundAtLocationId: string | null;
  readonly lostMinor: number;
  /** The lost units at the cost they left the source with. */
  readonly lostValueMinor: number;
}

/**
 * Batch 2 (M09-FR-03 · M08-FR-03 · M08-FR-04 · P-08 · §28): a valued shortfall is RESOLVED by a person who neither sent
 * nor counted the stock, with a reason code — once. Units that turned up come back through a compensating, two-person
 * `adjusted` movement (raised by the count, approved by the resolver); the rest is confirmed lost at its value. The
 * shortfall itself stays on the record beside its resolution (hard rule #6).
 */
export interface ShortfallResolution {
  readonly resolvedBy: string;
  readonly resolvedAt: string;
  readonly reasonCode: string;
  readonly note: string;
  readonly lines: readonly ShortfallResolutionLine[];
  /** The M08 movement ids the found units came back on (empty when nothing was found). */
  readonly movementIds: readonly string[];
}

export type ShortfallRefusal =
  | 'nothing_short' | 'shortfall_already_resolved' | 'counter_cannot_resolve' | 'issuer_cannot_resolve'
  | 'not_on_shortfall' | 'more_found_than_missing';

/**
 * Judge a shortfall resolution — pure, no throw: the refusal names its code. The receipt must be short and not yet
 * resolved; the resolver is neither the sender nor the counter (§28 — "cannot self-approve material variance"); every
 * found line is on the shortfall, found at the source or the destination, never more than went missing.
 */
export function judgeShortfallResolution(input: {
  readonly what: string;
  readonly shortfall: readonly ShortfallLine[];
  readonly prior: ShortfallResolution | undefined;
  readonly sentBy: string | undefined;
  readonly countedBy: string | undefined;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly resolvedBy: string;
  readonly found: readonly FoundLine[];
  readonly reasonCode: string;
  readonly note: string;
  readonly at: string;
}): { readonly ok: true; readonly resolution: ShortfallResolution } | { readonly ok: false; readonly code: ShortfallRefusal; readonly why: string } {
  const no = (code: ShortfallRefusal, why: string) => ({ ok: false as const, code, why });
  if (input.shortfall.length === 0) return no('nothing_short', `${input.what} arrived in full — there is nothing to resolve`);
  if (input.prior !== undefined) return no('shortfall_already_resolved', `${input.prior.resolvedBy} resolved this shortfall at ${input.prior.resolvedAt}; a second resolution would be a second truth`);
  if (input.resolvedBy === input.countedBy) return no('counter_cannot_resolve', `${input.resolvedBy} counted ${input.what} and cannot also resolve its shortfall (§28) — a second person decides`);
  if (input.resolvedBy === input.sentBy) return no('issuer_cannot_resolve', `${input.resolvedBy} sent ${input.what} and cannot also resolve its shortfall (§28) — a second person decides`);
  for (const f of input.found) {
    if (!Number.isInteger(f.foundMinor) || f.foundMinor < 0) return no('not_on_shortfall', `${f.productId}: a found quantity is a whole number, zero or more`);
    if (!input.shortfall.some((s) => s.productId === f.productId && s.batchId === f.batchId)) {
      return no('not_on_shortfall', `${f.productId}${f.batchId === null ? '' : ` · ${f.batchId}`} is not on the shortfall of ${input.what}`);
    }
    if (f.foundAtLocationId !== undefined && f.foundAtLocationId !== input.toLocationId && f.foundAtLocationId !== input.fromLocationId) {
      return no('not_on_shortfall', `${f.productId}: stock from ${input.what} can only turn up at ${input.toLocationId} or ${input.fromLocationId}, not ${f.foundAtLocationId}`);
    }
  }
  const lines: ShortfallResolutionLine[] = [];
  for (const s of input.shortfall) {
    const named = input.found.filter((f) => f.productId === s.productId && f.batchId === s.batchId);
    const found = named.reduce((n, f) => n + f.foundMinor, 0);
    if (found > s.quantityMinor) return no('more_found_than_missing', `${s.productId}: ${found} found, but only ${s.quantityMinor} went missing — count again`);
    const lost = s.quantityMinor - found;
    const unit = s.quantityMinor === 0 ? 0 : s.valueMinor / s.quantityMinor;
    lines.push({
      productId: s.productId, batchId: s.batchId, missingMinor: s.quantityMinor, foundMinor: found,
      foundAtLocationId: found === 0 ? null : named.find((f) => f.foundMinor > 0)?.foundAtLocationId ?? input.toLocationId,
      lostMinor: lost, lostValueMinor: Math.round(unit * lost),
    });
  }
  return { ok: true, resolution: { resolvedBy: input.resolvedBy, resolvedAt: input.at, reasonCode: input.reasonCode, note: input.note, lines, movementIds: [] } };
}

/** The valued shortfall lines of a receipt's discrepancies (what was dispatched and did not arrive). */
export const shortfallLinesOf = (discrepancies: readonly TransferDiscrepancy[]): ShortfallLine[] =>
  discrepancies.filter((d) => d.differenceMinor < 0).map((d) => ({ productId: d.productId, batchId: d.batchId, quantityMinor: -d.differenceMinor, valueMinor: d.value.minor }));

export interface TransferApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
}

export class TransferRefusedError extends Error {
  constructor(
    public readonly transferId: string,
    public readonly why: string,
  ) {
    super(`Transfer "${transferId}" refused: ${why}`);
    this.name = 'TransferRefusedError';
  }
}

/** Stock a line is drawn from, with the state it is in. */
export interface AvailableLot {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly state: 'on_hand' | 'quarantine' | 'expired' | 'damaged';
  readonly recalled?: boolean;
}

const NOT_TRANSFERABLE = ['quarantine', 'expired', 'damaged'] as const;

/**
 * Dispatch an approved transfer: stock leaves the source and becomes **in-transit at
 * the destination** — present, visible, and not sellable.
 */
export function dispatchTransfer(input: {
  readonly transfer: Transfer;
  readonly approval?: TransferApproval;
  readonly available: readonly AvailableLot[];
  readonly at: string;
}): { readonly transfer: Transfer; readonly movements: readonly StockMovement[] } {
  const { transfer } = input;

  if (transfer.state !== 'proposed' && transfer.state !== 'approved') {
    throw new TransferRefusedError(transfer.transferId, `it is already ${transfer.state}`);
  }
  if (transfer.fromLocationId === transfer.toLocationId) {
    throw new TransferRefusedError(transfer.transferId, 'a transfer to the same place is not a transfer');
  }
  if (transfer.lines.length === 0) {
    throw new TransferRefusedError(transfer.transferId, 'it moves nothing');
  }

  const approved =
    input.approval?.status === 'approved' &&
    input.approval.subjectRef === transfer.transferId &&
    input.approval.decidedBy !== transfer.requestedBy;
  if (!approved) {
    // Allocation recommends; a person decides (§28).
    throw new TransferRefusedError(
      transfer.transferId,
      'a transfer needs approval from someone other than the person who requested it',
    );
  }

  for (const line of transfer.lines) {
    const lots = input.available.filter(
      (l) => l.productId === line.productId && l.batchId === line.batchId,
    );
    const blocked = lots.find(
      (l) => l.recalled === true || NOT_TRANSFERABLE.includes(l.state as (typeof NOT_TRANSFERABLE)[number]),
    );
    if (blocked) {
      // Moving a problem to another branch does not solve it; it launders it.
      throw new TransferRefusedError(
        transfer.transferId,
        `${line.productId} is ${blocked.recalled === true ? 'recalled' : blocked.state} — sending it to another branch moves the problem, it does not solve it`,
      );
    }
    const sellable = lots
      .filter((l) => l.state === 'on_hand')
      .reduce((sum, l) => sum + l.quantityMinor, 0);
    // SF-03: every line drawing on the SAME product and batch draws on the same stock — two lines of 60 against 100 are
    // 120 asked, never two separate 60s that each fit.
    const asked = transfer.lines
      .filter((l) => l.productId === line.productId && l.batchId === line.batchId)
      .reduce((sum, l) => sum + l.quantityMinor, 0);
    if (sellable < asked) {
      const what = line.batchId === null ? line.productId : `${line.productId} batch ${line.batchId}`;
      throw new TransferRefusedError(
        transfer.transferId,
        `only ${sellable} of ${what} available to send, not ${asked}`,
      );
    }
  }

  const movements: StockMovement[] = transfer.lines.flatMap((line, i) => [
    {
      movementId: `${transfer.transferId}-out-${i + 1}`,
      productId: line.productId,
      locationId: transfer.fromLocationId,
      batchId: line.batchId,
      from: 'on_hand' as const,
      to: null,
      quantityMinor: line.quantityMinor,
      uom: line.uom,
      at: input.at,
      reason: `transfer ${transfer.transferId} dispatched to ${transfer.toLocationId}`,
    },
    {
      movementId: `${transfer.transferId}-transit-${i + 1}`,
      productId: line.productId,
      // In transit AT THE DESTINATION: the van is a place, and the branch can see
      // what is coming without being able to sell it.
      locationId: transfer.toLocationId,
      batchId: line.batchId,
      from: null,
      to: 'in_transit' as const,
      quantityMinor: line.quantityMinor,
      uom: line.uom,
      at: input.at,
      reason: `transfer ${transfer.transferId} in transit from ${transfer.fromLocationId}`,
    },
  ]);

  return {
    transfer: { ...transfer, state: 'in_transit', approvedBy: input.approval?.decidedBy, dispatchedAt: input.at },
    movements,
  };
}

export interface TransferDiscrepancy {
  readonly productId: string;
  readonly batchId: string | null;
  readonly dispatchedMinor: number;
  readonly receivedMinor: number;
  readonly differenceMinor: number;
  readonly value: Money;
  readonly detail: string;
}

export interface ReceiveTransferResult {
  readonly transfer: Transfer;
  readonly movements: readonly StockMovement[];
  /** Valued, owned, and never a silent adjustment. */
  readonly discrepancies: readonly TransferDiscrepancy[];
}

/**
 * Receive a transfer at the destination: in-transit becomes on-hand for what
 * actually arrived, and anything missing becomes a valued exception rather than
 * quietly disappearing.
 */
export function receiveTransfer(input: {
  readonly transfer: Transfer;
  /** What the receiving branch actually counted, per product+batch. */
  readonly counted: readonly { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number }[];
  readonly receivedBy: string;
  readonly at: string;
  readonly currency: Money['currency'];
}): ReceiveTransferResult {
  const { transfer } = input;
  if (transfer.state !== 'in_transit') {
    throw new TransferRefusedError(transfer.transferId, `it is ${transfer.state}, not in transit`);
  }

  const movements: StockMovement[] = [];
  const discrepancies: TransferDiscrepancy[] = [];

  transfer.lines.forEach((line, i) => {
    const counted =
      input.counted.find((c) => c.productId === line.productId && c.batchId === line.batchId)
        ?.quantityMinor ?? 0;
    const arrived = Math.min(counted, line.quantityMinor);

    if (arrived > 0) {
      movements.push({
        movementId: `${transfer.transferId}-recv-${i + 1}`,
        productId: line.productId,
        locationId: transfer.toLocationId,
        batchId: line.batchId,
        from: 'in_transit',
        to: 'on_hand',
        quantityMinor: arrived,
        uom: line.uom,
        at: input.at,
        reason: `transfer ${transfer.transferId} received by ${input.receivedBy}`,
      });
    }

    const difference = counted - line.quantityMinor;
    if (difference !== 0) {
      // Stock that left one place and never arrived at another is a miscount or a
      // theft. Both need a name against them.
      const missing = Math.abs(difference);
      discrepancies.push({
        productId: line.productId,
        batchId: line.batchId,
        dispatchedMinor: line.quantityMinor,
        receivedMinor: counted,
        differenceMinor: difference,
        value: { minor: line.unitCost.minor * missing, currency: input.currency },
        detail:
          difference < 0
            ? `${missing} left ${transfer.fromLocationId} and did not arrive — a miscount or a loss, and it needs an owner`
            : `${missing} more arrived than were dispatched — the source count was wrong`,
      });

      // What never arrived cannot stay in transit for ever; it is written out of
      // transit and carried as the exception above, never silently forgotten.
      if (difference < 0) {
        movements.push({
          movementId: `${transfer.transferId}-shortfall-${i + 1}`,
          productId: line.productId,
          locationId: transfer.toLocationId,
          batchId: line.batchId,
          from: 'in_transit',
          to: null,
          quantityMinor: missing,
          uom: line.uom,
          at: input.at,
          reason: `transfer ${transfer.transferId} shortfall — raised as an exception, not absorbed`,
        });
      }
    }
  });

  return {
    transfer: { ...transfer, state: 'received', receivedAt: input.at, receivedBy: input.receivedBy },
    movements,
    discrepancies,
  };
}

export interface AllocationNeed {
  readonly locationId: string;
  readonly productId: string;
  /** How much the location is short of its target. */
  readonly shortfallMinor: number;
  /** Rate of sale, used to prioritise who needs it most. */
  readonly dailyDemandMinor?: number;
}

export interface AllocationProposal {
  readonly productId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly quantityMinor: number;
  /** Days of cover this gives the destination — the reason it was chosen. */
  readonly daysOfCover: number | null;
  readonly detail: string;
}

/**
 * Propose how to spread scarce warehouse stock across stores. **Advisory only** —
 * nothing moves until a person approves it (§28, and hard rule #5's principle).
 *
 * When there is not enough for everyone, it allocates by DAYS OF COVER rather than
 * by raw shortfall: giving 100 units to a shop that sells 5 a day while a shop
 * selling 50 gets nothing is how one branch drowns while another runs dry.
 */
export function proposeAllocation(input: {
  readonly productId: string;
  readonly fromLocationId: string;
  readonly availableMinor: number;
  readonly needs: readonly AllocationNeed[];
}): readonly AllocationProposal[] {
  const needs = input.needs.filter((n) => n.productId === input.productId && n.shortfallMinor > 0);
  const totalShortfall = needs.reduce((s, n) => s + n.shortfallMinor, 0);

  if (totalShortfall <= input.availableMinor) {
    return needs.map((need) => ({
      productId: input.productId,
      fromLocationId: input.fromLocationId,
      toLocationId: need.locationId,
      quantityMinor: need.shortfallMinor,
      daysOfCover:
        need.dailyDemandMinor === undefined || need.dailyDemandMinor === 0
          ? null
          : Math.round((need.shortfallMinor / need.dailyDemandMinor) * 10) / 10,
      detail: 'enough for everyone — full shortfall allocated',
    }));
  }

  // Scarce: share by demand so every branch gets a similar number of days, rather
  // than a similar number of units.
  const demandTotal = needs.reduce((s, n) => s + (n.dailyDemandMinor ?? 1), 0);
  let remaining = input.availableMinor;
  const proposals: AllocationProposal[] = [];

  const ordered = [...needs].sort((a, b) => (b.dailyDemandMinor ?? 1) - (a.dailyDemandMinor ?? 1));
  ordered.forEach((need, index) => {
    const share =
      index === ordered.length - 1
        ? remaining // the last one absorbs the rounding, so nothing is stranded
        : Math.min(
            need.shortfallMinor,
            Math.floor((input.availableMinor * (need.dailyDemandMinor ?? 1)) / demandTotal),
          );
    const quantity = Math.max(0, Math.min(share, remaining, need.shortfallMinor));
    remaining -= quantity;
    if (quantity > 0) {
      proposals.push({
        productId: input.productId,
        fromLocationId: input.fromLocationId,
        toLocationId: need.locationId,
        quantityMinor: quantity,
        daysOfCover:
          need.dailyDemandMinor === undefined || need.dailyDemandMinor === 0
            ? null
            : Math.round((quantity / need.dailyDemandMinor) * 10) / 10,
        detail: 'not enough for everyone — shared by rate of sale, so each branch gets similar days of cover',
      });
    }
  });

  return proposals;
}
