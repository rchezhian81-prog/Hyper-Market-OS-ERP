import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { hmacSigner } from '../../services/catalogue/src/index';
import { signStorePack, verifyStorePack, type StorePackEnvelope } from '../../services/platform/src/store-packs';
import { STREAM, ROLE_REVOKED } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **PA-06 = DF-3-a — head office builds each store's setup and the store computer takes it, checked (Wave 4 · OB-25 "A" ·
 * M01-FR-03 · M02-FR-01/02 · §31 · P-01 · P-02 · P-08).**
 *
 * The audit found it: a store computer read its setup from a FILE someone carried to it, and nothing checked who made it,
 * for which shop or store, or how old it was. Real head office, a real store computer, the real pull:
 *   • head office builds the setup from its own records — the store's settings, the people granted at this store and
 *     their names, the products it published — signed, numbered, for this store only;
 *   • the store computer takes it only if the signature checks and it is this shop's, this store's and newer; it is
 *     written to disk (the one it replaces kept), it replaces the pack file, and it survives a restart;
 *   • a person granted later reaches the store on the next pull (always current, OB-25 "A"); a person whose grant ends
 *     leaves it; another store's computer cannot read this store's setup; head office unreachable → the store keeps
 *     trading on what it has, and an out-of-date setup is SAID, never thrown away.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: 'WH' };
const signer = hmacSigner(TEST_PACK_KEY);

