// The inbound loyalty-wallets pull — PF-09 step 3 (M17-FR-01/03/04 · §31 · P-01 · P-08 · hard rule #4).
//
// The till spends a member's points and store credit against the store computer's COPY of head office's balances
// (`packages/loyalty/src/wallet.ts`). This is how the copy arrives: a `WalletFeedSource` fetches `GET /v1/loyalty/wallets`
// under the box's own credential, and `pullWalletFeed` decides — without a network — whether the box takes it. The same
// rules as every other inbound feed (`indents-feed.ts`):
//   • Never put the token in a message (#4).
//   • Unreachable is not rejected: the box keeps the copy it holds and says how old it is (P-08), and tries again.
//   • Never go backwards: a feed built earlier than the one held is kept out.
//   • Another shop's feed is not this shop's balances, and is never taken.

import { readWalletFeed, type WalletFeed } from '../../../packages/loyalty/src/wallet';

export type WalletFeedFetch =
  | { readonly status: 'fetched'; readonly feed: WalletFeed }
  | { readonly status: 'unreachable'; readonly reason: string };

export interface WalletFeedSource {
  fetch(): Promise<WalletFeedFetch>;
}

export function httpWalletFeedSource(options: {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch: typeof globalThis.fetch;
}): WalletFeedSource {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    fetch: async (): Promise<WalletFeedFetch> => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const response = await options.fetch(`${base}/v1/loyalty/wallets`, {
          method: 'GET', headers: { authorization: `Bearer ${options.token}` }, signal: controller.signal,
        });
        if (response.status < 200 || response.status >= 300) {
          return { status: 'unreachable', reason: `the cloud answered ${response.status} for the loyalty balances` };
        }
        const feed = readWalletFeed(await response.json() as unknown);
        if (feed === undefined) return { status: 'unreachable', reason: 'the cloud returned something that is not a loyalty balance feed' };
        return { status: 'fetched', feed };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          status: 'unreachable',
          reason: aborted
            ? `no answer within ${timeoutMs}ms — the till keeps the balances this box holds`
            : 'could not reach the cloud — the till keeps the balances this box holds',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface WalletFeedReceiver {
  readonly tenantId: string;
  heldFeed(): WalletFeed | undefined;
  takeFeed(feed: WalletFeed, receivedAt: string): Promise<void>;
}

export type WalletFeedPullStatus = 'updated' | 'kept' | 'offline';

export interface WalletFeedPullOutcome {
  readonly status: WalletFeedPullStatus;
  /** Head office's clock on the copy the box holds after this pull; null when it holds none. */
  readonly asOf: string | null;
  readonly ageMinutes: number | null;
  readonly reason?: string;
}

const ageOf = (asOf: string | undefined, now: string): number | null =>
  asOf === undefined ? null : Math.max(0, Math.floor((Date.parse(now) - Date.parse(asOf)) / 60_000));

export async function pullWalletFeed(input: { readonly source: WalletFeedSource; readonly receiver: WalletFeedReceiver; readonly now: string }): Promise<WalletFeedPullOutcome> {
  const held = input.receiver.heldFeed();
  const got = await input.source.fetch();
  if (got.status === 'unreachable') {
    return { status: 'offline', asOf: held?.generatedAt ?? null, ageMinutes: ageOf(held?.generatedAt, input.now), reason: got.reason };
  }
  if (got.feed.tenantId !== input.receiver.tenantId) {
    return { status: 'kept', asOf: held?.generatedAt ?? null, ageMinutes: ageOf(held?.generatedAt, input.now), reason: 'the balances are for another shop' };
  }
  if (held !== undefined && Date.parse(got.feed.generatedAt) < Date.parse(held.generatedAt)) {
    return { status: 'kept', asOf: held.generatedAt, ageMinutes: ageOf(held.generatedAt, input.now), reason: 'the balances received are older than the ones this box holds' };
  }
  await input.receiver.takeFeed(got.feed, input.now);
  return { status: 'updated', asOf: got.feed.generatedAt, ageMinutes: ageOf(got.feed.generatedAt, input.now) };
}
