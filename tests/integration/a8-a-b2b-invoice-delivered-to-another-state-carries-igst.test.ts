import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { backingsFor, headOffice } from '../support/till-bill-world';
import { setApprovedCreditLimit } from '../support/approved-credit-limit';
import { onThePriceList, harnessPriceList } from '../support/b2b-price-on-record';

/**
 * **A8 — a B2B tax invoice delivered to another State carries IGST; inside Tamil Nadu it carries CGST + SGST — on the REAL
 * document, through the real API, in memory AND on real PostgreSQL, head office restarted COLD before it is read back.**
 *
 * The store's GSTIN (33 — Tamil Nadu) is the supplier's State. An order dispatched from the store and delivered to Kerala
 * (32) is invoiced with one IGST; one delivered inside the State with CGST + SGST; one with no delivery State named is the
 * store's own State, said on the document as assumed. A State code that is no State is refused with no number drawn; a
 * cashier may not issue a B2B invoice at all (403). A business with no GSTIN on record gets an invoice that SAYS it carries
 * no split, never a guessed one.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const LINES = [
  { lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 },
  { lineId: 'l2', productId: 'p2', description: 'Shampoo case', qty: 2, unitPriceMinor: 20_000, taxRateBps: 1_800 },
];
interface Gst { placeOfSupply: string; supplierStateCode: string; deliveryStateCode: string; basis: string; cgstMinor: number; sgstMinor: number; igstMinor: number }

describe.each(backings)('A8 — the B2B invoice carries IGST across States, CGST + SGST within — on $name', (backing) => {
  it('Kerala → IGST; Tamil Nadu → CGST + SGST; none named → assumed and said; bad code 400; cashier 403; read back after a cold restart', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-meena', role: 'cashier' }]);
    const t = ho.tenantId;
    await ho.h.enableFeature(t, 'b2b');
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', '/v1/org/gst-registrations/33AABCS1429B1Z1', 'u-owner', { companyId: 'SRE', legalName: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: '33AABCS1429B1Z1', placeOfBusiness: '12 Main Road\n\nTiruppur 641601, Tamil Nadu' });
    for (const p of ['p1', 'p2']) {
      await ho.ok('POST', '/v1/inventory/movements', 'u-owner', { movementId: `stock-${p}`, productId: p, locationId: 'S1', kind: 'received', quantityMinor: 1_000, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: 'u-owner' });
    }
    expect((await setApprovedCreditLimit(ho.h, t, 'u-owner', 'CUST1', { creditLimitMinor: 10_000_000 })).status).toBeLessThan(300); // OB-360
    const orderAndDeliver = async (n: number): Promise<void> => {
      await ho.ok('POST', `/v1/b2b/documents/CUST1/quotations/q${n}`, 'u-owner', { lines: await onThePriceList(harnessPriceList(ho.h, ho.tenantId), 'CUST1', LINES) });
      await ho.ok('POST', `/v1/b2b/documents/CUST1/orders/so${n}`, 'u-owner', { fromQuotationId: `q${n}`, locationId: 'S1' });
      await ho.ok('POST', `/v1/b2b/documents/CUST1/challans/dc${n}`, 'u-owner', { fromOrderId: `so${n}`, dispatched: { l1: 10, l2: 2 } });
    };
    const invoice = (id: string, body: Record<string, unknown>, user = 'u-owner') => ho.call('POST', `/v1/b2b/documents/CUST1/invoices/${id}`, user, body);

    await orderAndDeliver(1);
    expect((await invoice('inv-x', { fromOrderId: 'so1', deliveryStateCode: '32' }, 'u-meena')).status).toBe(403);
    const bad = await invoice('inv-bad', { fromOrderId: 'so1', deliveryStateCode: '99' });
    expect(bad.status).toBe(400);
    const kerala = await invoice('inv-kl', { fromOrderId: 'so1', deliveryStateCode: '32' });
    expect(kerala.status, JSON.stringify(kerala.body)).toBe(201);
    const k = kerala.body as { number: string; gst: Gst };
    expect(k.number).toBe('INV-000001'); // the refused one drew no number
    expect(k.gst).toMatchObject({ placeOfSupply: 'inter_state', supplierStateCode: '33', deliveryStateCode: '32', basis: 'delivery_state', cgstMinor: 0, sgstMinor: 0, igstMinor: 5_000 + 7_200 });

    await orderAndDeliver(2);
    const tn = (await invoice('inv-tn', { fromOrderId: 'so2', deliveryStateCode: '33' })).body as { gst: Gst };
    expect(tn.gst).toMatchObject({ placeOfSupply: 'intra_state', igstMinor: 0, cgstMinor: 6_100, sgstMinor: 6_100 });

    await orderAndDeliver(3);
    const local = (await invoice('inv-local', { fromOrderId: 'so3' })).body as { gst: Gst };
    expect(local.gst).toMatchObject({ placeOfSupply: 'intra_state', basis: 'store_state_assumed', deliveryStateCode: '33' });

    ho.restartCold(); // ── head office COLD: the stored document still says it ───────────────────────────────────────────
    const stored = await ho.ok('GET', '/v1/b2b/documents/CUST1/inv-kl', 'u-owner') as { document?: { gst?: Gst }; gst?: Gst };
    expect((stored.document ?? stored).gst).toMatchObject({ placeOfSupply: 'inter_state', igstMinor: 12_200 });
  }, 60_000);

  it('a business with no GSTIN on record: the invoice is issued and SAYS it carries no split', async () => {
    const ho = await headOffice(backing);
    await ho.h.enableFeature(ho.tenantId, 'b2b');
    for (const p of ['p1', 'p2']) {
      await ho.ok('POST', '/v1/inventory/movements', 'u-owner', { movementId: `stock-${p}`, productId: p, locationId: 'S1', kind: 'received', quantityMinor: 1_000, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: 'u-owner' });
    }
    expect((await setApprovedCreditLimit(ho.h, ho.tenantId, 'u-owner', 'CUST1', { creditLimitMinor: 10_000_000 })).status).toBeLessThan(300); // OB-360
    await ho.ok('POST', '/v1/b2b/documents/CUST1/quotations/q1', 'u-owner', { lines: await onThePriceList(harnessPriceList(ho.h, ho.tenantId), 'CUST1', LINES) });
    await ho.ok('POST', '/v1/b2b/documents/CUST1/orders/so1', 'u-owner', { fromQuotationId: 'q1', locationId: 'S1' });
    await ho.ok('POST', '/v1/b2b/documents/CUST1/challans/dc1', 'u-owner', { fromOrderId: 'so1', dispatched: { l1: 10, l2: 2 } });
    const inv = await ho.ok('POST', '/v1/b2b/documents/CUST1/invoices/inv1', 'u-owner', { fromOrderId: 'so1', deliveryStateCode: '32' }) as { gst?: unknown; gstNotJudged?: string };
    expect(inv.gst).toBeUndefined();
    expect(inv.gstNotJudged).toMatch(/not on record/);
  }, 60_000);
});
