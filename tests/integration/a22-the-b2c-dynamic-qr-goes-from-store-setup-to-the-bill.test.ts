import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { signInTill } from '../support/till-operator';
import { backingsFor, headOffice, startBox, storePack, type Box } from '../support/till-bill-world';

/**
 * **A22 (OB-326, built switched OFF) — the B2C dynamic QR from store setup to the printed bill, on the in-memory store AND
 * real PostgreSQL, head office and the store computer each restarted COLD, the till offline.**
 *
 *   OFF (the default): the store pack carries no QR, the served till is told nothing, the bill has no QR;
 *   the owner switches it on with only the UPI ID → the pack carries the switch and that detail → the served till prints no
 *     QR and says the bank account and IFSC are not set;
 *   the owner gives the bank account and IFSC (a bad IFSC is refused 422 by name; a cashier is refused 403) → after a cold
 *     restart of head office the pack carries all three → the store computer keeps it across ITS cold restart → the till,
 *     with no head office anywhere, prints the QR on the tax invoice.
 * Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'S1';
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601'] };
const boxes: Box[] = [];
afterEach(async () => { for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); } });

const CAT = {
  tenantId: 't', version: 1, builtAt: new Date().toISOString(),
  products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active' as const, hsnCode: '071360' }],
  barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' as const }],
};

describe.each(backings)('A22 — the B2C dynamic QR goes from store setup to the bill — on $name', (backing) => {
  it('off by default; on with a detail missing says "not set"; on with all three prints the QR offline, across cold restarts', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }, { userId: 'u-lanecash', role: 'cashier' }]);
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE' });
    await ho.ok('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 });
    const set = (key: string, value: unknown, by = 'u-owner') => ho.call('PUT', `/v1/platform/setup/invoice.b2c_dynamic_qr.${key}`, by, { value });
    const policies = async (): Promise<Record<string, unknown>> => {
      const r = await ho.call('GET', `/v1/store-packs/${STORE}`, 'u-box', undefined, undefined, STORE);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return (r.body as { sections: { policies: Record<string, unknown> } }).sections.policies;
    };

    // The setup page lists the switch OFF and each detail not set.
    const status = await ho.ok('GET', '/v1/platform/setup', 'u-owner') as { items: { key: string; value: unknown; isDefault: boolean }[] };
    expect(status.items.filter((i) => i.key.startsWith('invoice.b2c_dynamic_qr.')).map((i) => [i.key, i.value, i.isDefault])).toEqual([
      ['invoice.b2c_dynamic_qr.on', false, true], ['invoice.b2c_dynamic_qr.upi_id', '', true],
      ['invoice.b2c_dynamic_qr.bank_account', '', true], ['invoice.b2c_dynamic_qr.ifsc', '', true],
    ]);
    expect((await policies())['b2cDynamicQr']).toBeUndefined();

    /** A store computer holding this pack serves the till its lane; the till rings one bill offline and makes its invoice. */
    const ringOn = async (box: Box) => {
      const html = await (await fetch(`http://127.0.0.1:${box.edge.screens!.port}/pos/`)).text();
      const lane = JSON.parse(/<script>window\.posLane = ([\s\S]*?);<\/script>/.exec(html)![1]!) as Record<string, unknown>;
      const till = bootPos({
        laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: { ...CAT, tenantId: ho.tenantId }, realTrading: true, taxInvoice: SHOP,
        ...(lane['b2cDynamicQr'] === undefined ? {} : { b2cDynamicQr: lane['b2cDynamicQr'] as never }),
      });
      await signInTill(till, 'u-lanecash');
      till.scanBarcode('8901234567890');
      const n = await till.nextReceipt();
      await till.tenderCash(`S-${n}`, n, new Date().toISOString());
      const inv = till.taxInvoice();
      if (!inv.ok) throw new Error(inv.why);
      return { lane, inv };
    };
    const boxWith = async (served: Record<string, unknown>): Promise<Box> => {
      const pack = storePack(STORE, served['b2cDynamicQr'] === undefined ? {} : { b2cDynamicQr: served['b2cDynamicQr'] });
      const box = await startBox({ tenantId: ho.tenantId, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }], pack, env: { EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps' } });
      boxes.push(box);
      return box;
    };

    // OFF: nothing told, nothing printed.
    const off = await ringOn(await boxWith(await policies()));
    expect(off.lane).not.toHaveProperty('b2cDynamicQr');
    expect(off.inv.rows.some((r) => r.kind === 'qr')).toBe(false);

    // ON with only the UPI ID: the pack says so; the till prints no QR and names what is not set.
    expect((await set('on', true)).status).toBe(200);
    expect((await set('upi_id', 'srehyper@okaxis')).status).toBe(200);
    const half = await policies();
    expect(half['b2cDynamicQr']).toEqual({ on: true, upiId: 'srehyper@okaxis' });
    const partly = await ringOn(await boxWith(half));
    expect(partly.inv.rows.some((r) => r.kind === 'qr')).toBe(false);
    expect(partly.inv.qrNotSet).toEqual(['bank_account', 'ifsc']);

    // The rest; a bad IFSC is refused by name, a cashier is refused.
    expect(await set('ifsc', 'HDFC1234')).toMatchObject({ status: 422, body: { error: { code: 'setup_answer_refused' } } });
    expect((await set('ifsc', 'HDFC0001234', 'u-lanecash')).status).toBe(403);
    expect((await set('bank_account', '123456789012')).status).toBe(200);
    expect((await set('ifsc', 'hdfc0001234')).status).toBe(200);
    ho.restartCold(); // ── head office COLD ─────────────────────────────────────────────────────────────────────────────
    const full = await policies();
    expect(full['b2cDynamicQr']).toEqual({ on: true, upiId: 'srehyper@okaxis', bankAccountNo: '123456789012', ifsc: 'HDFC0001234' });

    const box = await boxWith(full);
    await box.restartCold(); // ── the store computer COLD, no head office anywhere ───────────────────────────────────────
    const printed = await ringOn(box);
    const qr = printed.inv.rows.find((r) => r.kind === 'qr');
    expect(qr?.qr?.payload).toContain('pa=srehyper%40okaxis');
    expect(qr?.qr?.payload).toContain(`invoiceNo=${encodeURIComponent(printed.inv.number)}`);
    expect(qr?.qr?.payload).toContain('ifsc=HDFC0001234');
    expect(printed.inv.qrNotSet).toBeUndefined();

    // Switched off again: gone from the pack.
    expect((await set('on', false)).status).toBe(200);
    expect((await policies())['b2cDynamicQr']).toBeUndefined();
  }, 90_000);
});
