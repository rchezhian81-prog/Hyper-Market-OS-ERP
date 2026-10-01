// The inbound floor-indents pull — SP-8c (F08 · WF-06 · M09-FR-03 · §31 · P-01 · P-08 · hard rule #4).
//
// The outbox drain carries the floor's asks, the back store's issues and the floor's counts UP to the cloud (SP-8b / SP-8c).
// Nothing carried head office's REGISTER down to the box: the warehouse handheld, served by the box's device socket with no
// path to the cloud, had no way to know which indents the back store owed. This is the inbound mirror, shaped exactly like
// the migration-register pull (`migration-feed.ts`): an `IndentsFeedSource` fetches `GET /v1/floor/indents?open=true` under
// the box's own credential, and `pullIndentsFeed` decides — without a network — whether the box takes what came back:
//   • **Never put the token in a message.** A reason string reaches logs and support threads (#4).
//   • **Unreachable is not rejected.** A timeout, a 5xx, an expired token — the box keeps the register it already holds
//     and says how old it is (P-08), and tries again next pass (P-01).
//   • **Never go backwards.** A register assembled earlier than the one held (a stale replica, a replayed reply) is kept out.
//   • **The rows are carried whole.** The box interprets only what it needs (the id, the state, the places, the owed lines);
//     the screens read the rest as head office wrote it.

/** One open indent as head office's register lists it (`presentIndent` + `needsAttention`); the box reads a few fields, carries the rest. */
export interface IndentsFeedRow {
  readonly indentId: string;
  readonly state: string;
  readonly fromLocationId?: string;
  readonly toLocationId?: string;
  readonly requestedBy?: string;
  readonly totals?: { readonly lines?: readonly IndentsFeedLine[]; readonly [k: string]: unknown };
  readonly [k: string]: unknown;
}
export interface IndentsFeedLine {
  readonly productId: string;
  readonly uom?: string;
  readonly outstandingMinor?: number;
  readonly [k: string]: unknown;
}

/** The register as the box reads it: the cloud's clock, and every open indent. */
export interface IndentsFeed {
  /** The cloud's clock when the register was assembled — the screens' "as of". */
  readonly asAt: string;
  readonly indents: readonly IndentsFeedRow[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read a body as the register, or say it is not one. Strict on what the box INTERPRETS; lenient on what it only carries. */
export function readIndentsFeed(body: unknown): IndentsFeed | undefined {
  if (!isObj(body) || !isStr(body['asAt']) || Number.isNaN(Date.parse(body['asAt'])) || !Array.isArray(body['indents'])) return undefined;
  for (const row of body['indents']) {
    if (!isObj(row) || !isStr(row['indentId']) || !isStr(row['state'])) return undefined;
    for (const key of ['fromLocationId', 'toLocationId', 'requestedBy'] as const) if (row[key] !== undefined && !isStr(row[key])) return undefined;
    const totals = row['totals'];
    if (totals !== undefined) {
      if (!isObj(totals)) return undefined;
      if (totals['lines'] !== undefined) {
        if (!Array.isArray(totals['lines'])) return undefined;
        for (const line of totals['lines']) {
          if (!isObj(line) || !isStr(line['productId'])) return undefined;
          if (line['outstandingMinor'] !== undefined && !Number.isInteger(line['outstandingMinor'])) return undefined;
        }
      }
    }
  }
  return body as unknown as IndentsFeed;
}

export type IndentsFeedFetch =
  | { readonly status: 'fetched'; readonly feed: IndentsFeed }
  /** Offline, timed out, a 5xx, an expired token, a body that is not a register — keep what is held, try again. */
  | { readonly status: 'unreachable'; readonly reason: string };

export interface IndentsFeedSource {
  fetch(): Promise<IndentsFeedFetch>;
}

export interface HttpIndentsFeedSourceOptions {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  readonly timeoutMs?: number;
  /** Injected so the source stays testable without a network. */
  readonly fetch: typeof globalThis.fetch;
}

/** Reach the real endpoint: `GET /v1/floor/indents?open=true` — the register the Indents screen itself reads. */
export function httpIndentsFeedSource(options: HttpIndentsFeedSourceOptions): IndentsFeedSource {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    fetch: async (): Promise<IndentsFeedFetch> => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const response = await options.fetch(`${base}/v1/floor/indents?open=true`, {
          method: 'GET',
          headers: { authorization: `Bearer ${options.token}` },
          signal: controller.signal,
        });
        // Anything but a clean 200 is "could not get the register" — the status, never the body (#4).
        if (response.status < 200 || response.status >= 300) {
          return { status: 'unreachable', reason: `the cloud answered ${response.status} for the floor indents` };
        }
        const feed = readIndentsFeed(await response.json() as unknown);
        if (feed === undefined) return { status: 'unreachable', reason: 'the cloud returned something that is not a floor-indent register' };
        return { status: 'fetched', feed };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          status: 'unreachable',
          reason: aborted
            ? `no answer within ${timeoutMs}ms — the handheld keeps the indents this box holds`
            : 'could not reach the cloud — the handheld keeps the indents this box holds',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The minimal view of the box the puller drives — structurally satisfied by the composition root. */
export interface IndentsFeedReceiver {
  /** The register this box holds now, or undefined if it has never taken one. */
  heldFeed(): IndentsFeed | undefined;
  /** Take `feed` as the register this box serves from now on. Called for a newer AND for a re-confirmed one. */
  takeFeed(feed: IndentsFeed, receivedAt: string): void;
}

export type IndentsFeedPullStatus =
  /** A newer register with different content was taken. The handheld and the Indents screen now show it. */
  | 'updated'
  /** The cloud re-confirmed the register the box already holds (same indents, newer clock). Taken, quietly. */
  | 'unchanged'
  /** A register was seen and not taken — assembled before the one held. */
  | 'kept'
  /** The cloud could not be reached — held register kept, will try again next pass. */
  | 'offline';

export interface IndentsFeedPullOutcome {
  readonly status: IndentsFeedPullStatus;
  /** The cloud clock of the register the box holds after this pull; null if it holds none. */
  readonly asAt: string | null;
  /** How far behind the cloud the held register is, in minutes (P-08); null if none is held. */
  readonly ageMinutes: number | null;
  readonly staffMessage: string;
  /** Only for `offline` and `kept`: why. Never contains the token (#4). */
  readonly reason?: string;
}

/** The content of a register with the clock taken off — what "the same register" means. */
export function indentsFeedDigest(feed: IndentsFeed): string {
  return JSON.stringify([...feed.indents].sort((a, b) => a.indentId.localeCompare(b.indentId)));
}

export function feedAgeMinutes(asAt: string, now: string): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(asAt)) / 60_000));
}

