// Browser entry — the bundler's input for the owner app (`pnpm build:owner`). It wires a real
// `OwnerSession` and attaches it as `window.ownerSession`, which `web/app.js` binds to.
//
// ── What this app may and may not assume ────────────────────────────────────
//
// The owner's phone holds **whatever it last received** (§31) and nothing else. It does not query
// the store; it cannot. So `window.ownerData` is the entire world as far as this screen is
// concerned, and when it is absent the screen has no numbers — which it says, rather than
// inventing any.
//
// ── The queue has to outlive the app, and that is a real decision ───────────
//
// The owner approves three things on a train and the phone kills the tab. If the queue lived only
// in memory those three decisions would be gone, silently, which is the worst way for an approval
// to disappear. So it is written to the device's own storage.
//
// What goes in there is deliberately small: request ids, subjects, values, the reason code and the
// freshness the decision was made on. **No card data, no credentials, no customer information**
// (hard rule #3, hard rule #4) — the same class of data as the brief the screen is already showing
// on the same device. The store is injectable, so a host app with a better one (IndexedDB, an OS
// keystore) supplies it instead of this.

import { buildBrief } from './brief';
import {
  APPROVE_REASONS,
  REJECT_REASONS,
  type DecisionReasonCode,
} from '../../../packages/approvals/src/reasons';
import {
  createOwnerSession,
  type BranchPayload,
  type OwnerDecision,
  type OwnerSession,
} from './owner-session';

/** The last-synced payload the phone holds. Absent means this screen knows nothing. */
export interface OwnerData {
  readonly branches?: readonly BranchPayload[];
  /** Seconds after which a branch's data counts as stale. Per-tenant. */
  readonly staleAfterSeconds?: number;
  /** Who the owner is to the approval engine. */
  readonly ownerId?: string;
  /** Maximum value this owner may approve, in minor units; null or absent = unlimited. */
  readonly approvalLimitMinor?: number | null;
  /** Whether a decision on stale data needs an explicit acknowledgement. Per-tenant. */
  readonly acknowledgeStaleDecisions?: boolean;
}

/** Where decisions wait until they can be sent. Injectable so a host app can supply a better one. */
export interface DecisionQueueStore {
  read(): readonly OwnerDecision[];
  write(decisions: readonly OwnerDecision[]): void;
}

/** A store that keeps nothing — used when the device offers no storage at all. */
export function forgetfulQueueStore(): DecisionQueueStore {
  let held: readonly OwnerDecision[] = [];
  return { read: () => held, write: (d) => { held = d; } };
}

/**
 * The device's own storage, guarded.
 *
 * Every access is wrapped: private-browsing modes throw on write, a full quota throws, and a
 * corrupt value must not take the whole app down on boot. A screen that fails to open is worse
 * than a screen that opens having lost its queue — but losing the queue silently is worse than
 * either, so a failed read is reported through `onProblem` rather than swallowed.
 */
export function deviceQueueStore(
  key: string,
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined,
  onProblem: (why: string) => void,
): DecisionQueueStore {
  if (storage === undefined) {
    onProblem('this device offers no storage, so decisions made offline will not survive a restart');
    return forgetfulQueueStore();
  }
  return {
    read: () => {
      try {
        const raw = storage.getItem(key);
        if (raw === null) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          onProblem('the saved decisions could not be read and have been left untouched');
          return [];
        }
        return parsed as OwnerDecision[];
      } catch {
        // Left in place rather than cleared: a decision nobody can read is still evidence that a
        // decision was made, and deleting it is the one thing that cannot be undone.
        onProblem('the saved decisions could not be read and have been left untouched');
        return [];
      }
    },
    write: (decisions) => {
      try {
        storage.setItem(key, JSON.stringify(decisions));
      } catch {
        onProblem('this decision could not be saved on the phone — send it before closing the app');
      }
    },
  };
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface OwnerWindow {
  ownerSession?: OwnerSession;
  ownerData?: OwnerData;
  ownerBrief?: typeof buildBrief;
  /** The decision vocabulary, so the view offers it and never invents a reason of its own. */
  ownerReasons?: {
    readonly approved: readonly DecisionReasonCode[];
    readonly rejected: readonly DecisionReasonCode[];
  };
  /**
   * Anything that went wrong with the device's own storage, for the view to show.
   *
   * It is a field rather than a swallowed callback because a queue that could not be saved is
   * exactly the kind of thing this product refuses to let disappear quietly (P-08): the owner has
   * made a decision that will not survive the app closing, and only they can act on that.
   */
  ownerQueueProblem?: string | null;
}

/**
 * Build the owner's session from the payload the phone holds.
 *
 * Returns `null` when there is no payload at all. That is not an error state to paper over: an
 * owner app with no data has nothing to show and nothing to decide, and the screen says exactly
 * that instead of rendering zeros that look like a quiet day.
 */
export function bootOwner(
  data: OwnerData | undefined,
  queueStore: DecisionQueueStore,
  now: () => string = () => new Date().toISOString(),
): OwnerSession | null {
  const branches = data?.branches;
  if (branches === undefined || branches.length === 0) return null;

  const limit = data?.approvalLimitMinor;
  const session = createOwnerSession(
    {
      owner: {
        userId: data?.ownerId ?? 'owner',
        branchScope: 'all',
        authorityLimit: limit === undefined || limit === null ? null : { minor: limit, currency: 'INR' },
      },
      staleAfterSeconds: data?.staleAfterSeconds ?? 300,
      // Defaulted ON. A screen that quietly stopped asking would make every travelling approval
      // look like one made on live numbers.
      acknowledgeStaleDecisions: data?.acknowledgeStaleDecisions ?? true,
    },
    branches,
    now,
    queueStore.read(),
  );

  // Persist after anything that changes the queue. Wrapping rather than teaching the session about
  // storage keeps the session pure — it is the same object the tests drive.
  const persist = <T>(result: T): T => {
    queueStore.write(session.queued());
    return result;
  };
  return {
    ...session,
    decide: (input) => persist(session.decide(input)),
    discardQueued: (requestId) => persist(session.discardQueued(requestId)),
  };
}

// In the browser `globalThis.window` IS the window, so this needs no DOM types.
const browserWindow = (globalThis as {
  window?: OwnerWindow;
  localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
}).window;

if (browserWindow !== undefined) {
  const storage = (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
  const owner = browserWindow.ownerData?.ownerId ?? 'owner';
  browserWindow.ownerQueueProblem = null;
  // Recorded where the view can read it, never swallowed. A decision the phone could not save is
  // a decision that will vanish when the app closes, and only the owner can do anything about it.
  const store = deviceQueueStore(`sre.owner.queue.${owner}`, storage, (why) => {
    browserWindow.ownerQueueProblem = why;
  });
  const session = bootOwner(browserWindow.ownerData, store);
  if (session !== null) browserWindow.ownerSession = session;
  browserWindow.ownerBrief = buildBrief;
  browserWindow.ownerReasons = { approved: APPROVE_REASONS, rejected: REJECT_REASONS };
}

export { buildBrief };
