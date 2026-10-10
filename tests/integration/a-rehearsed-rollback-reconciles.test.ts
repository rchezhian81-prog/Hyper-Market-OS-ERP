import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **GT-02 — a rehearsed rollback restores service AND reconciles the data, with the store's sync part of it, and the
 * outcome survives a restart (MG-11 · QG-08 · QG-12 · P-01 · P-08 · hard rule #6).**
 *
 * The REAL API (`startApi`) on REAL PostgreSQL, a REAL store computer (`startEdge`) syncing to it over HTTP. The
 * rehearsal: the new system starts trading; the store sells; one sale is rung while the store's line is down and sits on
 * its disk; the rollback is decided and the old system is seen taking its first bill (service restored). Then:
 *   • reconciling is REFUSED while the store computer has not synced past the switch-back — a sale still on its disk
 *     would be missing from head office's count;
 *   • the line comes back, the waiting sale goes up and the box reports; head office counts the new system's window from
 *     its OWN sales ledger (4 bills) — the old system holding only 3 is recorded as NOT reconciled, naming both
 *     differences, and the cutover gate still says "rollback not demonstrated";
 *   • the missing bill carried back: 4 bills, same takings — reconciled; the gate's rollback check passes, from the
 *     ledger, not from anything typed;
 *   • the API process is stopped and started again: the rollback, its execution evidence and both reconciliations are
 *     all still there, and the gate still reads it as demonstrated.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
const KEY = ['rollback', 'rehearsal', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const BOX = 'u-box1';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 5); });

