import { describe, it, expect } from 'vitest';
import { laneHealth, type ScreenInput } from '../../edge/store-edge/src/screen-data';

/**
 * **OB-392 · M12-FR-04 · D04-FR-05 — the manager's lane cards, from what the store computer already holds.**
 *
 * One card per lane: every lane that reported its devices, this box's own lane, and any lane with something unsent. Each
 * device is as the till last said, or `null` ("not reported", never "working" — P-08). The unsent count is the lane's own
 * items in the outbox; the last send to head office is the box's, and absent when the box cannot tell.
 */

const outbox = (payloads: readonly unknown[]) => ({ pending: () => payloads.map((payload, i) => ({ key: `k${i}`, event: { type: 'SaleCommitted', payload } })) });
const input = (over: Partial<Record<keyof ScreenInput, unknown>>): ScreenInput => ({ outbox: outbox([]), ...over }) as unknown as ScreenInput;

describe('OB-392: lane cards', () => {
  it('a box with no device register has no lane cards at all (absent, not an empty "all fine")', () => {
    expect(laneHealth(input({}))).toBeUndefined();
  });

  it('every reported lane, the box\'s own lane and every lane with unsent items get a card, sorted; unknown devices are null', () => {
    const cards = laneHealth(input({
      ownLaneId: 'lane-3',
      peripheralReports: [{ laneId: 'lane-2', reportedBy: 'u-c', reportedAt: '2026-10-26T04:30:00.000Z', devices: [{ kind: 'printer', state: 'failed', detail: 'paper out' }, { kind: 'scale', state: 'degraded' }, { kind: 'scanner', state: 'ok' }] }],
      outbox: outbox([{ laneId: 'lane-1' }, { laneId: 'lane-1' }, { laneId: 'lane-2' }, { nothing: true }]),
      laneLink: { lastSentAt: null },
    }))!;
    expect(cards.map((c) => c.laneId)).toEqual(['lane-1', 'lane-2', 'lane-3']);
    expect(cards[0]).toMatchObject({ laneId: 'lane-1', lastReportAt: null, devices: { printer: null, scanner: null, card_terminal: null }, unsent: 2, problems: 0, boxLastSentAt: null, boxLastSentShop: null });
    // The scale is not one of the three named devices, but its trouble still counts as a problem on the lane.
    expect(cards[1]).toMatchObject({ laneId: 'lane-2', lastReportAt: '2026-10-26T04:30:00.000Z', devices: { printer: { state: 'failed', detail: 'paper out' }, scanner: { state: 'ok' }, card_terminal: null }, unsent: 1, problems: 2 });
    expect(cards[1]!.lastReportShop).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(cards[2]).toMatchObject({ laneId: 'lane-3', lastReportAt: null, unsent: 0 });
  });

  it('the box\'s last send is said when known, and left out when the box cannot tell', () => {
    const known = laneHealth(input({ ownLaneId: 'lane-1', peripheralReports: [], laneLink: { lastSentAt: '2026-10-26T05:00:00.000Z' } }))!;
    expect(known[0]!.boxLastSentAt).toBe('2026-10-26T05:00:00.000Z');
    expect(known[0]!.boxLastSentShop).toMatch(/^2026-10-26T\d{2}:\d{2}$/);
    const unknown = laneHealth(input({ ownLaneId: 'lane-1', peripheralReports: [] }))!;
    expect('boxLastSentAt' in unknown[0]!).toBe(false);
  });
});
