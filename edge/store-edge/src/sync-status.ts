// The box's own account of its link to head office, for the sync badge on every served screen.
//
// Design system §1 rule 4: EVERY screen shows connection state (online · degraded · offline · reconnecting), the
// unsent count and last-sync freshness. Until Stage G slice 2 the till's badge said "Online · Unsent: 0" from a
// state nothing ever set — the shell had no fact to show, so it showed a constant, which is the one thing a sync
// badge must never do (P-08). The box is the one thing on a shop PC that actually knows: it owns the outboxes,
// it drains them, it pulls the catalogue. This is that knowledge as one small, honest answer, computed on
// request from what the box already records. Pure, so it is proven in a unit test; the lane socket serves it
// read-only (`GET /lane/sync-status`) and the screens poll it.

import type { PackPullStatus } from '../../sync-agent/src/pack-puller';

/** The box's link to head office, as far as the box can tell. */
export type CloudLink =
  /** The box is still starting: the queues exist, the agents that drain them do not yet. */
  | 'starting'
  /** No cloud is configured on this box — a standalone lane. Nothing will be sent from here until one is. */
  | 'not_configured'
  /** A cloud is configured but no pass has run yet — nothing to say either way, and it says so. */
  | 'unknown'
  /** The last pass reached head office. */
  | 'online'
  /** The last pass could not reach head office. Selling continues; the queue holds (P-01). */
  | 'offline';

/** What one drain queue reports — the shape `SyncAgent.health()` returns. */
export interface QueueHealth {
  readonly unsentCount: number;
  readonly deadLetterCount: number;
  readonly lastSuccessAt: string | null;
}

/** Where the box's store setup came from (PA-06 = DF-3-a · P-08): head office (signed, versioned), a file, or nothing. */
export interface StoreSetupStatus {
  readonly source: 'head-office' | 'file' | 'none';
  readonly version: number;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  /** Past its expiry: the till keeps trading on it (P-01) and the badge says so. */
  readonly expired: boolean;
}

export interface LaneSyncStatus {
  readonly cloud: CloudLink;
  /** Everything on this box waiting to go: sales, refunds, completions, day closes, partner-counter lines. */
  readonly unsent: number;
  /** Items head office refused that a person must look at. Never deleted (hard rule #6). */
  readonly deadLettered: number;
  /** When something from this box last reached head office, or null if nothing ever has. */
  readonly lastSentAt: string | null;
  /** When head office last answered this box at all — a send or a catalogue check — or null if never. */
  readonly lastContactAt: string | null;
  /** The box's clock when it answered, so a screen can show freshness without trusting its own clock. */
  readonly now: string;
  /** One sentence a cashier or manager can act on (P-08). The screens translate the STATE; this is for logs. */
  readonly staffMessage: string;
}

const latest = (times: readonly (string | null)[]): string | null => {
  let best: string | null = null;
  for (const t of times) {
    if (t === null) continue;
    if (best === null || Date.parse(t) > Date.parse(best)) best = t;
  }
  return best;
};

const held = (unsent: number, tail: string): string =>
  unsent === 0 ? 'Nothing is waiting to be sent.' : `${unsent} item(s) are saved on this box${tail}.`;

export function laneSyncStatus(input: {
  readonly configured: boolean | 'starting';
  readonly queues: readonly QueueHealth[];
  /** The last catalogue pull's outcome: `offline` is the box's most recent word on reachability. */
  readonly lastPackStatus: PackPullStatus | undefined;
  /** The box's own record of the last time head office answered a pull, if it keeps one. */
  readonly lastContactAt: string | null;
  readonly now: string;
}): LaneSyncStatus {
  const unsent = input.queues.reduce((n, q) => n + q.unsentCount, 0);
  const deadLettered = input.queues.reduce((n, q) => n + q.deadLetterCount, 0);
  const lastSentAt = latest(input.queues.map((q) => q.lastSuccessAt));
  const lastContactAt = latest([input.lastContactAt, lastSentAt]);

  const cloud: CloudLink = input.configured === 'starting' ? 'starting'
    : input.configured === false ? 'not_configured'
      : input.lastPackStatus === 'offline' ? 'offline'
        : input.lastPackStatus !== undefined || lastSentAt !== null ? 'online'
          : 'unknown';

  const refused = deadLettered === 0 ? '' : `${deadLettered} item(s) head office refused are waiting for a person to look at them. `;
  const staffMessage = refused + (
    cloud === 'starting' ? 'The store box is still starting up.'
      : cloud === 'not_configured' ? `No head office link is set up on this box. ${held(unsent, ' and will go only when a link is set up')}`
        : cloud === 'unknown' ? `Head office has not been checked yet. ${held(unsent, ' and will go on the first pass')}`
          : cloud === 'online' ? (unsent === 0 ? 'Everything has reached head office.' : `${unsent} item(s) still to send; head office answered at ${lastContactAt}.`)
            : `Head office could not be reached. ${held(unsent, ' and will go when the line is back')}${lastContactAt === null ? ' It has never been reached from this box.' : ` Last contact ${lastContactAt}.`}`
  );

  return { cloud, unsent, deadLettered, lastSentAt, lastContactAt, now: input.now, staffMessage };
}
