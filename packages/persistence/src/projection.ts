// Projections / read models (§29 reporting note, P-08) — reporting owns no source
// tables: a read model is DERIVED by folding the append-only event ledger, and is
// rebuildable at any time. Each projection tracks a WATERMARK (the highest event seq
// it has folded) so it can resume incrementally, and the time of the last event it
// saw, which feeds the data-freshness indicator (packages/reporting) — stale data is
// shown as such, never as fresh. Pure and deterministic: the fold is a plain reducer
// over domain events, exactly like the ledger's own `project`.

import type { DomainEvent } from '../../contracts/src/event';
import type { PersistedEvent } from './event-store';

/** A read-model definition: an initial state and a reducer over domain events. */
export interface Projection<S, TType extends string = string, TPayload = unknown> {
  readonly initial: S;
  apply(state: S, event: DomainEvent<TType, TPayload>): S;
}

export interface ProjectionResult<S> {
  readonly state: S;
  /** Highest event seq folded so far (the resume point). */
  readonly watermarkSeq: number;
  /** occurredAt of the last event folded — feeds the freshness indicator (P-08). */
  readonly lastEventAt: string | null;
  readonly eventCount: number;
}

/** A fresh (empty) projection result for an initial state. */
export function emptyProjectionResult<S>(initial: S): ProjectionResult<S> {
  return { state: initial, watermarkSeq: 0, lastEventAt: null, eventCount: 0 };
}

/**
 * Fold persisted events into a read model. Applies only events past the prior
 * watermark, in seq order, so a re-run picks up exactly the new events (incremental
 * projection) and a fold from the empty result rebuilds the model from scratch.
 * Pure — no I/O.
 */
export function runProjection<S>(
  events: readonly PersistedEvent[],
  projection: Projection<S>,
  prior?: ProjectionResult<S>,
): ProjectionResult<S> {
  let state = prior ? prior.state : projection.initial;
  let watermarkSeq = prior ? prior.watermarkSeq : 0;
  let lastEventAt = prior ? prior.lastEventAt : null;
  let eventCount = prior ? prior.eventCount : 0;

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const persisted of ordered) {
    if (persisted.seq <= watermarkSeq) continue; // already folded
    state = projection.apply(state, persisted.event);
    watermarkSeq = persisted.seq;
    lastEventAt = persisted.event.occurredAt;
    eventCount += 1;
  }

  return { state, watermarkSeq, lastEventAt, eventCount };
}

/** The minimal read interface a projection folds over (satisfied by an EventStore). */
export interface StreamReader {
  readStream(tenantId: string, stream: string): Promise<readonly PersistedEvent[]>;
}

/**
 * Project a tenant's event stream into a read model, resuming from `prior` (or
 * rebuilding from scratch when omitted). The read model plus its watermark is what a
 * reporting layer persists and serves, with the freshness derived from `lastEventAt`.
 */
export async function projectStream<S>(
  reader: StreamReader,
  tenantId: string,
  stream: string,
  projection: Projection<S>,
  prior?: ProjectionResult<S>,
): Promise<ProjectionResult<S>> {
  const events = await reader.readStream(tenantId, stream);
  return runProjection(events, projection, prior);
}
