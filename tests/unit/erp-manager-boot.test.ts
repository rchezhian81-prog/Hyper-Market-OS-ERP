import { describe, it, expect, afterEach } from 'vitest';
import { bootManager, openDayClosePort, portsFromData, type ManagerData } from '../../apps/web-erp/src/browser-entry';
import { NobodyNamedError } from '../../apps/web-erp/src/manager-session';
import { requestApproval } from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **The composition root the manager's screen actually binds to.**
 *
 * The unit tests around `manager-session` prove the rules; this proves the *assembly*, which is
 * where this project's silent faults have all lived — a port present in the design and absent in
 * the running system, a control quietly not being there.
 *
 * The fault this file exists to catch is one line long: `data.openExceptions ?? []`. It reads as
 * tidy defaulting, it makes every test pass, and it turns *"the store never told me"* into *"the
 * store told me there is nothing wrong"* — which is exactly enough to lock a trading day on a page
 * that had never spoken to the store.
 */

const AFTER_CUTOFF = '2026-08-05T02:30';
const AT = '2026-08-05T02:30:00Z';

const boot = (data?: ManagerData) => bootManager({
  storeId: 'store-1', branchId: 'b1', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
  managerId: 'u-mgr', approvalLimitMinor: 500_000, warehouseId: 'wh-1',
  ...(data === undefined ? {} : { data }),
});

