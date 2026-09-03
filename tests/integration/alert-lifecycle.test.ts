import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Alert lifecycle, end to end (M35-FR-04, API-11). The stateless health read computes the owned alerts a
// check SHOULD raise; this is the other half — an alert held over time: raised now, acknowledged (or not)
// later, and swept for escalation once its deadline passes with nobody having acknowledged. So: a raise
// persists the owned alert with its §32 deadline; a NAMED person acknowledges it (stopping escalation); the
// sweep routes every unacknowledged, past-due alert to the configured person; and the board shows every live
// alert, the ones needing a look first. Writes gated platform.alert.manage; the board platform.health.read.
//
// (The harness runs on a real clock, so a genuinely past-due alert cannot be produced here — the
// time-sensitive escalation is proven against the real route handler + engine in
// tests/unit/alert-lifecycle.test.ts. Here: raise / acknowledge / board / the escalate route's wiring + gate.)

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// A rule that owns the dead-letter component and escalates to u-boss if not acknowledged in 15 minutes.
const DL_RULE = { alertId: 'dl', component: 'dead_letter', firesAt: 'degraded', ownerUserId: 'u-owner', ownerName: 'Owner', ackWithinMinutes: 15, escalatesToUserId: 'u-boss' };
// Evidence with 50 dead letters → the dead-letter component fires.
const EVIDENCE = { signals: { deadLetterCount: 50 }, alertRules: [DL_RULE] };

const raise = (h: ApiHarness, u: string, key: string, body: unknown = EVIDENCE) =>
  h.request({ method: 'POST', path: '/v1/platform/alerts/raise', userId: u, tenantId: A, idempotencyKey: key, body });
const acknowledge = (h: ApiHarness, u: string, alertId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/alerts/${alertId}/acknowledge`, userId: u, tenantId: A, idempotencyKey: key });
const escalate = (h: ApiHarness, u: string, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/alerts/escalate', userId: u, tenantId: A, idempotencyKey: key });
const board = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/alerts', userId: u, tenantId: A });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // platform.alert.manage + platform.health.read
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // platform.alert.manage + platform.health.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('alert lifecycle: raise, acknowledge, sweep for escalation (M35-FR-04)', () => {
  it('raises an owned alert from evidence, shows it on the board, and survives a restart', async () => {
    const h = await cast();
    const res = await raise(h, 'u-owner', 'r-1');
    expect(res.status).toBe(200);
    expect((res.body as { raised: number; newlyOpened: number }).raised).toBe(1);
    expect((res.body as { newlyOpened: number }).newlyOpened).toBe(1);

    const b = await board(h, 'u-owner');
    expect(b.status).toBe(200);
    const alerts = (b.body as { alerts: { alert: { alertId: string; ownerName: string }; state: string }[]; open: number }).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ state: 'open' });
    expect(alerts[0]!.alert).toMatchObject({ alertId: 'dl', ownerName: 'Owner' });

    // A re-raise of the same ongoing condition stays ONE open alert (newlyOpened 0).
    expect((await raise(h, 'u-owner', 'r-2')).body).toMatchObject({ newlyOpened: 0 });
    expect((await board(h, 'u-owner')).body).toMatchObject({ open: 1 });

    // Durable across a restart.
    const h2 = apiHarness({ store: h.store });
    expect((await board(h2, 'u-owner')).body).toMatchObject({ open: 1 });
  });

  it('a named person acknowledges an alert, which the board records; acknowledging an unknown alert 404s', async () => {
    const h = await cast();
    await raise(h, 'u-owner', 'r-1');

    const ack = await acknowledge(h, 'u-mgr', 'dl', 'a-1');
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ alertId: 'dl', acknowledgedBy: 'u-mgr' });

    const alerts = (await board(h, 'u-owner')).body as { alerts: { state: string; acknowledgedBy?: string }[]; needAttention: number };
    expect(alerts.alerts[0]).toMatchObject({ state: 'acknowledged', acknowledgedBy: 'u-mgr' });
    expect(alerts.needAttention).toBe(0); // acknowledged → no longer needs a look

    const ghost = await acknowledge(h, 'u-owner', 'nope', 'a-ghost');
    expect(ghost.status).toBe(404);
    expect(codeOf(ghost)).toBe('unknown_alert');
  });

  it('the escalate sweep is wired and refuses to escalate an alert whose deadline is still in the future', async () => {
    const h = await cast();
    await raise(h, 'u-owner', 'r-1'); // ackDueBy is 15 minutes from now → not yet due

    const res = await escalate(h, 'u-owner', 'e-1');
    expect(res.status).toBe(200);
    expect((res.body as { count: number }).count).toBe(0); // nothing past its deadline yet
    const b = (await board(h, 'u-owner')).body as { alerts: { state: string }[] };
    expect(b.alerts[0]!.state).toBe('open');
  });

  it('gates writes on platform.alert.manage and the board on platform.health.read', async () => {
    const h = await cast();
    await raise(h, 'u-owner', 'r-1');

    // A cashier holds neither permission → refused everywhere.
    expect((await raise(h, 'u-cash', 'r-cash')).status).toBe(403);
    expect((await acknowledge(h, 'u-cash', 'dl', 'a-cash')).status).toBe(403);
    expect((await escalate(h, 'u-cash', 'e-cash')).status).toBe(403);
    expect((await board(h, 'u-cash')).status).toBe(403);
  });
});
