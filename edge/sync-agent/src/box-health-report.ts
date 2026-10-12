// The store computer tells head office how its disk, its queue and its tills' devices are (M35-FR-03 · D04-FR-05 · P-08).
//
// Head office cannot see the box's disk, nor what a till's scanner or printer last said: only the box knows. After each
// sync pass it says so, under its own store-locked credential (OB-54) — the report names NO store; head office stamps
// the store the box's signed credential names. While the box is cut off it cannot report, so head office's last report
// ages and is shown stale (never "fine").
//
// Never on the sale path (hard rule #1): it rides the sync loop after the drains, and a failed report is simply retried
// next pass. The token is configuration, never logged (hard rule #4). No person's name or id rides in it.

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
