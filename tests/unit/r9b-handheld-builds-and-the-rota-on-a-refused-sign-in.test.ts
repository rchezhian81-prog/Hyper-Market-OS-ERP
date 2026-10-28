import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  storeComputerBuildOf, judgeHandheldBuild, readHandheldBuild, readReportedBuild, withoutHandheldBuild, HANDHELD_BUILD_FIELD,
} from '../../packages/platform-admin/src/handheld-build';
import { APP_BUILD_VERSION } from '../../packages/platform-admin/src/client-version';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { drainToBox } from '../../packages/sync/src/device-drain';
import { readRelayItem } from '../../packages/sync/src/device-relay';
import { makeEvent } from '../../packages/contracts/src/event';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { withBoxHandheldBuild, queueBasketBuildReporter } from '../../edge/store-edge/src/handheld-build-check';
import { QueueBaskets } from '../../edge/store-edge/src/queue-baskets';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { withHandheldBuildCheck, handheldBuildExceptionsAdapter, handheldBuildRoutes } from '../../services/api/src/r9b-handheld-build-adapters';
import { versionPolicyAdapter } from '../../services/api/src/adapters';
import type { BoundStoreGuard } from '../../services/kernel/src/index';
import { createRosteringSession, ROSTERING_COPY } from '../../apps/web-erp/src/rostering-session';
import { rosteringViewFor, readRosteringWorklist } from '../../apps/web-erp/src/browser-entry';
import { rosterCopyOnBox } from '../../edge/store-edge/src/workforce-pack';
import { known, type StorePack } from '../../edge/store-edge/src/store-pack';

// Round 9 · R9-B — OB-537 (every handheld record carries the app build that made it; the store computer and head office flag
// work done on a withdrawn or too-old build, never refusing it after the fact) and OB-539 (the manager's Rota shows the store
// computer's read-only copy also when the store PC's head-office sign-in fails, 401, saying so). Synthetic data only.

const WITHDRAWN = { currentVersion: '99.0.0', previousVersion: '98.0.0', minimumSupportedVersion: '98.0.0', killedVersions: ['0.0.0'] };
const TOO_OLD = { currentVersion: '99.0.0', minimumSupportedVersion: '98.0.0' };
const FINE = { currentVersion: APP_BUILD_VERSION, minimumSupportedVersion: APP_BUILD_VERSION };
const AT = '2026-10-28T05:00:00.000Z';
const pick = (lineId = 'l1') => makeEvent({
  id: `W-1:${lineId}:picked`, type: 'PickLineResolved', occurredAt: AT, idempotencyKey: `pick:W-1:${lineId}:picked`, source: 'W-1',
  payload: { waveId: 'W-1', lineId, state: 'picked', pickedBy: 'u-picker' },
});