describe('PA-06 — head office delivers each store its setup', () => {
  let h: ApiHarness;
  let dir: string;
  const edges: EdgeProcess[] = [];
  const savedFetch = globalThis.fetch;
  let cut = false;
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner') =>
    h.request({ method, path, userId, tenantId: A, ...(method === 'POST' ? { idempotencyKey: `k-${Math.random()}` } : {}), ...(body === undefined ? {} : { body }) });
  const boot = async (over: Record<string, string> = {}) => {
    const e = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: 'S1' }), // this store computer's credential is bound to its store
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: 'S1', ...over,
    }, () => {}))!;
    edges.push(e);
    return e;
  };

  beforeEach(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-box', 'cashier', ['S1']);   // this store computer's own identity, at S1 only
    await h.provisionRole(A, 'u-box2', 'cashier', ['S2']);  // another store's computer
    await h.provisionRole(A, 'u-mgr', 'store_manager', ['S1']);
    cut = false;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (cut) throw new Error('network down');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-store-setup-'));
    const node = (id: string, body: Record<string, unknown>) => call('POST', `/v1/org/nodes/${id}`, body);
    expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await node('WH', { kind: 'warehouse', name: 'Back store', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await node('S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await node('S2', { kind: 'branch', name: 'Second store', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  });
  afterEach(async () => {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it('THE AUDIT\'S CASE: the store computer takes ITS setup from head office — signed, checked, on disk, replacing the file, and kept across a restart', async () => {
    // A store head office has not set up yet: nothing to send, and the store computer says so.
    expect((await call('GET', '/v1/store-packs/S1')).status).toBe(404);
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    // A pack FILE on the box (the old way) — the head-office setup must replace it, not mix with it.
    await writeFile(join(dir, 'old-pack.json'), JSON.stringify({ version: 1, policies: { storeId: 'OLD', branchId: 'OLD', branchName: 'From a file', tradingDayCutoff: '00:00', staleAfterSeconds: 1, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 1, warehouseId: 'OLD' } }));
    const edge = await boot({ EDGE_PACK_FILE: join(dir, 'old-pack.json') });
    expect(edge.storeSetup()).toMatchObject({ source: 'file' });

    const outcome = await edge.refreshStorePack!();
    expect(outcome).toMatchObject({ status: 'updated', expired: false });
    expect(edge.storeSetup()).toMatchObject({ source: 'head-office', expired: false });
    const onDisk = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect(verifyStorePack(signer, onDisk, { tenantId: A, storeId: 'S1', heldVersion: null, now: onDisk.issuedAt })).toEqual({ accepted: true });
    expect(onDisk.sections['policies']).toMatchObject({ storeId: 'S1', branchName: 'SRE Hyper Market', tradingDayCutoff: '02:00', warehouseId: 'WH' });
    expect((onDisk.sections['roleAssignments'] as { userId: string }[]).map((g) => g.userId).sort()).toEqual(['u-box', 'u-mgr', 'u-owner']);

    // The same content again is not news; a restart comes back on head office's setup, not the file.
    expect((await edge.refreshStorePack!()).status).toBe('unchanged');
    await edge.stop(); edges.pop();
    const again = await boot({ EDGE_PACK_FILE: join(dir, 'old-pack.json') });
    expect(again.storeSetup()).toMatchObject({ source: 'head-office', version: onDisk.version });
  });

  it('always current: a person granted later reaches the store on the next pull; a person whose grant ends leaves it', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const edge = await boot();
    await edge.refreshStorePack!();
    await h.provisionRole(A, 'u-new', 'cashier', ['S1']);
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const held = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect((held.sections['people'] as { userId: string }[]).map((p) => p.userId)).toContain('u-new');
    // The one it replaced is kept beside it.
    expect(JSON.parse(await readFile(join(dir, 'store-pack.previous.json'), 'utf8'))).toMatchObject({ storeId: 'S1' });
    // A person granted only at ANOTHER store never reaches this one.
    expect((held.sections['people'] as { userId: string }[]).map((p) => p.userId)).not.toContain('u-box2');

    // The new person's grant ends (a leaver): the next pull carries a setup without them.
    await h.store.append(A, STREAM.identity, makeEvent({
      id: 'revoke-u-new', type: ROLE_REVOKED, occurredAt: new Date().toISOString(), idempotencyKey: `revoke-${A}-u-new`, source: 'test',
      payload: { userId: 'u-new', roleId: 'cashier', branchScope: ['S1'] },
    }));
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const after = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect((after.sections['people'] as { userId: string }[]).map((p) => p.userId)).not.toContain('u-new');
  });

  it('only for that store: another store\'s computer cannot read it; a forged or another store\'s setup is refused and the held one stays', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const other = await h.request({ method: 'GET', path: '/v1/store-packs/S1', userId: 'u-box2', tenantId: A, branchId: 'S2' });
    expect(other.status).toBe(403);
    expect((other.body as { error: { code: string } }).error.code).toBe('not_this_stores_computer');

    const now = new Date().toISOString();
    const real = signStorePack(signer, { tenantId: A, storeId: 'S1', issuedAt: now, sections: { policies: {} } });
    expect(verifyStorePack(signer, { ...real, sections: { policies: { storeId: 'EVIL' } } }, { tenantId: A, storeId: 'S1', heldVersion: null, now })).toMatchObject({ accepted: false, reason: 'bad_signature' });
    expect(verifyStorePack(signer, real, { tenantId: A, storeId: 'S2', heldVersion: null, now })).toMatchObject({ accepted: false, reason: 'wrong_store' });
    expect(verifyStorePack(signer, real, { tenantId: 'other-shop', storeId: 'S1', heldVersion: null, now })).toMatchObject({ accepted: false, reason: 'wrong_shop' });
    expect(verifyStorePack(signer, real, { tenantId: A, storeId: 'S1', heldVersion: real.version, now })).toMatchObject({ accepted: false, reason: 'not_newer' });
    expect(verifyStorePack(hmacSigner('another-key'.padEnd(48, '0')), real, { tenantId: A, storeId: 'S1', heldVersion: null, now })).toMatchObject({ accepted: false, reason: 'bad_signature' });

    // A tampered file on the store computer's disk is not trusted at restart.
    const edge = await boot();
    await edge.refreshStorePack!();
    const onDisk = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    await edge.stop(); edges.pop();
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify({ ...onDisk, sections: { ...onDisk.sections, policies: { storeId: 'EVIL' } } }));
    expect((await boot()).storeSetup()).toMatchObject({ source: 'none' });
  });

  it('head office unreachable: the store keeps trading on what it has, says so; an out-of-date setup is said, not thrown away', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const edge = await boot();
    await edge.refreshStorePack!();
    cut = true;
    const offline = await edge.refreshStorePack!();
    expect(offline).toMatchObject({ status: 'offline', expired: false });
    expect(offline.staffMessage).toMatch(/could not be reached.*store setup/);
    expect(edge.storeSetup().source).toBe('head-office');

    // A held setup issued long ago: restored, used, and marked out of date.
    await edge.stop(); edges.pop();
    const old = signStorePack(signer, { tenantId: A, storeId: 'S1', issuedAt: '2026-01-01T00:00:00.000Z', sections: { policies: { storeId: 'S1' } } });
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(old));
    const restarted = await boot();
    expect(restarted.storeSetup()).toMatchObject({ source: 'head-office', expired: true });
    expect((await restarted.refreshStorePack!()).staffMessage).toMatch(/OUT OF DATE/);
    // Reachable again: the current setup replaces it.
    cut = false;
    expect((await restarted.refreshStorePack!()).status).toBe('updated');
    expect(restarted.storeSetup()).toMatchObject({ expired: false });
  });

  it('store settings are head office\'s record: owner sets them (a new version each change), a manager may not, a bad value is refused', async () => {
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    expect(((await call('POST', '/v1/stores/S1/settings', { ...SETTINGS, handoverToleranceMinor: 7_500 })).body as { settings: { version: number } }).settings.version).toBe(2);
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS, 'u-mgr')).status).toBe(403);
    expect((await call('POST', '/v1/stores/S1/settings', { ...SETTINGS, tradingDayCutoff: '25:00' })).status).toBe(400);
    expect((await call('POST', '/v1/stores/NOPE/settings', SETTINGS)).status).toBe(404);
    expect((await call('GET', '/v1/stores/S1/settings')).body).toMatchObject({ settings: { handoverToleranceMinor: 7_500, version: 2 } });
  });
});
