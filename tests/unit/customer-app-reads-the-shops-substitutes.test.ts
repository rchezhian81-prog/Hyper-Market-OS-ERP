import { describe, it, expect } from 'vitest';
import { bootShop, forgetfulBasket, type ShopData } from '../../apps/customer-app/src/browser-entry';
import type { ShopTransport, ShopAnswer } from '../../apps/customer-app/src/shop-transport';

// G-1 (M03-FR-04 · A04): the customer app reads the shop's approved substitutes for an item it cannot supply — the shop's
// own route (`GET /v1/storefront/products/:productId/substitutes`) as the signed-in customer. It only READS: signed out,
// offline or refused, it says which, and it keeps only well-formed entries the shop sent. Synthetic data only.

const data: ShopData = {
  tenantId: 't1', customerRef: 'c1', packVersion: 7, locationId: 'L1', slots: [], storeLocation: { lat: 11, lon: 77 }, deliveryFeeMinor: 0,
  products: [{ productId: 'MILK', name: 'Milk 1L', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'ea', barcodes: [], status: 'active', availableMinor: 0, availabilityAgeMinutes: 1 }],
};

function shopWith(answer: ShopAnswer) {
  const paths: { token: string; path: string }[] = [];
  const transport: ShopTransport = {
    placeOrder: () => Promise.resolve(answer),
    storefront: (request) => { paths.push(request); return Promise.resolve(answer); },
  };
  return { shop: bootShop(data, forgetfulBasket(), () => 'id-1', transport)!, paths };
}

describe('the customer app reads the shop\'s approved substitutes (G-1 · M03-FR-04)', () => {
  it('reads the shop\'s route as the signed-in customer and keeps only the well-formed entries, in the shop\'s order', async () => {
    const { shop, paths } = shopWith({ reached: true, status: 200, body: { productId: 'MILK', set: true, substitutes: [
      { productId: 'MILK-500', name: 'Milk 500ml', nameTa: 'பால் 500மி' }, { productId: 'BROOM', name: 'Broom' }, { name: 'no id' }, 'junk',
    ] } });
    expect(await shop.online.substitutes('MILK')).toEqual({ ok: false, refusal: 'not_signed_in' });
    expect(paths).toEqual([]);
    shop.signedIn('tok-1');
    expect(await shop.online.substitutes('MILK')).toEqual({ ok: true, value: [{ productId: 'MILK-500', name: 'Milk 500ml', nameTa: 'பால் 500மி' }, { productId: 'BROOM', name: 'Broom' }] });
    expect(paths).toEqual([{ token: 'tok-1', path: 'products/MILK/substitutes' }]);
    // Reading changes nothing in the basket.
    expect(shop.state().lines).toEqual([]);
  });

  it('offline or refused, it says which — never an empty list passed off as the shop\'s answer', async () => {
    const offline = shopWith({ reached: false, why: 'no_connection', detail: 'no signal' });
    offline.shop.signedIn('tok-1');
    expect(await offline.shop.online.substitutes('MILK')).toEqual({ ok: false, refusal: 'not_saved_no_connection' });
    const refused = shopWith({ reached: true, status: 404, body: { error: { whatHappened: 'Not found: product MILK' } } });
    refused.shop.signedIn('tok-1');
    expect(await refused.shop.online.substitutes('MILK')).toEqual({ ok: false, refusal: 'the_shop_refused', shopSaid: 'Not found: product MILK' });
  });
});
