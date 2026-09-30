import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bootPos } from '../../apps/pos/src/browser-entry';

// Audit observations at the browser-adapter boundary, not browser/edge/DB E2E.
// The durable write is intercepted so we can inspect exactly what PosSession
// gives the edge; no real money, disk record, cloud request, or store data moves.
describe('audit observations: the served POS configuration and close call', () => {
  it('records the default cashier, lane and 1970 trading day when booted as the served page boots', async () => {
    const source = readFileSync('apps/pos/src/browser-entry.ts', 'utf8');
    const actualBootstrap = source.slice(source.indexOf('browserWindow.posSession = bootPos('));
    expect(actualBootstrap).not.toContain('cashierId:');
    expect(actualBootstrap).not.toContain('laneId:');
    expect(actualBootstrap).not.toContain('tradingDay:');

    let written: Record<string, unknown> | undefined;
    const session = bootPos({
      durable: async (_id, record) => {
        written = JSON.parse(record) as Record<string, unknown>;
        return { committed: true, durable: true, detail: 'audit interception', laneMessage: 'saved' };
      },
    });
    session.scan({ productId: 'AUDIT-P1', description: 'Audit item', unitPriceMinor: 100, qty: 1 });
    await session.tenderCash('AUDIT-S1', 'AUDIT-R1', '2026-09-30T10:00:00.000Z');
    expect(written).toMatchObject({
      cashierId: 'cashier', laneId: 'lane-1', tradingDay: '1970-01-01',
      committedAt: '2026-09-30T10:00:00.000Z',
    });
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
    const session = bootPos();
    const actualUiInput = {
      shiftId: 'AUDIT-SH1', closedAt: '2026-09-30T10:00:00.000Z', countedMinor: 100,
    };
    // The production UI is plain JavaScript, so its missing fields pass its
    // build; reproduce that runtime boundary explicitly here.
    expect(() => session.till.close(actualUiInput as Parameters<typeof session.till.close>[0]))
      .toThrow('Money minor units must be a safe integer, got undefined.');
  });
});
