// The inbound pack pull, joined up — SYNC-01 (audit GAP-SYNC-01), §31, P-01, P-02, P-08.
//
// `PackSource` gets bytes from the cloud; `acceptPack` (via the edge's `takePack`) decides whether
// the lane trusts them. `pullPack` is the thin orchestration between the two — the inbound mirror of
// `SyncAgent.drain` — and it reimplements NEITHER: the fetch is the port, the trust decision is the
// one function the service and the tests already share, and staleness is `packFreshness`. Its whole
// job is to run them in the right order and report, in words a manager can act on, what the lane is
// now trading on and how old that is (P-08 — visible, never inferred).
//
// The rule that matters is the same one `acceptPack` holds: whatever happens — offline, a bad
// signature, an older pack, no pack published — **the lane keeps trading on the last pack it
// trusted** (P-01). A pull can only ever move the lane FORWARD to a newer, verified pack; it can
// never blank the catalogue or stop the till.

import { packFreshness, type SignedPack } from '../../../services/catalogue/src/pack';
import type { PackSource } from './pack-source';

/**
 * The minimal view of the edge the puller drives — structurally satisfied by `EdgeNode`
 * (`edge/store-edge`). Taken as an interface, not the concrete node, so the puller depends only on
 * the trust decision, not on the box's disk or lanes.
 */
export interface PackReceiver {
  /** The pack the lane is trading on now, or undefined if it has never trusted one. */
  pack(): SignedPack | undefined;
  /** Verify and, if trusted and newer, adopt `incoming`; otherwise keep the held pack. */
  takePack(incoming: SignedPack): { readonly accepted: boolean; readonly staffMessage: string };
}

export type PackPullStatus =
  /** A newer, verified pack was adopted. The lane is now on it. */
  | 'updated'
  /** A pack was seen but not adopted (bad signature, older, wrong tenant) — held pack kept. */
  | 'kept'
  /** The cloud has no catalogue published for this tenant yet. */
  | 'none_published'
  /** The cloud could not be reached — held pack kept, will try again next pass. */
  | 'offline';

export interface PackPullOutcome {
  readonly status: PackPullStatus;
  /** The version the lane is trading on after this pull; null if it still holds no pack. */
  readonly heldVersion: number | null;
  /** How stale the held pack is, in hours (P-08 visible staleness); null if no pack is held. */
  readonly ageHours: number | null;
  /** What to tell staff — the lane's own words when a pack was checked, else a plain line. */
  readonly staffMessage: string;
  /** Only for `offline`: why the cloud could not be reached. Never contains the token (#4). */
  readonly reason?: string;
}

/**
 * Pull the cloud's current pack and, if it is newer and verifies, put the lane on it.
 *
 * `now` is injected (the box has a local clock, but a pure function is what the tests drive) so the
 * reported age is deterministic. Returns exactly what the lane is trading on afterwards and how old
 * it is, so the poll loop can log it and a screen can show it.
 */
export async function pullPack(input: {
  readonly source: PackSource;
  readonly receiver: PackReceiver;
  readonly now: string;
}): Promise<PackPullOutcome> {
  const fetched = await input.source.fetch();

  // The freshness of whatever the lane holds RIGHT NOW — computed the same way in every branch, so
  // the age reported is always the age of the pack the lane is actually on.
  const freshnessOfHeld = (): { heldVersion: number | null; ageHours: number | null } => {
    const held = input.receiver.pack();
    return held === undefined
      ? { heldVersion: null, ageHours: null }
      : { heldVersion: held.snapshot.version, ageHours: packFreshness(held, input.now).ageHours };
  };

  if (fetched.status === 'unreachable') {
    const held = input.receiver.pack();
    return {
      status: 'offline',
      ...freshnessOfHeld(),
      reason: fetched.reason,
      staffMessage: held === undefined
        ? 'Could not reach the cloud, and this lane has no catalogue yet. Tell the manager before opening.'
        : `Could not reach the cloud to refresh the catalogue. Still selling from v${held.snapshot.version} — the last one this lane trusted.`,
    };
  }

  if (fetched.status === 'none_published') {
    const held = input.receiver.pack();
    return {
      status: 'none_published',
      ...freshnessOfHeld(),
      staffMessage: held === undefined
        ? 'The cloud has no catalogue published yet. This lane cannot price a scan until one is.'
        : `The cloud has no catalogue published. Still selling from v${held.snapshot.version}.`,
    };
  }

  // A pack came back. The lane — not this function — decides whether to trust it (signature, tenant,
  // version-not-backward), through the exact same `acceptPack` the service and the tests use.
  const result = input.receiver.takePack(fetched.pack);
  return { status: result.accepted ? 'updated' : 'kept', ...freshnessOfHeld(), staffMessage: result.staffMessage };
}
