// Snapshots for projections (CORE-03 / §30.2, ADR-A03-adjacent).
//
// A read model is a fold of the append-only ledger, and a fold that always starts at seq 0 grows
// without bound as the shop trades — the busiest read in the system (the owner's daily figures)
// re-reads every sale ever made, forever. A snapshot is the folded state at a WATERMARK, persisted,
// so a later read folds only the events SINCE it — the tail behind the snapshot — instead of the
// whole of history again.
//
// The ledger stays the only truth. A snapshot is DERIVED and DISPOSABLE: delete every snapshot and
// the next read rebuilds an identical model from the events (proved by test). So this changes only
// the cost of reading the truth, never the truth — hard rule #2 is about the ledger, which a
// snapshot never replaces, and hard rule #10 is unaffected because nothing here resolves anything.

import type { EventStore } from './event-store';
import type { SqlClient } from './sql-client';
import { scopedTo } from './sql-client';
import { runProjection, type Projection, type ProjectionResult } from './projection';

/** A persisted fold: a projection's state at a watermark, for one tenant / stream / projection. */
export interface Snapshot<S> {
  readonly tenantId: string;
  readonly stream: string;
  /**
   * The projection's identity. **Include a version** (e.g. `owner-kpis@2`): a snapshot is the shape
   * a specific reducer produced, and resuming a changed reducer from an old shape is a silent
   * corruption. Bump the name when the reducer changes and old snapshots are simply ignored, then
   * rebuilt — never misread.
   */
  readonly projection: string;
  readonly result: ProjectionResult<S>;
  readonly takenAt: string;
}

/**
 * Where snapshots live. A snapshot is derived state, never a source of truth: losing one costs a
 * rebuild, never data. Keyed by (tenant, stream, projection) — the newest write for a key wins.
 */
export interface SnapshotStore {
  load<S>(tenantId: string, stream: string, projection: string): Promise<Snapshot<S> | undefined>;
  save<S>(snapshot: Snapshot<S>): Promise<void>;
  /**
   * Round 34 · OB-124 (5): take the CLUSTER-WIDE lease to build one tenant's projection (`name`) — so two head-office
   * processes on one database never build it at the same time. Answers a release function while this caller holds it, or
   * undefined when another process holds it now (never waits). OPTIONAL: a store without it (memory) relies on the calling
   * process's own single-flight guard, which is the whole story there.
   */
  buildLease?(tenantId: string, name: string): Promise<BuildLeaseAnswer>;
}

/** Round 34 · OB-124 (5): the advisory-lock class of the projection build leases (two-key form; its own key space). */
export const PROJECTION_BUILD_LEASE_CLASS = 340_124;

/**
 * Round 35 · verifier r34 NEW-4: a build lease while it is held — call it to let go. `lost()` turns true when the database
 * session holding it ended under it (an idle-session timeout, a network cut, an administrator): the lock went with that
 * session, so another process may take it — the build stops at its next step rather than build alongside it.
 */
export interface BuildLeaseHeld {
  (): Promise<void>;
  readonly lost: () => boolean;
  /**
   * Round 36 · verifier r35 NEW-5: the build is over but its result waits to be saved — move this lease out of the BUILDS'
   * count (`maxConcurrentLeases`) into the KEPT count (`maxKeptLeases`), so a lease kept for up to 30 minutes never makes another
   * shop (a small one in particular) wait its turn. False: no room to keep it (the caller lets go). Absent: kept as it is.
   */
  readonly keep?: () => boolean;
}
/**
 * Round 35 · verifier r34 NEW-2: this process already holds as many build leases as it may (`maxConcurrentLeases`) — the
 * build waits for its turn (said, never waited on), so builds can never use up head office's connections.
 */
export const BUILD_LEASES_BUSY_HERE = 'busy_here' as const;
/** Held; undefined — another process holds it now; or this process is at its limit of builds at once. */
export type BuildLeaseAnswer = BuildLeaseHeld | undefined | typeof BUILD_LEASES_BUSY_HERE;

/** Round 35 · NEW-2/NEW-3: a database session of its own for one build lease (`pgDedicatedSession`), ended when `fn` settles. */
export type LeaseSession = <T>(fn: (conn: Pick<SqlClient, 'query'>, ended: () => unknown) => Promise<T>) => Promise<T>;

