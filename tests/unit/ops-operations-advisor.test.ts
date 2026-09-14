import { describe, it, expect } from 'vitest';
import { recommendOperationsRunbooks, type AlertForAdvice } from '../../packages/ops/src/index';
import type { RaisedAlert, HealthStatus } from '../../packages/ops/src/index';

// A06 "Operations" (§7.1 · API-13 · P-05) — the deterministic advisor. It reads the REAL persisted
// operational alerts (folded by the alert-lifecycle store) and, for each incident that still needs
// attention, recommends the reviewed runbook for its component. It decides nothing and executes nothing —
// a review list, worst-first; an operator acknowledges the alert and runs the runbook.

const alert = (over: Partial<RaisedAlert> & Pick<RaisedAlert, 'alertId' | 'component' | 'status'>): RaisedAlert => ({
  ownerUserId: 'u-op', ownerName: 'Operator', detail: `${over.component} incident`,
  raisedAt: '2026-09-14T09:00:00Z', ackDueBy: '2026-09-14T09:15:00Z', ...over,
});
const live = (a: RaisedAlert, state: AlertForAdvice['state'] = 'open'): AlertForAdvice => ({ alert: a, state });

describe('recommendOperationsRunbooks — incidents to a runbook, worst-first', () => {
  it('recommends the reviewed runbook for each unhealthy component, carrying the alert as evidence', () => {
    const out = recommendOperationsRunbooks([
      live(alert({ alertId: 'a-dl', component: 'dead_letter', status: 'down', detail: '3 items could not be sent' })),
    ]);
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.findingId).toBe('ops-runbook:a-dl');
    expect(f.component).toBe('dead_letter');
    expect(f.runbook.toLowerCase()).toContain('dead-letter');
    expect(f.runbook.toLowerCase()).toContain('never delete');
    expect(f.headline).toContain('dead_letter');
    expect(f.evidence.owner).toBe('Operator');
  });

  it('shares one runbook across every named integration (keyed by family)', () => {
    const out = recommendOperationsRunbooks([
      live(alert({ alertId: 'a-gstn', component: 'integration:gstn', status: 'degraded' })),
      live(alert({ alertId: 'a-rzp', component: 'integration:razorpay', status: 'degraded' })),
    ]);
    expect(out.map((f) => f.runbook)).toEqual([out[0]!.runbook, out[0]!.runbook]); // same integration runbook
    expect(out[0]!.runbook.toLowerCase()).toContain('integration');
  });

  it('leaves an acknowledged alert out — a named person is already on it (control by exception)', () => {
    const out = recommendOperationsRunbooks([
      live(alert({ alertId: 'a1', component: 'sync', status: 'down' }), 'acknowledged'),
      live(alert({ alertId: 'a2', component: 'queue', status: 'degraded' }), 'open'),
    ]);
    expect(out.map((f) => f.alertId)).toEqual(['a2']);
  });

  it('still recommends an escalated alert, and marks it escalated in the evidence', () => {
    const out = recommendOperationsRunbooks([live(alert({ alertId: 'a1', component: 'backup', status: 'down' }), 'escalated')]);
    expect(out).toHaveLength(1);
    expect(String(out[0]!.evidence.escalated)).toContain('past its deadline');
    expect(out[0]!.runbook.toLowerCase()).toContain('before anything else');
  });

  it('orders worst-first: down before degraded before unknown, then by component', () => {
    const mk = (id: string, c: string, s: HealthStatus) => live(alert({ alertId: id, component: c, status: s }));
    const out = recommendOperationsRunbooks([
      mk('u', 'catalogue', 'unknown'),
      mk('d1', 'queue', 'degraded'),
      mk('x', 'local_store', 'down'),
      mk('d2', 'database', 'degraded'),
    ]);
    expect(out.map((f) => f.status)).toEqual(['down', 'degraded', 'degraded', 'unknown']);
    // within 'degraded', component order is stable (database before queue)
    expect(out.filter((f) => f.status === 'degraded').map((f) => f.component)).toEqual(['database', 'queue']);
  });

  it('says nothing when there are no alerts, or every alert is acknowledged', () => {
    expect(recommendOperationsRunbooks([])).toEqual([]);
    expect(recommendOperationsRunbooks([live(alert({ alertId: 'a', component: 'sync', status: 'down' }), 'acknowledged')])).toEqual([]);
  });
});
