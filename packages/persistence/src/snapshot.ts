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
}

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
  constructor(private readonly client: Pick<SqlClient, 'query'>) {}

  async load<S>(tenantId: string, stream: string, projection: string): Promise<Snapshot<S> | undefined> {
    const rows = await this.client.query<{ data: Snapshot<S> }>(
      'SELECT data FROM projection_snapshot WHERE tenant_id = $1 AND stream = $2 AND projection = $3',
      [tenantId, stream, projection],
    );
    // `data` is JSONB — the driver hands it back already parsed into the stored Snapshot.
    return rows[0]?.data;
  }

  async save<S>(snapshot: Snapshot<S>): Promise<void> {
    await this.client.query(
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