describeOrSkip('GT-02 — a rehearsed rollback reconciles, store sync included — real API, real PostgreSQL, real store box, across a restart', () => {
  const clouds: RealCloud[] = [];
  const edges: EdgeProcess[] = [];
  const dirs: string[] = [];
  const savedFetch = globalThis.fetch;
  afterAll(async () => {
    for (const e of edges) await e.stop();
    for (const c of clouds) await c.stop();
    globalThis.fetch = savedFetch;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('refused while the store holds sales; recorded but not demonstrated when the old system is a bill short; demonstrated when every bill is back; kept across a restart', async () => {
    const tenantId = randomUUID();
    let cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY });
    clouds.push(cloud);
    const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
      cloud.request({ method, path, userId: OWNER, ...(body === undefined ? {} : { body }), ...(method === 'POST' ? { idempotencyKey: `k-${Math.random()}` } : {}) });

    // One store and its computer's own sign-in.
    expect((await call('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await call('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    await cloud.grant(BOX, 'cashier');
    const boxToken = cloud.token(BOX);
    // The store's line can be cut on its own: only the box's requests fail while it is down.
    let lineDown = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
      if (lineDown && auth === `Bearer ${boxToken}`) throw new Error('network down');
      return savedFetch(url, init);
    }) as typeof globalThis.fetch;

    const dir = await mkdtemp(join(tmpdir(), 'sre-gt02-')); dirs.push(dir);
    await writeFile(join(dir, 'setup.json'), JSON.stringify({ version: 1, policies: { storeId: 'S1', branchId: 'S1', branchName: 'SRE Hyper Market', tradingDayCutoff: '00:00', staleAfterSeconds: 3600, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 30, warehouseId: 'S1' } }));
    const sale = async (id: string, totalMinor: number): Promise<void> => {
      const committedAt = new Date().toISOString();
      const record = JSON.stringify({ id, saleId: id, laneId: 'lane-1', tradingDay: committedAt.slice(0, 10), committedAt, total: totalMinor, totalMinor, currency: 'INR', lines: [{ productId: 'P1', qty: 1, unitPriceMinor: totalMinor }], tenders: [{ kind: 'cash', amountMinor: totalMinor }] });
      await appendFile(join(dir, 'sales.log'), `${Buffer.byteLength(record, 'utf8')} ${record}\n`);
    };
    const boot = async (): Promise<EdgeProcess> => {
      const e = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_PACK_FILE: join(dir, 'setup.json'),
        CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: boxToken, EDGE_STORE_ID: 'S1',
      }, () => {}))!;
      edges.push(e);
      return e;
    };

    // The rehearsal night: the new system starts taking sales; three are rung and reach head office.
    const newSystemFrom = new Date().toISOString();
    await tick();
    await sale('R-1', 12_000); await sale('R-2', 8_500); await sale('R-3', 30_000);
    let box = await boot();
    await box.syncOnce!();
    expect(box.agent!.health().unsentCount).toBe(0);
    expect(await box.reportSyncWatermarks!()).toBe(true);

    // The line goes down; a fourth sale is rung and waits on the box's disk (through a restart of the box).
    lineDown = true;
    await box.stop(); edges.splice(edges.indexOf(box), 1);
    await sale('R-4', 4_250);
    box = await boot();
    await box.syncOnce!();
    expect(box.agent!.health().unsentCount).toBe(1);

    // The rollback: decided, then PERFORMED — the old system seen taking its first bill (service restored).
    expect((await call('POST', '/v1/migration/cutover/rollback', { cutoverId: 'cut-r', trigger: 'owner_decision', legacySystemAvailable: true })).status).toBe(201);
    await tick();
    const switchBack = new Date().toISOString();
    expect((await call('POST', '/v1/migration/cutover/rollback/cut-r/confirmation', { legacyFirstBillRef: 'OLD-5001', legacyTradingFrom: switchBack })).status).toBe(201);
    const reconcile = (count: number, totalMinor: number) => call('POST', '/v1/migration/cutover/rollback/cut-r/reconciliation', { newSystemTradingFrom: newSystemFrom, legacyCarriedBack: { count, totalMinor } });

    // 1 — REFUSED while the store computer has not synced past the switch-back: R-4 is still on its disk.
    const early = await reconcile(3, 50_500);
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('store_not_synced_through_switch_back');
    expect(((await call('GET', '/v1/migration/cutover/rollback/cut-r')).body as { reconciliations: unknown[] }).reconciliations).toEqual([]);

    // The line comes back: the waiting sale goes up and the box reports how far it has synced.
    lineDown = false;
    await tick();
    await box.syncOnce!();
    expect(box.agent!.health().unsentCount).toBe(0);
    expect(await box.reportSyncWatermarks!()).toBe(true);

    // 2 — The old system holds only 3 of the 4 bills: recorded as evidence, NOT reconciled, both differences named.
    const short = await reconcile(3, 50_500);
    expect(short.status).toBe(201);
    expect(short.body).toMatchObject({
      demonstrated: false,
      reconciliation: { reconciled: false, newSystem: { count: 4, totalMinor: 54_750 }, legacy: { count: 3, totalMinor: 50_500 }, stores: [{ storeId: 'S1' }] },
    });
    const gate = async (c: RealCloud) => ((await c.request({ method: 'POST', path: '/v1/migration/cutover/decision', userId: OWNER, idempotencyKey: `g-${Math.random()}`, body: { cutoverId: 'cut-r', evidence: { rollbackDemonstratedAt: '2026-01-01T00:00:00Z' } } })).body as { checks: { check: string; state: string }[]; ignoredFromCaller: string[] });
    const notYet = await gate(cloud);
    expect(notYet.checks.find((c) => c.check === 'rollback_demonstrated')?.state).toBe('failed');
    expect(notYet.ignoredFromCaller).toContain('rollbackDemonstratedAt');          // a typed time stands in for nothing

    // 3 — R-4 carried back: 4 bills, 54,750 paise on both sides. Reconciled; demonstrated.
    const balanced = await reconcile(4, 54_750);
    expect(balanced.status).toBe(201);
    expect(balanced.body).toMatchObject({ demonstrated: true, reconciliation: { reconciled: true, differences: [] } });
    expect((await gate(cloud)).checks.find((c) => c.check === 'rollback_demonstrated')?.state).toBe('passed');

    // 4 — RELOAD: a new API process over the same database. Everything is on the record.
    await cloud.stop(); clouds.pop();
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY });
    clouds.push(cloud);
    const after = (await call('GET', '/v1/migration/cutover/rollback/cut-r')).body as { rollback: { state: string; performed: boolean; execution: { legacyFirstBillRef: string } }; reconciliations: { reconciled: boolean }[]; demonstrated: boolean };
    expect(after.rollback).toMatchObject({ state: 'performed', performed: true, execution: { legacyFirstBillRef: 'OLD-5001' } });
    expect(after.reconciliations.map((r) => r.reconciled)).toEqual([false, true]);   // the short one is kept too (#6)
    expect(after.demonstrated).toBe(true);
    expect((await gate(cloud)).checks.find((c) => c.check === 'rollback_demonstrated')?.state).toBe('passed');
  }, 60_000);
});
