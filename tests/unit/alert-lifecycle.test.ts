import { describe, it, expect } from 'vitest';
import {
  projectAlerts, alertLifecycleRoutes,
  type AlertLifecycleEvent, type LiveAlert,
} from '../../services/platform/src/alert-lifecycle';
import type { RaisedAlert } from '../../packages/ops/src/index';
import type { RequestContext, HandlerResult } from '../../services/kernel/src/index';

// The alert-lifecycle FOLD and the escalate SWEEP — the time-sensitive half of M35-FR-04, proven with a
// controllable clock (the API harness runs on a real clock, so an alert cannot be made past-due there).

const alert = (over: Partial<RaisedAlert> = {}): RaisedAlert => ({
  alertId: 'a1', component: 'sync', status: 'down', ownerUserId: 'u-owner', ownerName: 'Owner',
  detail: 'sync is down', raisedAt: '2026-09-02T10:00:00Z', ackDueBy: '2026-09-02T10:15:00Z', ...over,
});

const raised = (a: RaisedAlert, escalatesToUserId?: string): AlertLifecycleEvent =>
  ({ alertId: a.alertId, change: 'raised', by: 'u-owner', at: a.raisedAt, alert: a, ...(escalatesToUserId !== undefined ? { escalatesToUserId } : {}) });

describe('projectAlerts folds the append-only alert log to the live set', () => {
  it('raises, then an acknowledgement moves it to acknowledged; the deadline and owner survive', () => {
    const live = projectAlerts([
      raised(alert(), 'u-boss'),
      { alertId: 'a1', change: 'acknowledged', by: 'u-mgr', at: '2026-09-02T10:05:00Z' },
    ]);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ state: 'acknowledged', acknowledgedBy: 'u-mgr', escalatesToUserId: 'u-boss' });
    expect(live[0]!.alert.ackDueBy).toBe('2026-09-02T10:15:00Z');
  });

  it('a re-raise of the same ongoing condition keeps the first deadline and any acknowledgement', () => {
    const live = projectAlerts([
      raised(alert({ raisedAt: '2026-09-02T10:00:00Z', ackDueBy: '2026-09-02T10:15:00Z' }), 'u-boss'),
      { alertId: 'a1', change: 'acknowledged', by: 'u-mgr', at: '2026-09-02T10:05:00Z' },
      raised(alert({ raisedAt: '2026-09-02T10:30:00Z', ackDueBy: '2026-09-02T10:45:00Z' }), 'u-boss'), // re-raise
    ]);
    expect(live).toHaveLength(1);
    expect(live[0]!.alert.ackDueBy).toBe('2026-09-02T10:15:00Z'); // original deadline, not the re-raise's
    expect(live[0]!.state).toBe('acknowledged'); // still acknowledged
  });

  it('ignores an acknowledge/escalate for an alert nobody raised (no phantom alert)', () => {
    const live = projectAlerts([
      { alertId: 'ghost', change: 'acknowledged', by: 'u-mgr', at: '2026-09-02T10:05:00Z' },
      { alertId: 'ghost', change: 'escalated', by: 'u-sys', at: '2026-09-02T10:20:00Z', escalatedTo: 'u-boss' },
    ]);
    expect(live).toHaveLength(0);
  });
});

// Route-unit harness for the escalate sweep, with a fixed clock and a stubbed live-alert set.
function sweepHarness(live: readonly LiveAlert[], now: string) {
  const logged: AlertLifecycleEvent[] = [];
  const routes = alertLifecycleRoutes({
    alerts: () => live,
    recordAlertEvent: (_t, e) => { logged.push(e); },
    now: () => now,
  });
  const escalate = routes.find((r) => r.method === 'POST' && r.path === '/v1/platform/alerts/escalate')!;
  return { logged, escalate };
}
const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({ tenantId: 't', userId: 'u-sys', branchId: null, params: {}, query: {}, body: {}, traceId: 'tr', ...over });
const run = async (r: { handler: (c: RequestContext) => Promise<HandlerResult> | HandlerResult }, c: RequestContext) => r.handler(c);

const liveOf = (a: RaisedAlert, over: Partial<LiveAlert> = {}): LiveAlert => ({ alert: a, state: 'open', ...over });

describe('the escalate sweep routes unacknowledged, past-due alerts to a named person', () => {
  it('escalates an alert past its deadline that nobody acknowledged', async () => {
    const h = sweepHarness([liveOf(alert(), { escalatesToUserId: 'u-boss' })], '2026-09-02T10:20:00Z'); // past 10:15
    const res = await run(h.escalate, ctx());
    expect(res.status).toBe(200);
    expect((res.body as { count: number; escalated: { escalatedTo: string }[] }).count).toBe(1);
    expect((res.body as { escalated: { escalatedTo: string }[] }).escalated[0]!.escalatedTo).toBe('u-boss');
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatchObject({ change: 'escalated', escalatedTo: 'u-boss' });
  });

  it('does NOT escalate before the deadline, nor one already acknowledged', async () => {
    const early = sweepHarness([liveOf(alert(), { escalatesToUserId: 'u-boss' })], '2026-09-02T10:05:00Z'); // before 10:15
    expect((await run(early.escalate, ctx())).status).toBe(200);
    expect(early.logged).toHaveLength(0);

    const acked = sweepHarness([liveOf(alert(), { escalatesToUserId: 'u-boss', state: 'acknowledged', acknowledgedBy: 'u-mgr', acknowledgedAt: '2026-09-02T10:05:00Z' })], '2026-09-02T10:20:00Z');
    expect((await run(acked.escalate, ctx())).status).toBe(200);
    expect(acked.logged).toHaveLength(0); // acknowledged in time → never escalates
  });

  it('reports an alert with nobody above its owner as having nowhere to go (P-08), and does not re-escalate', async () => {
    const nowhere = sweepHarness([liveOf(alert(), {})], '2026-09-02T10:20:00Z'); // no escalatesToUserId
    const res = await run(nowhere.escalate, ctx());
    expect((res.body as { escalated: { escalatedTo: string; detail: string }[] }).escalated[0]!.escalatedTo).toBe('');
    expect((res.body as { escalated: { detail: string }[] }).escalated[0]!.detail).toContain('nowhere to escalate');

    // Already escalated → the sweep leaves it alone (idempotent).
    const done = sweepHarness([liveOf(alert(), { escalatesToUserId: 'u-boss', state: 'escalated', escalatedTo: 'u-boss', escalatedAt: '2026-09-02T10:20:00Z' })], '2026-09-02T10:30:00Z');
    expect((await run(done.escalate, ctx())).status).toBe(200);
    expect(done.logged).toHaveLength(0);
  });
});
