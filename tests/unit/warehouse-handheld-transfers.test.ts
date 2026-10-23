import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  WarehouseSession, TRANSFER_DISPATCH_RECORDED, TRANSFER_RECEIPT_RECORDED, SENT_WORK_KINDS, FEEDBACK_CODES,
  transferDispatchKey, transferReceiptKey, type WarehouseAssignment, type HeldTransfers,
} from '../../apps/warehouse-app/src/warehouse-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import { personNamedBy } from '../../edge/store-edge/src/handheld-sign-in';

/**
 * **The warehouse handheld SENDS and COUNTS IN transfers with the line down (OB-288 lane 2 · P2 · WF-07 · M09-FR-03 · §31).**
 *
 * The box served the transfers head office says this store sends and counts in (pulled from head office, with when). A
 * send is one tap and confirm; a count-in is one count per line the transfer carries (0 is a real count). Each is saved
 * ONCE on the durable device queue in the signed-in worker's name, timed when it was done, and carries nothing of head
 * office's own (lines, stock, cost) on a send; the count-in carries only what was counted. Refusals queue nothing and say
 * why; the sent-work list says where each has got to; the box takes them (relayable, the person field) and they reach the
 * synced routes. English and Tamil for every new word.
 */

const AT = '2026-10-23T09:00:00.000Z';
const TRANSFERS: HeldTransfers = {
  asAt: '2026-10-23T08:40:00.000Z', ageMinutes: 20, storeId: 'S1',
  toSend: [{ transferId: 't-out', state: 'approved', fromLocationId: 'S1-BACK', toLocationId: 'S2', requestedBy: 'u-owner', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 10, uom: 'EA' }] }],
  toCountIn: [{
    transferId: 't-in', state: 'in_transit', fromLocationId: 'WH', toLocationId: 'S1', requestedBy: 'u-owner',
    lines: [{ productId: 'RICE', batchId: null, quantityMinor: 10, uom: 'EA' }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 4, uom: 'EA' }],
  }],
};
const ASSIGNMENT: WarehouseAssignment = { assignmentId: 'A-1', workerId: 'u-back', storeId: 'S1', bins: [], transfers: TRANSFERS };
const session = (over: Partial<WarehouseAssignment> = {}, outbox = new SyncOutbox()) => ({ outbox, s: new WarehouseSession({ ...ASSIGNMENT, ...over }, outbox, { now: () => AT }) });