export interface SqlSnapshotStoreOptions {
  /**
   * Round 35 · verifier r34 NEW-2: where a build lease's session comes from — a connection of its OWN, outside the pool that
   * serves requests (`pgDedicatedSession`), opened for the lease and closed after it (its lock can never go back into a pool).
   * Absent: a connection from the client's pool (`client.session`), discarded afterwards — then at most
   * `maxConcurrentLeases` (default 1) are ever held, so builds never hold the request pool's connections.
   */
  readonly leaseSession?: LeaseSession;
  /** How many build leases this process may hold at once (default 4 with `leaseSession`, else 1). The next waits its turn. */
  readonly maxConcurrentLeases?: number;
  /**
   * Round 36 · verifier r35 NEW-5: how many leases this process may KEEP after their builds, waiting to save (default 4 with
   * `leaseSession`, counted apart from the builds; on the pool's fallback there is no separate room — a kept lease stays in the
   * builds' count of 1, so the request pool is never used up).
   */
  readonly maxKeptLeases?: number;
  /** Round 35 · NEW-3: said when letting go of a lease failed (by name; the session is ended so the lock goes with it). */
  readonly onLeaseProblem?: (detail: string) => void;
}

/** Round 35 · verifier r34 NEW-3: letting go of a build lease failed — the session holding it is ended, never reused. */
export class BuildLeaseUnlockError extends Error {
  override readonly name = 'BuildLeaseUnlockError';
}
const describeError = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? `${code}: ${e.message}` : e.message;
};

/**
 * In-memory snapshot store (edge / test). The durable SQL store that persists the state as JSON is
 * a later increment; because a snapshot is disposable, an empty store is always a correct start —
 * it just means the first read folds from seq 0.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly byKey = new Map<string, Snapshot<unknown>>();

  private key(tenantId: string, stream: string, projection: string): string {
    // NUL-separated, never concatenated — a key that can collide is not one (as `event-store` keys
    // its idempotency map). Written as the escape, never a literal control byte (hard rule #8).
    return `${tenantId}\u0000${stream}\u0000${projection}`;
  }

  load<S>(tenantId: string, stream: string, projection: string): Promise<Snapshot<S> | undefined> {
    return Promise.resolve(this.byKey.get(this.key(tenantId, stream, projection)) as Snapshot<S> | undefined);
  }

  save<S>(snapshot: Snapshot<S>): Promise<void> {
    this.byKey.set(this.key(snapshot.tenantId, snapshot.stream, snapshot.projection), snapshot as Snapshot<unknown>);
    return Promise.resolve();
  }
}

/**
 * Durable snapshot store, backed by the `projection_snapshot` table (migration 0011). Survives a
 * restart, so a cold process resumes each projection from its last persisted fold instead of
 * re-folding the whole ledger. The whole `Snapshot` is stored as one JSONB `data`, keyed by
 * (tenant, stream, projection) — so the projection's STATE must be JSON-serialisable, which is the
 * one constraint this store adds over the in-memory one. `save` UPSERTs (the newest fold wins).
 */
export class SqlSnapshotStore implements SnapshotStore {
  /** Round 35 · NEW-2: the build leases this store holds now (each one session). */
  private leasesHeld = 0;
  /** Round 36 · NEW-5: the leases kept after their builds, waiting to save (each one session; not in `leasesHeld`). */
  private leasesKept = 0;

  constructor(private readonly client: Pick<SqlClient, 'query' | 'forTenant' | 'session'>, private readonly opts: SqlSnapshotStoreOptions = {}) {}

  /** Round 35 · NEW-2: how many build leases this store holds right now (for the tests and support). */
  get buildLeasesHeld(): number { return this.leasesHeld; }
  /** Round 36 · NEW-5: how many leases this store keeps after their builds right now (for the tests and support). */
  get buildLeasesKept(): number { return this.leasesKept; }

