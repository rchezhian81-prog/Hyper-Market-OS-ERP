import { describe, it, expect } from 'vitest';
import { createTransfersSession, rowView, TRANSFER_WORD_KEYS, text, type TransferRow } from '../../apps/web-erp/src/transfers-session';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';

/**
 * The Transfers page's session model (WF-07 · M09-FR-03): dispatch sends an EMPTY body (the sender is the approver and the
 * stock and its cost are head office's), a receipt sends only what was counted, a shortfall settlement says what turned up
 * and where. No cost is ever sent. The connected proof is tests/e2e/transfers-on-the-production-api.e2e.ts.
 */

function fakeHttp(answer: HttpAnswer = { result: 'ok', status: 200, body: {} }) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const http: HeadOfficeHttp = {
    get: async (path) => { sent.push({ method: 'GET', path }); return answer; },
    post: async (path, body) => { sent.push({ method: 'POST', path, body }); return answer; },
  };
  return { http, sent };
}
const MGR = { userId: 'u-mgr', permissions: ['inventory.availability.read', 'inventory.movement.append', 'inventory.adjustment.approve'] };
const T = { transferId: 't1', fromLocationId: 'br-1-back', toLocationId: 'br-1', requestedBy: 'u-prop', state: 'in_transit', approvedBy: 'u-send',
  lines: [{ productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 1_000 } }, { productId: 'P2', batchId: 'B7', quantityMinor: 4, uom: 'EA', unitCost: { minor: 0 } }],
  lineCostsMinor: [1_000, null] };

