// M35-FR-03 through the real authenticated API: the cloud's own ledgers become the health signals — the
// newest synced sale, the connector queues' dead letters, the catalogue pack's age, the adapters'
// heartbeats, the backups recorded — judged by the same engine; alerts raised from what was OBSERVED land
// on the same board the manual raise feeds; a lane's disk is never guessed.
import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa35';
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const post = (h: ApiHarness, path: string, u: string, key: string, body?: unknown) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, ...(body === undefined ? {} : { body }) });
const put = (h: ApiHarness, path: string, u: string, key: string, body: unknown) =>
  h.request({ method: 'PUT', path, userId: u, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, u: string) => h.request({ method: 'GET', path, userId: u, tenantId: A });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const RULES = {
  rules: [
    { alertId: 'sync-lag', component: 'sync', firesAt: 'degraded', ownerUserId: OWNER, ownerName: 'The owner', ackWithinMinutes: 30, escalatesToUserId: MGR },
    { alertId: 'dead-letters', component: 'dead_letter', firesAt: 'down', ownerUserId: MGR, ownerName: 'Store manager', ackWithinMinutes: 60 },
    { alertId: 'backup-stale', component: 'backup', firesAt: 'unknown', ownerUserId: OWNER, ownerName: 'The owner', ackWithinMinutes: 240 },
  ],
};
const bankSale = (h: ApiHarness, saleId: string, committedAt: string) => post(h, '/v1/sales', OWNER, `oh-${saleId}`, {
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, tradingDay: committedAt.slice(0, 10), committedAt,
  totalMinor: 10_000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'RICE', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_000, lineTotalMinor: 10_000 }],
  tenders: [{ kind: 'cash', amountMinor: 10_000 }],
});

interface Observed { observed: { signals: Record<string, unknown>; freshness: { lastSaleAt: string | null; ageSeconds: number | null }; queues: { connectorId: string; queued: number; deadLettered: number }[]; notObserved: string[] }; health: { status: string; components: { name: string; status: string }[] }; wouldRaise: { alertId: string }[]; rulesVersion: number | null }
const component = (o: Observed, name: string) => o.health.components.find((c) => c.name === name);

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, OWNER);
  await h.provisionRole(A, MGR, 'store_manager');
  await h.provisionRole(A, CASH, 'cashier');
  return h;
}

