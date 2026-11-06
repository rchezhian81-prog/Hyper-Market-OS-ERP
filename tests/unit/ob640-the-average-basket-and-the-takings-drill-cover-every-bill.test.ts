import { describe, it, expect } from 'vitest';
import { averageBasketMinor, salesSummary, type SaleFact } from '../../packages/reporting/src/sales-summary';
import { buildBrief } from '../../apps/owner-app/src/brief';
import { createOwnerSession, type BranchPayload } from '../../apps/owner-app/src/owner-session';

/**
 * **OB-640 (owner, 1 Nov 2026): the average basket is the takings ÷ EVERY bill, and the "Taken today" drill lists every
 * bill so its total is the tile's figure. The margin stays over the costed bills only.**
 *
 * Found by UI-3: three bills on the till whose products had no cost price showed "Average basket ₹0.00" — the average was
 * worked out over the costed bills only, and there were none. And the "Taken today" drill listed only the costed bills,
 * so its total disagreed with the tile above it.
 */

const fact = (saleId: string, totalMinor: number, cogsMinor = Math.round(totalMinor / 2)): SaleFact => ({
  saleId, netMinor: totalMinor, taxMinor: 0, totalMinor, cogsMinor, units: 1, tender: 'cash', currency: 'INR',
});

describe('the one average-basket rule', () => {
  it('is the takings ÷ the bills, rounded to the paisa — and not known when there is no bill', () => {
    expect(averageBasketMinor(896_00, 3)).toBe(29_867);
    expect(averageBasketMinor(100, 3)).toBe(33);
    expect(averageBasketMinor(0, 0)).toBeNull();
    // salesSummary uses the same rule for the bills it is given
    expect(salesSummary([fact('a', 100), fact('b', 201)]).avgBasketMinor).toBe(151);
  });
});

describe('the owner\'s average basket counts every bill', () => {
  const base = { asOf: '2026-11-01T12:00:00.000Z', lastSyncedAt: '2026-11-01T12:00:00.000Z', staleAfterSeconds: 900, exceptions: [], approvals: [] };

  it('three bills with no cost: ₹896 ÷ 3, never ₹0.00', () => {
    const brief = buildBrief({ ...base, sales: [], uncosted: { bills: 3, takenMinor: 896_00, tenderMix: { cash: 896_00 } } });
    expect(brief.takings.averageBasketMinor).toBe(29_867);
  });

  it('costed and uncosted bills together, after refunds: the takings ÷ every bill', () => {
    const brief = buildBrief({
      ...base, sales: [fact('a', 300_00), fact('b', 100_00)],
      uncosted: { bills: 2, takenMinor: 200_00, tenderMix: { cash: 200_00 } },
      refunds: { count: 1, refundedMinor: 60_00, tenderMix: { cash: 60_00 } },
    });
    expect(brief.takings.bills).toBe(4);
    expect(brief.takings.takenMinor).toBe(540_00);
    expect(brief.takings.averageBasketMinor).toBe(135_00);
    // the sentence quotes the same average as the tile
    expect(brief.headline).toContain('average basket ₹135.00');
    // the margin is still over the costed bills only
    expect(brief.kpis.marginMinor).toBe(200_00);
  });

  it('no bill at all: not known', () => {
    expect(buildBrief({ ...base, sales: [] }).takings.averageBasketMinor).toBeNull();
  });
});

describe('the "Taken today" drill lists every bill and every refund, and adds up to the tile', () => {
  const config = { owner: { userId: 'owner', branchScope: 'all' as const, authorityLimit: null }, staleAfterSeconds: 900, acknowledgeStaleDecisions: true };
  const payload: BranchPayload = {
    branchId: 'b1', name: 'Main', lastSyncedAt: '2026-11-01T12:00:00.000Z', exceptions: [], approvals: [],
    sales: [fact('S-1', 300_00), fact('S-2', 100_00)],
    uncosted: { bills: 2, takenMinor: 200_00, tenderMix: { cash: 200_00 }, lines: [{ id: 'S-3', amountMinor: 150_00, tender: 'upi' }, { id: 'S-4', amountMinor: 50_00, tender: 'cash' }] },
    refunds: { count: 1, refundedMinor: 60_00, tenderMix: { cash: 60_00 }, lines: [{ id: 'RT-1', amountMinor: 60_00, tender: 'cash' }] },
  };
  const session = createOwnerSession(config, [payload], () => '2026-11-01T12:05:00.000Z');

  it('takings: the costed bills, the bills with no cost and the refund taken off — the total is the tile', () => {
    const drill = session.drill('grossSales');
    expect(drill.lines.map((l) => [l.saleId, l.kind, l.contributesMinor])).toEqual([
      ['S-1', 'bill', 300_00], ['S-3', 'uncosted_bill', 150_00], ['S-2', 'bill', 100_00], ['S-4', 'uncosted_bill', 50_00], ['RT-1', 'refund', -60_00],
    ]);
    expect(drill.totalMinor).toBe(session.brief().takings.takenMinor);
    expect(drill.unlisted).toBe(0);
  });

  it('the bill count lists every bill; the margin lists only the costed ones', () => {
    expect(session.drill('baskets').lines).toHaveLength(session.brief().takings.bills);
    expect(session.drill('margin').lines.map((l) => l.saleId).sort()).toEqual(['S-1', 'S-2']);
  });

  it('an older store computer that sent only the counts: the drill says how many it could not list', () => {
    const old = createOwnerSession(config, [{ ...payload, uncosted: { bills: 2, takenMinor: 200_00, tenderMix: {} }, refunds: { count: 1, refundedMinor: 60_00, tenderMix: {} } }], () => '2026-11-01T12:05:00.000Z');
    expect(old.drill('grossSales').unlisted).toBe(3);
  });
});
