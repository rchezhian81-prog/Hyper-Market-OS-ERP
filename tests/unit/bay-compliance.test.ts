import { describe, it, expect } from 'vitest';
import { planogramCompliance, ShelfMap, type Planogram, type ShelfLocation } from '../../packages/merchandising/src/index';
import { scoreByBay, BAY_GAP_WORDS } from '../../packages/merchandising/src/bay-compliance';
import { SWITCHED_OFF_SHELF_RECOGNITION, RecognitionSwitchedOffError, testStandInShelfRecognition } from '../../packages/merchandising/src/shelf-image-port';

// D-13 (R4, OB-219): the score per bay compares counted facings with the planogram and names every gap; recognition is a
// switched-off link that sends nothing; staff counts remain the measure.

const S = 'S1';
const loc = (locationId: string, aisle: number, bay: number, position: number): ShelfLocation => ({ storeId: S, locationId, aisle, rack: 1, bay, shelf: 1, position });
const LOCS = [loc('L1', 1, 1, 1), loc('L2', 1, 1, 2), loc('L3', 1, 2, 1), loc('L4', 1, 2, 2), loc('L5', 2, 1, 1)];
const assign = (productId: string, locationId: string, capacityMinor: number) => ({ storeId: S, productId, locationId, capacityMinor, primary: true });
const PLAN: Planogram = {
  planogramId: 'PG-1', storeId: S, version: 1, effectiveFrom: '2026-10-01', createdBy: 'u-mgr',
  assignments: [assign('P-RICE', 'L1', 40), assign('P-SOAP', 'L2', 60), assign('P-DAL', 'L3', 20), assign('P-OIL', 'L4', 20), assign('P-SALT', 'L5', 10)],
};
const NOW = '2026-10-19T06:00:00.000Z';
const BACK = { 'P-RICE': 100, 'P-SOAP': 0, 'P-DAL': 50 };

describe('D-13 — the planogram score per bay, every gap named', () => {
  it('scores each bay over its observed facings and names "empty, stock in back", "empty, none in building", "never counted", "counted too long ago"', () => {
    const run = planogramCompliance({
      planogram: PLAN, map: new ShelfMap(S, LOCS, PLAN.assignments), backstock: BACK, assignedRole: 'store_manager', asOf: NOW, staleAfterMinutes: 240,
      shelfState: [
        { productId: 'P-RICE', locationId: 'L1', onShelfMinor: 0, observedAt: NOW },
        { productId: 'P-SOAP', locationId: 'L2', onShelfMinor: 0, observedAt: NOW },
        { productId: 'P-DAL', locationId: 'L3', onShelfMinor: 20, observedAt: NOW },
        { productId: 'P-OIL', locationId: 'L4', onShelfMinor: 20, observedAt: '2026-10-18T06:00:00.000Z' },
      ],
    });
    const bays = scoreByBay({ planogram: PLAN, locations: LOCS, issues: run.issues, backstock: BACK });
    expect(bays.map((b) => [b.bayKey, b.planned, b.observed, b.compliant, b.score])).toEqual([
      ['A1-R1-B1', 2, 2, 0, { kind: 'scored', bp: 0 }],
      ['A1-R1-B2', 2, 1, 1, { kind: 'scored', bp: 10_000 }],
      ['A2-R1-B1', 1, 0, 0, { kind: 'not_scored', because: 'no facing in this bay was counted recently enough' }],
    ]);
    expect(bays[0]!.gaps.map((g) => [g.productId, g.words])).toEqual([['P-RICE', 'empty, stock in back'], ['P-SOAP', 'empty, none in building']]);
    expect(bays[1]!.gaps.map((g) => [g.productId, g.words])).toEqual([['P-OIL', 'counted too long ago']]);
    expect(bays[2]!.gaps.map((g) => [g.productId, g.words])).toEqual([['P-SALT', 'never counted']]);
    expect(bays.every((b) => b.measuredBy === 'counted by staff')).toBe(true);
    expect(BAY_GAP_WORDS.below_refill_level).toBe('below the refill level');
  });
});

describe('D-13 — image recognition is a switched-off link (OB-219)', () => {
  it('switched off: it says so, and refuses before touching any photo — nothing is sent', async () => {
    expect(SWITCHED_OFF_SHELF_RECOGNITION.state).toBe('switched_off');
    expect(SWITCHED_OFF_SHELF_RECOGNITION.detail).toMatch(/no photo leaves the shop/);
    await expect(SWITCHED_OFF_SHELF_RECOGNITION.recognise({ photoId: 'x', mediaType: 'image/png', contentBase64: 'AA==' })).rejects.toBeInstanceOf(RecognitionSwitchedOffError);
  });
  it('the test stand-in answers from its table and records what it was asked — a suggestion, nothing more', async () => {
    const fake = testStandInShelfRecognition({ 'ph-1': [{ productId: 'P-RICE', facingsSeen: 3 }] });
    expect(await fake.recognise({ photoId: 'ph-1', mediaType: 'image/png', contentBase64: 'AA==' })).toEqual([{ productId: 'P-RICE', facingsSeen: 3 }]);
    expect(await fake.recognise({ photoId: 'ph-2', mediaType: 'image/png', contentBase64: 'AA==' })).toEqual([]);
    expect(fake.asked).toEqual(['ph-1', 'ph-2']);
  });
});
