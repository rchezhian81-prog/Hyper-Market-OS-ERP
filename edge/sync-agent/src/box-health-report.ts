// The store computer tells head office how its disk, its queue and its tills' devices are (M35-FR-03 · D04-FR-05 · P-08).
//
// Head office cannot see the box's disk, nor what a till's scanner or printer last said: only the box knows. After each
// sync pass it says so, under its own store-locked credential (OB-54) — the report names NO store; head office stamps
// the store the box's signed credential names. While the box is cut off it cannot report, so head office's last report
// ages and is shown stale (never "fine").
//
// Never on the sale path (hard rule #1): it rides the sync loop after the drains, and a failed report is simply retried
// next pass. The token is configuration, never logged (hard rule #4). No person's name or id rides in it.

import { splitReceiptNumber } from '../../../packages/contracts/src/receipt-number';

export interface BoxHealthReport {
  /** The box's clock when it made the report. */
  readonly observedAt: string;
  readonly disk: {
    readonly freeBytes: number;
    readonly totalBytes: number;
    readonly salesLogUsedBytes: number;
    readonly salesLogCapacityBytes: number;
    readonly reserveBytes: number;
  };
  readonly queue: { readonly unsent: number; readonly deadLettered: number };
  readonly tills: readonly {
    readonly laneId: string;
    readonly reportedAt: string;
    readonly devices: readonly { readonly kind: string; readonly state: string; readonly detail?: string }[];
    /** Is somebody signed in at that till now (P-08)? An unattended till stops re-sending its devices and goes stale. */
    readonly attended?: boolean;
  }[];
  /** Verifier r18 item 6: the highest bill-number count this box has GIVEN per prefix, used on a bill or not (a void keeps its number). */
  readonly receiptNumbersIssued?: readonly {
    readonly prefix: string; readonly through: number;
    /** Verifier r19: the highest count put on a bill on this box, or that it cannot vouch for (from its witness after a restore). */
    readonly soldThrough?: number;
    /** Verifier r19: numbers this box cannot vouch for — given after the backup it was restored from — as [from, to] ranges. */
    readonly atRisk?: readonly (readonly [number, number])[];
    /**
     * Verifier r20 LOST-1: the bills under this prefix still waiting in this box's own queues (sales and refunds, not yet
     * sent) — how many, and the lowest and highest count among them. Head office never calls a number "never received"
     * while the box still holds it. `count: 0` says the box holds none.
     */
    readonly unsent?: UnsentBillNumbers;
    /**
     * Verifier r21 DEAD-LETTER-AS-LOST: the bills under this prefix this box GAVE UP sending (its dead letters) — still on
     * the box, waiting for a person. Head office names them "needs a person", never "never received".
     */
    readonly deadLettered?: UnsentBillNumbers;
    /**
     * Round 25 · OB-94 "A": counts this box GAVE under the prefix and never put on a bill (a sale that could not be saved
     * after its number was taken), as [from, to] ranges — the newest, at most 50 ranges and 500 numbers, none above
     * `soldThrough`. Head office never names them "never received".
     */
    readonly unused?: readonly (readonly [number, number])[];
  }[];
  /** Verifier r19 OB87-1/OB87-2: the box's own check of its bill-number witness, and any held restore. */
  readonly billNumbering?: BillNumberingReport;
  /**
   * R3 · P-08: this machine's time zone against the shop's (edge/store-edge/src/shop-zone.ts `zoneCheck`) — told to head
   * office so a difference is shown there too, not only on the box's own screens. Zone names only; no person's data.
   */
  readonly zoneCheck?: BoxZoneReport;
}

/** R3 · P-08: the box's time-zone check as it rides the health report (its sentences stay on the box). */
export interface BoxZoneReport {
  readonly verdict: 'in_step' | 'differs';
  readonly shopTimeZone: string;
  readonly shopTimeZoneFrom: 'store_pack' | 'shop_default';
  readonly machineTimeZone: string;
}

/**
 * Verifier r20 LOST-1: bills under one prefix the box still holds unsent — how many, and the lowest and highest count.
 * Verifier r21 UNSENT-CEILING: and when the OLDEST of them was made (its sale's own time), so head office can say how long
 * bills have waited on this box.
 */
