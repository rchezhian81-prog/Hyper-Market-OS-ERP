import { describe, it, expect } from 'vitest';
import {
  WarehouseSession, FLOOR_INDENT_ISSUED, SENT_WORK_KINDS, FEEDBACK_CODES, type WarehouseAssignment,
} from '../../apps/warehouse-app/src/warehouse-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor } from '../../edge/sync-agent/src/http-transport';

/**
 * **The warehouse handheld ISSUES against a floor indent (SP-8c · F08 · WF-06 · M09-FR-03 · §28 · hard rules #1/#2).**
 *
 * The box served the indents head office says the back store owes (pulled from the register). The worker taps a line, scans
 * the bin they take from (any bin here holding the product — the indent names none), scans the item and confirms. The
 * session checks each scan as it happens, lowers its OWN bin projection through the authoritative movement engine, and
 * queues ONE `FloorIndentIssued` keyed on the command — the fact head office re-judges (requester ≠ issuer, over-issue,
 * over-draw against ITS stock) and posts once, lowering the same bin in the same write. Refusals queue nothing and say why;
 * the requester is refused before any scan (§28); a re-sent command is one issue.
 */

const AT = '2026-10-01T09:00:00.000Z';
const ASSIGNMENT: WarehouseAssignment = {
  assignmentId: 'A-1', workerId: 'u-back', storeId: 'store-1',
  bins: [
    { binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' },
    { binId: 'BIN-B', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' },
    { binId: 'BIN-C', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' },
  ],
  barcodes: [{ barcode: '890RICE', productId: 'RICE', level: 'unit' }, { barcode: '890OIL', productId: 'OIL', level: 'unit' }],
  packs: [{ productId: 'RICE', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }, { productId: 'OIL', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890OIL' }] }],
  // RICE sits in two bins; OIL in one; BIN-C is empty.
  contents: { 'BIN-A|RICE|': 8, 'BIN-B|RICE|': 30, 'BIN-B|OIL|': 4 },
  indentLines: [
    { indentId: 'ind-1', productId: 'RICE', uom: 'EA', outstandingMinor: 20, requestedBy: 'u-floor', toLocationId: 'S1' },
    { indentId: 'ind-1', productId: 'OIL', uom: 'EA', outstandingMinor: 4, requestedBy: 'u-floor', toLocationId: 'S1' },
    { indentId: 'ind-9', productId: 'RICE', uom: 'EA', outstandingMinor: 5, requestedBy: 'u-back', toLocationId: 'S1' }, // this worker's OWN ask
  ],
};
const session = (over: Partial<WarehouseAssignment> = {}) => {
  const outbox = new SyncOutbox();
  return { outbox, s: new WarehouseSession({ ...ASSIGNMENT, ...over }, outbox, { now: () => AT }) };
};

describe('the issue list: what the back store owes, with where the stock is', () => {
  it('lists every owed line in the order the box sent them, with the bins here that hold the product and what is still owed', () => {
    const { s } = session();
    expect(s.indentLines()).toEqual([
      expect.objectContaining({ indentId: 'ind-1', productId: 'RICE', remainingMinor: 20, issuedHereMinor: 0, binIds: ['BIN-A', 'BIN-B'] }),
      expect.objectContaining({ indentId: 'ind-1', productId: 'OIL', remainingMinor: 4, binIds: ['BIN-B'] }),
      expect.objectContaining({ indentId: 'ind-9', productId: 'RICE', remainingMinor: 5, binIds: ['BIN-A', 'BIN-B'] }),
    ]);
    expect(session({ indentLines: undefined }).s.indentLines()).toEqual([]);
  });

  it('the vocabulary is on the shared lists: the sent-work kind and every feedback code the issue can return', () => {
    expect(SENT_WORK_KINDS).toContain('issue');
    for (const code of ['issued', 'not_on_indent', 'indent_line_done', 'requester_cannot_issue', 'bin_has_none']) expect(FEEDBACK_CODES).toContain(code);
  });
});

describe('checking each scan at the racking (commits nothing)', () => {
  it('any bin holding the product will do; a bin holding none, an unknown bin, a wrong item, an unknown line are refused by name', () => {
    const { s, outbox } = session();
    expect(s.checkIssue({ indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-A' })).toMatchObject({ ok: true, batchId: null, inBinMinor: 8 });
    expect(s.checkIssue({ indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-B', scannedItem: '890RICE' })).toMatchObject({ ok: true, inBinMinor: 30 });
    expect(s.checkIssue({ indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-C' })).toMatchObject({ ok: false, signal: expect.objectContaining({ code: 'bin_has_none', feedback: 'reject' }) });
    expect(s.checkIssue({ indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-Z' })).toMatchObject({ ok: false, signal: expect.objectContaining({ code: 'unknown_bin', resolutionRequired: true }) });
    expect(s.checkIssue({ indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-B', scannedItem: '890OIL' })).toMatchObject({ ok: false, signal: expect.objectContaining({ code: 'wrong_item' }) });
    expect(s.checkIssue({ indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-B', scannedItem: 'nonsense' })).toMatchObject({ ok: false, signal: expect.objectContaining({ code: 'unknown_barcode' }) });
    expect(s.checkIssue({ indentId: 'ind-7', productId: 'RICE', scannedBinId: 'BIN-A' })).toMatchObject({ ok: false, signal: expect.objectContaining({ code: 'not_on_indent' }) });
    expect(outbox.all()).toEqual([]);
  });

  it('the requester is refused their own indent before any scan (§28) — and the row is still listed so they can see it is owed', () => {
    const { s, outbox } = session();
    expect(s.checkIssue({ indentId: 'ind-9', productId: 'RICE', scannedBinId: 'BIN-A' })).toMatchObject({ ok: false, signal: expect.objectContaining({ code: 'requester_cannot_issue', feedback: 'reject' }) });
    expect(s.issueToFloor({ commandId: 'c-own', indentId: 'ind-9', productId: 'RICE', scannedBinId: 'BIN-A', scannedItem: '890RICE', at: AT })).toMatchObject({ accepted: false, signal: expect.objectContaining({ code: 'requester_cannot_issue' }) });
    expect(outbox.all()).toEqual([]);
    expect(s.binContents()['BIN-A|RICE|']).toBe(8);
  });
});

describe('issuing: ONE fact queued, the bin lowered here, head office re-judges', () => {
  it('defaults to what is owed capped at what the bin holds; lowers the bin; advances the line; queues one FloorIndentIssued on the shared route', () => {
    const { s, outbox } = session();
    const out = s.issueToFloor({ commandId: 'c-1', indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-A', scannedItem: '890RICE', at: AT });
    expect(out).toMatchObject({ accepted: true, indentId: 'ind-1', productId: 'RICE', binId: 'BIN-A', quantityMinor: 8, signal: expect.objectContaining({ code: 'issued', feedback: 'accept' }) });
    expect(out.signal.detail).toContain('12 still owed');
    expect(s.binContents()['BIN-A|RICE|']).toBe(0);
    expect(s.indentLines()[0]).toMatchObject({ indentId: 'ind-1', productId: 'RICE', remainingMinor: 12, issuedHereMinor: 8, binIds: ['BIN-B'] });
    const [item] = outbox.pending();
    expect(item?.key).toBe('indent-issue:ind-1:c-1');
    expect(item?.event.type).toBe(FLOOR_INDENT_ISSUED);
    expect(item?.event.payload).toEqual({
      indentId: 'ind-1', issueId: 'c-1', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 8, binId: 'BIN-A', uom: 'EA' }],
      issuedBy: 'u-back', at: AT, storeId: 'store-1', source: 'warehouse-handheld',
    });
    // The shared route carries it as the WAREHOUSE surface, to the cloud's synced issue path with both ids filled.
    expect(isRelayable(item!.event.type, 'warehouse')).toBe(true);
    expect(isRelayable(item!.event.type, 'manager')).toBe(false);
    expect(pathFor(item!.event)).toBe('/v1/floor/indents/ind-1/issues/c-1/synced');
    expect(s.sentWork()[0]).toMatchObject({ kind: 'issue', id: 'c-1', what: 'RICE · BIN-A', detail: '8 EA · ind-1', state: 'saved_here' });
  });

  it('a second issue from another bin finishes the line and it leaves the list; more than is owed or more than the bin holds is refused with nothing queued', () => {
    const { s, outbox } = session();
    s.issueToFloor({ commandId: 'c-1', indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-A', scannedItem: '890RICE', at: AT });
    expect(s.issueToFloor({ commandId: 'c-2', indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-B', scannedItem: '890RICE', quantityMinor: 13, at: AT })).toMatchObject({ accepted: false, signal: expect.objectContaining({ code: 'invalid_command' }) });
    expect(s.issueToFloor({ commandId: 'c-3', indentId: 'ind-1', productId: 'OIL', scannedBinId: 'BIN-B', scannedItem: '890OIL', quantityMinor: 5, at: AT })).toMatchObject({ accepted: false, signal: expect.objectContaining({ code: 'invalid_command' }) });
    expect(outbox.all()).toHaveLength(1);
    const done = s.issueToFloor({ commandId: 'c-2', indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-B', scannedItem: '890RICE', at: AT });
    expect(done).toMatchObject({ accepted: true, quantityMinor: 12 });
    expect(done.signal.detail).not.toContain('still owed');
    expect(s.binContents()['BIN-B|RICE|']).toBe(18);
    expect(s.indentLines().map((l) => `${l.indentId}|${l.productId}`)).toEqual(['ind-1|OIL', 'ind-9|RICE']);
    expect(s.checkIssue({ indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-B' })).toMatchObject({ ok: false, signal: expect.objectContaining({ code: 'indent_line_done', feedback: 'warn' }) });
    expect(outbox.all()).toHaveLength(2);
  });

  it('a draw the bin cannot cover is the movement engine\'s own refusal; a repeated command is ignored, not issued twice', () => {
    const { s, outbox } = session();
    expect(s.issueToFloor({ commandId: 'c-x', indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-A', scannedItem: '890RICE', quantityMinor: 9, at: AT })).toMatchObject({ accepted: false, signal: expect.objectContaining({ code: 'insufficient_in_bin' }) });
    expect(s.issueToFloor({ commandId: 'c-1', indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-A', scannedItem: '890RICE', quantityMinor: 5, at: AT }).accepted).toBe(true);
    expect(s.issueToFloor({ commandId: 'c-1', indentId: 'ind-1', productId: 'RICE', scannedBinId: 'BIN-A', scannedItem: '890RICE', quantityMinor: 3, at: AT })).toMatchObject({ accepted: false, signal: expect.objectContaining({ code: 'duplicate_ignored', feedback: 'warn' }) });
    expect(s.binContents()['BIN-A|RICE|']).toBe(3);
    expect(outbox.all()).toHaveLength(1);
  });
});