describe('observed operational health (M35-FR-03, API-11)', () => {
  it('reads its own ledgers: a fresh sale, a published pack, a connector with a dead letter, an adapter\'s heartbeats, a recorded backup', async () => {
    const h = await cast();
    // Nothing yet: everything is said to be unknown or empty — never ok by assumption.
    let o = (await get(h, '/v1/platform/operational-health/observed', OWNER)).body as Observed;
    expect(o.observed.freshness).toEqual({ lastSaleAt: null, ageSeconds: null });
    expect(component(o, 'sync')).toMatchObject({ status: 'unknown' });
    expect(component(o, 'backup')).toMatchObject({ status: 'unknown' });
    expect(o.health.components.some((c) => c.name === 'local_store')).toBe(false);
    expect(o.observed.notObserved[0]).toMatch(/localStoreWritable/);

    await h.store.append(A, STREAM.catalogue, makeEvent({
      id: 'pack-1', type: 'CataloguePublished', occurredAt: minutesAgo(30), idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: A, version: 1, builtAt: minutesAgo(30), products: [{ productId: 'RICE', taxBps: 500 }], barcodes: [] } },
    }));
    const saleAt = minutesAgo(2);
    expect((await bankSale(h, 's1', saleAt)).status).toBeLessThan(300);
    // A connector with a mapping, one queued message and one dead-lettered (M32).
    expect((await post(h, '/v1/integration/connectors/tally/mappings/v1', OWNER, 'map-1', { rules: [{ kind: 'copy', from: 'total', to: 'amount' }], required: ['amount'] })).status).toBeLessThan(300);
    expect((await post(h, '/v1/integration/connectors/tally/queue/m1', OWNER, 'q-m1', { kind: 'voucher', deliveryKey: 'd1', connectorVersion: 'v1', payload: { total: 1 } })).status).toBeLessThan(300);
    expect((await post(h, '/v1/integration/connectors/tally/queue/m2', OWNER, 'q-m2', { kind: 'voucher', deliveryKey: 'd2', connectorVersion: 'v1', payload: { total: 2 } })).status).toBeLessThan(300);
    expect((await post(h, '/v1/integration/connectors/tally/queue/m2/failed', OWNER, 'q-m2-dead', { reason: 'Tally refused the ledger name', permanent: true })).status).toBeLessThan(300);
    // An enabled adapter with a recent good heartbeat, and a disabled one that must not be judged.
    expect((await post(h, '/v1/integration/adapters/tally-books', OWNER, 'ad-tally', { category: 'accounting', vendor: 'demo-books', environment: 'sandbox', credentialRef: 'vault://demo/tally', enabled: true, retains: [] })).status).toBeLessThan(300);
    expect((await post(h, '/v1/integration/adapters/tally-books/heartbeats/hb-1', OWNER, 'hb-1', { ok: true, at: minutesAgo(5) })).status).toBeLessThan(300);
    expect((await post(h, '/v1/integration/adapters/sms', OWNER, 'ad-sms', { category: 'messaging', vendor: 'demo-sms', environment: 'sandbox', credentialRef: 'vault://demo/sms', enabled: false, retains: [] })).status).toBeLessThan(300);
    expect((await post(h, '/v1/platform/backups/nightly-1/taken', MGR, 'bk-1', { at: minutesAgo(180), ok: true, encrypted: true, offsite: true, sizeBytes: 1_024 })).status).toBe(201);

    o = (await get(h, '/v1/platform/operational-health/observed', OWNER)).body as Observed;
    expect(o.observed.freshness.lastSaleAt).toBe(saleAt);
    expect(o.observed.freshness.ageSeconds).toBeGreaterThanOrEqual(100);
    expect(o.observed.freshness.ageSeconds).toBeLessThan(600);
    expect(o.observed.signals).toMatchObject({ queueDepth: 1, deadLetterCount: 1, databaseReachable: true, integrations: { 'tally-books': true } });
    expect(o.observed.signals['integrations']).not.toHaveProperty('sms');
    expect(o.observed.queues).toEqual([{ connectorId: 'tally', queued: 1, deadLettered: 1 }]);
    expect(component(o, 'sync')).toMatchObject({ status: 'ok' });
    expect(component(o, 'dead_letter')).toMatchObject({ status: 'down' });
    expect(component(o, 'catalogue')).toMatchObject({ status: 'ok' });
    expect(component(o, 'backup')).toMatchObject({ status: 'ok' });
    expect(component(o, 'integration:tally-books')).toMatchObject({ status: 'ok' });
    expect(o.rulesVersion).toBeNull();
    expect(o.wouldRaise).toEqual([]);
  });

  it('with rules defined, what was observed is raised onto the alert board — owned, escalatable, acknowledgeable; and nothing without rules', async () => {
    const h = await cast();
    await bankSale(h, 's-old', minutesAgo(180)); // three hours ago: sync is DOWN
    await post(h, '/v1/integration/connectors/tally/mappings/v1', OWNER, 'map-1', { rules: [{ kind: 'copy', from: 'total', to: 'amount' }], required: ['amount'] });
    await post(h, '/v1/integration/connectors/tally/queue/m1', OWNER, 'q-m1', { kind: 'voucher', deliveryKey: 'd1', connectorVersion: 'v1', payload: { total: 1 } });
    await post(h, '/v1/integration/connectors/tally/queue/m1/failed', OWNER, 'q-m1-dead', { reason: 'poison', permanent: true });

    const refused = await post(h, '/v1/platform/operational-health/observed/raise', OWNER, 'raise-0');
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe('alert_rules_not_defined');
    expect(((await get(h, '/v1/platform/alerts', OWNER)).body as { alerts: unknown[] }).alerts).toEqual([]);

    expect((await put(h, '/v1/platform/alert-rules', OWNER, 'rules-1', RULES)).body).toMatchObject({ version: 1, rules: 3 });
    expect(((await get(h, '/v1/platform/alert-rules', MGR)).body as { rules: { version: number; definedBy: string } }).rules).toMatchObject({ version: 1, definedBy: OWNER });

    const raised = await post(h, '/v1/platform/operational-health/observed/raise', OWNER, 'raise-1');
    expect(raised.status).toBe(200);
    const body = raised.body as { raised: number; newlyOpened: number; alerts: { alertId: string; status: string; ownerUserId: string }[] };
    expect(body.newlyOpened).toBe(3);
    expect(body.alerts.map((a) => [a.alertId, a.status, a.ownerUserId])).toEqual(expect.arrayContaining([
      ['sync-lag', 'down', OWNER], ['dead-letters', 'down', MGR], ['backup-stale', 'unknown', OWNER],
    ]));
    const board = (await get(h, '/v1/platform/alerts', MGR)).body as { alerts: { alert: { alertId: string }; state: string; escalatesToUserId?: string }[] };
    expect(board.alerts.map((a) => [a.alert.alertId, a.state])).toEqual(expect.arrayContaining([['sync-lag', 'open'], ['dead-letters', 'open'], ['backup-stale', 'open']]));
    expect(board.alerts.find((a) => a.alert.alertId === 'sync-lag')?.escalatesToUserId).toBe(MGR);
    // The manual lifecycle works on them unchanged: the owner acknowledges the sync alert.
    expect((await post(h, '/v1/platform/alerts/sync-lag/acknowledge', OWNER, 'ack-1', { note: 'lane 1 was offline for stocktake' })).status).toBeLessThan(300);
    const after = (await get(h, '/v1/platform/alerts', OWNER)).body as { alerts: { alert: { alertId: string }; state: string }[] };
    expect(after.alerts.find((a) => a.alert.alertId === 'sync-lag')?.state).toBe('acknowledged');
    // A re-run re-raises the still-true conditions but opens nothing new.
    const again = (await post(h, '/v1/platform/operational-health/observed/raise', OWNER, 'raise-2')).body as { raised: number; newlyOpened: number };
    expect(again.raised).toBe(3);
    expect(again.newlyOpened).toBe(0);
    // Cold restart: the rules and the board are facts on the ledger.
    const h2 = apiHarness({ store: h.store });
    expect(((await get(h2, '/v1/platform/alert-rules', OWNER)).body as { rules: { version: number } }).rules.version).toBe(1);
    expect(((await get(h2, '/v1/platform/alerts', OWNER)).body as { alerts: unknown[] }).alerts).toHaveLength(3);
  });

  it('who may: a cashier neither reads health nor defines rules nor records a backup; a bad backup record and a reused id are refused', async () => {
    const h = await cast();
    expect((await get(h, '/v1/platform/operational-health/observed', CASH)).status).toBe(403);
    expect((await put(h, '/v1/platform/alert-rules', CASH, 'r-x', RULES)).status).toBe(403);
    expect((await post(h, '/v1/platform/backups/b-x/taken', CASH, 'bk-x', { at: minutesAgo(1), ok: true, encrypted: true, offsite: true })).status).toBe(403);
    expect((await put(h, '/v1/platform/alert-rules', MGR, 'r-bad', { rules: [] })).status).toBe(400);
    const bad = await post(h, '/v1/platform/backups/b-1/taken', OWNER, 'bk-bad', { at: 'last night', ok: true, encrypted: true, offsite: true });
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_backup_record');
    expect((await post(h, '/v1/platform/backups/b-1/taken', OWNER, 'bk-1', { at: minutesAgo(10), ok: true, encrypted: false, offsite: true })).body).toMatchObject({ counts: false, why: ['it is not encrypted'] });
    const dup = await post(h, '/v1/platform/backups/b-1/taken', OWNER, 'bk-1-again', { at: minutesAgo(9), ok: true, encrypted: true, offsite: true });
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('backup_already_recorded');
    const o = (await get(h, '/v1/platform/operational-health/observed', MGR)).body as Observed;
    expect(component(o, 'backup')).toMatchObject({ status: 'unknown' }); // an unencrypted backup does not count
  });
});
