import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { inMemoryTillBox } from '../support/in-memory-till-box';

// Audit observations at the browser-adapter boundary, not browser/edge/DB E2E.
// The durable write is intercepted so we can inspect exactly what PosSession
// gives the edge; no real money, disk record, cloud request, or store data moves.
//
// F09 — FIXED in SP-4b: case 1 is now the REGRESSION (the served boot passes the box's lane and cut-off and never a
// cashier; the till refuses payment until a cashier signs in; the sale names the real three).
// F10 — FIXED in SP-4c: case 2 is now the REGRESSION (the Close button sends exactly what a cashier knows — shift, moment,
// count, and a reason once asked — and that IS the complete input: the store box works every other figure out from what
// it recorded, decides the close and records it durably; the till keeps no cash of its own).
describe('audit observations: the served POS configuration and close call', () => {
  it('F09 FIXED: the served page boot passes the box\'s lane and cut-off and NO cashier; a sale is refused until somebody signs in, then names the real cashier, lane and day', async () => {
    const source = readFileSync('apps/pos/src/browser-entry.ts', 'utf8');
    const actualBootstrap = source.slice(source.indexOf('browserWindow.posSession = bootPos('));
    // The box tells the page which lane it is and when the day ends; the page never names a cashier — the person does.
    expect(actualBootstrap).toContain('laneId: lane.laneId');
    expect(actualBootstrap).toContain('tradingDayCutoff: lane.tradingDayCutoff');
    expect(actualBootstrap).not.toContain('cashierId:');
    expect(actualBootstrap).not.toContain('tradingDay:');
    expect(source).not.toMatch(/'lane-1'|'cashier'|1970-01-01/);

    let written: Record<string, unknown> | undefined;
    const session = bootPos({
      laneId: 'lane-7', tradingDayCutoff: '02:00',
      durable: async (_id, record) => {
        written = JSON.parse(record) as Record<string, unknown>;
        return { committed: true, durable: true, detail: 'audit interception', laneMessage: 'saved' };
      },
    });
    session.scan({ productId: 'AUDIT-P1', description: 'Audit item', unitPriceMinor: 100, qty: 1 });
    // Nobody signed in → refused in the cashier's words, nothing written.
    await expect(session.tenderCash('AUDIT-S1', 'AUDIT-R1', '2026-09-30T10:00:00.000Z'))
      .rejects.toMatchObject({ laneMessage: expect.stringContaining('Sign in with your staff code') });
    expect(written).toBeUndefined();
    // The real cashier signs in: the record names them, the box's lane, and the day worked out at the moment of sale.
    session.signIn('u-meena');
    await session.tenderCash('AUDIT-S1', 'AUDIT-R1', '2026-09-30T10:00:00.000Z');
    expect(written).toMatchObject({
      cashierId: 'u-meena', laneId: 'lane-7', tradingDay: session.lane().tradingDayAt('2026-09-30T10:00:00.000Z'),
      committedAt: '2026-09-30T10:00:00.000Z',
    });
    expect(written).not.toMatchObject({ tradingDay: '1970-01-01' });
  });

  it('F10 FIXED: the Close till button sends shift, moment and count — and that is the WHOLE input; the box works out the rest, decides and records the close', async () => {
    const source = readFileSync('apps/pos/web/app.js', 'utf8');
    const calls = [...source.matchAll(/session\.till\.close\(\{([\s\S]*?)\}\)/g)].map((m) => m[1] ?? '');
    expect(calls.length).toBeGreaterThanOrEqual(2); // once with the count, once more with the reason the box asked for
    for (const call of calls) {
      expect(call).toContain('shiftId');
      expect(call).toContain('closedAt');
      expect(call).toContain('countedMinor');
      // The four money figures are the STORE BOX's to work out from what it recorded — the till never supplies them,
      // so it can never supply the wrong ones and never learns the expected figure before the count.
      for (const boxs of ['openingFloatMinor', 'cashSalesMinor', 'pickupsMinor', 'cashRefundsMinor', 'expectedMinor']) {
        expect(call).not.toContain(boxs);
      }
    }
    // The till also keeps no cash ledger and no in-browser outbox for cash: nothing to lose on a reload.
    expect(source).not.toMatch(/drawerBalance|tillBalance|expectedCash/);

    // The exact input the button sends, against a box running the real engine: it closes.
    const box = inMemoryTillBox({ laneId: 'audit-lane', toleranceMinor: 10_000 });
    const session = bootPos({ laneId: 'audit-lane', cashierId: 'audit-cashier', ...box.ports });
    expect(await session.till.moveCash({ kind: 'float_issue', amountMinor: 100, at: '2026-09-30T09:00:00.000Z' })).toMatchObject({ committed: true });
    const actualUiInput = { shiftId: 'AUDIT-SH1', closedAt: '2026-09-30T10:00:00.000Z', countedMinor: 100 };
    expect(await session.till.close(actualUiInput)).toMatchObject({ closed: true, varianceMinor: 0, exceptionRaised: false, countedMinor: 100 });
    // And the close is a record on the box with every figure the box itself worked out.
    expect(box.records.at(-1)).toMatchObject({ kind: 'close', shiftId: 'AUDIT-SH1', openingFloatMinor: 100, cashSalesMinor: 0, pickupsMinor: 0, cashRefundsMinor: 0, expectedMinor: 100, cashierId: 'audit-cashier', laneId: 'audit-lane' });
  });
});
