// The inbound migration-register pull — Stage C3b (MG-04, MG-06, MG-10, §31, P-01, P-08, hard rule #4).
//
// The outbox drain carries the migration screen's DECISIONS up to the cloud (C3a: `MigrationExceptionResolved`,
// `MigrationTotalSigned`). Nothing carried the cloud's REGISTER down: the box read its migration sections from
// the store pack file once at boot, and nothing on the cloud ever produced that file. So the screen at the box
// showed whatever somebody had typed into a file, with none of the decisions the desk had since taken.
//
// This is the inbound mirror for the migration screen, shaped exactly like the catalogue pull
// (`pack-source.ts` / `pack-puller.ts`): a `MigrationFeedSource` fetches `GET /v1/migration/screen`, and
// `pullMigrationFeed` decides — without a network — whether the box takes what came back. The rules it shares
// with the catalogue pull:
//   • **Never put the token in a message.** A reason string reaches logs and support threads (#4).
//   • **Unreachable is not rejected.** A timeout, a 5xx, an expired token — the box keeps the register it
//     already holds and says how old it is (P-08), and tries again next pass (P-01).
//   • **Never go backwards.** A feed generated earlier than the one held (a stale replica, a replayed reply)
//     is kept out; so is another shop's.
//   • **A section the cloud did not send stays not known.** The puller hands the feed over whole; the store
//     pack decides what each absence means — this layer never fills one in.

/** The feed as the box reads it: the few fields it interprets typed, the rest carried whole to the screen. */
export interface MigrationFeed {
  readonly tenantId: string;
  /** The cloud's clock when the feed was assembled — the screen's "as of". */
  readonly generatedAt: string;
  readonly policy?: { readonly cutoverId: string; readonly requiredCleanDays: number; readonly [k: string]: unknown };
  readonly loadOperator?: string;
  readonly rollbackDemonstratedAt?: string;
  readonly exceptions?: readonly unknown[];
  readonly totals?: readonly unknown[];
  readonly refusedDecisions?: readonly unknown[];
  readonly parallelDays?: readonly unknown[];
  readonly parallelDifferences?: readonly unknown[];
  readonly rollbacks?: readonly unknown[];
  readonly exclusions?: readonly unknown[];
  readonly verification?: Readonly<Record<string, unknown>>;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const LIST_SECTIONS = ['exceptions', 'totals', 'refusedDecisions', 'parallelDays', 'parallelDifferences', 'rollbacks', 'exclusions'] as const;

/**
 * Read a body as a feed, or say it is not one. Strict on the fields the box INTERPRETS (tenant, clock, the
 * policy's id and clean-day count), lenient on the sections it only carries — those are the screen's to read.
 * A garbled answer is treated as unreachable by the source, never handed to the screen.
 */
export function readMigrationFeed(body: unknown): MigrationFeed | undefined {
  if (!isObj(body) || !isStr(body['tenantId']) || !isStr(body['generatedAt']) || Number.isNaN(Date.parse(body['generatedAt']))) return undefined;
  const policy = body['policy'];
  if (policy !== undefined) {
    if (!isObj(policy) || !isStr(policy['cutoverId'])) return undefined;
    const days = policy['requiredCleanDays'];
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) return undefined;
  }
  for (const s of LIST_SECTIONS) if (body[s] !== undefined && !Array.isArray(body[s])) return undefined;
  for (const s of ['loadOperator', 'rollbackDemonstratedAt'] as const) if (body[s] !== undefined && !isStr(body[s])) return undefined;
  if (body['verification'] !== undefined && !isObj(body['verification'])) return undefined;
  return body as unknown as MigrationFeed;
}

/** The result of trying to fetch the migration register from the cloud. */
export type MigrationFeedFetch =
  | { readonly status: 'fetched'; readonly feed: MigrationFeed }
  /** Offline, timed out, a 5xx, an expired token, a body that is not a feed — keep what is held, try again. */
  | { readonly status: 'unreachable'; readonly reason: string };

export interface MigrationFeedSource {
  fetch(): Promise<MigrationFeedFetch>;
}

export interface HttpMigrationFeedSourceOptions {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  readonly timeoutMs?: number;
  /** Injected so the source stays testable without a network. */
  readonly fetch: typeof globalThis.fetch;
}