describe('OB-537 · the build rule (packages/platform-admin/src/handheld-build.ts)', () => {
  it('the store computer writes the build each time and marks it only when its pack bars it, or none was reported under a policy', () => {
    expect(storeComputerBuildOf('picker', '0.0.0', undefined)).toEqual({ client: 'picker', appVersion: '0.0.0' });
    expect(storeComputerBuildOf('picker', '0.0.0', FINE)).toEqual({ client: 'picker', appVersion: '0.0.0' });
    expect(storeComputerBuildOf('warehouse', '0.0.0', WITHDRAWN)).toEqual({ client: 'warehouse', appVersion: '0.0.0', storeComputerVersionCheck: { verdict: 'version_killed', reported: '0.0.0', minimumSupportedVersion: '98.0.0' } });
    expect(storeComputerBuildOf('driver', '0.0.0', TOO_OLD).storeComputerVersionCheck?.verdict).toBe('upgrade_required');
    expect(storeComputerBuildOf('queue_till', null, TOO_OLD)).toEqual({ client: 'queue_till', appVersion: null, storeComputerVersionCheck: { verdict: 'no_version_reported', reported: null, minimumSupportedVersion: '98.0.0' } });
    expect(storeComputerBuildOf('queue_till', null, undefined)).toEqual({ client: 'queue_till', appVersion: null });
  });

  it('head office judges by its OWN policy first, then the store computer\'s mark: material, informational, or nothing', () => {
    const mine = judgeHandheldBuild({ client: 'picker', appVersion: '0.0.0' }, TOO_OLD, 'A pick');
    expect(mine).toMatchObject({ severity: 'material', verdict: 'upgrade_required', client: 'picker', markedByStoreComputer: null });
    expect(mine!.detail).toBe('A pick was done on a picking handheld on app 0.0.0, which is below the minimum supported version 98.0.0');
    // Head office has no policy, the box marked it: still material, said as marked.
    const marked = judgeHandheldBuild(storeComputerBuildOf('warehouse', '0.0.0', WITHDRAWN), undefined, 'A count');
    expect(marked).toMatchObject({ severity: 'material', verdict: 'version_killed', markedByStoreComputer: 'version_killed' });
    expect(marked!.detail).toBe('A count was done on a warehouse handheld on app 0.0.0, which head office has withdrawn (the store computer marked it too)');
    // No build reported under the box's policy: informational, never a fake fault.
    expect(judgeHandheldBuild(storeComputerBuildOf('driver', null, TOO_OLD), undefined, 'A stop')).toMatchObject({ severity: 'informational', verdict: 'no_version_reported' });
    // A supported build, or no policy anywhere: nothing.
    expect(judgeHandheldBuild({ client: 'picker', appVersion: APP_BUILD_VERSION }, FINE, 'x')).toBeUndefined();
    expect(judgeHandheldBuild({ client: 'picker', appVersion: '0.0.0' }, undefined, 'x')).toBeUndefined();
  });

  it('reads and takes the build off a payload; a build that is not text is not a build', () => {
    const payload = { waveId: 'W-1', [HANDHELD_BUILD_FIELD]: { client: 'picker', appVersion: '1.2.3' } };
    expect(withoutHandheldBuild(payload)).toEqual({ build: { client: 'picker', appVersion: '1.2.3' }, payload: { waveId: 'W-1' }, carried: true });
    expect(withoutHandheldBuild({ waveId: 'W-1' })).toEqual({ build: undefined, payload: { waveId: 'W-1' }, carried: false });
    expect(readHandheldBuild({ client: 'manager', appVersion: '1' })).toBeUndefined();
    expect(readReportedBuild(undefined)).toEqual({ ok: true, appVersion: undefined });
    expect(readReportedBuild(' 1.0.0 ')).toEqual({ ok: true, appVersion: '1.0.0' });
    expect(readReportedBuild(7)).toEqual({ ok: false });
    expect(readReportedBuild('')).toEqual({ ok: false });
  });
});

