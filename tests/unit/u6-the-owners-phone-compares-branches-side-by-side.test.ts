import { describe, it, expect } from 'vitest';
import { createOwnerSession, type BranchPayload, type OwnerConfig } from '../../apps/owner-app/src/owner-session';
import type { SaleFact } from '../../packages/reporting/src/index';
import { officeLinksFor } from '../../edge/store-edge/src/screen-server';

/**
 * **U6 · M29-FR-02 · OB-701 (owner, 7 Nov 2026, decision 4 = B) — the owner's phone compares its branches SIDE BY SIDE and
 * links to the office's audit trail and system health (never a copy).** The comparison is the session's own figures, one
 * row per branch, each with its own freshness; a branch that never reached the phone says "not known", never ₹0.00.
 */
const NOW = '2026-11-07T14:00:00.000Z';
const now = () => NOW;
const sale = (saleId: string, totalMinor: number, cogsMinor: number): SaleFact => ({ saleId, netMinor: totalMinor, taxMinor: 0, totalMinor, cogsMinor, units: 2, tender: 'cash', currency: 'INR' });
const OWNER: OwnerConfig = { owner: { userId: 'u-owner', roleId: 'owner', branchScope: 'all', approvalLimitMinor: 10_000_000_00 } as unknown as OwnerConfig['owner'], staleAfterSeconds: 300, acknowledgeStaleDecisions: true };
const branch = (over: Partial<BranchPayload>): BranchPayload => ({
  branchId: 'b1', name: 'Main', lastSyncedAt: '2026-11-07T13:59:00.000Z', sales: [], exceptions: [], approvals: [], ...over,
});

describe('the owner\'s phone compares branches side by side', () => {
  it('one row per branch, in the order the phone was given them, each with its own figures and freshness; the branch in view is not changed', () => {
    const s = createOwnerSession(OWNER, [
      branch({ branchId: 'b1', name: 'Main', sales: [sale('s1', 500_00, 300_00), sale('s2', 250_00, 100_00)], approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'Dal', requestedBy: 'u-b', valueMinor: 100 }] }),
      branch({ branchId: 'b2', name: 'Annexe', lastSyncedAt: '2026-11-07T02:00:00.000Z', sales: [sale('s3', 100_00, 80_00)] }),
      branch({ branchId: 'b3', name: 'New store', lastSyncedAt: null, sales: [] }),
    ], now);
    s.viewBranch('b2');
    const rows = s.compare();
    expect(rows.map((r) => [r.branchId, r.name, r.freshness.state])).toEqual([['b1', 'Main', 'fresh'], ['b2', 'Annexe', 'stale'], ['b3', 'New store', 'missing']]);
    expect(rows[0]).toMatchObject({ takenMinor: 750_00, bills: 2, marginMinor: 350_00, marginKnown: true, approvalsWaiting: 1, attentionCount: 1 });
    expect(rows[1]).toMatchObject({ takenMinor: 100_00, bills: 1, marginMinor: 20_00, marginKnown: true, approvalsWaiting: 0 });
    // Never a nought for a branch that never reached the phone: the figures are not known.
    expect(rows[2]).toMatchObject({ takenMinor: null, bills: null, marginMinor: null, marginKnown: false, approvalsWaiting: null });
    expect(s.currentBranchId()).toBe('b2');
  });

  it('the office links the box gives the phone carry the public prefix, and point at the office pages — never a copy on the phone', () => {
    expect(officeLinksFor('')).toEqual({ auditLog: '/audit-log', storeComputers: '/store-computers', compare: '/branch-compare' });
    expect(officeLinksFor('/shop')).toEqual({ auditLog: '/shop/audit-log', storeComputers: '/shop/store-computers', compare: '/shop/branch-compare' });
  });
});