/** Reach the real endpoint. `GET /v1/migration/screen` returns the tenant's `MigrationScreenFeed`. */
export function httpMigrationFeedSource(options: HttpMigrationFeedSourceOptions): MigrationFeedSource {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    fetch: async (): Promise<MigrationFeedFetch> => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const response = await options.fetch(`${base}/v1/migration/screen`, {
          method: 'GET',
          headers: { authorization: `Bearer ${options.token}` },
          signal: controller.signal,
        });
        // Anything but a clean 200 is "could not get the register" — a 403 (the box's login lacks the read),
        // a 401 (token expired), a 5xx. The status, never the body: a body can echo the request (#4).
        if (response.status < 200 || response.status >= 300) {
          return { status: 'unreachable', reason: `the cloud answered ${response.status} for the migration register` };
        }
        const feed = readMigrationFeed(await response.json() as unknown);
        if (feed === undefined) return { status: 'unreachable', reason: 'the cloud returned something that is not a migration register' };
        return { status: 'fetched', feed };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          status: 'unreachable',
          reason: aborted
            ? `no answer within ${timeoutMs}ms — the migration screen keeps the register this box holds`
            : 'could not reach the cloud — the migration screen keeps the register this box holds',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The minimal view of the box the puller drives — structurally satisfied by the composition root. */
export interface MigrationFeedReceiver {
  readonly tenantId: string;
  /** The feed this box holds now, or undefined if it has never taken one. */
  heldFeed(): MigrationFeed | undefined;
  /** Take `feed` as the register this box shows from now on. Called for a newer AND for a re-confirmed one. */
  takeFeed(feed: MigrationFeed, receivedAt: string): void;
}

export type MigrationFeedPullStatus =
  /** A newer register with different content was taken. The screen now shows it. */
  | 'updated'
  /** The cloud re-confirmed the register the box already shows (same content, newer clock). Taken, quietly. */
  | 'unchanged'
  /** A feed was seen and not taken — another shop's, or generated before the one held. */
  | 'kept'
  /** The cloud could not be reached — held register kept, will try again next pass. */
  | 'offline';

export interface MigrationFeedPullOutcome {
  readonly status: MigrationFeedPullStatus;
  /** The cloud clock of the register the box shows after this pull; null if it holds none. */
  readonly generatedAt: string | null;
  /** How far behind the cloud the shown register is, in hours (P-08); null if none is held. */
  readonly ageHours: number | null;
  readonly staffMessage: string;
  /** Only for `offline` and `kept`: why. Never contains the token (#4). */
  readonly reason?: string;
}

/** The content of a feed with the clock taken off — what "the same register" means. */
export function feedDigest(feed: MigrationFeed): string {
  return JSON.stringify(Object.fromEntries(Object.entries(feed).filter(([key]) => key !== 'generatedAt')));
}

export function feedAgeHours(generatedAt: string, now: string): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(generatedAt)) / 3_600_000));
}

/**
 * Pull the cloud's migration register and, if it is this shop's and not older than what is held, put the box
 * on it. `now` is injected so the reported age is deterministic.
 */
export async function pullMigrationFeed(input: {
  readonly source: MigrationFeedSource;
  readonly receiver: MigrationFeedReceiver;
  readonly now: string;
}): Promise<MigrationFeedPullOutcome> {
  const held = input.receiver.heldFeed();
  const shown = (): { generatedAt: string | null; ageHours: number | null } => {
    const h = input.receiver.heldFeed();
    return h === undefined
      ? { generatedAt: null, ageHours: null }
      : { generatedAt: h.generatedAt, ageHours: feedAgeHours(h.generatedAt, input.now) };
  };
  const asOf = (): string => {
    const h = input.receiver.heldFeed();
    return h === undefined
      ? 'the migration screen has not been told anything by the cloud yet'
      : `the migration screen shows the register as of ${h.generatedAt} (${feedAgeHours(h.generatedAt, input.now)} hour(s) behind the cloud)`;
  };

  const result = await input.source.fetch();
  if (result.status === 'unreachable') {
    return { status: 'offline', ...shown(), staffMessage: `Cloud not reachable — ${asOf()}.`, reason: result.reason };
  }
  const feed = result.feed;
  if (feed.tenantId !== input.receiver.tenantId) {
    return { status: 'kept', ...shown(), staffMessage: `The cloud answered with another shop's migration register — ignored; ${asOf()}.`, reason: 'tenant mismatch' };
  }
  if (held !== undefined && Date.parse(feed.generatedAt) < Date.parse(held.generatedAt)) {
    return { status: 'kept', ...shown(), staffMessage: `The cloud answered with an OLDER migration register than this box holds — ignored; ${asOf()}.`, reason: 'older than held' };
  }
  const changed = held === undefined || feedDigest(held) !== feedDigest(feed);
  input.receiver.takeFeed(feed, input.now);
  const sections = LIST_SECTIONS.filter((s) => feed[s] !== undefined).length + (feed.policy === undefined ? 0 : 1);
  return {
    status: changed ? 'updated' : 'unchanged',
    ...shown(),
    staffMessage: changed
      ? `Migration register updated from the cloud (as of ${feed.generatedAt}, ${sections} section(s)${feed.policy === undefined ? ', no cutover terms written yet' : `, cutover ${feed.policy.cutoverId}`}).`
      : `Migration register re-confirmed by the cloud (as of ${feed.generatedAt}).`,
  };
}