describe('a screen that was told nothing knows nothing', () => {
  it('boots with every register unknown when no payload arrived', () => {
    const floor = boot().floor();
    for (const figure of [floor.approvalsWaiting, floor.exceptions, floor.unsent, floor.tasks]) {
      expect(figure.known).toBe(false);
    }
  });

  it('will not close the day', () => {
    const attempt = boot().closeTheDay({ dayCloseId: 'dc-1', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.map((b) => b.source).sort()).toEqual(['exceptions', 'unsent']);
    expect(attempt.blockers.every((b) => b.kind === 'cannot_see')).toBe(true);
  });

  it('says why, in words somebody can act on', () => {
    const attempt = boot().closeTheDay({ dayCloseId: 'dc-2', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    if (attempt.closed) return;
    expect(attempt.blockers[0]?.why).toMatch(/has not received that list from the store/);
  });
});

describe('a key the payload did not carry is not an empty list', () => {
  // The one-line fault, tested from the outside. `?? []` here would pass every other test in the
  // suite and would be the whole defect.
  it('reports a missing exception list as unknown, not as none open', () => {
    const ports = portsFromData({ unsentItems: [], tasks: [] });
    expect(ports.openExceptions('2026-08-04')).toEqual({
      known: false,
      why: 'this screen has not received that list from the store yet',
    });
  });

  it('reports a list that arrived EMPTY as known and empty', () => {
    // The other half of the same fact, and the reason the two must be distinguishable at all.
    expect(portsFromData({ openExceptions: [] }).openExceptions('2026-08-04'))
      .toEqual({ known: true, items: [] });
  });

  it('closes the day when the store really did say everything is clear', () => {
    const attempt = boot({ approvals: [], openExceptions: [], unsentItems: [], tasks: [] })
      .closeTheDay({ dayCloseId: 'dc-3', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    expect(attempt.closed).toBe(true);
    if (!attempt.closed) return;
    expect(attempt.result.locked).toBe(true);
  });
});

describe('a product the screen was never told about has no price of zero', () => {
  it('refuses to value a count for an unknown product', () => {
    const session = boot({ openExceptions: [], unsentItems: [] });
    const attempt = session.countStock({
      countId: 'c-1', productId: 'p-unknown', locationId: 'aisle-1', uom: 'ea',
      countedMinor: 3, reasonCode: 'shrinkage', at: AT,
    });
    expect(attempt.counted).toBe(false);
    if (attempt.counted) return;
    expect(attempt.refusal).toBe('value_not_known');
    expect(attempt.why).toMatch(/p-unknown/);
  });

  it('values a count for a product the store did describe', () => {
    const session = boot({ products: [{ id: 'p-1', valuePerUnitMinor: 4_000 }] });
    session.receive({
      grnId: 'grn-1', number: 'GRN-1', poId: 'po-1', receivedAt: AT,
      lines: [{ productId: 'p-1', quantityMinor: 10, uom: 'ea' }],
    });
    const attempt = session.countStock({
      countId: 'c-2', productId: 'p-1', locationId: 'aisle-1', uom: 'ea',
      countedMinor: 10, reasonCode: 'ok', at: AT,
    });
    expect(attempt.counted).toBe(true);
    if (!attempt.counted) return;
    expect(attempt.result.reconciled).toBe(true);
  });
});

describe('the manager it boots is the manager the store configured', () => {
  it('scopes approvals to the configured branch and limit', () => {
    const session = boot({
      approvals: [
        requestApproval({ id: 'a1', subjectType: 'refund', subjectRef: 'r1', requestedBy: 'u-cashier', branchId: 'b1', value: money(100_000, 'INR') }),
        requestApproval({ id: 'a2', subjectType: 'refund', subjectRef: 'r2', requestedBy: 'u-cashier', branchId: 'b2', value: money(100_000, 'INR') }),
        requestApproval({ id: 'a3', subjectType: 'po', subjectRef: 'r3', requestedBy: 'u-buyer', branchId: 'b1', value: money(900_000, 'INR') }),
      ],
    });
    const queue = session.approvalQueue();
    expect(queue.known).toBe(true);
    if (!queue.known) return;
    const by = (id: string) => queue.rows.find((r) => r.request.id === id);
    expect(by('a1')?.actionable).toBe(true);
    expect(by('a2')?.blockedReason).toBe('out_of_scope'); // another branch
    expect(by('a3')?.blockedReason).toBe('exceeds_authority'); // ₹9,000 over a ₹5,000 limit
  });

  it('gives a company-wide manager an "all" scope rather than a branch of null', () => {
    const session = bootManager({
      branchId: null, tradingDay: '2026-08-04', tradingDayCutoff: '02:00', managerId: 'u-owner',
      approvalLimitMinor: null,
      data: {
        approvals: [requestApproval({
          id: 'a1', subjectType: 'refund', subjectRef: 'r1', requestedBy: 'u-cashier',
          branchId: 'anywhere', value: money(9_999_999, 'INR'),
        })],
      },
    });
    const queue = session.approvalQueue();
    if (!queue.known) return;
    expect(queue.rows[0]?.actionable).toBe(true);
  });
});

describe('the day close reaches the store computer only when the box injected its address (M14-FR-04)', () => {
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  afterEach(() => {
    if (originalFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
    else (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('boots with NO box path when no lane address was injected', () => {
    expect(boot({ openExceptions: [], unsentItems: [] }).canCloseViaBox).toBe(false);
    // openDayClosePort mirrors that: no address means no port at all.
    expect(openDayClosePort(undefined)).toBeUndefined();
  });

  it('POSTs the close to the box\'s lane, cross-port, and reports back what the box decided', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return { status: 200, json: async () => ({ closed: true, tradingDay: '2026-08-04', locked: true }) };
    }) as unknown as typeof fetch;

    const session = bootManager({
      managerId: 'u-mgr', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
      laneWriteBase: 'http://127.0.0.1:8899',
      data: { openExceptions: [], unsentItems: [] },
    });
    expect(session.canCloseViaBox).toBe(true);
    const outcome = await session.closeViaBox({ dayCloseId: 'dc-b1', closedAtLocal: AFTER_CUTOFF, closedAt: AT });

    expect(outcome).toEqual({ closed: true, tradingDay: '2026-08-04' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8899/lane/day-close');
    // The manager's own id travels with the ask, so the box records who locked the day (§28 on reopen).
    expect(calls[0]?.body).toEqual({ dayCloseId: 'dc-b1', closedBy: 'u-mgr' });
  });

  it('passes the box\'s refusal reason straight through, and never a false close', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 200, json: async () => ({ closed: false, reason: 'the day cannot close: 2 items have not reached head office' }),
    })) as unknown as typeof fetch;

    const port = openDayClosePort('http://127.0.0.1:8899');
    expect(port).toBeDefined();
    const outcome = await port!({ dayCloseId: 'dc-b2', closedBy: 'u-mgr' });
    expect(outcome).toEqual({ closed: false, reason: 'the day cannot close: 2 items have not reached head office' });
  });

  it('turns a dropped link into a refusal-with-reason, not a lock', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const port = openDayClosePort('http://127.0.0.1:8899');
    const outcome = await port!({ dayCloseId: 'dc-b3', closedBy: 'u-mgr' });
    expect(outcome.closed).toBe(false);
    if (outcome.closed) return;
    expect(outcome.reason).toMatch(/could not be reached/i);
  });

  it('does not report a close on a non-2xx or malformed body', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 500, json: async () => ({ reason: 'the box fell over' }),
    })) as unknown as typeof fetch;
    const port = openDayClosePort('http://127.0.0.1:8899');
    const outcome = await port!({ dayCloseId: 'dc-b4', closedBy: 'u-mgr' });
    expect(outcome).toEqual({ closed: false, reason: 'the box fell over' });
  });
});

