import { describe, it, expect } from 'vitest';
import {
  bootOwner,
  deviceQueueStore,
  forgetfulQueueStore,
  type DecisionQueueStore,
  type OwnerData,
} from '../../apps/owner-app/src/browser-entry';
import type { BranchPayload } from '../../apps/owner-app/src/owner-session';
import type { SaleFact } from '../../packages/reporting/src/index';

/**
 * **The composition root the owner's phone actually binds to.**
 *
 * The session tests prove the rules; this proves the assembly, which is where every silent fault
 * in this project has lived. Two shapes are hunted here specifically:
 *
 *   1. A payload that arrived with nothing in it, rendered as a quiet day rather than as no day.
 *   2. A queue that lives only in memory — three approvals made on a train and lost when the phone
 *      killed the tab, silently, which is the worst way for an approval to disappear.
 */

const NOW = '2026-08-05T10:00:00.000Z';
const now = () => NOW;
const FRESH_SYNC = '2026-08-05T09:59:00.000Z';

const SALE: SaleFact = {
  saleId: 's1', netMinor: 100_00, taxMinor: 18_00, totalMinor: 118_00,
  cogsMinor: 70_00, units: 3, tender: 'cash', currency: 'INR',
};

const BRANCH: BranchPayload = {
  branchId: 'b1',
  name: 'SRE Hyper Market',
  lastSyncedAt: FRESH_SYNC,
  sales: [SALE],
  exceptions: [],
  approvals: [
    { id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', valueMinor: 45_000 },
  ],
};

const data = (over: Partial<OwnerData> = {}): OwnerData => ({
  branches: [BRANCH], ownerId: 'u-owner', staleAfterSeconds: 300, ...over,
});

describe('a phone that was told nothing has nothing to show', () => {
  it('builds no session at all when there is no payload', () => {
    // Not an error to paper over. An owner app with no data has nothing to show and nothing to
    // decide, and the screen says exactly that instead of rendering zeros.
    expect(bootOwner(undefined, forgetfulQueueStore(), now)).toBeNull();
  });

  it('builds no session when a payload arrived carrying no branches', () => {
    // The subtler half: something came, and it was empty. A screen of zeros here would read as a
    // shop that took no money today.
    expect(bootOwner({ ownerId: 'u-owner' }, forgetfulQueueStore(), now)).toBeNull();
    expect(bootOwner({ branches: [] }, forgetfulQueueStore(), now)).toBeNull();
  });

  it('builds a session as soon as one branch arrives, even one that never synced', () => {
    const session = bootOwner(
      data({ branches: [{ ...BRANCH, lastSyncedAt: null, sales: [] }] }),
      forgetfulQueueStore(),
      now,
    );
    expect(session).not.toBeNull();
    // And it says it has never synced rather than showing an empty day as a real one.
    expect(session!.brief().freshness.state).toBe('missing');
  });
});

describe('the queue survives the phone closing the app', () => {
  /** A stand-in for the device's own storage, with the same failure modes. */
  const fakeStorage = (initial: Record<string, string> = {}) => {
    const held: Record<string, string> = { ...initial };
    return {
      held,
      getItem: (k: string) => held[k] ?? null,
      setItem: (k: string, v: string) => { held[k] = v; },
    };
  };

  it('writes a decision to the device and reads it back into a rebuilt session', () => {
    const storage = fakeStorage();
    const problems: string[] = [];
    const store = deviceQueueStore('k', storage, (why) => problems.push(why));

    const first = bootOwner(data(), store, now)!;
    expect(first.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' }).ok).toBe(true);
    expect(problems).toEqual([]);

    // The app is killed and reopened against a fresh store over the same device storage.
    const second = bootOwner(data(), deviceQueueStore('k', storage, () => {}), now)!;
    expect(second.queued()).toHaveLength(1);
    expect(second.queued()[0]?.request.id).toBe('a1');
    // And the request is no longer shown as waiting, so it cannot be approved a second time.
    expect(second.brief().approvals).toHaveLength(0);
  });

  it('persists a discard too, so a decision the owner cleared does not come back', () => {
    const storage = fakeStorage();
    const first = bootOwner(data(), deviceQueueStore('k', storage, () => {}), now)!;
    first.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' });
    first.discardQueued('a1');

    const second = bootOwner(data(), deviceQueueStore('k', storage, () => {}), now)!;
    expect(second.queued()).toHaveLength(0);
  });

  it('says so when the device offers no storage at all', () => {
    // A phone in a private-browsing mode, or a locked-down device. The decision is still taken —
    // but the owner is told it will not survive the app closing, because only they can act on it.
    const problems: string[] = [];
    const store = deviceQueueStore('k', undefined, (why) => problems.push(why));
    const session = bootOwner(data(), store, now)!;
    expect(session.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' }).ok).toBe(true);
    expect(problems[0]).toMatch(/will not survive a restart/);
  });

  it('says so when a decision could not be written, rather than swallowing it', () => {
    const problems: string[] = [];
    const store = deviceQueueStore('k', {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded'); },
    }, (why) => problems.push(why));

    const session = bootOwner(data(), store, now)!;
    session.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' });
    expect(problems[0]).toMatch(/could not be saved/);
  });

  it('opens with an empty queue on unreadable storage, and LEAVES the bad value alone', () => {
    // A screen that fails to open is worse than one that opens having lost its queue. But deleting
    // the unreadable value is the one thing that cannot be undone — a decision nobody can read is
    // still evidence a decision was made (hard rule #6 in spirit).
    const storage = fakeStorage({ k: 'not json at all' });
    const problems: string[] = [];
    const session = bootOwner(data(), deviceQueueStore('k', storage, (why) => problems.push(why)), now);
    expect(session).not.toBeNull();
    expect(session!.queued()).toHaveLength(0);
    expect(problems[0]).toMatch(/left untouched/);
    expect(storage.held['k']).toBe('not json at all');
  });

  it('treats a value that is not a list as unreadable rather than trusting it', () => {
    const problems: string[] = [];
    const storage = fakeStorage({ k: '{"sneaky":true}' });
    bootOwner(data(), deviceQueueStore('k', storage, (why) => problems.push(why)), now);
    expect(problems[0]).toMatch(/could not be read/);
  });

  it('stores no card data, no credentials and no customer details', () => {
    // Hard rules #3 and #4. What goes on the device is request ids, subjects, values, the reason
    // code and the freshness — the same class of data as the brief already on the same screen.
    const storage = fakeStorage();
    const session = bootOwner(data(), deviceQueueStore('k', storage, () => {}), now)!;
    session.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' });

    const written = storage.held['k'] ?? '';
    expect(written).not.toMatch(/card|cvv|pan|token|password|secret|otp|aadhaar|phone|email/i);
    expect(written).toContain('within_policy');
  });
});

describe('the owner it boots is the owner the tenant configured', () => {
  it('honours a configured approval limit', () => {
    const capped = bootOwner(
      data({ approvalLimitMinor: 10_000, branches: [{ ...BRANCH, approvals: [
        { id: 'a1', subjectType: 'purchase_order', subjectRef: 'PO-1', requestedBy: 'u-buyer', valueMinor: 900_000 },
      ] }] }),
      forgetfulQueueStore(),
      now,
    )!;
    expect(capped.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' }))
      .toEqual({ ok: false, refusal: 'exceeds_authority' });
  });

  it('treats an absent limit as unlimited, and an explicit null the same way', () => {
    for (const approvalLimitMinor of [undefined, null]) {
      const session = bootOwner(
        data({ ...(approvalLimitMinor === undefined ? {} : { approvalLimitMinor }) }),
        forgetfulQueueStore(),
        now,
      )!;
      expect(session.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' }).ok).toBe(true);
    }
  });

  it('defaults the stale acknowledgement ON, so a travelling approval is never silent', () => {
    const session = bootOwner(
      data({ branches: [{ ...BRANCH, lastSyncedAt: '2026-08-04T23:00:00.000Z' }] }),
      forgetfulQueueStore(),
      now,
    )!;
    expect(session.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' }))
      .toEqual({ ok: false, refusal: 'stale_data_not_acknowledged' });
  });

  it('still refuses the owner their own request (§28) through the assembled path', () => {
    const session = bootOwner(
      data({ branches: [{ ...BRANCH, approvals: [
        { id: 'a1', subjectType: 'write_off', subjectRef: 'W-1', requestedBy: 'u-owner', valueMinor: 1_000 },
      ] }] }),
      forgetfulQueueStore(),
      now,
    )!;
    expect(session.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' }))
      .toEqual({ ok: false, refusal: 'self_approval_forbidden' });
  });
});

describe('the queue store contract', () => {
  it('round-trips through the forgetful store, so tests and hosts share one shape', () => {
    const store: DecisionQueueStore = forgetfulQueueStore();
    expect(store.read()).toEqual([]);
    const session = bootOwner(data(), store, now)!;
    session.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' });
    expect(store.read()).toHaveLength(1);
  });
});
