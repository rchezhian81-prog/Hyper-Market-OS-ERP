import { describe, it, expect } from 'vitest';
import { reconcileDsd, signDeliveryNote, DsdRefusedError, heldNeedsSecondPerson, type DsdHandBack } from '../../packages/receiving/src/dsd-checkin';
import { DsdDoorSession, DSD_CHECK_IN_CLOSED } from '../../apps/warehouse-app/src/dsd-door';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/** D-11 (R3, OB-141 "A"): the door check-in rule, and the handheld session that runs it offline. */
const AT = '2030-06-01T08:00:00.000Z';
const scan = (scanId: string, productId: string, q: number) => ({ scanId, productId, quantityMinor: q, at: AT });
const back = (handBackId: string, productId: string, q: number, reason: DsdHandBack['reason'] = 'damaged'): DsdHandBack => ({ handBackId, productId, quantityMinor: q, reason, note: null, at: AT });
const expected = [{ productId: 'milk', expectedMinor: 20, unitCostMinor: 2_500 }, { productId: 'curd', expectedMinor: 10, unitCostMinor: 3_000 }];

describe('D-11 door check-in rule', () => {
  it('every scan difference is a discrepancy line: short, over and not expected', () => {
    const r = reconcileDsd({ against: 'po', expected, scans: [scan('a', 'milk', 22), scan('b', 'curd', 7), scan('c', 'butter', 2)], handBacks: [] });
    expect(r.discrepancies).toEqual([
      { productId: 'butter', kind: 'not_expected', expectedMinor: 0, scannedMinor: 2, differenceMinor: 2 },
      { productId: 'curd', kind: 'short', expectedMinor: 10, scannedMinor: 7, differenceMinor: -3 },
      { productId: 'milk', kind: 'over', expectedMinor: 20, scannedMinor: 22, differenceMinor: 2 },
    ]);
    // within the order is received; beyond it (and anything not ordered) is held for a second person
    expect(r.lines.find((l) => l.productId === 'milk')).toMatchObject({ keptMinor: 22, receivableMinor: 20, heldMinor: 2 });
    expect(r.lines.find((l) => l.productId === 'butter')).toMatchObject({ keptMinor: 2, receivableMinor: 0, heldMinor: 2, unitCostMinor: null });
    expect(r.heldValueMinor).toBeNull(); // butter has no known cost — said, never zero
  });

  it('a hand-back is kept apart from the scan difference and valued for the debit note', () => {
    const r = reconcileDsd({ against: 'po', expected, scans: [scan('a', 'milk', 20), scan('b', 'curd', 10)], handBacks: [back('h1', 'milk', 3)] });
    expect(r.discrepancies).toEqual([]);
    expect(r.lines.find((l) => l.productId === 'milk')).toMatchObject({ scannedMinor: 20, handedBackMinor: 3, keptMinor: 17, receivableMinor: 17, heldMinor: 0 });
    expect(r.handedBackValueMinor).toBe(7_500);
  });

  it('nothing can be handed back that did not come off the van; a reason is required', () => {
    expect(() => reconcileDsd({ against: 'po', expected, scans: [scan('a', 'milk', 2)], handBacks: [back('h1', 'milk', 3)] })).toThrow(/hand_back_more_than_scanned|only 2 scanned/);
    expect(() => reconcileDsd({ against: 'po', expected, scans: [scan('a', 'milk', 2)], handBacks: [{ ...back('h1', 'milk', 1), reason: 'because' as never }] })).toThrow(DsdRefusedError);
  });

  it('a route sheet carries no purchase order: everything kept is held for a second person (the DSD cap)', () => {
    const r = reconcileDsd({ against: 'route', expected, scans: [scan('a', 'milk', 20)], handBacks: [] });
    expect(r.lines.find((l) => l.productId === 'milk')).toMatchObject({ receivableMinor: 0, heldMinor: 20 });
    expect(heldNeedsSecondPerson(r.heldValueMinor)).toBe(true);
    expect(heldNeedsSecondPerson(0)).toBe(false);
  });

  it('the delivery cannot close without a signed note, and refuses any cash at the door (OB-141)', () => {
    const r = reconcileDsd({ against: 'po', expected, scans: [scan('a', 'milk', 20)], handBacks: [back('h1', 'milk', 1)] });
    const attempt = (body: Record<string, unknown>) => () => signDeliveryNote({ body, reconciliation: r, receiverId: 'u-recv', at: AT });
    expect(attempt({})).toThrow(expect.objectContaining({ code: 'delivery_note_not_signed' }));
    expect(attempt({ deliveryNote: { noteRef: 'DN-1' } })).toThrow(expect.objectContaining({ code: 'delivery_note_not_signed' }));
    for (const cash of [{ cashMinor: 500 }, { tender: 'cash' }, { payment: { amountMinor: 1 } }, { settlement: 'cash' }, { deliveryNote: { noteRef: 'N', driverSignedName: 'Ravi', cashMinor: 5 } }]) {
      expect(attempt({ deliveryNote: { noteRef: 'N', driverSignedName: 'Ravi' }, ...cash }), JSON.stringify(cash)).toThrow(expect.objectContaining({ code: 'no_cash_at_the_door' }));
    }
    const note = signDeliveryNote({ body: { deliveryNote: { noteRef: 'N-7', driverSignedName: 'Ravi' } }, reconciliation: r, receiverId: 'u-recv', at: AT });
    expect(note).toEqual({ noteRef: 'N-7', driverSignedName: 'Ravi', receiverId: 'u-recv', signedAt: AT, kept: [{ productId: 'milk', quantityMinor: 19 }], handedBack: [{ productId: 'milk', quantityMinor: 1, reason: 'damaged' }], settlement: 'supplier_bill_later' });
  });
});

