import { describe, it, expect } from 'vitest';
import { projectServiceRequests, type ServiceRequestEvent } from '../../services/platform/src/service-requests';

// M33-FR-04 — the fold behind the platform service-request tracker.

const AT = (n: number): string => `2026-09-02T1${n}:00:00Z`;
const raised = (id: string, at: string): ServiceRequestEvent => ({ requestId: id, change: 'raised', by: 'u-admin', at, title: `${id} title`, detail: 'something is wrong', category: 'device', priority: 'high' });
const assigned = (id: string, to: string, at: string): ServiceRequestEvent => ({ requestId: id, change: 'assigned', assignedTo: to, by: 'u-admin', at });
const statusChanged = (id: string, status: ServiceRequestEvent['status'], at: string, note?: string): ServiceRequestEvent => ({ requestId: id, change: 'statusChanged', status, by: 'u-admin', at, ...(note !== undefined ? { note } : {}) });

describe('projectServiceRequests — the request fold', () => {
  it('an empty log is no requests', () => {
    expect(projectServiceRequests([])).toEqual([]);
  });

  it('a raised request is open and needs attention', () => {
    const [r] = projectServiceRequests([raised('sr1', AT(0))]);
    expect(r).toMatchObject({ requestId: 'sr1', status: 'open', priority: 'high', needsAttention: true });
  });

  it('assigning gives it an owner and moves it off open', () => {
    const [r] = projectServiceRequests([raised('sr1', AT(0)), assigned('sr1', 'u-eng', AT(1))]);
    expect(r).toMatchObject({ assignedTo: 'u-eng', status: 'in_progress', needsAttention: true });
  });

  it('resolving records the resolution and stops it needing attention; re-opening clears the stale resolution', () => {
    const resolved = projectServiceRequests([raised('sr1', AT(0)), statusChanged('sr1', 'resolved', AT(1), 'replaced the lane cable')]);
    expect(resolved[0]).toMatchObject({ status: 'resolved', resolution: 'replaced the lane cable', needsAttention: false });

    const reopened = projectServiceRequests([raised('sr1', AT(0)), statusChanged('sr1', 'resolved', AT(1), 'x'), statusChanged('sr1', 'open', AT(2))]);
    expect(reopened[0]).toMatchObject({ status: 'open', needsAttention: true });
    expect(reopened[0]?.resolution).toBeUndefined();
  });

  it('an assign or status change for a request nobody raised is ignored — no phantom request', () => {
    expect(projectServiceRequests([assigned('ghost', 'u-eng', AT(1)), statusChanged('ghost', 'closed', AT(2))])).toEqual([]);
  });

  it('folds many requests independently', () => {
    const rs = projectServiceRequests([raised('a', AT(0)), statusChanged('a', 'closed', AT(1)), raised('b', AT(0))]);
    expect(rs.find((r) => r.requestId === 'a')?.status).toBe('closed');
    expect(rs.find((r) => r.requestId === 'b')?.status).toBe('open');
  });
});
