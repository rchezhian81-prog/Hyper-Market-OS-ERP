// The store edge's promise: what the cashier is told is on the disk — P-01, hard rule #1,
// NFR-03 (zero acknowledged transaction loss), §31.
//
// **The receipt prints after the durable write, never before.** That single ordering is the whole
// of this file, and getting it the other way round produces the worst failure the product has: a
// sale the cashier saw succeed, the customer paid for and walked away from, which was never
// written anywhere. Nobody finds out. The day is short and the drawer is right, so the till gets
// blamed for a counting error that never happened.
//
// It also produces the one place in the entire system where **refusing a sale is correct**, and it
// is worth being precise about why, because `services/pos` refuses nothing:
//
//   • The **edge** refuses *before* the sale completes. Nothing has happened yet. The cashier can
//     say "one moment" and the customer is still standing there. That is a bad minute.
//   • The **cloud** refuses *after* the sale completed. The money is in the drawer and the
//     customer has gone. That is a lost sale and a day that will not balance.
//
// Same word, opposite consequences, decided by which side of the transaction it falls on.

/** A write that is on the disk when it returns, or throws. The adapter supplies the fsync. */
export interface DurableLog {
  /** Appends and returns only once the bytes will survive power loss. */
  append(record: string): Promise<void>;
  /** Bytes currently held. Drives the capacity decision below. */
  usedBytes(): Promise<number>;
  readonly capacityBytes: number;
}

export type CommitRefusal = 'could_not_write_durably' | 'no_room_left';

export interface CommitOutcome {
  readonly committed: boolean;
  readonly refusedBecause?: CommitRefusal;
  /**
   * Typed as the literal `true` on the committed path. If this is returned, the sale is on the
   * disk — that is what the field means and it is the only thing it may mean.
   */
  readonly durable?: true;
  readonly detail: string;
  /** What the cashier is told, in words that work with a customer watching. */
  readonly laneMessage: string;
}

/**
 * Commit a sale locally, or refuse it before the customer pays.
 *
 * Nothing here touches the network — that is hard rule #1 and it is why this function is
 * synchronous in spirit even where the disk write is not: it awaits a local file, and nothing else.
 */
export async function commitLocally(input: {
  readonly saleId: string;
  readonly record: string;
  readonly log: DurableLog;
  /** Space below which no new sale is accepted. Kept in reserve, per-tenant. */
  readonly reserveBytes?: number;
}): Promise<CommitOutcome> {
  const reserve = input.reserveBytes ?? 1_048_576;

  const used = await input.log.usedBytes();
  if (used + input.record.length + reserve > input.log.capacityBytes) {
    return {
      committed: false,
      refusedBecause: 'no_room_left',
      detail: `${used} of ${input.log.capacityBytes} bytes used; this sale plus the ${reserve}-byte reserve does not fit`,
      laneMessage: 'This lane cannot record any more sales until it syncs. Do not take payment. Tell the manager now — the other lanes may be fine.',
    };
  }

  try {
    await input.log.append(input.record);
  } catch (e) {
    // Refused BEFORE the customer pays. The one moment in the product where refusing a sale is
    // the right answer, because the sale has not happened yet.
    return {
      committed: false,
      refusedBecause: 'could_not_write_durably',
      detail: `the local write failed: ${e instanceof Error ? e.message : String(e)}`,
      laneMessage: 'This lane could not save the sale. Do not take payment and do not hand over the goods — use another lane and tell the manager.',
    };
  }

  return {
    committed: true,
    durable: true,
    detail: `sale ${input.saleId} is on the disk before the receipt printed`,
    laneMessage: 'Sale complete.',
  };
}

// ── Capacity: what is given up, and in what order ────────────────────────────

/**
 * What the edge holds, ranked by what it may lose first.
 *
 * A shop trading for three days with no line will fill a disk, and something has to give. The
 * ranking is the decision: **the sale is last, always**, and everything above it exists to be
 * given up so that it never is. A design that treats all queued work alike stops accepting sales
 * to preserve a telemetry batch.
 */
export type EdgeDataKind =
  /** Metrics and timings. Nice to have, never missed. */
  | 'telemetry'
  /** Catalogue versions fetched ahead of being needed. */
  | 'prefetched_catalogue'
  /** Sales already synced and acknowledged by the cloud. The cloud has them. */
  | 'synced_history'
  /** Stock movements from handhelds. Real work, recoverable by a recount. */
  | 'pending_movements'
  /** Sales taken and not yet synced. **Money. Never shed.** */
  | 'unsynced_sales';

/** Lower is shed first. `unsynced_sales` is deliberately last and nothing may be added after it. */
export const SHED_ORDER: readonly EdgeDataKind[] = [
  'telemetry', 'prefetched_catalogue', 'synced_history', 'pending_movements', 'unsynced_sales',
];

export interface Usage {
  readonly kind: EdgeDataKind;
  readonly bytes: number;
}

