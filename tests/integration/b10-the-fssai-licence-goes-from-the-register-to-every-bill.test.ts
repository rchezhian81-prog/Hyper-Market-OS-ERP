import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { signInTill } from '../support/till-operator';
import { backingsFor, headOffice, startBox, storePack, type Box } from '../support/till-bill-world';

/**
 * **B10 (FSSAI — the licence number on every bill): from head office's compliance register to the printed bill, on the
 * in-memory store AND real PostgreSQL, head office and the store computer each restarted COLD, the till offline.**
 *
 *   the owner registers the store's FSSAI licence (authority FSSAI, its number as the reference, its dates) → head office
 *   says it (GET /v1/compliance/fssai-licence; a cashier is refused 403, a request with no store 400) → the store pack
 *   carries it in `policies.fssaiLicence` → the store computer keeps it across a cold restart → the till, with no head
 *   office anywhere, prints "FSSAI Lic. No. …" on the bill; a licence that has run out is not sent and not printed.
 * Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'S1';
const LICENCE = '12419999000123';
const boxes: Box[] = [];
afterEach(async () => { for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); } });

const CAT = {
  tenantId: 't', version: 1, builtAt: new Date().toISOString(),
  products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active' as const }],
  barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' as const }],
};

describe.each(backings)('B10 — the FSSAI licence goes from the register to every bill — on $name', (backing) => {
  it('registered → said → in the store pack → kept by the box across a cold restart → printed on the bill offline; an expired one is not', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }, { userId: 'u-lanecash', role: 'cashier' }]);
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE' });
    await ho.ok('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 });
    const register = (id: string, body: Record<string, unknown>) => ho.ok('POST', `/v1/compliance/obligations/${id}`, 'u-owner', {
      kind: 'licence', name: 'FSSAI State Licence', authority: 'FSSAI', branchId: STORE, responsible: { userId: 'u-owner', name: 'Owner' }, ...body,
    });
    const said = async () => ho.ok('GET', '/v1/compliance/fssai-licence', 'u-owner', undefined, { storeId: STORE }) as Promise<{ licence: { number: string; validUntil?: string } | null; said: string }>;
    const policies = async () => {
      const r = await ho.call('GET', `/v1/store-packs/${STORE}`, 'u-box', undefined, undefined, STORE);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return (r.body as { sections: { policies: Record<string, unknown> } }).sections.policies;
    };

    // Only an expired licence on the register: nothing is said, nothing goes in the pack.
    await register('fssai-2020', { reference: '10019999000001', validFrom: '2015-04-01', expiresOn: '2020-03-31' });
    expect(await said()).toMatchObject({ licence: null, said: expect.stringMatching(/bills print no licence number/) });
    expect((await policies())['fssaiLicence']).toBeUndefined();

    // The current one.
    await register('fssai-2025', { reference: LICENCE, validFrom: '2025-01-01', expiresOn: '2099-12-31' });
    ho.restartCold(); // ── head office COLD ─────────────────────────────────────────────────────────────────────────────
    expect(await said()).toMatchObject({ licence: { number: LICENCE, validUntil: '2099-12-31' }, said: `FSSAI Lic. No. ${LICENCE}, valid until 2099-12-31.` });
    expect((await ho.call('GET', '/v1/compliance/fssai-licence', 'u-lanecash', undefined, { storeId: STORE })).status).toBe(403);
    expect((await ho.call('GET', '/v1/compliance/fssai-licence', 'u-owner')).status).toBe(400);
    const served = await policies();
    expect(served['fssaiLicence']).toEqual({ number: LICENCE, validUntil: '2099-12-31' });

    // The store computer holds the pack; NO head office reachable from here on.
    const pack = { ...storePack(STORE), policies: { ...storePack(STORE)['policies'] as Record<string, unknown>, fssaiLicence: served['fssaiLicence'] } };
    const box = await startBox({ tenantId: ho.tenantId, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }], pack });
    boxes.push(box);
    const parsed = readPack(pack, new Date().toISOString()).policies;
    expect(parsed.known && parsed.value.fssaiLicence).toEqual({ number: LICENCE, validUntil: '2099-12-31' });

    const ring = async (): Promise<string> => {
      const till = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: { ...CAT, tenantId: ho.tenantId }, ...(parsed.known ? { fssaiLicence: parsed.value.fssaiLicence ?? null } : {}) });
      await signInTill(till, 'u-lanecash');
      till.scanBarcode('8901234567890');
      const n = await till.nextReceipt();
      await till.tenderCash(`S-${n}`, n, new Date().toISOString());
      const bill = till.receiptLines();
      if (!bill.ok) throw new Error(bill.why);
      return bill.lines.join('\n');
    };
    expect(await ring()).toContain(`FSSAI Lic. No. ${LICENCE}`);
    await box.restartCold(); // ── the store computer COLD, still offline ──────────────────────────────────────────────────
    expect(await ring()).toContain(`FSSAI Lic. No. ${LICENCE}`);
  }, 90_000);
});