  /**
   * Round 34 · OB-124 (5): a PostgreSQL session-level advisory lock (`pg_try_advisory_lock`, never waiting) on its own
   * connection, outside any transaction, held until the release function is called — or until that connection ends (a
   * crashed process lets go by itself; a lock never outlives its holder, so no lease row can be left stuck). Keyed on the
   * tenant and the projection (`hashtext`; two keys sharing a hash only take turns). A client with no sessions holds no lock:
   * the lease is then granted at once and the process's own guard is all there is (said in the type).
   *
   * Round 35 (verifier r34): NEW-2 — the session is a connection of its own (`leaseSession`), never one the requests need, and
   * no more than `maxConcurrentLeases` are held at once (`BUILD_LEASES_BUSY_HERE` beyond that, never a wait); NEW-3 — the
   * session is ENDED after the lease (a pooled one is discarded, never handed back), so a lock whose unlock failed can never
   * go back into a pool still held; the failure is said by name (`onLeaseProblem`) and never swallowed; NEW-4 — the answer's
   * `lost()` says when the session ended under the lease.
   */
  buildLease(tenantId: string, name: string): Promise<BuildLeaseAnswer> {
    const session: LeaseSession | undefined = this.opts.leaseSession
      ?? (this.client.session === undefined ? undefined : (this.client.session.bind(this.client) as LeaseSession));
    if (session === undefined) return Promise.resolve(Object.assign(async () => undefined, { lost: () => false }));
    const max = this.opts.maxConcurrentLeases ?? (this.opts.leaseSession === undefined ? 1 : 4);
    if (this.leasesHeld >= max) return Promise.resolve(BUILD_LEASES_BUSY_HERE);
    this.leasesHeld += 1;
    let freed = false;
    let kept = false;
    const free = (): void => { if (!freed) { freed = true; if (kept) this.leasesKept -= 1; else this.leasesHeld -= 1; } };
    // Round 36 · NEW-5: moved to the kept count (with its own room) once its build is over — never blocking other builds.
    const separate = this.opts.leaseSession !== undefined;
    const maxKept = this.opts.maxKeptLeases ?? (separate ? 4 : 0);
    const keep = (): boolean => {
      if (freed || kept) return !freed;
      if (!separate) return true; // the pool's fallback: it stays in the builds' count
      if (this.leasesKept >= maxKept) return false;
      kept = true; this.leasesHeld -= 1; this.leasesKept += 1;
      return true;
    };
    const say = this.opts.onLeaseProblem ?? ((detail: string) => { process.stderr.write(`${detail}\n`); });
    const key = `${tenantId}:${name}`;
    return new Promise((resolve, reject) => {
      let answered = false;
      let over = false;
      let letGo: () => void = () => undefined;
      const released = new Promise<void>((r) => { letGo = r; });
      const held: Promise<void> = session<void>(async (conn, ended) => {
        const rows = await conn.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS got', [PROJECTION_BUILD_LEASE_CLASS, key]);
        if (rows[0]?.got !== true) { free(); answered = true; resolve(undefined); return; }
        answered = true;
        resolve(Object.assign(async () => { letGo(); await held.catch(() => undefined); }, { lost: () => over || ended() !== undefined, keep }));
        await released;
        if (ended() !== undefined) return; // the session already ended: the lock went with it
        let unlocked: boolean;
        try {
          unlocked = (await conn.query<{ ok: boolean }>('SELECT pg_advisory_unlock($1::int, hashtext($2)) AS ok', [PROJECTION_BUILD_LEASE_CLASS, key]))[0]?.ok === true;
        } catch (e) {
          say(`projection build lease ${key}: letting go failed (${describeError(e)}) — its database session is ended so the lock goes with it (BuildLeaseUnlockError)`);
          throw new BuildLeaseUnlockError(`letting go of the build lease ${key} failed: ${describeError(e)}`);
        }
        if (!unlocked) {
          say(`projection build lease ${key}: the database said it was not held when letting go — its database session is ended (BuildLeaseUnlockError)`);
          throw new BuildLeaseUnlockError(`the build lease ${key} was not held when letting go`);
        }
      }).finally(() => { over = true; free(); });
      held.catch((e: unknown) => {
        if (!answered) { reject(e); return; }
        // Said by name (above) for an unlock; any other failure after the lease was granted is said here — never swallowed.
        if (!(e instanceof BuildLeaseUnlockError)) say(`projection build lease ${key}: its database session failed (${describeError(e)}); the session is ended so the lock goes with it`);
      });
    });
  }

