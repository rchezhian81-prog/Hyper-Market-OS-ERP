import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { makeEvent } from '../../packages/contracts/src/event';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';

/**
 * **An approval decided on the manager's screen reaches head office through the store computer — durably at every
 * hop, exactly once, with every refusal visible (SP-2a · F11 · M02-FR-03 · §31 · hard rules #1/#6/#10).**
 *
 * The audit's F11: a manager's decision existed nowhere. This drives the REAL box (`startEdge`: lane socket, fsync'd
 * device-events log, cursor, durable dead-letter store, its own sync agent) against the REAL cloud (the API harness,
 * in memory, behind a `fetch` the test can cut or make lose a reply):
 *
 *   • a device batch on `POST /lane/outbox` is on the box's disk and queued BEFORE the device hears `accepted`;
 *     one sync pass delivers it to `/v1/approvals/decisions/:id/synced` under the box's credential and the register
 *     names the DECIDER and the relay; the status route then says `posted`;
 *   • the same batch again is `duplicate` — before AND after a box restart (the dedupe set is rebuilt from the whole
 *     log, not the unfinished tail), and nothing is re-sent;
 *   • a type the box does not relay, or a malformed item, is `refused` with the reason and touches no disk;
 *   • a decision head office refuses as CONFLICTING (a second, different decision for the same request → 422) is
 *     a visible dead-letter on the box — `refused` with the reason on the status route — and survives a restart;
 *   • a reply lost between the cloud and the box (the cloud recorded it; the box never heard) is a retry that the
 *     cloud answers idempotently: one record at head office, the item acknowledged once (RR-F02 / §31.1);
 *   • a box with no cloud still takes and holds the work, counts it in its sync status, and refuses to close the day
 *     over it (M14-FR-04).
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

// The box and head office hold the same pack signing key, as a real store and its head office do (ADR-0023).
const KEY = TEST_PACK_KEY;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T10:00:00.000Z';
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [] });

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

const decisionEvent = (id: string, over: Record<string, unknown> = {}) => makeEvent({
  id: `approval-decision-${id}`, type: 'ApprovalDecided', occurredAt: AT, idempotencyKey: `approval-decision-${id}`,
  source: 'web-erp/manager',
  payload: {
    id, subjectType: 'refund', subjectRef: 'sale-99', requestedBy: 'u-cashier', branchId: 'store-1',
    value: { minor: 20_000, currency: 'INR' }, status: 'approved', decidedBy: 'u-mgr', reason: 'within_policy',
    decidedAt: AT, storeId: 'store-1', source: 'manager-screen', ...over,
  },
});

/** `user` is the person the hosted copy's front says is signed in (X-Sre-User) — the box seals a decision they made. */
const postBatch = async (edge: EdgeProcess, items: unknown[], source = 'manager', user?: string): Promise<{ status: number; acks: DeviceAck[] }> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091', ...(user === undefined ? {} : { 'x-sre-user': user }) },
    body: JSON.stringify({ source, items }),
  });
  const body = (await res.json()) as { acks: DeviceAck[] };
  return { status: res.status, acks: body.acks };
};
const statusOf = async (edge: EdgeProcess, keys: string[]): Promise<BoxItemStatus[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`);
  return ((await res.json()) as { items: BoxItemStatus[] }).items;
};
const recordsOn = async (edge: EdgeProcess): Promise<{ idempotencyKey: string; type: string }[]> =>
  (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => {
    const p = JSON.parse(r.ok ? r.record : '{}') as { idempotencyKey: string; type: string };
    return { idempotencyKey: p.idempotencyKey, type: p.type };
  });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function boxWithoutCloud(dir?: string): Promise<EdgeProcess> {
  const d = dir ?? await tempDir('sre-mgr-decisions-nocloud-');
  const packFile = join(d, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');
  const edge = (await startEdge({
    EDGE_DATA_DIR: d, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_PACK_FILE: packFile,
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return edge;
}

/** A real cloud behind a `fetch` the test controls: cut it, or make it lose the reply after the cloud has acted. */
async function cloud(): Promise<{
  h: ApiHarness; dir: string; start: () => Promise<EdgeProcess>;
  setOnline: (v: boolean) => void; loseNextReply: () => void; posts: () => number;
}> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  const dir = await tempDir('sre-mgr-decisions-cloud-');
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');

  let online = true;
  let lose = false;
  let posts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/approvals/decisions/') && (init.method ?? 'GET') === 'POST') posts += 1;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'],
      path,
      token: hdr['authorization']?.replace(/^Bearer /, ''),
      idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (lose) { lose = false; throw new Error('ECONNRESET'); } // the cloud acted; the reply never arrived
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const start = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      // The hosted copy (ADR-0020 §6): the front's sign-in names the person, and the box seals what they decide.
      EDGE_LANE_ID: 'lane-1', EDGE_LANE_TRUST_FORWARDED_USER: '1',
      CLOUD_API_URL: 'https://cloud.example.test',
      CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
      EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, dir, start, setOnline: (v) => { online = v; }, loseNextReply: () => { lose = true; }, posts: () => posts };
}

const registerAt = async (h: ApiHarness) => (await h.request({ method: 'GET', path: '/v1/approvals/decisions', userId: 'u-owner', tenantId: A }))
  .body as { decisions: { requestId: string; decidedBy: string; relayedBy: string; status: string; flags: string[] }[] };

describe('the manager\'s decision: device → box (durable) → head office (once), and the box says where it is', () => {
  it('is on the box\'s disk before the device hears accepted, reaches the register in one pass naming decider and relay, and reads back as posted', async () => {
    const c = await cloud();
    const edge = await c.start();
    const e = decisionEvent('a1');

    const { status, acks } = await postBatch(edge, [{ key: e.idempotencyKey, event: e }], 'manager', 'u-mgr');
    expect(status).toBe(200);
    expect(acks).toEqual([{ key: 'approval-decision-a1', status: 'accepted' }]);
    // Durable on the box and queued — the device may now forget its pending state.
    expect(await recordsOn(edge)).toEqual([{ idempotencyKey: 'approval-decision-a1', type: 'ApprovalDecided' }]);
    expect(edge.deviceEventsOutbox.pending().map((i) => i.event.type)).toEqual(['ApprovalDecided']);
    expect(await statusOf(edge, ['approval-decision-a1'])).toEqual([{ key: 'approval-decision-a1', state: 'pending', attempts: 0 }]);
    expect(edge.syncStatus().unsent).toBe(1);

    const pass = await edge.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(pass.dead).toBe(0);
    const reg = await registerAt(c.h);
    expect(reg.decisions).toHaveLength(1);
    expect(reg.decisions[0]).toMatchObject({ requestId: 'a1', decidedBy: 'u-mgr', relayedBy: 'u-box', status: 'approved', flags: [] });
    expect(await statusOf(edge, ['approval-decision-a1'])).toEqual([{ key: 'approval-decision-a1', state: 'posted', attempts: 0 }]);
    expect(edge.syncStatus().unsent).toBe(0);
  });

  it('the same batch again is duplicate — before and after a restart — and nothing is re-sent; an unknown key is unknown', async () => {
    const c = await cloud();
    const first = await c.start();
    const e = decisionEvent('a1');
    await postBatch(first, [{ key: e.idempotencyKey, event: e }]);
    expect((await postBatch(first, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'approval-decision-a1', status: 'duplicate' }]);
    await first.syncOnce!();
    expect(c.posts()).toBe(1);
    await first.stop();
    cleanups.pop(); // stopped by hand

    const second = await c.start();
    // The device retries after a lost reply, long after the box acknowledged and cursored past the record.
    expect((await postBatch(second, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'approval-decision-a1', status: 'duplicate' }]);
    expect(await statusOf(second, ['approval-decision-a1', 'never-seen'])).toEqual([
      { key: 'approval-decision-a1', state: 'posted', attempts: 0 },
      { key: 'never-seen', state: 'unknown', attempts: 0 },
    ]);
    await second.syncOnce!();
    expect(c.posts()).toBe(1);
    expect(await recordsOn(second)).toHaveLength(1);
    expect((await registerAt(c.h)).decisions).toHaveLength(1);
  });

  it('refuses — per item, with the reason, touching no disk — a type this box does not relay for the source, and a malformed item', async () => {
    const edge = await boxWithoutCloud();
    // A sale never rides the device route (the till has its own path) — the allow-list refuses it by type.
    const sale = makeEvent({ id: 's1', type: 'SaleCommitted', occurredAt: AT, idempotencyKey: 's1', source: 'web-erp/manager', payload: { saleId: 's1' } });
    const fromPicker = decisionEvent('a7');
    const { acks } = await postBatch(edge, [
      { key: 's1', event: sale },
      { key: 'nope', event: { type: 'ApprovalDecided' } },
      { key: fromPicker.idempotencyKey, event: fromPicker },
    ], 'picker');
    expect(acks.map((a) => a.status)).toEqual(['refused', 'refused', 'refused']);
    expect(acks[0]?.reason).toMatch(/SaleCommitted is not a record this box relays for picker/);
    expect(acks[1]?.reason).toMatch(/has no id/);
    expect(acks[2]?.reason).toMatch(/ApprovalDecided is not a record this box relays for picker/);
    expect(await recordsOn(edge)).toEqual([]);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);
  });

  it('a decision head office refuses as conflicting is a visible dead-letter on the box, named on the status route, and survives a restart', async () => {
    const c = await cloud();
    const first = await c.start();
    const original = decisionEvent('a1');
    await postBatch(first, [{ key: original.idempotencyKey, event: original }]);
    await first.syncOnce!();
    // A second box (or the same one, re-keyed by a re-minted device) sends a DIFFERENT decision for a1.
    const conflicting = makeEvent({ ...decisionEvent('a1', { status: 'rejected', decidedBy: 'u-owner', reason: 'against_policy' }), id: 'approval-decision-a1-b', idempotencyKey: 'approval-decision-a1-b' });
    expect((await postBatch(first, [{ key: 'approval-decision-a1-b', event: conflicting }])).acks[0]?.status).toBe('accepted');
    const pass = await first.syncOnce!();
    expect(pass.dead).toBe(1);
    const status = await statusOf(first, ['approval-decision-a1-b']);
    expect(status[0]?.state).toBe('refused');
    expect(status[0]?.reason).toMatch(/decision_conflicts_with_record/);
    expect(first.syncStatus().deadLettered).toBe(1);
    await first.stop();
    cleanups.pop();

    const second = await c.start();
    const after = await statusOf(second, ['approval-decision-a1-b']);
    expect(after[0]?.state).toBe('refused');
    expect(after[0]?.reason).toMatch(/decision_conflicts_with_record/);
    expect(second.syncStatus().deadLettered).toBe(1);
    // Head office still holds exactly the first decision.
    const reg = await registerAt(c.h);
    expect(reg.decisions).toHaveLength(1);
    expect(reg.decisions[0]).toMatchObject({ requestId: 'a1', status: 'approved', decidedBy: 'u-mgr' });
  });

  it('a reply lost between head office and the box is retried and settles to ONE record, acknowledged once (RR-F02)', async () => {
    const c = await cloud();
    const edge = await c.start();
    const e = decisionEvent('a1');
    await postBatch(edge, [{ key: e.idempotencyKey, event: e }]);
    c.loseNextReply();
    const first = await edge.syncOnce!();
    expect(first.sent).toBe(0);
    expect(edge.deviceEventsOutbox.find('approval-decision-a1')).toMatchObject({ state: 'pending', attempts: 1 });
    // The cloud DID record it — the reply was what got lost.
    expect((await registerAt(c.h)).decisions).toHaveLength(1);
    const second = await edge.syncOnce!();
    expect(second.sent).toBe(1);
    expect(edge.deviceEventsOutbox.find('approval-decision-a1')?.state).toBe('acknowledged');
    expect((await registerAt(c.h)).decisions).toHaveLength(1);
    expect(c.posts()).toBe(2);
  });

  it('a cut line keeps the decision on the box — pending, not refused — and it goes when the line is back', async () => {
    const c = await cloud();
    const edge = await c.start();
    const e = decisionEvent('a1');
    await postBatch(edge, [{ key: e.idempotencyKey, event: e }]);
    c.setOnline(false);
    const offline = await edge.syncOnce!();
    expect(offline.sent).toBe(0);
    expect(offline.dead).toBe(0);
    expect((await statusOf(edge, ['approval-decision-a1']))[0]).toMatchObject({ state: 'pending', attempts: 1 });
    c.setOnline(true);
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await statusOf(edge, ['approval-decision-a1']))[0]?.state).toBe('posted');
  });

  it('a box with no cloud takes the work, holds it durably, counts it in its sync status and will not close the day over it', async () => {
    const dir = await tempDir('sre-mgr-decisions-hold-');
    const first = await boxWithoutCloud(dir);
    const e = decisionEvent('a1');
    expect((await postBatch(first, [{ key: e.idempotencyKey, event: e }])).acks[0]?.status).toBe('accepted');
    expect(first.syncStatus()).toMatchObject({ cloud: 'not_configured', unsent: 1 });
    const close = await first.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr' });
    expect(close.closed).toBe(false);
    if (close.closed) return;
    expect(close.reason).toMatch(/unsent|not.*reached|sync/i);
    await first.stop();
    cleanups.pop();

    const second = await boxWithoutCloud(dir);
    expect(second.deviceEventsOutbox.pending().map((i) => i.key)).toEqual(['approval-decision-a1']);
    expect(second.syncStatus().unsent).toBe(1);
    expect((await postBatch(second, [{ key: e.idempotencyKey, event: e }])).acks[0]?.status).toBe('duplicate');
  });
});

describe('the box seals a decision only for the person it verified (2b-vi-c-3 · ADR-0023 amendment · PA-03)', () => {
  type Flagged = { requestId: string; decidedBy: string; flags: string[] };
  const decisionOf = async (h: ApiHarness, id: string): Promise<Flagged | undefined> =>
    (await registerAt(h)).decisions.find((d) => d.requestId === id);

  it('nobody signed in, or somebody else signed in: relayed unsealed, recorded at head office flagged "not verified at the store"', async () => {
    const c = await cloud();
    const edge = await c.start();
    const nobody = decisionEvent('n1');
    const other = decisionEvent('n2');
    expect((await postBatch(edge, [{ key: nobody.idempotencyKey, event: nobody }])).acks[0]?.status).toBe('accepted');
    expect((await postBatch(edge, [{ key: other.idempotencyKey, event: other }], 'manager', 'u-somebody-else')).acks[0]?.status).toBe('accepted');
    // What sits on the box's disk carries no stamp: the box vouches for nobody it did not verify.
    expect(edge.deviceEventsOutbox.pending().map((i) => (i.event.payload as Record<string, unknown>)['deciderVerified'])).toEqual([undefined, undefined]);
    await edge.syncOnce!();
    expect((await decisionOf(c.h, 'n1'))?.flags).toContain('decider_not_verified_at_store');
    expect((await decisionOf(c.h, 'n2'))?.flags).toContain('decider_not_verified_at_store');
  });

  it('a stamp the device wrote itself is removed by the box; the decision of the signed-in manager is sealed by the box and clean', async () => {
    const c = await cloud();
    const edge = await c.start();
    const forged = decisionEvent('f1', { deciderVerified: { userId: 'u-mgr', via: 'pin', laneId: 'lane-1', seal: 'made-up' } });
    await postBatch(edge, [{ key: forged.idempotencyKey, event: forged }]);
    const real = decisionEvent('f2');
    await postBatch(edge, [{ key: real.idempotencyKey, event: real }], 'manager', 'u-mgr');
    const stamps = edge.deviceEventsOutbox.pending().map((i) => (i.event.payload as Record<string, unknown>)['deciderVerified']);
    expect(stamps[0]).toBeUndefined();
    expect(stamps[1]).toMatchObject({ userId: 'u-mgr', via: 'verified_sign_in', laneId: 'lane-1' });
    await edge.syncOnce!();
    expect((await decisionOf(c.h, 'f1'))?.flags).toContain('decider_not_verified_at_store');
    expect((await decisionOf(c.h, 'f2'))?.flags).toEqual([]);
  });

  it('a sealed decision changed on the way (the reason rewritten) no longer matches: flagged, and the change is said', async () => {
    const c = await cloud();
    const edge = await c.start();
    const e = decisionEvent('t1');
    await postBatch(edge, [{ key: e.idempotencyKey, event: e }], 'manager', 'u-mgr');
    const sealed = edge.deviceEventsOutbox.pending()[0]!.event.payload as Record<string, unknown>;
    // Posted straight to head office with one word changed after the box sealed it.
    const res = await c.h.request({
      method: 'POST', path: '/v1/approvals/decisions/t1/synced', userId: 'u-box', tenantId: A, idempotencyKey: 'tampered-t1',
      body: { ...sealed, reason: 'rewritten after the seal' },
    });
    expect((res.body as { flags: string[] }).flags).toContain('decider_seal_does_not_match');
  });
});

describe('the migration screen\'s decisions ride the same box route, sealed (2b-vi-c-4)', () => {
  it('an exception resolved on the screen is relayed by a real box, sealed for the signed-in owner, and applied at head office', async () => {
    const c = await cloud();
    const EX = { exceptionId: 'EX-1', kind: 'duplicate_product', severity: 'low', confidence: 'probable', legacyIds: ['L-1', 'L-2'], evidence: 'same name and pack' };
    expect((await c.h.request({ method: 'POST', path: '/v1/migration/exceptions', userId: 'u-mgr', tenantId: A, idempotencyKey: 'x1', body: { exceptions: [EX] } })).status).toBe(201);
    const edge = await c.start();
    const e = makeEvent({
      id: 'MigrationExceptionResolved-EX-1', type: 'MigrationExceptionResolved', occurredAt: AT, idempotencyKey: `${A}:MigrationExceptionResolved:EX-1`,
      source: 'migration-screen',
      payload: { tenantId: A, cutoverId: 'cut-1', exceptionId: 'EX-1', action: 'migrate_as_is', decidedBy: 'u-owner', reason: 'both are genuinely sold' },
    });
    // The screen's source is the ERP surface ('manager'); a handheld may not send it.
    expect((await postBatch(edge, [{ key: e.idempotencyKey, event: e }], 'warehouse')).acks[0]?.status).toBe('refused');
    expect((await postBatch(edge, [{ key: e.idempotencyKey, event: e }], 'manager', 'u-owner')).acks[0]?.status).toBe('accepted');
    expect((edge.deviceEventsOutbox.pending()[0]?.event.payload as Record<string, unknown>)['deciderVerified']).toMatchObject({ userId: 'u-owner' });
    const pass = await edge.syncOnce!();
    expect(pass.dead).toBe(0);
    const ex = (await c.h.request({ method: 'GET', path: '/v1/migration/exceptions', userId: 'u-owner', tenantId: A })).body as { exceptions: { resolution?: { decidedBy: string } }[] };
    expect(ex.exceptions[0]?.resolution).toMatchObject({ decidedBy: 'u-owner' });
  });
});

