import { describe, it, expect } from 'vitest';
import { bootManager, portsFromData, type ManagerData } from '../../apps/web-erp/src/browser-entry';
import { requestApproval } from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';

/**
 * **The composition root the manager's screen actually binds to.**
 *
 * The unit tests around `manager-session` prove the rules; this proves the *assembly*, which is
 * where this project's silent faults have all lived — a port present in the design and absent in
 * the running system, a control quietly not being there.
 *
 * The fault this file exists to catch is one line long: `data.openExceptions ?? []`. It reads as
 * tidy defaulting, it makes every test pass, and it turns *"the store never told me"* into *"the
 * store told me there is nothing wrong"* — which is exactly enough to lock a trading day on a page
 * that had never spoken to the store.
 */

const AFTER_CUTOFF = '2026-08-05T02:30';
const AT = '2026-08-05T02:30:00Z';

const boot = (data?: ManagerData) => bootManager({
  storeId: 'store-1', branchId: 'b1', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
  managerId: 'u-mgr', approvalLimitMinor: 500_000, warehouseId: 'wh-1',
  ...(data === undefined ? {} : { data }),
});

describe('a screen that was told nothing knows nothing', () => {
  it('boots with every register unknown when no payload arrived', () => {
    const floor = boot().floor();
    for (const figure of [floor.approvalsWaiting, floor.exceptions, floor.unsent, floor.tasks]) {
      expect(figure.known).toBe(false);
    }
  });

  it('will not close the day', () => {
    const attempt = boot().closeTheDay({ dayCloseId: 'dc-1', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.map((b) => b.source).sort()).toEqual(['exceptions', 'unsent']);
    expect(attempt.blockers.every((b) => b.kind === 'cannot_see')).toBe(true);
  });

  it('says why, in words somebody can act on', () => {
    const attempt = boot().closeTheDay({ dayCloseId: 'dc-2', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    if (attempt.closed) return;
    expect(attempt.blockers[0]?.why).toMatch(/has not received that list from the store/);
  });
});

describe('a key the payload did not carry is not an empty list', () => {
  // The one-line fault, tested from the outside. `?? []` here would pass every other test in the
  // suite and would be the whole defect.
  it('reports a missing exception list as unknown, not as none open', () => {
    const ports = portsFromData({ unsentItems: [], tasks: [] });
    expect(ports.openExceptions('2026-08-04')).toEqual({
      known: false,
      why: 'this screen has not received that list from the store yet',
    });
  });

  it('reports a list that arrived EMPTY as known and empty', () => {
    // The other half of the same fact, and the reason the two must be distinguishable at all.
    expect(portsFromData({ openExceptions: [] }).openExceptions('2026-08-04'))
      .toEqual({ known: true, items: [] });
  });

  it('closes the day when the store really did say everything is clear', () => {
    const attempt = boot({ approvals: [], openExceptions: [], unsentItems: [], tasks: [] })
      .closeTheDay({ dayCloseId: 'dc-3', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    expect(attempt.closed).toBe(true);
    if (!attempt.closed) return;
    expect(attempt.result.locked).toBe(true);
  });
});

describe('a product the screen was never told about has no price of zero', () => {
  it('refuses to value a count for an unknown product', () => {
    const session = boot({ openExceptions: [], unsentItems: [] });
    const attempt = session.countStock({
      countId: 'c-1', productId: 'p-unknown', locationId: 'aisle-1', uom: 'ea',
      countedMinor: 3, reasonCode: 'shrinkage', at: AT,
    });
    expect(attempt.counted).toBe(false);
    if (attempt.counted) return;
    expect(attempt.refusal).toBe('value_not_known');
    expect(attempt.why).toMatch(/p-unknown/);
  });

  it('values a count for a product the store did describe', () => {
    const session = boot({ products: [{ id: 'p-1', valuePerUnitMinor: 4_000 }] });
    session.receive({
      grnId: 'grn-1', number: 'GRN-1', poId: 'po-1', receivedAt: AT,
      lines: [{ productId: 'p-1', quantityMinor: 10, uom: 'ea' }],
    });
    const attempt = session.countStock({
      countId: 'c-2', productId: 'p-1', locationId: 'aisle-1', uom: 'ea',
      countedMinor: 10, reasonCode: 'ok', at: AT,
    });
    expect(attempt.counted).toBe(true);
    if (!attempt.counted) return;
    expect(attempt.result.reconciled).toBe(true);
  });
});

describe('the manager it boots is the manager the store configured', () => {
  it('scopes approvals to the configured branch and limit', () => {
    const session = boot({
      approvals: [
        requestApproval({ id: 'a1', subjectType: 'refund', subjectRef: 'r1', requestedBy: 'u-cashier', branchId: 'b1', value: money(100_000, 'INR') }),
        requestApproval({ id: 'a2', subjectType: 'refund', subjectRef: 'r2', requestedBy: 'u-cashier', branchId: 'b2', value: money(100_000, 'INR') }),
        requestApproval({ id: 'a3', subjectType: 'po', subjectRef: 'r3', requestedBy: 'u-buyer', branchId: 'b1', value: money(900_000, 'INR') }),
      ],
    });
    const queue = session.approvalQueue();
    expect(queue.known).toBe(true);
    if (!queue.known) return;
    const by = (id: string) => queue.rows.find((r) => r.request.id === id);
    expect(by('a1')?.actionable).toBe(true);
    expect(by('a2')?.blockedReason).toBe('out_of_scope'); // another branch
    expect(by('a3')?.blockedReason).toBe('exceeds_authority'); // ₹9,000 over a ₹5,000 limit
  });

  it('gives a company-wide manager an "all" scope rather than a branch of null', () => {
    const session = bootManager({
      branchId: null, tradingDay: '2026-08-04', tradingDayCutoff: '02:00', managerId: 'u-owner',
      approvalLimitMinor: null,
      data: {
        approvals: [requestApproval({
          id: 'a1', subjectType: 'refund', subjectRef: 'r1', requestedBy: 'u-cashier',
          branchId: 'anywhere', value: money(9_999_999, 'INR'),
        })],
      },
    });
    const queue = session.approvalQueue();
    if (!queue.known) return;
    expect(queue.rows[0]?.actionable).toBe(true);
  });
});