describe('the transfers session', () => {
  it('dispatch sends an empty body; a receipt sends only the counted quantities, refusing anything that is not a whole number before any POST', async () => {
    const { http, sent } = fakeHttp();
    const s = createTransfersSession(MGR, http);
    await s.dispatch('t1');
    expect(await s.receive(T, ['8', ''])).toEqual({ result: 'invalid', key: 'needCounts' });
    expect(await s.receive(T, ['8', '1.5'])).toEqual({ result: 'invalid', key: 'needCounts' });
    await s.receive(T, ['8', ' 4 ']);
    expect(sent).toEqual([
      { method: 'POST', path: '/v1/warehouse/transfers/t1/dispatch', body: {} },
      { method: 'POST', path: '/v1/warehouse/transfers/t1/receive', body: { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }, { productId: 'P2', batchId: 'B7', quantityMinor: 4 }] } },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/unitCost|approvedBy|available/);
  });

  it('a settlement names what turned up and where (the sending place by its id), never a value; a note of a few words is needed', async () => {
    const { http, sent } = fakeHttp({ result: 'ok', status: 201, body: {} });
    const s = createTransfersSession(MGR, http);
    const row: TransferRow = { transfer: { ...T, state: 'received', receivedBy: 'u-recv' }, shortfall: [{ productId: 'P1', batchId: null, quantityMinor: 2, valueMinor: 2_000 }, { productId: 'P2', batchId: 'B7', quantityMinor: 1, valueMinor: 0 }], shortfallOpen: true, forIndent: false };
    expect(await s.resolve(row, { reasonCode: 'miscount', note: 'ok', found: [] })).toEqual({ result: 'invalid', key: 'needResolution' });
    expect(await s.resolve(row, { reasonCode: 'lost_it', note: 'searched', found: [] })).toEqual({ result: 'invalid', key: 'needResolution' });
    expect(await s.resolve(row, { reasonCode: 'miscount', note: 'searched', found: [{ text: 'x', at: 'destination' }] })).toEqual({ result: 'invalid', key: 'needResolution' });
    await s.resolve(row, { reasonCode: 'theft_suspected', note: ' searched the van ', found: [{ text: '1', at: 'source' }, { text: '', at: 'destination' }] });
    expect(sent).toEqual([{ method: 'POST', path: '/v1/warehouse/transfers/t1/shortfall/resolution', body: { reasonCode: 'theft_suspected', note: 'searched the van', lines: [{ productId: 'P1', batchId: null, foundMinor: 1, foundAtLocationId: 'br-1-back' }] } }]);
  });

  it('shows head office\'s own cost per line (an unvalued line says so, never ₹0.00), the open shortfall as an exception, and what may be done', () => {
    const v = rowView('en', { transfer: { ...T, state: 'received', receivedBy: 'u-recv' }, shortfall: [{ productId: 'P1', batchId: null, quantityMinor: 2, valueMinor: 2_000 }], shortfallOpen: true, forIndent: false });
    expect(v.lines.map((l) => l.cost)).toEqual(['₹10.00', null]);
    expect(v).toMatchObject({ stateWord: 'Received', flags: ['Shortfall open'], tone: 'error', canDispatch: false, canReceive: false, canResolve: true });
    expect(v.shortfall[0]!.worth).toBe('₹20.00');
    expect(v.people).toEqual(['proposed by u-prop', 'sent and approved by u-send', 'counted in by u-recv']);
    const proposed = rowView('en', { transfer: { ...T, state: 'proposed', approvedBy: undefined, lineCostsMinor: undefined } as never, shortfall: [], shortfallOpen: false, forIndent: false });
    expect(proposed.lines.map((l) => l.cost)).toEqual(['₹10.00', null]);
    expect(proposed.canDispatch).toBe(true);
    const indent = rowView('en', { transfer: { ...T, state: 'received' }, shortfall: [{ productId: 'P1', batchId: null, quantityMinor: 1, valueMinor: 1_000 }], shortfallOpen: true, forIndent: true });
    expect(indent).toMatchObject({ canResolve: false, flags: ['Floor indent — settled on the indent'] });
  });

  it('a refusal is head office\'s words; a nobody reads and sends nothing; a role without the movement right is offered no act', async () => {
    const s = createTransfersSession(MGR, fakeHttp({ result: 'refused', status: 422, code: 'dispatcher_cannot_receive', whatHappened: 'u-mgr dispatched transfer t1 and cannot also count it in at br-1 (§28).' }).http);
    expect(s.say('en', await s.receive(T, ['10', '4'])).words).toBe('Head office refused: u-mgr dispatched transfer t1 and cannot also count it in at br-1 (§28).');
    const { http, sent } = fakeHttp();
    const nobody = createTransfersSession(undefined, http);
    expect(await nobody.list()).toEqual({ result: 'invalid', key: 'nobody' });
    expect(await nobody.dispatch('t1')).toEqual({ result: 'invalid', key: 'nobody' });
    expect(sent).toEqual([]);
    expect(createTransfersSession({ userId: 'u-x', permissions: ['inventory.availability.read'] }, http).may).toEqual({ read: true, move: false, resolve: false });
  });

  it('WF-07: a transfer is cancelled only before it leaves, with a reason a person can read; the cancelled one says so and who did it', async () => {
    const { http, sent } = fakeHttp();
    const s = createTransfersSession(MGR, http);
    expect(await s.cancel('t1', '  no ')).toEqual({ result: 'invalid', key: 'needCancelReason' });
    expect(sent).toEqual([]);
    await s.cancel('t1', ' store 2 no longer needs it ');
    expect(sent).toEqual([{ method: 'POST', path: '/v1/warehouse/transfers/t1/cancel', body: { reason: 'store 2 no longer needs it' } }]);
    const row = (state: string, forIndent = false, extra: Record<string, unknown> = {}): TransferRow => ({ transfer: { ...T, state, approvedBy: undefined, ...extra } as never, shortfall: [], shortfallOpen: false, forIndent });
    expect(rowView('en', row('proposed')).canCancel).toBe(true);
    expect(rowView('en', row('proposed', true)).canCancel).toBe(false); // a floor-indent transfer is withdrawn on its indent
    for (const state of ['in_transit', 'received', 'cancelled']) expect(rowView('en', row(state)).canCancel, state).toBe(false);
    const gone = rowView('ta', row('cancelled', false, { cancelledBy: 'u-mgr', cancelReason: 'not needed' }));
    expect(gone).toMatchObject({ stateWord: text('ta', 'cancelled'), canDispatch: false, canReceive: false, tone: 'idle' });
    expect(gone.people).toContain(`${text('ta', 'cancelledBy')} u-mgr — "not needed"`);
  });

  it('has a Tamil word for every English one', () => {
    for (const k of TRANSFER_WORD_KEYS) expect(text('ta', k), k).not.toBe(text('en', k));
  });
});