/**
 * Pull the cloud's open floor indents and, if the register is not older than what is held, put the box on it.
 * `now` is injected so the reported age is deterministic.
 */
export async function pullIndentsFeed(input: {
  readonly source: IndentsFeedSource;
  readonly receiver: IndentsFeedReceiver;
  readonly now: string;
}): Promise<IndentsFeedPullOutcome> {
  const held = input.receiver.heldFeed();
  const shown = (): { asAt: string | null; ageMinutes: number | null } => {
    const h = input.receiver.heldFeed();
    return h === undefined ? { asAt: null, ageMinutes: null } : { asAt: h.asAt, ageMinutes: feedAgeMinutes(h.asAt, input.now) };
  };
  const asOf = (): string => {
    const h = input.receiver.heldFeed();
    return h === undefined
      ? 'the box has not been told about any floor indents yet'
      : `the box holds the floor indents as of ${h.asAt} (${feedAgeMinutes(h.asAt, input.now)} minute(s) behind the cloud)`;
  };

  const result = await input.source.fetch();
  if (result.status === 'unreachable') {
    return { status: 'offline', ...shown(), staffMessage: `Cloud not reachable — ${asOf()}.`, reason: result.reason };
  }
  const feed = result.feed;
  if (held !== undefined && Date.parse(feed.asAt) < Date.parse(held.asAt)) {
    return { status: 'kept', ...shown(), staffMessage: `The cloud answered with OLDER floor indents than this box holds — ignored; ${asOf()}.`, reason: 'older than held' };
  }
  const changed = held === undefined || indentsFeedDigest(held) !== indentsFeedDigest(feed);
  input.receiver.takeFeed(feed, input.now);
  const owed = feed.indents.filter((i) => i.state === 'approved' || i.state === 'issuing').length;
  return {
    status: changed ? 'updated' : 'unchanged',
    ...shown(),
    staffMessage: changed
      ? `Floor indents updated from the cloud (as of ${feed.asAt}: ${feed.indents.length} open, ${owed} for the back store to issue).`
      : `Floor indents re-confirmed by the cloud (as of ${feed.asAt}).`,
  };
}