  async load<S>(tenantId: string, stream: string, projection: string): Promise<Snapshot<S> | undefined> {
    const rows = await scopedTo(this.client, tenantId).query<{ data: Snapshot<S> }>(
      'SELECT data FROM projection_snapshot WHERE tenant_id = $1 AND stream = $2 AND projection = $3',
      [tenantId, stream, projection],
    );
    // `data` is JSONB — the driver hands it back already parsed into the stored Snapshot.
    return rows[0]?.data;
  }

  async save<S>(snapshot: Snapshot<S>): Promise<void> {
    await scopedTo(this.client, snapshot.tenantId).query(
      `INSERT INTO projection_snapshot (tenant_id, stream, projection, data)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (tenant_id, stream, projection)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [snapshot.tenantId, snapshot.stream, snapshot.projection, JSON.stringify(snapshot)],
    );
  }
}

export interface SnapshotProjectionOptions {
  /**
   * Take a fresh snapshot once this many events have accrued SINCE THE LAST ONE. Default 500. A
   * snapshot on every read would write more than it saves; too rare and the tail grows unbounded.
   * `0` disables writing (read-through only) — useful when a caller wants snapshot resume without
   * paying to advance it.
   */
  readonly snapshotEvery?: number;
  /**
   * Fold only events of this type — narrowed at the store (`readStream`'s `type`), alongside the
   * snapshot's `sinceSeq`. When a projection cares about one kind of event on a shared stream (the
   * credit notes among the journals), reading the whole stream to ignore most of it is the cost a
   * snapshot exists to remove; the watermark then advances by that type's own seq, which is exactly
   * what a resume of that projection needs.
   */
  readonly eventType?: string;
  /** Injected clock for `takenAt` — the codebase forbids an ambient `now` (it would break resume). */
  readonly now?: () => string;
}

/**
 * Fold a projection resuming from its latest snapshot.
 *
 *   1. load the snapshot for (tenant, stream, projection);
 *   2. read only the events AFTER its watermark (`sinceSeq` — narrowed at the store, not in memory,
 *      so the read is genuinely cheaper and not merely filtered afterwards);
 *   3. fold that tail onto the snapshot's state;
 *   4. when enough new events have accrued, persist a fresh snapshot so the NEXT read's tail stays
 *      bounded.
 *
 * Equivalent to a full fold by construction: `runProjection(tail, projection, snapshot.result)`
 * applies exactly the events — in seq order, each once — that a from-scratch fold would apply after
 * the watermark. The equivalence is pinned by test, because a snapshot that disagrees with the
 * events is the one bug that turns a performance feature into a correctness one.
 */
export async function projectFromSnapshot<S>(
  reader: Pick<EventStore, 'readStream'>,
  snapshots: SnapshotStore,
  tenantId: string,
  stream: string,
  projectionName: string,
  projection: Projection<S>,
  opts?: SnapshotProjectionOptions,
): Promise<ProjectionResult<S>> {
  const prior = await snapshots.load<S>(tenantId, stream, projectionName);
  const priorResult = prior?.result;
  const priorWatermark = priorResult?.watermarkSeq ?? 0;

  const tail = await reader.readStream(tenantId, stream, {
    sinceSeq: priorWatermark,
    ...(opts?.eventType === undefined ? {} : { type: opts.eventType }),
  });
  const result = runProjection(tail, projection, priorResult);

  const every = opts?.snapshotEvery ?? 500;
  const accrued = result.eventCount - (priorResult?.eventCount ?? 0);
  if (every > 0 && accrued >= every && result.watermarkSeq > priorWatermark) {
    await snapshots.save<S>({
      tenantId,
      stream,
      projection: projectionName,
      result,
      // The moment the snapshot is TRUE as of — the last event it folded, unless the caller injects
      // a clock. Never an ambient `Date.now()`.
      takenAt: opts?.now?.() ?? result.lastEventAt ?? '',
    });
  }

  return result;
}