describe('OB-537 · the handheld stamps its build when it queues a record, and the box writes it on the record', () => {
  it('a record keeps the build it was QUEUED on — across a restart onto a newer build — and the drain hands it over', async () => {
    const store = noDeviceStore();
    const old = new DeviceOutbox(store, [], undefined, '0.9.0');
    old.enqueue(pick('l1'));
    expect(old.find('pick:W-1:l1:picked')?.appVersion).toBe('0.9.0');
    // The phone is updated and reopens its queue: the old record still names the old build; a new one names the new build.
    const restored = JSON.parse(store.read()!) as never[];
    const updated = new DeviceOutbox(store, restored, undefined, '1.0.0');
    updated.enqueue(pick('l1')); // a re-queue of the same key keeps the build it was first queued on
    updated.enqueue(pick('l2'));
    expect(updated.find('pick:W-1:l1:picked')?.appVersion).toBe('0.9.0');
    expect(updated.find('pick:W-1:l2:picked')?.appVersion).toBe('1.0.0');
    const sent: unknown[] = [];
    await drainToBox({
      outbox: updated, boxBase: '', source: 'picker',
      fetch: async (_url, init) => { sent.push(JSON.parse(init.body!)); return { status: 200, json: async () => ({ acks: [] }) }; },
    });
    expect((sent[0] as { items: { key: string; appVersion?: string }[] }).items.map((i) => [i.key, i.appVersion])).toEqual([['pick:W-1:l1:picked', '0.9.0'], ['pick:W-1:l2:picked', '1.0.0']]);
  });

  it('the box reads the build with the item; one that is not a build number is refused with the reason', () => {
    const e = pick();
    expect(readRelayItem({ key: e.idempotencyKey, event: e, appVersion: '0.0.0' })).toMatchObject({ ok: true, item: { appVersion: '0.0.0' } });
    expect(readRelayItem({ key: e.idempotencyKey, event: e })).toEqual({ ok: true, item: { key: e.idempotencyKey, event: e } });
    expect(readRelayItem({ key: e.idempotencyKey, event: e, appVersion: { v: 1 } })).toEqual({ ok: false, key: e.idempotencyKey, reason: "the item's appVersion is not a build number" });
  });

  it('only a handheld\'s record gets the box\'s build; a device-supplied build is replaced; a barred one is said in the log', () => {
    const said: string[] = [];
    const forged = makeEvent({ ...pick(), payload: { ...(pick().payload as object), handheldBuild: { client: 'picker', appVersion: '99.0.0' } } });
    const kept = withBoxHandheldBuild(forged, 'picker', '0.0.0', WITHDRAWN, (l) => said.push(l));
    expect((kept.payload as Record<string, unknown>)['handheldBuild']).toEqual({ client: 'picker', appVersion: '0.0.0', storeComputerVersionCheck: { verdict: 'version_killed', reported: '0.0.0', minimumSupportedVersion: '98.0.0' } });
    expect(said).toEqual(['PickLineResolved pick:W-1:l1:picked from the picker was made on app 0.0.0 — version killed; kept and marked for head office.']);
    // A manager's screen record is untouched; an unflagged handheld record is written quietly.
    expect(withBoxHandheldBuild(pick(), 'manager', '0.0.0', WITHDRAWN, () => {})).toEqual(pick());
    expect((withBoxHandheldBuild(pick(), 'driver', undefined, undefined, (l) => said.push(l)).payload as Record<string, unknown>)['handheldBuild']).toEqual({ client: 'driver', appVersion: null });
    expect(said).toHaveLength(1);
  });

  it('a queue basket keeps the build that made it, reports it once to head office\'s queue, and refuses a build that is not a number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r9b-qb-'));
    try {
      const logged: string[] = [];
      const outbox = new SyncOutbox();
      const keys = new Set<string>();
      const deviceLog = { records: [] as string[], append: async (r: string) => { deviceLog.records.push(r); }, usedBytes: async () => 0, capacityBytes: 10_000_000 };
      const baskets = await QueueBaskets.open({
        dataDir: dir, capacityBytes: 10_485_760, codes: () => ['1234', '2345'],
        buildOf: (v) => storeComputerBuildOf('queue_till', v, TOO_OLD),
        onHandedOver: queueBasketBuildReporter({ tenantId: 't', keys, log: deviceLog, outbox, say: (l) => logged.push(l) }),
      });
      const lines = [{ productId: 'P-DAL', name: 'Dal', barcode: '8901234567890', quantityMinor: 1 }];
      const out = await baskets.handOver({ handheldLane: 'device:hh-q1', by: 'u-q', basketId: 'B-1', lines, handheldTotalMinor: 100, appVersion: '0.0.0' });
      expect(out).toMatchObject({ handedOver: true, code: '1234' });
      // Re-sent after a lost reply: the same hand-over, reported once.
      await baskets.handOver({ handheldLane: 'device:hh-q1', by: 'u-q', basketId: 'B-1', lines, handheldTotalMinor: 100, appVersion: '0.0.0' });
      expect(outbox.pending().map((i) => [i.event.type, (i.event.payload as { reportedBuild: unknown }).reportedBuild])).toEqual([
        ['QueueBasketBuildReported', { client: 'queue_till', appVersion: '0.0.0', storeComputerVersionCheck: { verdict: 'upgrade_required', reported: '0.0.0', minimumSupportedVersion: '98.0.0' } }],
      ]);
      expect(deviceLog.records).toHaveLength(1);
      expect(logged).toEqual(['queue basket B-1 from the queue till was made on app 0.0.0 — upgrade required; kept and marked for head office.']);
      expect(await baskets.handOver({ handheldLane: 'device:hh-q1', by: 'u-q', basketId: 'B-2', lines, handheldTotalMinor: 100, appVersion: ['x'] })).toMatchObject({ handedOver: false, refusedBecause: 'basket_not_readable' });
      await baskets.close();
      // Cold restart: the basket on the box's own disk still names its build and the mark.
      const again = await QueueBaskets.open({ dataDir: dir, capacityBytes: 10_485_760 });
      const recalled = await again.recall({ code: '1234', laneId: 'lane-1', cashierId: 'u-c' });
      expect(recalled).toMatchObject({ recalled: true });
      await again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('OB-537 · head office takes the build off before the handler and keeps a finding once the record is accepted', () => {
  const principal = { tenantId: 't-1', userId: 'u-box', branchId: 'S1' };
  const request = (body: unknown) => ({ method: 'POST' as const, routePath: '/v1/fulfilment/waves/:waveId/lines/:lineId/synced', permission: 'fulfilment.pack.record', params: { waveId: 'W-1', lineId: 'l1' }, query: {}, body });

  it('the handler reads the record exactly as made; the binding\'s own stamp and after-accept step are kept; a barred build is kept as a finding', async () => {
    const store = new InMemoryEventStore();
    await versionPolicyAdapter({ store, now: () => AT }).recordPolicyEvent('t-1', { policy: TOO_OLD, by: 'u-owner', at: AT }, 'p1');
    let innerAccepted = 0;
    const inner: BoundStoreGuard = async (_p, _a, r) => ({ ok: true, stampedBody: { ...(r.body as object), storeId: 'S1' }, onAccepted: () => { innerAccepted += 1; } });
    const guard = withHandheldBuildCheck(inner, { store, now: () => AT });
    const body = { waveId: 'W-1', lineId: 'l1', state: 'picked', handheldBuild: storeComputerBuildOf('picker', '0.0.0', undefined) };
    const verdict = await guard(principal as never, {} as never, request(body));
    expect(verdict).toMatchObject({ ok: true, stampedBody: { waveId: 'W-1', lineId: 'l1', state: 'picked', storeId: 'S1' } });
    expect(verdict.stampedBody).not.toHaveProperty('handheldBuild');
    // Nothing is kept until the handler has accepted the record.
    expect(await handheldBuildExceptionsAdapter({ store }).list('t-1')).toEqual([]);
    await verdict.onAccepted!();
    await verdict.onAccepted!(); // the same record again collapses onto one finding
    expect(innerAccepted).toBe(2);
    const found = await handheldBuildExceptionsAdapter({ store }).list('t-1');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'handheld_work_on_an_unsupported_app_version', severity: 'material', verdict: 'upgrade_required', client: 'picker', appVersion: '0.0.0', store: 'S1', relayedBy: 'u-box', route: '/v1/fulfilment/waves/:waveId/lines/:lineId/synced' });
    expect(found[0]!.recordRef).toMatch(/^waveId=W-1&lineId=l1#/);
  });

  it('a refusal by the binding stands untouched; a body with no build passes as before; a supported build keeps nothing', async () => {
    const store = new InMemoryEventStore();
    const refused: BoundStoreGuard = async () => ({ ok: false, code: 'store_computer_record_names_another_store' });
    expect(await withHandheldBuildCheck(refused, { store, now: () => AT })(principal as never, {} as never, request({ handheldBuild: { client: 'picker', appVersion: '0.0.0' } })))
      .toEqual({ ok: false, code: 'store_computer_record_names_another_store' });
    const plain: BoundStoreGuard = async () => ({ ok: true });
    expect(await withHandheldBuildCheck(plain, { store, now: () => AT })(principal as never, {} as never, request({ waveId: 'W-1' }))).toEqual({ ok: true });
    const fine = await withHandheldBuildCheck(plain, { store, now: () => AT })(principal as never, {} as never, request({ waveId: 'W-1', handheldBuild: { client: 'picker', appVersion: APP_BUILD_VERSION } }));
    expect(fine.stampedBody).toEqual({ waveId: 'W-1' });
    await fine.onAccepted!();
    expect(await handheldBuildExceptionsAdapter({ store }).list('t-1')).toEqual([]);
  });

  it('the queue basket report: a barred build is kept; a malformed report is 400 and nothing is kept; the register lists material and counts informational', async () => {
    const store = new InMemoryEventStore();
    await versionPolicyAdapter({ store, now: () => AT }).recordPolicyEvent('t-1', { policy: WITHDRAWN, by: 'u-owner', at: AT }, 'p1');
    const [read, report] = handheldBuildRoutes({ store, now: () => AT });
    const ctx = (params: Record<string, string>, body: unknown) => ({ tenantId: 't-1', userId: 'u-box', branchId: 'S1', scope: ['S1'], params, query: {}, body, traceId: 'x' }) as never;
    const body = { basketId: 'B-1', handheldLane: 'device:hh-q1', handedOverBy: 'u-q', handedOverAt: AT, lineCount: 1, reportedBuild: { client: 'queue_till', appVersion: '0.0.0' } };
    expect(await report!.handler(ctx({ basketId: 'B-1' }, body))).toEqual({ status: 200, body: { basketId: 'B-1', flagged: true, severity: 'material', verdict: 'version_killed' } });
    await expect(report!.handler(ctx({ basketId: 'B-2' }, body))).rejects.toMatchObject({ status: 400 });
    await report!.handler(ctx({ basketId: 'B-3' }, { ...body, basketId: 'B-3', reportedBuild: { client: 'queue_till', appVersion: null, storeComputerVersionCheck: { verdict: 'no_version_reported' } } }));
    const listed = (await read!.handler(ctx({}, undefined))).body as { material: { recordRef: string; detail: string }[]; informational: number };
    expect(listed.material.map((m) => m.recordRef)).toEqual(['device:hh-q1/B-1']);
    expect(listed.material[0]!.detail).toBe('queue basket B-1 (handed over by u-q) was done on a queue till on app 0.0.0, which head office has withdrawn');
    expect(listed.informational).toBe(1);
  });
});

describe('OB-539 · the Rota shows the store computer\'s copy when the store PC\'s head-office sign-in fails (401)', () => {
  const asAt = '2026-10-28T03:30:00.000Z'; // 09:00 in the shop
  const NOW = '2026-10-28T06:30:00.000Z';
  const ROSTER = {
    storeId: 'S1', asAt, published: [],
    employees: [{ employeeId: 'E-R', name: 'Rani', roles: ['cashier'], active: true }],
    shifts: [{ shiftId: 'SH-1', branchId: 'S1', startsAt: '2026-10-29T00:30:00.000Z', endsAt: '2026-10-29T08:30:00.000Z', requiredRoles: [{ role: 'cashier', count: 2 }] }],
    assignments: [{ shiftId: 'SH-1', employeeId: 'E-R', role: 'cashier' }],
  };
  const copyData = () => ({ userId: 'u-mgr', permissions: ['workforce.roster.read', 'workforce.roster.manage'], boxRoster: rosterCopyOnBox({ roster: known(ROSTER) } as StorePack)! });
  const sessionFor = (read: Parameters<typeof rosteringViewFor>[1], data: Parameters<typeof rosteringViewFor>[0]) => {
    const shown = rosteringViewFor(data, read);
    return createRosteringSession({ userId: 'u-mgr', ...shown.config, now: () => NOW }, {
      worklist: () => shown.worklist, mayRead: () => true, mayManage: () => true, assignPort: () => ({ post: async () => 'assigned' as const }),
    });
  };
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it('a 401 is the head-office sign-in failing — none held on this PC, or head office no longer believes it; the box\'s own PIN ending is not', async () => {
    expect(await readRosteringWorklist(answer(401, { error: { code: 'head_office_sign_in_needed' } }))).toEqual({ kind: 'sign_in_refused' });
    expect(await readRosteringWorklist(answer(401, { error: { code: 'unauthenticated' } }))).toEqual({ kind: 'sign_in_refused' });
    expect(await readRosteringWorklist(answer(401, 'not json at all'))).toEqual({ kind: 'sign_in_refused' });
    expect(await readRosteringWorklist(answer(401, { error: { code: 'office_sign_in_needed' } }))).toEqual({ kind: 'refused', status: 401 });
    expect(await readRosteringWorklist(answer(403, { error: { code: 'forbidden' } }))).toEqual({ kind: 'refused', status: 403 });
  });

  it('with a copy: the store computer\'s copy, saying head office refused the sign-in, READ-ONLY; in Tamil too', async () => {
    const s = sessionFor({ kind: 'sign_in_refused' }, copyData());
    const v = s.view('en');
    expect(v.source).toBe('box_copy');
    expect(v.heldWords).toBe("Head office refused this computer's head-office sign-in. This is the STORE COMPUTER'S COPY of the roster, as head office last sent it at 2026-10-28 09:00 (3 hour(s) old). It may be out of date.");
    expect(v.readOnlyWords).toBe(ROSTERING_COPY.en.heldReadOnlySignIn);
    expect([v.mayManage, v.gapCount, v.rota.map((r) => r.people)]).toEqual([false, 1, ['Rani (cashier)']]);
    expect(await s.assign('SH-1', 'E-R', 'cashier')).toBe('refused');
    const ta = s.view('ta');
    expect(ta.heldWords).toContain('தலைமை அலுவலக உள்நுழைவைத் தலைமை அலுவலகம் மறுத்தது');
    expect(ta.heldWords).toContain('கடைக் கணினி நகல்');
    expect(ta.readOnlyWords).toBe(ROSTERING_COPY.ta.heldReadOnlySignIn);
    // The line-down copy (OB-531) still says the line is down.
    expect(sessionFor({ kind: 'unreachable' }, copyData()).view('en').heldWords).toMatch(/^Head office cannot be reached\./);
  });

  it('with no copy: said plainly — head office refused the sign-in and there is no copy; never "no gaps"', () => {
    const v = sessionFor({ kind: 'sign_in_refused' }, { userId: 'u-mgr', permissions: ['workforce.roster.read'], boxRoster: null }).view('en');
    expect([v.source, v.gapCount, v.mayManage, v.screenState.label, v.readOnlyWords]).toEqual(['sign_in_refused', 0, false, ROSTERING_COPY.en.signInRefusedNoCopy, ROSTERING_COPY.en.heldReadOnlySignIn]);
    expect(sessionFor({ kind: 'sign_in_refused' }, { userId: 'u-mgr', permissions: ['workforce.roster.read'], boxRoster: null }).view('ta').screenState.label).toBe(ROSTERING_COPY.ta.signInRefusedNoCopy);
  });
});
