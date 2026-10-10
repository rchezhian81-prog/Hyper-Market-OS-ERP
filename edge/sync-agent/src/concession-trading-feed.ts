// The inbound partner-counter trading pull — PF-13 (M27-FR-01/04 · §31 · P-01 · P-08 · hard rule #4).
//
// `GET /v1/concession/trading-feed` under the box's own credential: every agreement's terms, so the box can stop a counter
// whose agreement lapsed before money changes hands, with the cable out. The same rules as every inbound feed: never the
// token in a message; unreachable keeps what is held; never backwards; never another shop's.

import { readConcessionTradingFeed, type ConcessionTradingFeed } from '../../../packages/concession/src/trading-feed';

export type ConcessionTradingPullOutcome =
  | { readonly status: 'updated'; readonly asOf: string }
  | { readonly status: 'kept' | 'offline'; readonly asOf: string | null; readonly reason: string };

export async function pullConcessionTradingFeed(input: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
  readonly receiver: { readonly tenantId: string; heldFeed(): ConcessionTradingFeed | undefined; takeFeed(feed: ConcessionTradingFeed, receivedAt: string): Promise<void> };
  readonly now: string;
  readonly timeoutMs?: number;
}): Promise<ConcessionTradingPullOutcome> {
  const held = input.receiver.heldFeed();
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, input.timeoutMs ?? 10_000);
  let feed: ConcessionTradingFeed | undefined;
  try {
    const response = await input.fetch(`${input.baseUrl.replace(/\/+$/, '')}/v1/concession/trading-feed`, {
      method: 'GET', headers: { authorization: `Bearer ${input.token}` }, signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      return { status: 'offline', asOf: held?.generatedAt ?? null, reason: `the cloud answered ${response.status} for the counters' agreements` };
    }
    feed = readConcessionTradingFeed(await response.json() as unknown);
  } catch {
    return { status: 'offline', asOf: held?.generatedAt ?? null, reason: 'could not reach the cloud — the counters keep the agreements this box holds' };
  } finally {
    clearTimeout(timer);
  }
  if (feed === undefined) return { status: 'kept', asOf: held?.generatedAt ?? null, reason: 'the cloud returned something that is not a counters\' trading feed' };
  if (feed.tenantId !== input.receiver.tenantId) return { status: 'kept', asOf: held?.generatedAt ?? null, reason: 'the agreements are for another shop' };
  if (held !== undefined && Date.parse(feed.generatedAt) < Date.parse(held.generatedAt)) return { status: 'kept', asOf: held.generatedAt, reason: 'the agreements received are older than the ones this box holds' };
  await input.receiver.takeFeed(feed, input.now);
  return { status: 'updated', asOf: feed.generatedAt };
}
