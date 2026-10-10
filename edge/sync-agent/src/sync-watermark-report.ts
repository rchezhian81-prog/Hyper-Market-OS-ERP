// The store computer tells head office how far each of its queues has reached (EA-01 · M29-FR-01/03 · D13 · P-08).
//
// The owner's figures at head office are only as fresh as the last COMPLETE sync from each store. Head office cannot
// work that out from the newest sale it happens to hold — a store trading through a long cloud cut has newer sales on
// its own disk that head office has never seen. Only the box knows its watermark, so after each sync pass it says it:
// per queue (sales, refunds, …) "everything committed before this instant has reached you", how many items still
// wait, and how many head office refused. Head office keeps the latest report per store and domain; while the box is
// cut off it cannot report, so the last report it holds ages — and the owner's figures say stale.
//
// Never on the sale path (hard rule #1): it rides the sync loop after the drains, and a failed report is simply
// retried next pass. The token is configuration, never logged (hard rule #4).

/** One queue's watermark, as the box reports it. */
export interface DomainWatermark {
  /** The queue: sales, refunds, completions, day_close, concession_tags, device_events, till_cash. */
  readonly domain: string;
  /** Everything committed on the box before this instant has reached head office; null when no pass has run. */
  readonly completeThrough: string | null;
  readonly unsent: number;
  readonly deadLettered: number;
}

export interface SyncWatermarkReport {
  /** The box's clock when it made the report. */
  readonly observedAt: string;
  readonly domains: readonly DomainWatermark[];
}

export function httpSyncWatermarkReporter(options: {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  readonly storeId: string;
  readonly timeoutMs?: number;
  readonly fetch: typeof globalThis.fetch;
}): (report: SyncWatermarkReport) => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return async (report) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const response = await options.fetch(`${base}/v1/stores/${encodeURIComponent(options.storeId)}/sync-watermarks`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`, 'content-type': 'application/json',
          // One report per (store, moment): a retried POST of the same report collapses onto the first.
          'idempotency-key': `sync-wm-${options.storeId}-${report.observedAt}`,
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
