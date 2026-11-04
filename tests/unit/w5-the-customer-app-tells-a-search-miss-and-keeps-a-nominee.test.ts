import { describe, it, expect } from 'vitest';
import { bootShop, forgetfulBasket, type ShopData } from '../../apps/customer-app/src/browser-entry';
import type { ShopTransport, ShopAnswer } from '../../apps/customer-app/src/shop-transport';

/**
 * W5 · D02-FR-04 (OB-319) and C5 (DPDP s.14) — the customer app's model:
 *   • a finished search that found nothing is told to the shop as the WORDS only (lower-cased, spaces folded) — never a phone
 *     number or an e-mail address, never while signed out, and the same finished search is told once;
 *   • the nominee is named and withdrawn ON THE SHOP and read back from the shop's own answer — the phone never says "saved"
 *     on its own.
 */
const data: ShopData = {
  tenantId: 't-w5', customerRef: 'guest', packVersion: 1, locationId: 'L1', consentPurposes: [], storeLocation: { lat: 11.0, lon: 77.0 },
  products: [{ productId: 'MILK', name: 'Milk 1L', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'each', barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 }],
};

function transport(nominee: () => unknown) {
  const sent: { kind: string; method: string; path: string; body?: unknown }[] = [];
  const ok = (body: unknown, status = 201): Promise<ShopAnswer> => Promise.resolve({ reached: true, status, body });
  const t: ShopTransport = {
    placeOrder: () => ok({}),
    commerce: (r) => { sent.push({ kind: 'commerce', method: r.method, path: r.path, body: r.body }); return ok({ recorded: true }); },
    privacy: (r) => {
      sent.push({ kind: 'privacy', method: r.method, path: r.path, body: r.body });
      if (r.method === 'GET') return ok({ consent: [], requests: [], nominee: nominee() }, 200);
      return ok({ tellTheCustomer: r.path === '/nominee' ? 'Saved: n-1 (son) may exercise your privacy rights…' : 'Saved: n-1 is no longer your nominee.' });
    },
  };
  return { t, sent };
}

describe('W5 customer app — search misses (D02-FR-04) and the nominee (C5)', () => {
  it('a search miss is sent as the words only, once, and never a phone number, an e-mail address, or while signed out', async () => {
    const { t, sent } = transport(() => null);
    const shop = bootShop(data, forgetfulBasket(), () => 'id-1', t)!;
    expect(await shop.recordSearchMiss('saffron')).toEqual({ sent: false }); // signed out: nothing sent
    shop.signedIn('tok');
    expect(await shop.recordSearchMiss('  Saffron   Strands ')).toEqual({ sent: true });
    expect(await shop.recordSearchMiss('saffron strands')).toEqual({ sent: false }); // the same finished search: once
    expect(await shop.recordSearchMiss('9876543210')).toEqual({ sent: false });
    expect(await shop.recordSearchMiss('me@example.com')).toEqual({ sent: false });
    expect(sent).toEqual([{ kind: 'commerce', method: 'POST', path: 'catalogue/search-misses', body: { words: 'saffron strands' } }]);
  });

  it('the nominee is named and withdrawn on the shop, and the phone shows what the shop read back', async () => {
    let held: unknown = null;
    const { t, sent } = transport(() => held);
    const shop = bootShop(data, forgetfulBasket(), () => 'id-2', t)!;
    expect((await shop.setNominee('n-1', 'son')).ok).toBe(false); // signed out
    expect(sent).toEqual([]);
    shop.signedIn('tok');
    held = { nomineeRef: 'n-1', relationship: 'son' };
    const named = await shop.setNominee(' n-1 ', ' son ');
    expect(named).toEqual({ ok: true, tellTheCustomer: 'Saved: n-1 (son) may exercise your privacy rights…' });
    expect(shop.myNominee()).toEqual({ nomineeRef: 'n-1', relationship: 'son' });
    held = null;
    expect((await shop.withdrawNominee()).ok).toBe(true);
    expect(shop.myNominee()).toBeNull();
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /nominee', 'GET ', 'POST /nominee/withdrawal', 'GET ']);
    expect(sent[0]!.body).toEqual({ nomineeRef: 'n-1', relationship: 'son' });
  });
});
