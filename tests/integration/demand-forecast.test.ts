import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// D-1 demand forecast on the live API (API-04). Given a product's own banked sales, the route decomposes a
// baseline × day-of-week seasonality and projects it forward, scored by a back-test — all from the sales the
// store already keeps. A stateless read; it never writes.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const ONE_DAY = 86_400_000;
const indexOf = (day: string) => Math.floor(Date.parse(`${day}T00:00:00.000Z`) / ONE_DAY);
const dayOf = (index: number) => new Date(index * ONE_DAY).toISOString().slice(0, 10);
const dowOf = (day: string) => new Date(`${day}T00:00:00.000Z`).getUTCDay();

const bankSale = (h: ApiHarness, u: string, saleId: string, productId: string, qty: number, tradingDay: string) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: `fc-${saleId}`,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: u,
      tradingDay, committedAt: `${tradingDay}T09:00:00Z`, totalMinor: qty * 100, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: 100, lineTotalMinor: qty * 100 }],
      tenders: [{ kind: 'cash', amountMinor: qty * 100 }],
    },
  });

const forecast = (h: ApiHarness, u: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/inventory/demand-forecast', userId: u, tenantId: A, query });

interface ForecastBody {
  productId: string; baselinePerDay: number; dowFactors: number[]; method: string;
  horizon: { day: string; dow: number; forecastQty: number; signalMultiplier: number; appliedSignals: string[] }[];
  signals: { from: string; to: string; multiplier: number; label?: string }[];
  quality?: { testedDays: number; wape: number };
}
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// Two weeks of BREAD: weekends sell 30, weekdays 10.
const FROM = '2026-06-07';
const TO = dayOf(indexOf(FROM) + 13);
async function seedTwoWeeks(h: ApiHarness): Promise<void> {
  await h.seedOwner(A, 'u-owner');
  for (let i = 0; i < 14; i += 1) {
    const day = dayOf(indexOf(FROM) + i);
    const qty = dowOf(day) === 0 || dowOf(day) === 6 ? 30 : 10;
    await bankSale(h, 'u-owner', `B${i}`, 'BREAD', qty, day);
  }
}

describe('demand forecast on the live API (D-1)', () => {
  it('forecasts a product from its banked sales, learning the weekly pattern, and scores itself', async () => {
    const h = apiHarness();
    await seedTwoWeeks(h);

    const res = await forecast(h, 'u-owner', { productId: 'BREAD', from: FROM, to: TO, horizonDays: '7' });
    expect(res.status).toBe(200);
    const b = res.body as ForecastBody;

    expect(b.productId).toBe('BREAD');
    expect(b.method).toBe('baseline_x_dow');
    expect(b.horizon).toHaveLength(7);
    const sat = b.horizon.find((d) => d.dow === 6)!;
    const wed = b.horizon.find((d) => d.dow === 3)!;
    expect(sat.forecastQty).toBeGreaterThan(wed.forecastQty); // the weekend spike carries into the forecast
    // Two weeks is enough to hold out a week and score it.
    expect(b.quality?.testedDays).toBe(7);
    expect(b.quality?.wape).toBeLessThan(0.05);
  });

  it('applies an exogenous event signal passed as ?events=FROM~TO~MULT~LABEL', async () => {
    const h = apiHarness();
    await seedTwoWeeks(h);
    const eventDay = dayOf(indexOf(TO) + 2); // a day inside the 7-day horizon

    const base = (res: ForecastBody) => res.horizon.find((d) => d.day === eventDay)!.forecastQty;
    const plain = await forecast(h, 'u-owner', { productId: 'BREAD', from: FROM, to: TO, horizonDays: '7' });
    const withEvent = await forecast(h, 'u-owner', { productId: 'BREAD', from: FROM, to: TO, horizonDays: '7', events: `${eventDay}~${eventDay}~2~Diwali` });

    const b = withEvent.body as ForecastBody;
    const ev = b.horizon.find((d) => d.day === eventDay)!;
    expect(ev.signalMultiplier).toBe(2);
    expect(ev.appliedSignals).toContain('Diwali');
    expect(ev.forecastQty).toBe(base(plain.body as ForecastBody) * 2); // the festival doubles that day
    expect(b.signals).toHaveLength(1);
  });

  it('rejects a malformed events string', async () => {
    const h = apiHarness();
    await seedTwoWeeks(h);
    expect(codeOf(await forecast(h, 'u-owner', { productId: 'BREAD', from: FROM, to: TO, events: 'notadate~x~2' }))).toBe('invalid_forecast_input');
  });

  it('needs a product, rejects a bad horizon, and is authorized', async () => {
    const h = apiHarness();
    await seedTwoWeeks(h);
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds inventory.availability.read
    await h.provisionRole(A, 'u-cash', 'cashier');       // does not

    expect(codeOf(await forecast(h, 'u-owner', { from: FROM, to: TO }))).toBe('forecast_needs_a_product');
    expect(codeOf(await forecast(h, 'u-owner', { productId: 'BREAD', from: FROM, to: TO, horizonDays: '0' }))).toBe('bad_forecast_horizon');

    expect((await forecast(h, 'u-mgr', { productId: 'BREAD', from: FROM, to: TO })).status).toBe(200);
    expect((await forecast(h, 'u-cash', { productId: 'BREAD', from: FROM, to: TO })).status).toBe(403);
  });
});
