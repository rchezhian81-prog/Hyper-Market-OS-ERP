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
  }[];
  /** Verifier r19 OB87-1/OB87-2: the box's own check of its bill-number witness, and any held restore. */
  readonly billNumbering?: BillNumberingReport;
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
