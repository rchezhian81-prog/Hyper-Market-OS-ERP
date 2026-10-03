// The inbound assignments pull — HA-1 (M19-FR-01 · M19-FR-03 · §31 · P-01 · P-08 · hard rule #4).
//
// The picker's wave and the driver's route used to reach the phones only from the box's pack FILE. This is the inbound mirror,
// shaped exactly like the floor-indents pull (`indents-feed.ts`): an `AssignmentsFeedSource` fetches
// `GET /v1/fulfilment/assignments?storeId=` under the box's own credential, and `pullAssignmentsFeed` decides — without a
// network — whether the box takes what came back:
//   • **Never put the token in a message.** A reason string reaches logs and support threads (#4).
//   • **Unreachable is not rejected.** A timeout, a 5xx, an expired token — the box keeps the assignments it already holds and
//     says how old they are (P-08), and tries again next pass (P-01).
//   • **Never go backwards.** A feed assembled earlier than the one held (a stale replica, a replayed reply) is kept out.
//   • **The whole feed replaces what is held.** A wave that was packed, or a route that settled, leaves the phone's list by
//     itself, because head office no longer lists it as open.
//   • **The pack file's `wave` / `route` sections are not touched.** They stay the dispatcher's hand-written override; the
//     screens say which of the two they are holding.

/** A wave as head office hands it to a picker — the box's `PackWave` shape, plus who assigned it and when. */
export interface AssignedWave {
  readonly waveId: string;
  readonly pickerId: string;
  readonly lines: readonly {
    readonly lineId: string;
    readonly orderRef: string;
    readonly productId: string;
    readonly description: string;
    readonly bin: string;
    readonly requiredQty: number;
    readonly uom: string;
    readonly unitPriceMinor: number;
  }[];
  readonly assignedBy: string;
  readonly assignedAt: string;
}

/** A route as head office hands it to a driver — the box's `PackRoute` shape, plus who assigned it and when. */
export interface AssignedRoute {
  readonly routeId: string;
  readonly driverId: string;
  readonly stops: readonly {
    readonly stopId: string;
    readonly orderRef: string;
    readonly area: string;
    readonly codMinor: number;
    readonly costMinor?: number;
    readonly orderValueMinor?: number;
  }[];
  readonly contributionRule?: { readonly maxCostShareBps: number };
  readonly assignedBy: string;
  readonly assignedAt: string;
}

