import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { assessShiftClose } from '../../packages/till/src/index';
import { verifyDayEvidencePack, type DayEvidencePack } from '../../packages/day-close/src/evidence-pack';
import { signInTill } from '../support/till-operator';
import { auditTrailAdapter } from '../../services/api/src/adapters';
import { sealedDayReopen } from '../support/store-seal';
import { backingsFor, headOffice, linkBoxTo, startBox, storePack, type Box, type Link } from '../support/till-bill-world';

/**
 * **M14-FR-04 — a closed day has an evidence pack (sales, tenders, cash, over/short, exceptions, reopen history), sealed
 * with a hash and exportable for the CA: from bills rung at a real store computer to head office's pack, on the in-memory
 * store AND real PostgreSQL, head office restarted COLD.**
 *
 *   two bills rung offline at the till → synced → the till's shift closes ₹5 short with a reason → the day closes, is
 *   reopened with an approver, and closes again → the owner's pack: both bills, cash taken per tender, the till's expected
 *   / counted / short and its sign-off, the short as an exception (resolved once the owner signs it off), the close,
 *   the reopen and the second close in order, `final: true`; the hash re-derives (and breaks on one changed figure); the
 *   CSV carries it; the export is on the audit trail; a cashier is refused 403; an unknown close is 404; across a cold
 *   restart the same facts give the same hash. Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'S1';
const boxes: Box[] = [];
let link: Link | undefined;
afterEach(async () => { link?.restore(); for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); } });

const CAT = {
  tenantId: 't', version: 1, builtAt: new Date().toISOString(),
  products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active' as const }],
  barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' as const }],
};

describe.each(backings)('M14-FR-04 — a closed day has a sealed evidence pack — on $name', (backing) => {
  it('sales, tenders, cash, over/short, exceptions and reopen history; the hash re-derives; CSV; audited; 403/404; cold restart', async () => {
    const ho = await headOffice(backing, [
      { userId: 'u-box', role: 'store_computer', stores: [STORE] }, { userId: 'u-lanecash', role: 'cashier' },
      { userId: 'u-mgr', role: 'store_manager', stores: [STORE] }, { userId: 'u-acct', role: 'accountant' },
    ]);
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE' });
    await ho.ok('POST', '/v1/org/nodes/wh-1', 'u-owner', { kind: 'warehouse', name: 'Store floor', parentId: STORE, companyId: 'SRE' });

    // Two bills rung at the till with the line cut; then the line returns and they sync.
    link = linkBoxTo(ho, 'u-box', STORE);
    const box = await startBox({ tenantId: ho.tenantId, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }], pack: storePack(STORE), cloud: { boxUser: 'u-box', storeId: STORE } });
    boxes.push(box);
    link.online = false;
    const till = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: { ...CAT, tenantId: ho.tenantId } });
    await signInTill(till, 'u-lanecash');
    const bills: string[] = [];
    for (const scans of [1, 2]) {
      for (let i = 0; i < scans; i += 1) till.scanBarcode('8901234567890');
      const n = await till.nextReceipt();
      await till.tenderCash(`S-${n}`, n, new Date().toISOString());
      bills.push(n);
      till.newSale();
    }
    link.online = true;
    expect(await box.edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const sales = await ho.h.store.readStream(ho.tenantId, 'sales', { type: 'SaleCommitted' });
    const day = (sales[0]?.event.payload as { tradingDay: string }).tradingDay;

    // The till's shift: ₹5 short with a reason; then the day closes, is reopened (approved), and closes again.
    const shift = { openingFloatMinor: 50_000, cashSalesMinor: 31_500, pickupsMinor: 0, cashRefundsMinor: 0, countedCashMinor: 81_000, toleranceMinor: 100, reasonCode: 'counting_error' };
    const decided = assessShiftClose(shift);
    expect(decided.exceptionRaised).toBe(true);
    const { countedCashMinor, ...figures } = shift;
    const shiftClose = await ho.call('POST', '/v1/shifts/SH-1/close/synced', 'u-owner', {
      ...figures, tillId: 'lane-1', laneId: 'lane-1', cashierId: 'u-lanecash', tradingDay: day, storeId: STORE,
      openedAt: `${day}T03:00:00.000Z`, closedAt: `${day}T15:00:00.000Z`, countedMinor: countedCashMinor,
      expectedMinor: decided.expectedMinor, varianceMinor: decided.varianceMinor, exceptionRaised: decided.exceptionRaised,
    });
    expect(shiftClose.status, JSON.stringify(shiftClose.body)).toBe(202);
    const syncClose = (id: string, at: string) => ho.call('POST', `/v1/pos/day-close/${id}/synced`, 'u-mgr', { storeId: STORE, tradingDay: day, closedBy: 'u-mgr', closedAt: at }, undefined, STORE);
    expect((await syncClose('dc-1', `${day}T18:00:00.000Z`)).status).toBe(202);
    const reopen = await ho.call('POST', '/v1/pos/day-close/dc-1/reopen/synced', 'u-mgr', sealedDayReopen(ho.tenantId, 'dc-1', { reopenedBy: 'u-mgr', approvedBy: 'u-owner', reason: 'late supplier credit note' }), undefined, STORE);
    expect(reopen.status).toBe(202);

    type Answer = { pack: DayEvidencePack; verified: boolean; csv: string; fileName: string; said: string };
    const packOf = async (id: string, user = 'u-owner'): Promise<Answer> => {
      const r = await ho.call('GET', `/v1/pos/day-close/${id}/evidence-pack`, user, undefined, undefined, user === 'u-mgr' ? STORE : undefined);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Answer;
    };
    // Reopened and not closed again: produced, NOT final, said.
    const reopened = await packOf('dc-1');
    expect(reopened.pack.final).toBe(false);
    expect(reopened.said).toMatch(/NOT FINAL — The day was reopened .* by u-mgr \(approved by u-owner\)/);

    expect((await syncClose('dc-2', `${day}T19:00:00.000Z`)).status).toBe(202);
    const a = await packOf('dc-2');
    expect(a.verified).toBe(true);
    expect(a.pack).toMatchObject({
      storeId: STORE, storeName: 'SRE Hyper Market', tradingDay: day, final: true, notFinalBecause: null,
      sales: { count: 2, grossMinor: 31_500, byLane: [{ laneId: 'lane-1', count: 2, grossMinor: 31_500 }] },
      refunds: { count: 0, totalMinor: 0 },
      tenders: [{ kind: 'cash', takenMinor: 31_500, refundedMinor: 0, netMinor: 31_500 }],
      cash: { expectedMinor: 81_500, countedMinor: 81_000, overShortMinor: -500, notKnownBecause: null },
      overShort: [{ shiftId: 'SH-1', tillId: 'lane-1', overShortMinor: -500, material: true, signedOffBy: null }],
    });
    expect(a.pack.sales.bills.map((b) => b.receiptNumber)).toEqual(bills);
    expect(a.pack.exceptions.filter((e) => e.source === 'cash')).toEqual([expect.objectContaining({ ref: 'SH-1', kind: 'cash_over_short', resolved: false, amountMinor: -500 })]);
    expect(a.pack.history.map((h) => [h.event, h.dayCloseId, h.by, h.approvedBy])).toEqual([['closed', 'dc-1', 'u-mgr', null], ['reopened', 'dc-1', 'u-mgr', 'u-owner'], ['closed', 'dc-2', 'u-mgr', null]]);
    // The same pack from either close of the day.
    expect((await packOf('dc-1')).pack.contentHash).toBe(a.pack.contentHash);
    // One changed figure breaks the seal.
    expect(verifyDayEvidencePack({ ...a.pack, sales: { ...a.pack.sales, grossMinor: a.pack.sales.grossMinor - 1 } })).toBe(false);
    // The CSV for the CA: the figures in rupees and the seal on its last row.
    expect(a.csv.split('\r\n')).toEqual(expect.arrayContaining(['sales,total,315.00,2 bills', 'cash,over/short,-5.00,', `seal,sha256,,${a.pack.contentHash}`]));
    expect(a.fileName).toBe(`day-evidence-${STORE}-${day}-${a.pack.contentHash.slice(0, 12)}`);

    // The owner signs the short off → the exception is resolved (kept), and the seal moves with the facts.
    expect((await ho.call('POST', '/v1/shifts/SH-1/over-short/review', 'u-owner', { disposition: 'counting_error', note: 'recounted with the manager' })).status).toBeLessThan(300);
    ho.restartCold(); // ── head office COLD ─────────────────────────────────────────────────────────────────────────────
    const b = await packOf('dc-2', 'u-acct');
    expect(b.verified).toBe(true);
    expect(b.pack.exceptions.find((e) => e.ref === 'SH-1')).toMatchObject({ resolved: true });
    expect(b.pack.cash.tills[0]?.signedOffBy).toBe('u-owner');
    expect(b.pack.contentHash).not.toBe(a.pack.contentHash);
    expect((await packOf('dc-2', 'u-mgr')).pack.contentHash).toBe(b.pack.contentHash); // the same facts, the same seal

    // Refused: a cashier (403); an unknown close (404). The exports are on the audit trail with their seals.
    expect((await ho.call('GET', '/v1/pos/day-close/dc-2/evidence-pack', 'u-lanecash')).status).toBe(403);
    expect((await ho.call('GET', '/v1/pos/day-close/dc-404/evidence-pack', 'u-owner')).status).toBe(404);
    const trail = await auditTrailAdapter({ store: ho.h.store }).records(ho.tenantId);
    const exports = trail.filter((t) => t.action === 'day_evidence.export');
    expect(exports.map((t) => t.actorId)).toEqual(['u-owner', 'u-owner', 'u-owner', 'u-acct', 'u-mgr']);
    expect(exports.at(-1)?.after?.contentHash).toBe(b.pack.contentHash);
  }, 90_000);
});
