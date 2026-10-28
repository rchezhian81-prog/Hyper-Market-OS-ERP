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
import type { StoreComputerStatus } from './store-computer-status-file';

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
  | 'offline'
  /**
   * OB-429: head office refused this box's own login, so the box has stopped contacting it (one failed sign-in at head
   * office, never the five that would lock the shop's address). Selling continues; the queue holds until the login is
   * renewed and the box restarted.
   */
  | 'login_refused';

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
  /**
   * Audit row 6: the STORE COMPUTER's own check (store-computer status) — backup age, the till's queue, the disk, the
   * containers — read from its status file. Absent on a box that is not the shop's store computer (no file configured).
   */
  readonly storeComputer?: StoreComputerStatus;
  /**
   * OB-403 "A" · §31.1: while this box's clock is 5+ minutes out, the till applies no offer that starts after `cutoffAt`
   * (the till reads this with the badge, every 10 seconds). Absent on a box with no clock check yet.
   */
  readonly offerHold?: { readonly held: boolean; readonly cutoffAt: string | null };
  /**
   * OB-501 (R7-A): the app version policy in this box's signed pack — the till re-reads it with the badge, so a build head
   * office withdraws stops starting new bills without a reload (it finishes the bill in progress). `null` = none set.
   */
  readonly appVersionPolicy?: unknown;
  /** Verifier r19 OB87-1: the box's own check of its bill-number witness (absent on a box with no till). */
  readonly billNumbering?: {
    readonly witness: 'kept' | 'unavailable' | 'none'; readonly fault?: string; readonly restoreHeld: boolean; readonly restoreBecause?: string;
    readonly restoreSince?: string; readonly sharedWith: readonly { readonly box: string; readonly lastWrittenAt: string }[]; readonly says: string;
  };
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
  /** Verifier r19 OB87-1: the bill-number witness check — an unavailable witness leads the sentence (P-08). */
  readonly billNumbering?: LaneSyncStatus['billNumbering'];
  /** OB-429: head office's answer to this box's own login (box-login-gate.ts). Absent on a box with no cloud. */
  readonly boxLogin?: { readonly refused: boolean; readonly refusedAt: string | null };
}): LaneSyncStatus {
  const unsent = input.queues.reduce((n, q) => n + q.unsentCount, 0);
  const deadLettered = input.queues.reduce((n, q) => n + q.deadLetterCount, 0);
  const lastSentAt = latest(input.queues.map((q) => q.lastSuccessAt));
  const lastContactAt = latest([input.lastContactAt, lastSentAt]);

  const cloud: CloudLink = input.configured === 'starting' ? 'starting'
    : input.configured === false ? 'not_configured'
      : input.boxLogin?.refused === true ? 'login_refused'
      : input.lastPackStatus === 'offline' ? 'offline'
        : input.lastPackStatus !== undefined || lastSentAt !== null ? 'online'
          : 'unknown';

  const refused = deadLettered === 0 ? '' : `${deadLettered} item(s) head office refused are waiting for a person to look at them. `;
  const staffMessage = refused + (
    cloud === 'starting' ? 'The store box is still starting up.'
      : cloud === 'not_configured' ? `No head office link is set up on this box. ${held(unsent, ' and will go only when a link is set up')}`
        : cloud === 'unknown' ? `Head office has not been checked yet. ${held(unsent, ' and will go on the first pass')}`
          : cloud === 'login_refused' ? `Head office refused this store computer's own login${input.boxLogin?.refusedAt == null ? '' : ` at ${input.boxLogin.refusedAt}`}, so it has stopped contacting head office (so the shop's sign-ins are not locked). Selling continues. ${held(unsent, ' and will go once the login is renewed')} Renew the store computer's head-office login, then restart the store computer.`
          : cloud === 'online' ? (unsent === 0 ? 'Everything has reached head office.' : `${unsent} item(s) still to send; head office answered at ${lastContactAt}.`)
            : `Head office could not be reached. ${held(unsent, ' and will go when the line is back')}${lastContactAt === null ? ' It has never been reached from this box.' : ` Last contact ${lastContactAt}.`}`
  );

  const witnessWarning = input.billNumbering !== undefined && input.billNumbering.witness === 'unavailable' ? `${input.billNumbering.says} ` : '';
  return {
    cloud, unsent, deadLettered, lastSentAt, lastContactAt, now: input.now, staffMessage: witnessWarning + staffMessage,
    ...(input.billNumbering === undefined ? {} : { billNumbering: input.billNumbering }),
  };
}
