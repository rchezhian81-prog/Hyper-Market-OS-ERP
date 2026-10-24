import { describe, it, expect } from 'vitest';
import {
  createHeatMapSession, heatBand, figureWords, areaNotes, areaName, heatMapWords, heatMapOutcomeWords, HEAT_MAP_COPY, type HeatAreaView,
} from '../../apps/web-erp/src/floor-heat-map-session';

// OB-288 P2 · OB-308 — the Floor heat map page's session, DOM-free: it asks head office only for someone who may read space
// performance, says what it needs in words, bands a heat into five steps of one hue (never a colour for "not known"), and
// says every figure in English and Tamil.

const area = (over: Partial<HeatAreaView> = {}): HeatAreaView => ({
  areaId: 'dairy', name: 'Dairy', nameTa: 'பால் பொருட்கள்', x: 0, y: 0, width: 5, depth: 10, squareFeet: 50, products: ['milk'], salesMinor: 15_750,
  marginMinor: null, marginNotKnownFor: ['milk'], salesPerSqFt: { kind: 'per_sq_ft', minorPerSqFt: 315 }, marginPerSqFt: { kind: 'not_meaningful', because: 'x' },
  heat: 100, underperforming: false, ...over,
});

describe('the Floor heat map session', () => {
  it('reads only for someone holding merchandising.space.read, and says what is missing', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string) => { calls.push(url); return new Response(JSON.stringify({ storeId: 'store-1', areas: [] }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    expect((await createHeatMapSession({ viewer: undefined, fetch }).read({ storeId: 's', from: '2026-10-01', to: '2026-10-23', measure: 'sales' }))).toEqual({ result: 'invalid', why: 'nobody' });
    const cashier = createHeatMapSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch });
    expect(cashier.may.read).toBe(false);
    expect(await cashier.read({ storeId: 's', from: '2026-10-01', to: '2026-10-23', measure: 'sales' })).toEqual({ result: 'invalid', why: 'cannotRead' });
    const mgr = createHeatMapSession({ viewer: { userId: 'u-mgr', permissions: ['merchandising.space.read'] }, fetch });
    expect(await mgr.read({ storeId: ' ', from: '2026-10-01', to: '2026-10-23', measure: 'sales' })).toEqual({ result: 'invalid', why: 'needStore' });
    expect(await mgr.read({ storeId: 'store-1', from: '', to: '2026-10-23', measure: 'sales' })).toEqual({ result: 'invalid', why: 'needDates' });
    expect(calls).toEqual([]);
    expect((await mgr.read({ storeId: 'store-1', from: '2026-10-01', to: '2026-10-23', measure: 'margin' })).result).toBe('ok');
    expect(calls).toEqual(['/v1/merchandising/stores/store-1/heat-map?from=2026-10-01&to=2026-10-23&measure=margin']);
  });

  it('says a refusal, a missing plan and a lost link in words', async () => {
    const refusing = (status: number, whatHappened: string) => (async () => new Response(JSON.stringify({ error: { code: 'x', whatHappened } }), { status })) as unknown as typeof globalThis.fetch;
    const s = (f: typeof globalThis.fetch) => createHeatMapSession({ viewer: { userId: 'u', permissions: ['merchandising.space.read'] }, fetch: f });
    const noPlan = await s(refusing(404, 'Not found: floor plan for store store-9')).read({ storeId: 'store-9', from: '2026-10-01', to: '2026-10-23', measure: 'sales' });
    expect(heatMapOutcomeWords('en', noPlan)).toBe(heatMapWords('en', 'noPlan'));
    const lost = await s((async () => { throw new Error('down'); }) as unknown as typeof globalThis.fetch).read({ storeId: 's', from: '2026-10-01', to: '2026-10-23', measure: 'sales' });
    expect(heatMapOutcomeWords('ta', lost)).toBe(HEAT_MAP_COPY.ta.unreachable);
  });

  it('five steps of one hue; "not known" is no step; figures and notes in both languages', () => {
    expect([0, 19, 20, 55, 70, 80, 100].map(heatBand)).toEqual([0, 0, 1, 2, 3, 4, 4]);
    expect(heatBand(null)).toBeNull();
    expect(figureWords('en', area(), 'sales')).toBe('₹3.15 per sq ft');
    expect(figureWords('en', area(), 'margin')).toBe('Not known');
    expect(areaNotes('en', area(), 'margin')).toEqual(['Margin not known — no buying cost for milk']);
    expect(areaNotes('ta', area({ salesMinor: 0, underperforming: true }), 'sales')).toEqual([HEAT_MAP_COPY.ta.nothingSold, HEAT_MAP_COPY.ta.underperforming]);
    expect(areaName('ta', area())).toBe('பால் பொருட்கள்');
    expect(areaName('ta', area({ nameTa: null }))).toBe('Dairy');
    expect(Object.keys(HEAT_MAP_COPY.ta).sort()).toEqual(Object.keys(HEAT_MAP_COPY.en).sort());
  });
});