describe('the warehouse handheld sends and counts in transfers offline', () => {
  it('lists what head office said this store sends and counts in, and says when it never heard', () => {
    const { s } = session();
    expect(s.transferWork()).toMatchObject({ known: true, asAt: TRANSFERS.asAt, ageMinutes: 20, toSend: [{ transferId: 't-out', doneHere: false }], toCountIn: [{ transferId: 't-in', doneHere: false }] });
    expect(session({ transfers: null }).s.transferWork()).toEqual({ known: false, toSend: [], toCountIn: [] });
    expect(session({ transfers: undefined }).s.transferWork().known).toBe(false);
  });

  it('a send is saved once in the worker\'s name, with nothing of head office\'s own on it', () => {
    const { outbox, s } = session();
    const out = s.sendTransfer({ transferId: 't-out', at: AT });
    expect(out).toMatchObject({ accepted: true, signal: { feedback: 'accept', code: 'transfer_sent' } });
    expect(outbox.all().map((i) => i.key)).toEqual([transferDispatchKey('t-out')]);
    const ev = outbox.all()[0]!.event;
    expect(ev).toMatchObject({ type: TRANSFER_DISPATCH_RECORDED, idempotencyKey: 'transfer-dispatch:t-out', occurredAt: AT });
    expect(ev.payload).toEqual({ transferId: 't-out', storeId: 'S1', dispatchedBy: 'u-back', at: AT, source: 'warehouse-handheld' });
    // A second tap changes nothing; a transfer this store does not send is refused; nothing more is queued.
    expect(s.sendTransfer({ transferId: 't-out', at: AT }).signal).toMatchObject({ feedback: 'warn', code: 'transfer_already_done' });
    expect(s.sendTransfer({ transferId: 't-in', at: AT }).signal.code).toBe('not_a_transfer_here');
    expect(outbox.all()).toHaveLength(1);
    expect(s.transferWork().toSend[0]!.doneHere).toBe(true);
  });

  it('a count-in needs every line counted (0 is a count), is saved once, and a short count is said', () => {
    const { outbox, s } = session();
    expect(s.countInTransfer({ transferId: 't-in', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }], at: AT }).signal.code).toBe('count_incomplete');
    expect(s.countInTransfer({ transferId: 't-in', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 1.5 }], at: AT }).signal.code).toBe('not_a_quantity');
    expect(s.countInTransfer({ transferId: 't-in', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 4 }, { productId: 'SUGAR', batchId: null, quantityMinor: 1 }], at: AT }).signal.code).toBe('count_incomplete');
    expect(s.countInTransfer({ transferId: 't-out', counted: [], at: AT }).signal.code).toBe('not_a_transfer_here');
    expect(outbox.all()).toHaveLength(0);
    const out = s.countInTransfer({ transferId: 't-in', counted: [{ productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 0 }, { productId: 'RICE', batchId: null, quantityMinor: 8 }], at: AT });
    expect(out.signal).toMatchObject({ feedback: 'warn', code: 'transfer_counted_in' });
    expect(out.signal.detail).toContain('6 fewer than were sent');
    expect(outbox.all().map((i) => i.key)).toEqual([transferReceiptKey('t-in')]);
    expect(outbox.all()[0]!.event).toMatchObject({
      type: TRANSFER_RECEIPT_RECORDED,
      payload: { transferId: 't-in', storeId: 'S1', receivedBy: 'u-back', at: AT, source: 'warehouse-handheld', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 8 }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 0 }] },
    });
    expect(s.countInTransfer({ transferId: 't-in', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 4 }], at: AT }).signal.code).toBe('transfer_already_done');
    expect(outbox.all()).toHaveLength(1);
  });

  it('survives the handheld being closed: the same queue on reopen shows both done and lists them with the box\'s word', () => {
    const { outbox, s } = session();
    s.sendTransfer({ transferId: 't-out', at: AT });
    s.countInTransfer({ transferId: 't-in', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 4 }], at: AT });
    const reopened = session({}, outbox).s;
    expect(reopened.transferWork().toSend[0]!.doneHere).toBe(true);
    expect(reopened.transferWork().toCountIn[0]!.doneHere).toBe(true);
    expect(reopened.sendTransfer({ transferId: 't-out', at: AT }).signal.code).toBe('transfer_already_done');
    outbox.acknowledge(transferDispatchKey('t-out'));
    expect(reopened.handedKeys()).toEqual([transferDispatchKey('t-out')]);
    reopened.noteBoxStatus([{ key: transferDispatchKey('t-out'), state: 'refused', attempts: 1, reason: 'transfer_cancelled: cancelled before it left' }]);
    const sent = reopened.sentWork();
    expect(sent.map((w) => [w.kind, w.id, w.state])).toEqual([['transfer_in', 't-in', 'saved_here'], ['transfer_out', 't-out', 'refused']]);
    expect(sent[1]!.reason).toContain('transfer_cancelled');
    expect(sent[1]!.detail).toBe('→ S2 · 1');
  });

  it('the box takes them from the handheld, by the person they name, to the synced routes', () => {
    const { outbox, s } = session();
    s.sendTransfer({ transferId: 't-out', at: AT });
    s.countInTransfer({ transferId: 't-in', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 4 }], at: AT });
    const [send, count] = outbox.all().map((i) => i.event);
    expect(isRelayable(send!.type, 'warehouse')).toBe(true);
    expect(isRelayable(count!.type, 'warehouse')).toBe(true);
    expect(personNamedBy(send!)).toEqual({ ok: true, userId: 'u-back' });
    expect(personNamedBy(count!)).toEqual({ ok: true, userId: 'u-back' });
    expect(pathFor(send!)).toBe('/v1/warehouse/transfers/t-out/dispatch/synced');
    expect(pathFor(count!)).toBe('/v1/warehouse/transfers/t-in/receive/synced');
  });

  it('has a word in English and Tamil for every new outcome and kind', () => {
    for (const code of ['transfer_sent', 'transfer_counted_in', 'not_a_transfer_here', 'transfer_already_done', 'count_incomplete']) expect(FEEDBACK_CODES).toContain(code);
    expect(SENT_WORK_KINDS).toEqual(expect.arrayContaining(['transfer_out', 'transfer_in']));
    const view = readFileSync('apps/warehouse-app/web/app.js', 'utf8');
    const ta = view.slice(view.indexOf('  ta: {'));
    for (const key of ['toSendHeading', 'toCountInHeading', 'transfersAsOf', 'confirmSend', 'countInLine', 'transferDoneHere']) expect(ta).toMatch(new RegExp(`\\b${key}: '[^']*[\\u0B80-\\u0BFF]`));
  });
});
