import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Operational health & alerting, end to end (M35-FR-03/04 · §32, API-11). Health is computed from
// EVIDENCE the edge reports, and two rules matter more than any single number: `canTrade` is separate
// from `status` (a cloud outage degrades the status but the store keeps selling — P-01; only a lane that
// cannot record a sale locally must stop), and a missing signal is `unknown`, never a cheerful `ok`
// (P-08). Alerts route to a NAMED person with a §32 acknowledgement deadline. Gated platform.health.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const health = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'oh1') =>
  h.request({ method: 'POST', path: '/v1/platform/operational-health', userId: u, tenantId: A, idempotencyKey: key, body });

type Health = { health: { status: string; canTrade: boolean; summary: string; components: { name: string; status: string; detail: string }[] }; alerts: { alertId: string; ownerName: string; ackDueBy: string; status: string }[] };

// Fresh (server "now"-ish) timestamps so lag/age read as up to date.
const fresh = () => new Date().toISOString();
const healthy = () => ({ lastSyncAt: fresh(), queueDepth: 0, deadLetterCount: 0, catalogueBuiltAt: fresh(), databaseReachable: true, localStoreWritable: true, lastBackupAt: fresh(), backupMaxAgeSeconds: 86_400 });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // platform.health.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // not
  return h;
}

describe('operational health: can-I-trade separate from status, missing = unknown (M35-FR-03/04)', () => {
  it('reads healthy when the evidence is fresh', async () => {
    const h = await cast();
    const r = (await health(h, 'u-owner', { signals: healthy() })).body as Health;
    expect(r.health.status).toBe('ok');
    expect(r.health.canTrade).toBe(true);
    expect(r.health.summary).toBe('Everything is up to date');
    expect(r.alerts).toHaveLength(0);
  });

  it('keeps the store trading through a cloud outage, and stops it only when the lane cannot record', async () => {
    const h = await cast();
    // Cloud database unreachable, but the lane can still record — degraded, NOT stop-selling (P-01).
    const outage = (await health(h, 'u-owner', { signals: { ...healthy(), databaseReachable: false } })).body as Health;
    expect(outage.health.status).toBe('degraded');
    expect(outage.health.canTrade).toBe(true);
    expect(outage.health.components.find((c) => c.name === 'local_store')?.status).toBe('ok');

    // The one thing that stops a lane: it cannot record a sale locally.
    const stop = (await health(h, 'u-owner', { signals: { ...healthy(), localStoreWritable: false } }, 'oh2')).body as Health;
    expect(stop.health.canTrade).toBe(false);
    expect(stop.health.components.find((c) => c.name === 'local_store')?.detail).toContain('CANNOT record');
  });

  it('treats a missing signal as unknown, never a cheerful ok', async () => {
    const h = await cast();
    const r = (await health(h, 'u-owner', { signals: {} })).body as Health;
    expect(r.health.status).toBe('unknown');
    expect(r.health.summary.toLowerCase()).toContain('unknown');
    // Nothing has explicitly said the lane cannot record, so trading is not stopped on an absence.
    expect(r.health.canTrade).toBe(true);
  });

  it('raises an owned alert for a breached component, leaves a healthy one alone, and is gated', async () => {
    const h = await cast();
    const rules = [
      { alertId: 'a-sync', component: 'sync', firesAt: 'degraded', ownerUserId: 'u-mgr', ownerName: 'Priya', ackWithinMinutes: 15, escalatesToUserId: 'u-owner' },
      { alertId: 'a-queue', component: 'queue', firesAt: 'down', ownerUserId: 'u-mgr', ownerName: 'Priya', ackWithinMinutes: 15 },
    ];
    // Sync is far behind (down); the queue is empty (ok).
    const r = (await health(h, 'u-owner', { signals: { ...healthy(), lastSyncAt: '2020-01-01T00:00:00Z', queueDepth: 0 }, alertRules: rules })).body as Health;
    // Only the breached component's rule fires, and it names a person with a deadline.
    expect(r.alerts.map((a) => a.alertId)).toEqual(['a-sync']);
    expect(r.alerts[0]).toMatchObject({ ownerName: 'Priya', status: 'down' });
    expect(r.alerts[0]?.ackDueBy).toBeTruthy();

    // A cashier does not read platform health.
    expect((await health(h, 'u-cash', { signals: healthy() }, 'oh-c')).status).toBe(403);
  });
});
