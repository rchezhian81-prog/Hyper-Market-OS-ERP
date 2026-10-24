import { describe, it, expect } from 'vitest';
import { gtinValid, readScan, scanFrames, scanSupported } from '../../apps/customer-app/src/barcode-scan';
import { quoteRows, repeatOrderBody, deliveryHandover, basketKey, COUPON_CODE } from '../../apps/customer-app/src/customer-commerce';
import { COUPON_CODE as SHOP_COUPON_CODE } from '../../services/orders/src/storefront';
import { httpShopTransport } from '../../apps/customer-app/src/shop-transport';

// OB-288 wave 3 — the customer app's commerce rules (D08-FR-02 camera barcode · WF-13 the shop's price · OB-303 repeat
// orders · the delivery-code slot), and the transport that carries them. DOM-free; the browser journey is in tests/e2e.

describe('camera barcode (D08-FR-02)', () => {
  it('only a retail barcode with the right check digit becomes a search', () => {
    expect(['8900000000012', '4006381333931', '96385074', '036000291452'].map(gtinValid)).toEqual([true, true, true, true]);
    expect(['8900000000013', '12345', 'abc', '', '890000000001x'].map(gtinValid)).toEqual([false, false, false, false, false]);
    expect(readScan([{ rawValue: 'https://example.test/qr' }, { rawValue: ' 8900000000012 ' }])).toBe('8900000000012');
    expect(readScan([{ rawValue: '8900000000013' }])).toBeUndefined();
  });

  it('frames are read until a code is found, the customer stops, or the frames run out — a reader error is not a code', async () => {
    let n = 0;
    const reader = { detect: async () => { n += 1; if (n === 1) throw new Error('blurred'); return n < 3 ? [] : [{ rawValue: '8900000000012' }]; } };
    expect(await scanFrames({ reader, frame: () => null, nextFrame: async () => {}, stopped: () => false, maxFrames: 10 })).toEqual({ found: true, code: '8900000000012' });
    expect(await scanFrames({ reader: { detect: async () => [] }, frame: () => null, nextFrame: async () => {}, stopped: () => false, maxFrames: 3 })).toEqual({ found: false, why: 'nothing_found' });
    expect(await scanFrames({ reader, frame: () => null, nextFrame: async () => {}, stopped: () => true, maxFrames: 3 })).toEqual({ found: false, why: 'stopped' });
  });

  it('a phone scans only with a reader that knows a retail format and a camera to ask for', async () => {
    const cam = { mediaDevices: { getUserMedia: () => undefined } };
    expect(await scanSupported({ navigator: cam })).toBe(false);
    expect(await scanSupported({ BarcodeDetector: { getSupportedFormats: async () => ['qr_code'] }, navigator: cam })).toBe(false);
    expect(await scanSupported({ BarcodeDetector: { getSupportedFormats: async () => ['qr_code', 'ean_13'] }, navigator: cam })).toBe(true);
    expect(await scanSupported({ BarcodeDetector: { getSupportedFormats: async () => ['ean_13'] }, navigator: {} })).toBe(false);
  });
});

describe('the shop\'s price (WF-13)', () => {
  it('rows are the shop\'s amounts: goods, offers, coupon (or why not), delivery, what you pay', () => {
    expect(quoteRows({ priced: true, goodsMinor: 210_00, deliveryFeeMinor: 40_00, payableMinor: 224_00, promotions: { discountMinor: 6_00, applied: [] }, coupon: { code: 'SAVE20', applied: true, outcome: 'redeemed', discountMinor: 20_00, detail: '' } }))
      .toEqual([{ kind: 'goods', amountMinor: 210_00 }, { kind: 'offers', amountMinor: -6_00 }, { kind: 'coupon', amountMinor: -20_00 }, { kind: 'delivery', amountMinor: 40_00 }, { kind: 'payable', amountMinor: 224_00 }]);
    expect(quoteRows({ priced: true, goodsMinor: 60_00, deliveryFeeMinor: 0, payableMinor: 60_00, promotions: { discountMinor: 0, applied: [] }, coupon: { code: 'NOPE', applied: false, outcome: 'unknown_code', discountMinor: 0, detail: '' } }))
      .toEqual([{ kind: 'goods', amountMinor: 60_00 }, { kind: 'coupon_refused', code: 'NOPE', outcome: 'unknown_code' }, { kind: 'delivery', amountMinor: 0 }, { kind: 'payable', amountMinor: 60_00 }]);
    // Never a fake zero: an unpriced basket says which products have no price.
    expect(quoteRows({ priced: false, unpriced: ['SAREE'] })).toEqual([{ kind: 'unpriced', productIds: ['SAREE'] }]);
  });

  it('the coupon rule is head office\'s own; a basket\'s key changes with any line, the fulfilment or the coupon', () => {
    expect(COUPON_CODE.source).toBe(SHOP_COUPON_CODE.source);
    const a = basketKey([{ productId: 'B', quantityMinor: 1 }, { productId: 'A', quantityMinor: 2 }], 'delivery', 'SAVE20');
    expect(basketKey([{ productId: 'A', quantityMinor: 2 }, { productId: 'B', quantityMinor: 1 }, { productId: 'C', quantityMinor: 0 }], 'delivery', ' SAVE20 ')).toBe(a);
    expect(basketKey([{ productId: 'A', quantityMinor: 3 }, { productId: 'B', quantityMinor: 1 }], 'delivery', 'SAVE20')).not.toBe(a);
    expect(basketKey([{ productId: 'A', quantityMinor: 2 }, { productId: 'B', quantityMinor: 1 }], 'pickup', 'SAVE20')).not.toBe(a);
    expect(basketKey([{ productId: 'A', quantityMinor: 2 }, { productId: 'B', quantityMinor: 1 }], 'delivery', undefined)).not.toBe(a);
  });
});