describe('the served manager is the person the store NAMED — never a stand-in (Stage G slice 5c · §28 · hard rule #4)', () => {
  const served: ManagerData = {
    userId: 'u-meena', approvalLimitMinor: 250_000, storeId: 'store-7', branchId: 'b7',
    tradingDay: '2026-09-29', tradingDayCutoff: '02:00', countApprovalThresholdMinor: 50_000, warehouseId: 'wh-7',
    approvals: [
      requestApproval({ id: 'a1', subjectType: 'refund', subjectRef: 'r1', requestedBy: 'u-cashier', branchId: 'b7', value: money(100_000, 'INR') }),
      requestApproval({ id: 'a2', subjectType: 'refund', subjectRef: 'r2', requestedBy: 'u-cashier', branchId: 'store-1', value: money(100_000, 'INR') }),
      requestApproval({ id: 'a3', subjectType: 'po', subjectRef: 'r3', requestedBy: 'u-buyer', branchId: 'b7', value: money(300_000, 'INR') }),
    ],
    openExceptions: [], unsentItems: [], tasks: [],
  };

  it('boots as the named manager, in the pack\'s branch, on the pack\'s trading day, with the pack\'s limit', () => {
    const session = bootManager({ data: served });
    expect(session.floor().manager).toBe('u-meena');
    expect(session.floor().tradingDay).toBe('2026-09-29');
    const queue = session.approvalQueue();
    if (!queue.known) throw new Error('queue unknown');
    const by = (id: string) => queue.rows.find((r) => r.request.id === id);
    expect(by('a1')?.actionable).toBe(true);
    expect(by('a2')?.blockedReason).toBe('out_of_scope'); // the OLD default branch, now another branch
    expect(by('a3')?.blockedReason).toBe('exceeds_authority'); // ₹3,000 over the pack's ₹2,500 limit
  });

  it('a company-wide manager the pack names with branch null keeps the "all" scope', () => {
    const session = bootManager({ data: { ...served, branchId: null, approvalLimitMinor: null } });
    const queue = session.approvalQueue();
    if (!queue.known) throw new Error('queue unknown');
    expect(queue.rows.every((r) => r.actionable)).toBe(true);
  });

  it('an explicit configuration still wins over the payload — a test or a standalone shell may name its own', () => {
    const session = bootManager({ managerId: 'u-owner', branchId: null, approvalLimitMinor: null, data: served });
    expect(session.floor().manager).toBe('u-owner');
  });

  it('a payload that names nobody boots NOBODY: the registers show, and every action refuses with the reason', () => {
    const { userId: _drop, ...unnamed } = served;
    void _drop;
    const session = bootManager({ data: unnamed });
    expect(session.floor().manager).toBeNull();
    expect(session.floor().approvalsWaiting).toEqual({ known: true, count: 3 });
    expect(session.floor().approvalsIcanClear).toEqual({ known: true, count: 0 });

    const queue = session.approvalQueue();
    if (!queue.known) throw new Error('queue unknown');
    expect(queue.rows.map((r) => r.blockedReason)).toEqual(['nobody_named', 'nobody_named', 'nobody_named']);

    expect(session.decideApproval({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT }))
      .toEqual({ ok: false, refusal: 'nobody_named' });

    const close = session.closeTheDay({ dayCloseId: 'dc-9', closedAtLocal: '2026-09-30T02:30', closedAt: '2026-09-30T02:30:00Z' });
    expect(close.closed).toBe(false);
    if (close.closed) return;
    expect(close.blockers.map((b) => b.kind)).toEqual(['nobody_named']);

    expect(() => session.receive({ grnId: 'g1', number: 'GRN-1', poId: null, receivedAt: AT, lines: [{ productId: 'p1', quantityMinor: 1, uom: 'ea' }] }))
      .toThrow(NobodyNamedError);

    const count = session.countStock({ countId: 'c1', productId: 'p1', locationId: 'wh-7', uom: 'ea', countedMinor: 1, reasonCode: 'shrinkage', at: AT });
    expect(count.counted).toBe(false);
    if (count.counted) return;
    expect(count.refusal).toBe('nobody_named');
  });

  it('nobody named cannot close the day through the box either — the refusal names the reason, not a lock', async () => {
    const { userId: _drop, ...unnamed } = served;
    void _drop;
    const session = bootManager({ data: unnamed, laneWriteBase: 'http://127.0.0.1:1' });
    const outcome = await session.closeViaBox({ dayCloseId: 'dc-10', closedAtLocal: '2026-09-30T02:30', closedAt: '2026-09-30T02:30:00Z' });
    expect(outcome).toEqual({ closed: false, reason: 'nobody is named on this screen, so it cannot close the day' });
  });

  it('the old default identity is gone: with no configuration and no payload there is no manager, not `manager`', () => {
    expect(bootManager().floor().manager).toBeNull();
  });
});