export interface UnsentBillNumbers { readonly count: number; readonly from?: number; readonly to?: number; readonly oldestAt?: string }

/**
 * Verifier r20 LOST-1: per bill-number prefix, the bills still waiting in the box's queues — from the queued events' own
 * receipt number (a sale's `receiptNumber`, a refund's `number`). A queued event with no readable number is not counted.
 */
export function unsentBillNumbersOf(payloads: Iterable<unknown>): Map<string, UnsentBillNumbers> {
  return queuedBillNumbersOf([...payloads].map((payload) => ({ payload })));
}

/**
 * Verifier r21: per bill-number prefix, the bills in one of the box's queues (pending, or given up on) — from each queued
 * event's own receipt number, with the earliest `occurredAt` among them as `oldestAt` (when given).
 */
export function queuedBillNumbersOf(events: Iterable<{ readonly payload: unknown; readonly occurredAt?: string }>): Map<string, UnsentBillNumbers> {
  const out = new Map<string, { count: number; from: number; to: number; oldestAt?: string }>();
  for (const { payload: p, occurredAt } of events) {
    const x = p !== null && typeof p === 'object' ? p as { receiptNumber?: unknown; number?: unknown } : {};
    const n = typeof x.receiptNumber === 'string' ? x.receiptNumber : x.number;
    const split = splitReceiptNumber(n);
    if (split === undefined || split.counter < 1) continue;
    const { prefix, counter: count } = split;
    const cur = out.get(prefix);
    const at = typeof occurredAt === 'string' && !Number.isNaN(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : undefined;
    if (cur === undefined) out.set(prefix, { count: 1, from: count, to: count, ...(at === undefined ? {} : { oldestAt: at }) });
    else {
      cur.count += 1; cur.from = Math.min(cur.from, count); cur.to = Math.max(cur.to, count);
      if (at !== undefined && (cur.oldestAt === undefined || Date.parse(at) < Date.parse(cur.oldestAt))) cur.oldestAt = at;
    }
  }
  return out;
}

/** Verifier r20 LOST-1: each reported prefix with the bills under it still unsent (`count: 0` when the box holds none). */
export function withUnsent<T extends { readonly prefix: string }>(
  issued: readonly T[], unsent: ReadonlyMap<string, UnsentBillNumbers>, deadLettered?: ReadonlyMap<string, UnsentBillNumbers>,
): (T & { readonly unsent: UnsentBillNumbers; readonly deadLettered?: UnsentBillNumbers })[] {
  return issued.map((x) => ({
    ...x, unsent: unsent.get(x.prefix) ?? { count: 0 },
    // Verifier r21: the bills this box gave up sending, per prefix (`count: 0` when none) — when the caller lists them.
    ...(deadLettered === undefined ? {} : { deadLettered: deadLettered.get(x.prefix) ?? { count: 0 } }),
  }));
}

/** One prefix as the box's bill-number register gives it (`ReceiptNumbers.issuedThrough()`), before its queues are added. */
export type IssuedPrefix = Omit<NonNullable<BoxHealthReport['receiptNumbersIssued']>[number], 'unsent' | 'deadLettered'>;

/**
 * Round 25 · OB-93 "A" (verifier r24 NEW-1) — what the box's health report is made from. Everything that has to WAIT (the
 * filesystem, the sales log's size, the witness folder) is awaited FIRST; then the queues' counts and the per-prefix lists
 * of bills still to send are read in ONE synchronous step — nothing can run in between (Node runs one thing at a time), so
 * a sale committed while the report was being made is either in both the count and the list, or in neither. Before round
 * 25 the counts were read, then the sales log's size was awaited, then the lists were read: a sale landing in that gap made
 * an honest report contradict its own queue, and head office raised a false "lost track" alarm.
 */
export interface BoxHealthSources {
  readonly disk: () => Promise<BoxHealthReport['disk']>;
  readonly billNumbering?: () => Promise<BillNumberingReport & { readonly says?: string }>;
  /** Each queue's own count — read in the one synchronous step. */
  readonly queues: () => readonly { readonly unsentCount: number; readonly deadLetterCount: number }[];
  readonly tills: () => BoxHealthReport['tills'];
  /** The bill-number register's prefixes, and the queued and given-up events whose numbers are listed per prefix. */
  readonly issued?: () => readonly IssuedPrefix[];
  readonly pending?: () => Iterable<{ readonly payload: unknown; readonly occurredAt?: string }>;
  readonly deadLetters?: () => Iterable<{ readonly payload: unknown; readonly occurredAt?: string }>;
  /** R3 · P-08: the box's own time-zone check, read when the report is made. */
  readonly zone?: () => BoxZoneReport;
  readonly now: () => string;
}

/** Round 25 · OB-93: make the box's health report — every await first, then counts and lists in one synchronous step. */
export async function boxHealthReportOf(s: BoxHealthSources): Promise<BoxHealthReport> {
  const disk = await s.disk();
  const billNumbering = s.billNumbering === undefined ? undefined : billNumberingReport(await s.billNumbering());
  // ── ONE synchronous step from here to the return: no await, so no sale can be committed between the counts and the lists.
  const queues = s.queues();
  const issued = s.issued === undefined ? undefined
    : withUnsent(s.issued(), queuedBillNumbersOf(s.pending?.() ?? []), queuedBillNumbersOf(s.deadLetters?.() ?? []));
  return {
    observedAt: s.now(), disk,
    queue: { unsent: queues.reduce((n, h) => n + h.unsentCount, 0), deadLettered: queues.reduce((n, h) => n + h.deadLetterCount, 0) },
    tills: s.tills(),
    ...(issued === undefined ? {} : { receiptNumbersIssued: issued }),
    ...(billNumbering === undefined ? {} : { billNumbering }),
    ...(s.zone === undefined ? {} : { zoneCheck: zoneReport(s.zone()) }),
  };
}

/** R3 · P-08: only the four facts head office needs — the box's staff sentences stay on the box. */
export function zoneReport(z: BoxZoneReport): BoxZoneReport {
  return { verdict: z.verdict, shopTimeZone: z.shopTimeZone.slice(0, 64), shopTimeZoneFrom: z.shopTimeZoneFrom, machineTimeZone: z.machineTimeZone.slice(0, 64) };
}

/** Verifier r19 OB87-1/OB87-2: what the box says about its bill-number witness (no person's data; a short box id only). */
export interface BillNumberingReport {
  readonly witness: 'kept' | 'unavailable' | 'none';
  readonly fault?: string;
  readonly restoreHeld: boolean;
  readonly restoreBecause?: string;
  readonly restoreSince?: string;
  readonly sharedWith: readonly { readonly box: string; readonly lastWrittenAt: string }[];
}

/** The report's part from the box's witness check (`ReceiptNumbers.witnessHealth()`), its sentence left on the box. */
export function billNumberingReport(h: BillNumberingReport & { readonly says?: string }): BillNumberingReport {
  return {
    witness: h.witness, ...(h.fault === undefined ? {} : { fault: h.fault.slice(0, 400) }), restoreHeld: h.restoreHeld,
    ...(h.restoreBecause === undefined ? {} : { restoreBecause: h.restoreBecause }), ...(h.restoreSince === undefined ? {} : { restoreSince: h.restoreSince }),
    sharedWith: h.sharedWith.slice(0, 20).map((x) => ({ box: x.box, lastWrittenAt: x.lastWrittenAt })),
  };
}

export const BOX_HEALTH_REPORT_PATH = '/v1/store-computers/health-reports';

export function httpBoxHealthReporter(options: {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  /** Only used to make the idempotency key unique per box; the store itself is the credential's, stamped at head office. */
  readonly storeId: string;
  readonly timeoutMs?: number;
  readonly fetch: typeof globalThis.fetch;
}): (report: BoxHealthReport) => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return async (report) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const response = await options.fetch(`${base}${BOX_HEALTH_REPORT_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`, 'content-type': 'application/json',
          // One report per (box, moment): a retried POST of the same report collapses onto the first.
          'idempotency-key': `box-health-${options.storeId}-${report.observedAt}`,
        },
        body: JSON.stringify(report), signal: controller.signal,
      });
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