describe('D-11 the handheld door session (offline)', () => {
  const data = {
    workerId: 'u-recv', storeId: 'S-A',
    barcodes: [{ barcode: '890MILK', productId: 'milk', level: 'unit' }, { barcode: '890MILKCASE', productId: 'milk', level: 'case' }],
    packs: [{ productId: 'milk', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890MILK' }, { level: 'case', containsMinor: 12, barcode: '890MILKCASE' }] }],
    openDeliveries: [{ poId: 'po-1', number: 'PO-1', supplierId: 'sup-1', ordered: [{ productId: 'milk', quantityMinor: 12, unitCost: { minor: 2_500 } }] }],
  };
  it('scans, hands back and closes with the signed note — ONE record queued, nothing before close', () => {
    const outbox = new SyncOutbox();
    const s = new DsdDoorSession(data as never, outbox, () => AT);
    expect(s.scan('x', '890MILK').code).toBe('dsd_not_started');
    expect(s.start({ checkInId: 'c-1', driverName: '' , poId: 'po-1' }).code).toBe('dsd_needs_vendor');
    expect(s.start({ checkInId: 'c-1', poId: 'po-1', driverName: 'mobile 9876543210' }).feedback).toBe('accept');
    expect(s.scan('s1', '890MILKCASE')).toMatchObject({ feedback: 'accept', code: 'dsd_scanned' });
    expect(s.scan('s2', '890MILK').code).toBe('dsd_scanned');
    expect(s.scan('s3', 'NOPE').code).toBe('unknown_barcode');
    expect(s.handBack('h1', 'milk', 20, 'damaged').code).toBe('hand_back_more_than_scanned');
    expect(s.handBack('h1', 'milk', 2, 'damaged').code).toBe('dsd_handed_back');
    expect(s.view()!.discrepancies).toEqual([{ productId: 'milk', kind: 'over', expectedMinor: 12, scannedMinor: 13, differenceMinor: 1 }]);
    expect(outbox.unsentCount()).toBe(0);
    expect(s.close({ noteRef: '', driverSignedName: 'mobile 9876543210' }).code).toBe('delivery_note_not_signed');
    expect(s.close({ noteRef: 'NOTE-55', driverSignedName: 'mobile 9876543210' }).code).toBe('dsd_closed');
    expect(outbox.unsentCount()).toBe(1);
    const item = outbox.all()[0]!;
    expect(item.event.type).toBe(DSD_CHECK_IN_CLOSED);
    expect(item.event.payload).toMatchObject({ checkInId: 'c-1', poId: 'po-1', supplierId: 'sup-1', storeId: 'S-A', receivedBy: 'u-recv', deliveryNote: { noteRef: 'NOTE-55' } });
    expect(JSON.stringify(item.event.payload)).not.toMatch(/cash|tender|payment/i);
    expect(s.close({ noteRef: 'NOTE-55', driverSignedName: 'x' }).code).toBe('dsd_already_closed');
    expect(outbox.unsentCount()).toBe(1);
  });

  it('R3 D-11: a route sheet the box served is offered beside the orders; the check-in is made against it for the place it names, and what is kept is held', () => {
    const outbox = new SyncOutbox();
    const withRoute = { ...data, storeId: 'WH-A', dsdRoutes: [{ routeId: 'r-bread', supplierId: 'sup-bake', storeId: 'S-A', version: 2, lines: [{ productId: 'milk', expectedMinor: 6, unitCostMinor: 2_000 }] }] };
    const s = new DsdDoorSession(withRoute as never, outbox, () => AT);
    expect(s.choices()).toEqual({ orders: [{ poId: 'po-1', number: 'PO-1', supplierId: 'sup-1' }], routes: [{ routeId: 'r-bread', supplierId: 'sup-bake' }] });
    expect(s.start({ checkInId: 'c-r', routeId: 'r-bread', poId: 'po-1', driverName: 'mobile 9876543210' }).code).toBe('dsd_needs_vendor'); // one or the other
    expect(s.start({ checkInId: 'c-r', routeId: 'r-bread', driverName: 'mobile 9876543210' })).toMatchObject({ feedback: 'accept', code: 'dsd_started' });
    s.scan('s1', '890MILK');
    const view = s.view()!;
    expect(view).toMatchObject({ against: 'r-bread', supplierId: 'sup-bake' });
    expect(view.lines).toEqual([expect.objectContaining({ productId: 'milk', expectedMinor: 6, scannedMinor: 1, keptMinor: 1, receivableMinor: 0, heldMinor: 1 })]);
    expect(view.discrepancies).toEqual([{ productId: 'milk', kind: 'short', expectedMinor: 6, scannedMinor: 1, differenceMinor: -5 }]);
    expect(s.close({ noteRef: 'NOTE-R', driverSignedName: 'mobile 9876543210' }).code).toBe('dsd_closed');
    const payload = outbox.all()[0]!.event.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ checkInId: 'c-r', routeId: 'r-bread', supplierId: 'sup-bake', storeId: 'S-A' });
    expect(payload['poId']).toBeUndefined();
    // An order check-in on the same phone is still made for the phone's own place.
    const o2 = new SyncOutbox();
    const u = new DsdDoorSession(withRoute as never, o2, () => AT);
    u.start({ checkInId: 'c-p', poId: 'po-1', driverName: 'd' });
    u.close({ noteRef: 'N', driverSignedName: 'd' });
    expect(o2.all()[0]!.event.payload).toMatchObject({ poId: 'po-1', storeId: 'WH-A' });
  });
});