export interface ShedPlan {
  readonly shed: readonly { readonly kind: EdgeDataKind; readonly bytes: number; readonly why: string }[];
  readonly freedBytes: number;
  readonly enough: boolean;
  /** Typed as the literal `false`. No plan this function produces ever sheds an unsynced sale. */
  readonly shedsAnySale: false;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * Decide what to give up to free `needBytes`.
 *
 * Stops before `unsynced_sales` however short it still is. Where shedding everything else is not
 * enough, the honest answer is that it is not enough — and the lane refuses new sales rather than
 * deleting money that has been taken.
 */
export function planShed(usage: readonly Usage[], needBytes: number): ShedPlan {
  const byKind = new Map(usage.map((u) => [u.kind, u.bytes]));
  const shed: { kind: EdgeDataKind; bytes: number; why: string }[] = [];
  let freedBytes = 0;

  const WHY: Readonly<Record<EdgeDataKind, string>> = {
    telemetry: 'measurements about the shop, not the shop',
    prefetched_catalogue: 'it can be fetched again when the line is back',
    synced_history: 'the cloud has already acknowledged these',
    pending_movements: 'real work, and a recount can rebuild it — unlike a sale, which cannot',
    unsynced_sales: 'never',
  };

  for (const kind of SHED_ORDER) {
    if (kind === 'unsynced_sales') break; // The line nothing crosses.
    if (freedBytes >= needBytes) break;
    const bytes = byKind.get(kind) ?? 0;
    if (bytes <= 0) continue;
    shed.push({ kind, bytes, why: WHY[kind] });
    freedBytes += bytes;
  }

  const enough = freedBytes >= needBytes;
  const salesHeld = byKind.get('unsynced_sales') ?? 0;

  return {
    shed, freedBytes, enough,
    shedsAnySale: false,
    detail: enough
      ? `${freedBytes} bytes freed from ${shed.map((s) => s.kind).join(', ')}`
      : `only ${freedBytes} of ${needBytes} bytes could be freed without touching ${salesHeld} bytes of sales that have not reached the cloud`,
    ownerAction: enough
      ? 'nothing — the lane keeps trading and the freed data rebuilds itself when the line is back'
      : `this lane is nearly full and holds sales the cloud has not seen. It will refuse new sales rather than delete them. Get it a connection today — the money is safe on the disk and it is not anywhere else`,
  };
}

// ── What the shop is told ────────────────────────────────────────────────────

export interface EdgeHealth {
  readonly unsyncedSales: number;
  readonly deadLettered: number;
  readonly lastSyncAt?: string;
  readonly usedBytes: number;
  readonly capacityBytes: number;
  readonly hoursOfHeadroom?: number;
  /** Typed as the literal `true`: whatever the state of the line, the lanes sell (P-01). */
  readonly shopKeepsTrading: true;
  readonly staffMessage: string;
}

/**
 * The state of the edge, in a sentence somebody can act on.
 *
 * "247 items pending" is a number staff learn to ignore. What they can act on is how long it has
 * been since anything reached the cloud, and how much longer this will hold (P-08, NFR-09).
 */
export function edgeHealth(input: {
  readonly unsyncedSales: number;
  readonly deadLettered: number;
  readonly lastSyncAt?: string;
  readonly now: string;
  readonly usedBytes: number;
  readonly capacityBytes: number;
  readonly bytesPerHour: number;
}): EdgeHealth {
  const free = Math.max(0, input.capacityBytes - input.usedBytes);
  const hoursOfHeadroom = input.bytesPerHour > 0 ? Math.floor(free / input.bytesPerHour) : undefined;
  const behindHours = input.lastSyncAt === undefined ? undefined
    : Math.floor((Date.parse(input.now) - Date.parse(input.lastSyncAt)) / 3_600_000);

  const staffMessage = input.deadLettered > 0
    ? `Selling normally. ${input.deadLettered} item(s) the cloud refused are waiting for somebody to look at them — they are not lost and they are not going anywhere.`
    : input.unsyncedSales === 0
      ? 'Selling normally. Everything has reached the cloud.'
      : behindHours !== undefined && behindHours >= 1
        ? `Selling normally. Nothing has reached the cloud for ${behindHours} hour(s); ${input.unsyncedSales} sale(s) are held safely here${hoursOfHeadroom === undefined ? '' : ` and there is room for about ${hoursOfHeadroom} more hour(s) of trading`}.`
        : `Selling normally. ${input.unsyncedSales} sale(s) still to send.`;

  return {
    unsyncedSales: input.unsyncedSales,
    deadLettered: input.deadLettered,
    ...(input.lastSyncAt === undefined ? {} : { lastSyncAt: input.lastSyncAt }),
    usedBytes: input.usedBytes,
    capacityBytes: input.capacityBytes,
    ...(hoursOfHeadroom === undefined ? {} : { hoursOfHeadroom }),
    shopKeepsTrading: true,
    staffMessage,
  };
}
