import { describe, it, expect } from 'vitest';
import { createTransfersSession, TRANSFER_WORD_KEYS, text } from '../../apps/web-erp/src/transfers-session';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';
import { warehousePayload } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';

/**
 * Fix batch 5 (M09 · WF-07 · P-07 · P-08 · §28), DOM-free:
 *  • D-036 — a transfer is STARTED on the Transfers page: proposed in the person's own session with the places, the items and
 *    whole quantities; nothing is priced (head office values it at its own cost) and a second person sends it.
 *  • D-033 — the warehouse handheld is told each open delivery's supplier NAME and when its put-away list was taken.
 * Synthetic data only.
 */

function fakeHttp(answer: HttpAnswer = { result: 'ok', status: 201, body: {} }) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const http: HeadOfficeHttp = {
    get: async (path) => { sent.push({ method: 'GET', path }); return answer; },
    post: async (path, body) => { sent.push({ method: 'POST', path, body }); return answer; },
  };
  return { http, sent };
}
const MOVER = { userId: 'u-wh', permissions: ['inventory.availability.read', 'inventory.movement.append'] };
const READER = { userId: 'u-read', permissions: ['inventory.availability.read'] };

describe('D-036: starting a transfer on the Transfers page', () => {
  it('proposes it with the places, the items and whole quantities — never a cost, never an approver', async () => {
    const { http, sent } = fakeHttp();
    const s = createTransfersSession(MOVER, http);
    const out = await s.propose({ transferId: 'tr-1', fromLocationId: ' wh-1 ', toLocationId: 'store-1', lines: [{ productId: 'p-biscuit', quantityText: ' 24 ', uom: '' }, { productId: 'p-rice', quantityText: '5', uom: 'bag' }] });
    expect(out.result).toBe('ok');
    expect(sent).toEqual([{ method: 'POST', path: '/v1/warehouse/transfers/tr-1', body: {
      fromLocationId: 'wh-1', toLocationId: 'store-1',
      lines: [{ productId: 'p-biscuit', quantityMinor: 24, uom: 'EA' }, { productId: 'p-rice', quantityMinor: 5, uom: 'BAG' }],
    } }]);
    expect(JSON.stringify(sent)).not.toMatch(/cost|approvedBy|price/i);
  });

  it('refuses before any POST: no places, the same place, no item, a quantity that is not a whole number above zero, an item twice', async () => {
    const { http, sent } = fakeHttp();
    const s = createTransfersSession(MOVER, http);
    const line = { productId: 'p-biscuit', quantityText: '24', uom: 'EA' };
    expect(await s.propose({ transferId: 'a', fromLocationId: '', toLocationId: 'store-1', lines: [line] })).toEqual({ result: 'invalid', key: 'needPlaces' });
    expect(await s.propose({ transferId: 'a', fromLocationId: 'wh-1', toLocationId: 'wh-1', lines: [line] })).toEqual({ result: 'invalid', key: 'samePlace' });
    expect(await s.propose({ transferId: 'a', fromLocationId: 'wh-1', toLocationId: 'store-1', lines: [] })).toEqual({ result: 'invalid', key: 'needTransferLine' });
    for (const q of ['0', '2.5', 'x', '']) {
      expect(await s.propose({ transferId: 'a', fromLocationId: 'wh-1', toLocationId: 'store-1', lines: [{ ...line, quantityText: q }] })).toEqual({ result: 'invalid', key: 'needTransferLine' });
    }
    expect(await s.propose({ transferId: 'a', fromLocationId: 'wh-1', toLocationId: 'store-1', lines: [line, line] })).toEqual({ result: 'invalid', key: 'twiceOnTransfer' });
    expect(sent).toEqual([]);
  });

  it('a person who may not move stock is told so and nothing is sent', async () => {
    const { http, sent } = fakeHttp();
    const s = createTransfersSession(READER, http);
    expect(s.may.move).toBe(false);
    expect(await s.propose({ transferId: 'a', fromLocationId: 'wh-1', toLocationId: 'store-1', lines: [{ productId: 'p', quantityText: '1', uom: 'EA' }] })).toEqual({ result: 'invalid', key: 'mayNotStart' });
    expect(sent).toEqual([]);
  });

  it('a refusal from head office (e.g. an unknown place) is said in the person\'s words', async () => {
    const { http } = fakeHttp({ result: 'refused', status: 422, body: { code: 'unknown_location', whatHappened: 'Head office does not know the place store-9.' } } as unknown as HttpAnswer);
    const s = createTransfersSession(MOVER, http);
    const out = await s.propose({ transferId: 'a', fromLocationId: 'wh-1', toLocationId: 'store-9', lines: [{ productId: 'p', quantityText: '1', uom: 'EA' }] });
    expect(s.say('en', out).tone).toBe('err');
  });

  it('every new word is said in English and Tamil', () => {
    for (const k of ['startTransfer', 'startTransferNote', 'lFromPlace', 'lToPlace', 'lItem', 'lHowMany', 'lUnit', 'addLine', 'removeLine', 'proposeTransfer', 'proposed_ok', 'needPlaces', 'samePlace', 'needTransferLine', 'twiceOnTransfer', 'mayNotStart']) {
      expect(TRANSFER_WORD_KEYS).toContain(k);
      expect(text('ta', k)).not.toBe(text('en', k));
    }
  });
});

describe('D-033: the warehouse handheld is told the supplier\'s name and how old its put-away list is', () => {
  const AT = '2026-11-16T10:00:00.000Z';
  const pack = (supplierName?: string) => readPack({
    version: 1,
    warehouse: {
      assignmentId: 'warehouse-store-1', workerId: 'u-wh', storeId: 'store-1', bins: [],
      goodsIn: [{ productId: 'p-biscuit', batchId: null, quantityMinor: 125, uom: 'EA' }],
      openDeliveries: [{ poId: 'po-1', number: 'PO-0001', supplierId: 'sup-1', ...(supplierName === undefined ? {} : { supplierName }), deliverToLocationId: 'store-1', grnId: 'grn-po-1-1', ordered: [{ productId: 'p-biscuit', quantityMinor: 40, unitCostMinor: 2_000, currency: 'INR' }] }],
    },
  }, AT);

  it('carries the supplier name with each open delivery, and the time the box took the list', () => {
    const data = warehousePayload({ pack: pack('Demo Foods Pvt Ltd'), now: AT } as never)!;
    expect((data['openDeliveries'] as { supplierName?: string }[])[0]!.supplierName).toBe('Demo Foods Pvt Ltd');
    expect(data['goodsInAsAt']).toBe(AT);
  });

  it('a delivery whose supplier has no name on record carries none (the handheld then shows the code, never a blank)', () => {
    const data = warehousePayload({ pack: pack(), now: AT } as never)!;
    expect((data['openDeliveries'] as Record<string, unknown>[])[0]!).not.toHaveProperty('supplierName');
  });
});
