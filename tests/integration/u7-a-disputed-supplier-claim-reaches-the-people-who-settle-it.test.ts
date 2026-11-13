import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { claimDisputeAlertSweep, claimDisputeCountsFor } from '../../services/api/src/rfq-requests-adapters';
import { alsoEachPassOf } from '../../services/api/src/ops-alert-sweeps';
import { streamName, STREAM } from '../../services/api/src/adapters';

const ALERTS_STREAM = streamName(STREAM.platform, 'alerts');

/**
 * **U7 · OB-726 (owner, in writing: B) · M24-FR-02 alt — a disputed (rejected) supplier claim reaches the people who
 * settle it, and is counted for the Today page.** A supplier raises two claims; the buyer rejects both:
 *
 *   • the counts the store pack carries (`claimDisputeCountsFor`, in the signed pack head office serves) are the register's
 *     own: 2 open, 0 overdue;
 *   • the ops-alert worker's sweep raises ONE alert per open dispute, owned by the buyer who rejected it and also sent to
 *     every owner (who may settle it too); a second pass raises nothing (the open alert collapses it), and so does a
 *     replayed pass at the same moment;
 *   • settling one dispute on Supplier claims clears ITS alert at once (and a later pass clears nothing twice); the other
 *     stays open; the counts follow (1 open);
 *   • every change is a new fact on the alert log — the raise is still there after the clear (append-only);
 *   • the worker's own hook runs the sweep (`alsoEachPassOf`);
 *   • on PostgreSQL the alerts and the counts survive a cold restart.
 * Synthetic data only.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

interface BoardAlert { alert: { alertId: string; ownerUserId: string; alsoToUserIds?: string[]; detail: string; component: string }; state: string; occurrence: number }

describe.each(backings)('U7 · OB-726 — a disputed supplier claim is alerted and counted — on $name', ({ name, harness }) => {
  it('raised once per open dispute to the buyer and the owners; settled → cleared; counted for Today', async () => {
    let h = harness();
    const T = randomUUID();
    const post = (path: string, userId: string, body: unknown) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `${path}-${userId}-${randomUUID()}`, body });
    const now = () => new Date().toISOString();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 's-1');
    for (const [u, r] of [['u-buyer', 'store_manager'], ['u-sup', 'supplier']] as const) await h.provisionRole(T, u, r);
    await deliveryPlaces(h, T, 'store-1');
    expect((await post('/v1/purchase/orders/po-x', 'u-buyer', { supplierId: 's-1', deliverToLocationId: 'store-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }] })).status).toBe(201);
    expect((await post('/v1/purchase/orders/po-x/approval', 'u-owner', { reason: 'fixture' })).status).toBe(200);
    expect((await post('/v1/supplier-portal/partners/s-1', 'u-buyer', { grants: ['raise_claim'], documents: [], requiredDocuments: [], logins: ['u-sup'] })).status).toBeLessThan(300);
    for (const id of ['clm-a', 'clm-b']) {
      expect((await post('/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: id, kind: 'claim', document: { poId: 'po-x', claimMinor: 2_000, why: 'bill short-paid' } })).status).toBe(201);
    }

    const sweep = () => claimDisputeAlertSweep({ store: h.store, now })(T, now());
    const counts = () => claimDisputeCountsFor({ store: h.store, now })(T);
    const board = async (): Promise<BoardAlert[]> => {
      const r = await h.request({ method: 'GET', path: '/v1/platform/alerts', userId: 'u-owner', tenantId: T });
      expect(r.status).toBe(200);
      return ((r.body as { alerts: BoardAlert[] }).alerts).filter((a) => a.alert.alertId.startsWith('supplier-claim-dispute:'));
    };

    // Nothing rejected yet: nothing to raise, and an honest zero to count.
    expect(await sweep()).toBe(0);
    expect(await counts()).toEqual({ open: 0, overdue: 0 });

    for (const id of ['clm-a', 'clm-b']) {
      expect((await post(`/v1/supplier-portal/partners/s-1/submissions/${id}/review`, 'u-buyer', { decision: 'reject', reason: 'paid in full on 2 Nov' })).status).toBe(201);
    }
    expect(await counts()).toEqual({ open: 2, overdue: 0 });
    // The store pack head office signs carries the same two counts (no build time inside) — what the Today page reads.
    expect((await post('/v1/stores/store-1/settings', 'u-owner', { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'store-1' })).status).toBeLessThan(300);
    const pack = await h.request({ method: 'GET', path: '/v1/store-packs/store-1', userId: 'u-owner', tenantId: T });
    expect(pack.status, JSON.stringify(pack.body).slice(0, 300)).toBe(200);
    expect((pack.body as { sections: Record<string, unknown> }).sections['supplierClaimDisputes']).toEqual({ open: 2, overdue: 0 });

    // ── 1 · Raised once per open dispute — to the buyer who rejected it, and to every owner.
    expect(await sweep()).toBe(2);
    expect(await sweep()).toBe(0); // already open — collapses
    const at = now();
    const same = claimDisputeAlertSweep({ store: h.store, now });
    expect(await same(T, at)).toBe(0);
    expect(await same(T, at)).toBe(0); // a replayed pass at the same moment writes nothing either
    let alerts = await board();
    expect(alerts.map((a) => a.alert.alertId).sort()).toEqual(['supplier-claim-dispute:DSP-clm-a', 'supplier-claim-dispute:DSP-clm-b']);
    for (const a of alerts) {
      expect(a.state).toBe('open');
      expect(a.occurrence).toBe(1);
      expect(a.alert.ownerUserId).toBe('u-buyer');
      expect(a.alert.alsoToUserIds ?? []).toEqual(expect.arrayContaining(['u-owner']));
      expect(a.alert.detail).toContain('s-1');
      expect(a.alert.detail).toContain('Supplier claims');
    }

    // ── 2 · Settling one clears ITS alert at once; the other stays open; the counts follow.
    expect((await post('/v1/purchase/supplier-claims/disputes/s-1/clm-a/resolve', 'u-buyer', { outcome: 'supplier_withdrew', reason: 'supplier saw the 2 Nov payment' })).status).toBe(201);
    alerts = await board();
    expect(alerts.find((a) => a.alert.alertId === 'supplier-claim-dispute:DSP-clm-a')?.state).toBe('cleared');
    expect(alerts.find((a) => a.alert.alertId === 'supplier-claim-dispute:DSP-clm-b')?.state).toBe('open');
    expect(await counts()).toEqual({ open: 1, overdue: 0 });
    expect(await sweep()).toBe(0); // the settled one is never raised again; nothing cleared twice
    const log = await h.store.readStream(T, ALERTS_STREAM, { type: 'AlertLifecycle' });
    const facts = log.map((e) => e.event.payload as { alertId: string; change: string }).filter((p) => p.alertId === 'supplier-claim-dispute:DSP-clm-a').map((p) => p.change);
    expect(facts).toEqual(['raised', 'cleared']); // append-only: the raise is kept beside the clear

    // ── 3 · The worker's own hook runs it (nothing new now).
    const said: string[] = [];
    expect(await alsoEachPassOf({ breaches: async () => 0, gstTimeBar: async () => 0, claimDisputes: claimDisputeAlertSweep({ store: h.store, now }), say: (l) => said.push(l) })(T, now())).toBe(0);
    expect(said).toEqual([]);

    // ── 4 · Cold restart (PostgreSQL): the alerts and the counts are still there.
    if (name === 'real PostgreSQL') {
      const sql = pgPoolClient(pool!);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
      alerts = await board();
      expect(alerts.find((a) => a.alert.alertId === 'supplier-claim-dispute:DSP-clm-b')?.state).toBe('open');
      expect(alerts.find((a) => a.alert.alertId === 'supplier-claim-dispute:DSP-clm-a')?.state).toBe('cleared');
      expect(await counts()).toEqual({ open: 1, overdue: 0 });
      expect(await sweep()).toBe(0);
    }
  }, 120_000);
});