describe('who judges whether the day has ended (M14-FR-04)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const clean: ManagerData = { userId: 'u-mgr', tradingDay: today, tradingDayCutoff: '02:00', openExceptions: [], unsentItems: [], tasks: [] };

  it('with no store computer wired, this screen judges it: the running day has not ended, so the preview close is blocked', () => {
    const session = bootManager({ data: clean });
    const blockers = session.blockersForClose(`${today}T12:00`);
    expect(blockers.map((b) => b.kind)).toEqual(['day_not_ended']);
  });

  it('with a store computer wired, the BOX judges it — the screen lists only the registers, and the box closes the last ended day', () => {
    const session = bootManager({ data: clean, laneWriteBase: 'http://127.0.0.1:1' });
    expect(session.canCloseViaBox).toBe(true);
    expect(session.blockersForClose(`${today}T12:00`)).toEqual([]);
  });
});

describe('the queue the manager screen boots on is the device\'s, not the tab\'s (SP-2a · F11)', () => {
  /** A browser's localStorage, as far as the queue is concerned: the same key read back after a reload. */
  const memoryStorage = () => {
    const held = new Map<string, string>();
    return { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => { held.set(k, v); }, held };
  };
  const served: ManagerData = {
    userId: 'u-mgr', storeId: 'store-7', branchId: 'store-7', approvalLimitMinor: 500_000, tradingDay: '2026-09-30', tradingDayCutoff: '02:00',
    approvals: [requestApproval({ id: 'a1', subjectType: 'refund', subjectRef: 'sale-1', requestedBy: 'u-cashier', branchId: 'store-7', value: money(10_000, 'INR') })],
    openExceptions: [], unsentItems: [], tasks: [],
  };

  it('writes a decision to the device under a per-store key, and a reboot over the same storage still holds it and no longer offers the request', () => {
    const storage = memoryStorage();
    const first = bootManager({ data: served, storage });
    expect(first.floor().approvalsIcanClear).toEqual({ known: true, count: 1 });
    expect(first.decideApproval({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT }).ok).toBe(true);
    expect([...storage.held.keys()]).toEqual(['sre.manager.outbox.store-7']);
    expect(first.floor()).toMatchObject({ approvalsWaiting: { known: true, count: 0 }, heldHere: 1, unsent: { known: true, count: 1 } });

    const reloaded = bootManager({ data: served, storage });
    expect(reloaded.floor()).toMatchObject({ approvalsWaiting: { known: true, count: 0 }, approvalsIcanClear: { known: true, count: 0 }, heldHere: 1 });
    expect(reloaded.decisions()).toMatchObject([{ requestId: 'a1', decision: 'approved', state: 'saved_here' }]);
    expect(reloaded.decideApproval({ requestId: 'a1', decision: 'rejected', reasonCode: 'against_policy', decidedAt: AT })).toEqual({ ok: false, refusal: 'already_decided' });
  });

  it('two stores\' screens on one browser never share a queue', () => {
    const storage = memoryStorage();
    bootManager({ data: served, storage }).decideApproval({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT });
    const other = bootManager({ data: { ...served, storeId: 'store-8', branchId: 'store-8', approvals: [{ ...served.approvals![0]!, branchId: 'store-8' }] }, storage });
    expect(other.floor().heldHere).toBe(0);
    expect(other.floor().approvalsWaiting).toEqual({ known: true, count: 1 });
    expect([...storage.held.keys()].sort()).toEqual(['sre.manager.outbox.store-7']);
  });

  it('an explicit outbox wins (the composition root hands the same one to the relay)', () => {
    const outbox = new SyncOutbox();
    const session = bootManager({ data: served, outbox });
    session.decideApproval({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT });
    expect(outbox.find('approval-decision-a1')?.event.type).toBe('ApprovalDecided');
  });

  it('with no box wired there is no relay; with one, the relay hands pending decisions to the box and folds its word back in', async () => {
    const { openManagerRelay } = await import('../../apps/web-erp/src/browser-entry');
    const outbox = new SyncOutbox();
    const session = bootManager({ data: served, outbox, laneWriteBase: 'http://127.0.0.1:1' });
    expect(openManagerRelay(undefined, session, outbox)).toBeUndefined();
    session.decideApproval({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT });

    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${new URL(u).pathname}`);
      if (u.endsWith('/lane/outbox')) {
        const sent = JSON.parse(String(init?.body)) as { source: string; items: { key: string }[] };
        expect(sent.source).toBe('manager');
        return new Response(JSON.stringify({ acks: sent.items.map((i) => ({ key: i.key, status: 'accepted' })) }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [{ key: 'approval-decision-a1', state: 'posted', attempts: 0 }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const relay = openManagerRelay('http://127.0.0.1:1', session, outbox)!;
      const result = await relay.syncNow();
      expect(result).toEqual({ handed: 1, refused: 0, failed: 0, offline: false });
      expect(calls).toEqual(['POST /lane/outbox', 'GET /lane/outbox/status']);
      expect(session.decisions()[0]?.state).toBe('posted');
      expect(session.floor().heldHere).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('a box that cannot be reached leaves the decision saved here, retrying — nothing lost, nothing refused', async () => {
    const { openManagerRelay } = await import('../../apps/web-erp/src/browser-entry');
    const outbox = new SyncOutbox();
    const session = bootManager({ data: served, outbox, laneWriteBase: 'http://127.0.0.1:1' });
    session.decideApproval({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    try {
      const result = await openManagerRelay('http://127.0.0.1:1', session, outbox)!.syncNow();
      expect(result).toEqual({ handed: 0, refused: 0, failed: 1, offline: true });
      expect(session.decisions()[0]).toMatchObject({ state: 'retrying', attempts: 1 });
      expect(session.floor().heldHere).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
