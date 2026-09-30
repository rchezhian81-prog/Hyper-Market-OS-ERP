import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bootPos } from '../../apps/pos/src/browser-entry';

// Audit observations at the browser-adapter boundary, not browser/edge/DB E2E.
// The durable write is intercepted so we can inspect exactly what PosSession
// gives the edge; no real money, disk record, cloud request, or store data moves.
//
// F09 — FIXED in SP-4b: case 1 is now the REGRESSION (the served boot passes the box's lane and cut-off and never a
// cashier; the till refuses payment until a cashier signs in; the sale names the real three).
// F10 — still OBSERVED (SP-4c): case 2 still passes, which means the Close button's input is still incomplete.
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

  it('throws Money undefined on the exact input shape the Close till button sends', () => {
    const source = readFileSync('apps/pos/web/app.js', 'utf8');
    const actualCall = source.match(/const result = session\.till\.close\(\{([\s\S]*?)\}\);/)?.[1];
    expect(actualCall).toBeDefined();
    expect(actualCall).toContain('shiftId:');
    expect(actualCall).toContain('closedAt:');
    expect(actualCall).toContain('countedMinor:');
    for (const missing of ['openingFloatMinor:', 'cashSalesMinor:', 'pickupsMinor:', 'cashRefundsMinor:']) {
      expect(actualCall).not.toContain(missing);
    }
    // A lane and a cashier are given here so the close reaches the button's input (F09 is fixed; F10 is still observed).
    const session = bootPos({ laneId: 'audit-lane', cashierId: 'audit-cashier' });
    const actualUiInput = {
      shiftId: 'AUDIT-SH1', closedAt: '2026-09-30T10:00:00.000Z', countedMinor: 100,
    };
    // The production UI is plain JavaScript, so its missing fields pass its
    // build; reproduce that runtime boundary explicitly here.
    expect(() => session.till.close(actualUiInput as Parameters<typeof session.till.close>[0]))
      .toThrow('Money minor units must be a safe integer, got undefined.');
  });
});