/** The store's open assignments as the box reads them: the cloud's clock, the store, the waves, the routes. */
export interface AssignmentsFeed {
  readonly asAt: string;
  readonly storeId: string;
  readonly waves: readonly AssignedWave[];
  readonly routes: readonly AssignedRoute[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Read a body as the feed, or say it is not one. Strict on everything the phones act on — an unreadable line is an unreadable feed. */
export function readAssignmentsFeed(body: unknown): AssignmentsFeed | undefined {
  if (!isObj(body) || !isStr(body['asAt']) || Number.isNaN(Date.parse(body['asAt'])) || !isStr(body['storeId'])
    || !Array.isArray(body['waves']) || !Array.isArray(body['routes'])) return undefined;
  for (const w of body['waves']) {
    if (!isObj(w) || !isStr(w['waveId']) || !isStr(w['pickerId']) || !isStr(w['assignedBy']) || !isStr(w['assignedAt']) || !Array.isArray(w['lines'])) return undefined;
    for (const l of w['lines']) {
      if (!isObj(l) || !isStr(l['lineId']) || !isStr(l['orderRef']) || !isStr(l['productId']) || !isStr(l['description']) || !isStr(l['bin'])
        || !isNonNegInt(l['requiredQty']) || !isStr(l['uom']) || !isNonNegInt(l['unitPriceMinor'])) return undefined;
    }
  }
  for (const r of body['routes']) {
    if (!isObj(r) || !isStr(r['routeId']) || !isStr(r['driverId']) || !isStr(r['assignedBy']) || !isStr(r['assignedAt']) || !Array.isArray(r['stops'])) return undefined;
    for (const s of r['stops']) {
      if (!isObj(s) || !isStr(s['stopId']) || !isStr(s['orderRef']) || !isStr(s['area']) || !isNonNegInt(s['codMinor'])) return undefined;
      if (s['costMinor'] !== undefined && !isNonNegInt(s['costMinor'])) return undefined;
      if (s['orderValueMinor'] !== undefined && !isNonNegInt(s['orderValueMinor'])) return undefined;
    }
    if (r['contributionRule'] !== undefined && (!isObj(r['contributionRule']) || !isNonNegInt(r['contributionRule']['maxCostShareBps']))) return undefined;
  }
  return body as unknown as AssignmentsFeed;
}

export type AssignmentsFeedFetch =
  | { readonly status: 'fetched'; readonly feed: AssignmentsFeed }
  /** Offline, timed out, a 5xx, an expired token, a body that is not a feed — keep what is held, try again. */
  | { readonly status: 'unreachable'; readonly reason: string };

export interface AssignmentsFeedSource {
  fetch(): Promise<AssignmentsFeedFetch>;
}

export interface HttpAssignmentsFeedSourceOptions {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  /** The store whose assignments this box serves — from the pack's policies. */
  readonly storeId: string;
  readonly timeoutMs?: number;
  /** Injected so the source stays testable without a network. */
  readonly fetch: typeof globalThis.fetch;
}

/** Reach the real endpoint: `GET /v1/fulfilment/assignments?storeId=` — the open assignments head office holds for this store. */
export function httpAssignmentsFeedSource(options: HttpAssignmentsFeedSourceOptions): AssignmentsFeedSource {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    fetch: async (): Promise<AssignmentsFeedFetch> => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const response = await options.fetch(`${base}/v1/fulfilment/assignments?storeId=${encodeURIComponent(options.storeId)}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${options.token}` },
          signal: controller.signal,
        });
        // Anything but a clean 200 is "could not get the assignments" — the status, never the body (#4).
        if (response.status < 200 || response.status >= 300) {
          return { status: 'unreachable', reason: `the cloud answered ${response.status} for the assignments` };
        }
        const feed = readAssignmentsFeed(await response.json() as unknown);
        if (feed === undefined) return { status: 'unreachable', reason: 'the cloud returned something that is not an assignments feed' };
        if (feed.storeId !== options.storeId) return { status: 'unreachable', reason: 'the cloud answered for a different store' };
        return { status: 'fetched', feed };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          status: 'unreachable',
          reason: aborted
            ? `no answer within ${timeoutMs}ms — the phones keep the assignments this box holds`
            : 'could not reach the cloud — the phones keep the assignments this box holds',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The minimal view of the box the puller drives — structurally satisfied by the composition root. */
export interface AssignmentsFeedReceiver {
  /** The assignments this box holds now, or undefined if it has never taken any. */
  heldFeed(): AssignmentsFeed | undefined;
  /** Take `feed` as the assignments this box serves from now on. Called for a newer AND for a re-confirmed one. */
  takeFeed(feed: AssignmentsFeed, receivedAt: string): void;
}

export type AssignmentsFeedPullStatus =
  /** A newer feed with different content was taken. The phones now show it. */
  | 'updated'
  /** The cloud re-confirmed what the box already holds (same assignments, newer clock). Taken, quietly. */
  | 'unchanged'
  /** A feed was seen and not taken — assembled before the one held. */
  | 'kept'
  /** The cloud could not be reached — held assignments kept, will try again next pass. */
  | 'offline';

export interface AssignmentsFeedPullOutcome {
  readonly status: AssignmentsFeedPullStatus;
  /** The cloud clock of the feed the box holds after this pull; null if it holds none. */
  readonly asAt: string | null;
  /** How far behind the cloud the held feed is, in minutes (P-08); null if none is held. */
  readonly ageMinutes: number | null;
  readonly staffMessage: string;
  /** Only for `offline` and `kept`: why. Never contains the token (#4). */
  readonly reason?: string;
}

/** The content of a feed with the clock taken off — what "the same assignments" means. */
export function assignmentsFeedDigest(feed: AssignmentsFeed): string {
  const waves = [...feed.waves].sort((a, b) => a.waveId.localeCompare(b.waveId));
  const routes = [...feed.routes].sort((a, b) => a.routeId.localeCompare(b.routeId));
  return JSON.stringify([feed.storeId, waves, routes]);
}

export function assignmentsAgeMinutes(asAt: string, now: string): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(asAt)) / 60_000));
}

/**
 * Pull the store's open assignments and, if the feed is not older than what is held, put the box on it.
 * `now` is injected so the reported age is deterministic.
 */
export async function pullAssignmentsFeed(input: {
  readonly source: AssignmentsFeedSource;
  readonly receiver: AssignmentsFeedReceiver;
  readonly now: string;
}): Promise<AssignmentsFeedPullOutcome> {
  const held = input.receiver.heldFeed();
  const shown = (): { asAt: string | null; ageMinutes: number | null } => {
    const h = input.receiver.heldFeed();
    return h === undefined ? { asAt: null, ageMinutes: null } : { asAt: h.asAt, ageMinutes: assignmentsAgeMinutes(h.asAt, input.now) };
  };
  const asOf = (): string => {
    const h = input.receiver.heldFeed();
    return h === undefined
      ? 'the box has not been told about any assignments yet'
      : `the box holds the assignments as of ${h.asAt} (${assignmentsAgeMinutes(h.asAt, input.now)} minute(s) behind the cloud)`;
  };

  const result = await input.source.fetch();
  if (result.status === 'unreachable') {
    return { status: 'offline', ...shown(), staffMessage: `Cloud not reachable — ${asOf()}.`, reason: result.reason };
  }
  const feed = result.feed;
  if (held !== undefined && Date.parse(feed.asAt) < Date.parse(held.asAt)) {
    return { status: 'kept', ...shown(), staffMessage: `The cloud answered with OLDER assignments than this box holds — ignored; ${asOf()}.`, reason: 'older than held' };
  }
  const changed = held === undefined || assignmentsFeedDigest(held) !== assignmentsFeedDigest(feed);
  input.receiver.takeFeed(feed, input.now);
  return {
    status: changed ? 'updated' : 'unchanged',
    ...shown(),
    staffMessage: changed
      ? `Assignments updated from head office (as of ${feed.asAt}: ${feed.waves.length} wave(s) to pick, ${feed.routes.length} route(s) to drive).`
      : `Assignments re-confirmed by head office (as of ${feed.asAt}).`,
  };
}