describe('repeat orders (OB-303)', () => {
  const base = { lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'X', quantityMinor: 0 }], locationId: 'br-1', today: '2026-10-23', startsOn: '2026-10-24', every: 'days' as const, days: 7, fulfilment: 'pickup' as const };
  it('the form becomes the shop\'s body — only real lines, the schedule, the start', () => {
    expect(repeatOrderBody(base)).toEqual({ ok: true, body: { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'br-1', schedule: { kind: 'every_days', days: 7 }, startsOn: '2026-10-24', fulfilment: 'pickup' } });
    expect(repeatOrderBody({ ...base, every: 'weekdays', weekdays: [5, 1, 1] })).toMatchObject({ ok: true, body: { schedule: { kind: 'weekdays', weekdays: [1, 5] } } });
    expect(repeatOrderBody({ ...base, fulfilment: 'delivery', location: { lat: 11, lon: 76 }, slotTime: '10:30' })).toMatchObject({ ok: true, body: { delivery: { location: { lat: 11, lon: 76 }, slotTime: '10:30' } } });
  });
  it('refused before anything is sent, with the reason', () => {
    expect(repeatOrderBody({ ...base, lines: [] })).toEqual({ ok: false, why: 'empty_basket' });
    expect(repeatOrderBody({ ...base, locationId: undefined })).toEqual({ ok: false, why: 'no_store' });
    expect(repeatOrderBody({ ...base, startsOn: '2026-10-22' })).toEqual({ ok: false, why: 'bad_start' });
    expect(repeatOrderBody({ ...base, days: 0 })).toEqual({ ok: false, why: 'bad_days' });
    expect(repeatOrderBody({ ...base, every: 'weekdays', weekdays: [] })).toEqual({ ok: false, why: 'no_weekdays' });
    expect(repeatOrderBody({ ...base, fulfilment: 'delivery', slotTime: '10:30' })).toEqual({ ok: false, why: 'no_location' });
    expect(repeatOrderBody({ ...base, fulfilment: 'delivery', location: { lat: 11, lon: 76 }, slotTime: '25:00' })).toEqual({ ok: false, why: 'bad_time' });
  });
});

describe('the delivery code and arrival time', () => {
  it('are "not given yet" (null) until the delivery record carries them — never invented', () => {
    expect(deliveryHandover(null)).toEqual({ code: null, eta: null });
    expect(deliveryHandover({ status: 'out_for_delivery' })).toEqual({ code: null, eta: null });
    expect(deliveryHandover({ handoverCode: '4821', eta: '2026-10-23T10:30:00.000Z' })).toEqual({ code: '4821', eta: '2026-10-23T10:30:00.000Z' });
    expect(deliveryHandover({ handoverCode: 'abcd', eta: 'soon' })).toEqual({ code: null, eta: null });
  });
});

describe('the commerce transport', () => {
  it('carries the coupon on the order, a body on PUT and POST, none on GET, and says when it never reached the shop', async () => {
    const seen: { url: string; method: string; body?: string }[] = [];
    const fetch = (async (url: string, init: { method: string; body?: string }) => { seen.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) }); return new Response('{}', { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const t = httpShopTransport({ fetch });
    await t.placeOrder({ orderId: 'o-1', token: 'tk', lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'br-1', couponCode: 'SAVE20' });
    await t.commerce!({ token: 'tk', method: 'PUT', path: 'me/cart', body: { lines: [] } });
    await t.commerce!({ token: 'tk', method: 'GET', path: 'me/ai-suggestions?locationId=br-1' });
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ couponCode: 'SAVE20' });
    expect(seen[1]).toEqual({ url: '/v1/me/cart', method: 'PUT', body: '{"lines":[]}' });
    expect(seen[2]).toEqual({ url: '/v1/me/ai-suggestions?locationId=br-1', method: 'GET' });
    const offline = httpShopTransport({ fetch, isOnline: () => false });
    expect(await offline.commerce!({ token: 'tk', method: 'POST', path: 'me/help/answers', body: {} })).toMatchObject({ reached: false, why: 'no_connection' });
  });
});
