import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import { RELAYABLE_DEVICE_EVENTS } from '../../packages/sync/src/device-relay';
import { HANDHELD_PERSON_FIELD } from '../../edge/store-edge/src/handheld-sign-in';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * D-11 (R3, OB-141 "A") — on the real API, in memory and on PostgreSQL, with a cold restart:
 * "a DSD delivery is checked in against its vendor and PO or route. Every scan difference is captured as a discrepancy
 * line. Goods handed back are recorded as an on-spot return linked to a debit note. The delivery cannot close until
 * settlement is recorded per the Q10 answer" — no cash at the door; a signed delivery note of what was kept and handed
 * back; paid later as a supplier bill.
 */
const backings = r3OpsBackings();
const cost = { minor: 2_500, currency: 'INR' };

describe.each(backings)('a DSD delivery is checked in at the door — on $name (D-11)', ({ harness, restart }) => {
  it('PO check-in: differences by name, hand-back on the debit note, no close without the signed note or with cash, extras to a second person; route and relayed paths', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-recv', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S-A']);
    await approvedSuppliers(h, T, 'sup-dairy');
    const { req, ok, code } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S-A', { kind: 'branch', name: 'Store A', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/purchase/orders/po-dairy', { supplierId: 'sup-dairy', deliverToLocationId: 'S-A', lines: [{ productId: 'p-milk', orderedQty: 20, unitCost: cost }, { productId: 'p-curd', orderedQty: 10, unitCost: { minor: 3_000, currency: 'INR' } }] }, 'u-recv'), 'po');
    await ok(req('POST', '/v1/purchase/orders/po-dairy/approval', { reason: 'weekly dairy' }), 'issue po');
    const onHand = async (p: string) => ((await req('GET', '/v1/inventory/availability', undefined, 'u-owner', { productId: p })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === 'S-A')?.onHandMinor ?? 0;

    // ── open: against the vendor and its PO; a cashier cannot; a PO of another vendor or an unknown one is refused ──
    const open = { supplierId: 'sup-dairy', storeId: 'S-A', poId: 'po-dairy', driverName: 'Ravi', vehicleRef: 'TN-38-AB-1234', arrivedAt: '2030-06-01T06:30:00.000Z' };
    expect((await req('POST', '/v1/inventory/dsd-checkins/c-1', open, 'u-till')).status).toBe(403);
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-x', { ...open, poId: 'po-none' }, 'u-recv'))).toBe('order_or_route_unknown');
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-y', { ...open, supplierId: 'sup-nobody' }, 'u-recv'))).toBe('supplier_not_approved');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1', open, 'u-recv'), 'open');
    for (const [id, p, q] of [['s1', 'p-milk', 12], ['s2', 'p-milk', 10], ['s3', 'p-curd', 7], ['s4', 'p-butter', 2]] as const) {
      await ok(req('POST', `/v1/inventory/dsd-checkins/c-1/scans/${id}`, { productId: p, quantityMinor: q }, 'u-recv'), `scan ${id}`);
    }
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/hand-backs/h-x', { productId: 'p-curd', quantityMinor: 9, reason: 'damaged' }, 'u-recv'))).toBe('hand_back_more_than_scanned');
    const hb = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/hand-backs/h-1', { productId: 'p-milk', quantityMinor: 3, reason: 'damaged', note: 'crushed crate' }, 'u-recv'), 'hand back')).body as { debitNoteRef: string };
    expect(hb.debitNoteRef).toBe('DN-DSD-c-1');

    h = restart(h); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────
    await h.provisionRole(T, 'u-box', 'store_computer', ['S-A']); // the new API's harness learns which store the box's credential is for

    const live = (await req('GET', '/v1/inventory/dsd-checkins/c-1')).body as { reconciliation: { discrepancies: { productId: string; kind: string; differenceMinor: number }[] } };
    expect(live.reconciliation.discrepancies).toEqual([
      expect.objectContaining({ productId: 'p-butter', kind: 'not_expected', differenceMinor: 2 }),
      expect.objectContaining({ productId: 'p-curd', kind: 'short', differenceMinor: -3 }),
      expect.objectContaining({ productId: 'p-milk', kind: 'over', differenceMinor: 2 }),
    ]);
    // ── close: not without the signed note; never with cash ─────────────────────────────────────────────────────
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/close', {}, 'u-recv'))).toBe('delivery_note_not_signed');
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/close', { deliveryNote: { noteRef: 'DN-SUP-77', driverSignedName: 'Ravi' }, cashMinor: 50_000 }, 'u-recv'))).toBe('no_cash_at_the_door');
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/close', { deliveryNote: { noteRef: 'DN-SUP-77', driverSignedName: 'Ravi' }, settlement: 'cash' }, 'u-recv'))).toBe('no_cash_at_the_door');
    expect(await onHand('p-milk')).toBe(0);
    const closed = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/close', { deliveryNote: { noteRef: 'DN-SUP-77', driverSignedName: 'Ravi' } }, 'u-recv'), 'close')).body as { checkIn: {
      status: string; settlement: string; deliveryNote: { kept: { productId: string; quantityMinor: number }[]; handedBack: { productId: string; quantityMinor: number }[] };
      debitNote: { debitNoteRef: string; valueMinor: number; handBackIds: string[] }; held: { state: string; lines: { productId: string; quantityMinor: number }[] }; cashAtTheDoor: string;
    } };
    expect(closed.checkIn).toMatchObject({ status: 'closed', settlement: 'supplier_bill_later', debitNote: { debitNoteRef: 'DN-DSD-c-1', valueMinor: 7_500, handBackIds: ['h-1'] } });
    expect(closed.checkIn.deliveryNote.kept).toEqual([{ productId: 'p-butter', quantityMinor: 2 }, { productId: 'p-curd', quantityMinor: 7 }, { productId: 'p-milk', quantityMinor: 19 }]);
    expect(closed.checkIn.deliveryNote.handedBack).toEqual([{ productId: 'p-milk', quantityMinor: 3, reason: 'damaged' }]);
    // Within the order is received now; the butter (not ordered) is held for a second person.
    expect(await onHand('p-milk')).toBe(19);
    expect(await onHand('p-curd')).toBe(7);
    expect(await onHand('p-butter')).toBe(0);
    expect(closed.checkIn.held).toMatchObject({ state: 'pending', lines: [{ productId: 'p-butter', quantityMinor: 2 }] });
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/scans/s9', { productId: 'p-milk', quantityMinor: 1 }, 'u-recv'))).toBe('dsd_check_in_closed');
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/held/decide', { decision: 'approved', reason: 'we stock it' }, 'u-recv'))).toBe('self_approval');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/held/decide', { decision: 'approved', reason: 'we stock it' }, 'u-mgr2'), 'approve extras');
    expect(await onHand('p-butter')).toBe(2);
    // A resend of the close is the same close (no second posting).
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/close', { deliveryNote: { noteRef: 'DN-SUP-77', driverSignedName: 'Ravi' } }, 'u-recv'), 'close again');
    expect(await onHand('p-milk')).toBe(19);
    const list = (await req('GET', '/v1/inventory/dsd-checkins', undefined, 'u-owner', { supplierId: 'sup-dairy' })).body as { debitNotes: { debitNoteRef: string }[] };
    expect(list.debitNotes.map((d) => d.debitNoteRef)).toEqual(['DN-DSD-c-1']);

    // ── a route check-in: everything kept waits for a second person (no purchase order) ─────────────────────────
    await ok(req('POST', '/v1/inventory/dsd-routes/r-bread', { supplierId: 'sup-dairy', storeId: 'S-A', lines: [{ productId: 'p-bread', expectedMinor: 30, unitCostMinor: 2_000 }] }, 'u-recv'), 'route sheet');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-2', { supplierId: 'sup-dairy', storeId: 'S-A', routeId: 'r-bread', driverName: 'Mani', arrivedAt: '2030-06-01T07:00:00.000Z' }, 'u-recv'), 'route open');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-2/scans/b1', { productId: 'p-bread', quantityMinor: 30 }, 'u-recv'), 'bread scan');
    const c2 = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-2/close', { deliveryNote: { noteRef: 'R-1', driverSignedName: 'Mani' } }, 'u-recv'), 'route close')).body as { checkIn: { held: { state: string } } };
    expect(c2.checkIn.held.state).toBe('pending');
    expect(await onHand('p-bread')).toBe(0);
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-2/held/decide', { decision: 'rejected', reason: 'route sheet wrong' }, 'u-mgr2'), 'reject');
    expect(await onHand('p-bread')).toBe(0);

    // ── the handheld's record relayed by the store computer: the receiver re-verified, the order head office's ─────
    const relayed = {
      checkInId: 'c-3', supplierId: 'sup-dairy', storeId: 'S-A', poId: 'po-dairy', driverName: 'mobile 9876543210', arrivedAt: '2030-06-02T06:00:00.000Z',
      receivedBy: 'u-recv', scans: [{ scanId: 'x1', productId: 'p-curd', quantityMinor: 3, at: '2030-06-02T06:05:00.000Z' }], handBacks: [],
      deliveryNote: { noteRef: 'NOTE-9', driverSignedName: 'mobile 9876543210' }, at: '2030-06-02T06:10:00.000Z',
    };
    expect((await req('POST', '/v1/inventory/dsd-checkins/c-3/synced', relayed, 'u-recv')).status).toBe(403); // a person cannot pose as the box
    const cashTry = await req('POST', '/v1/inventory/dsd-checkins/c-3/synced', { ...relayed, cash: 100 }, 'u-box');
    expect(code(cashTry), JSON.stringify(cashTry.body)).toBe('no_cash_at_the_door');
    const r3 = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-3/synced', relayed, 'u-box'), 'relayed')).body as { checkIn: { status: string; via: string; flags: string[] } };
    expect(r3.checkIn).toMatchObject({ status: 'closed', via: 'relayed', flags: [] });
    expect(await onHand('p-curd')).toBe(10); // 7 + 3, within the order's open 10
    // A relayed check-in naming someone the grants do not back: everything is held for a person, flagged.
    const r4 = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-4/synced', { ...relayed, checkInId: 'c-4', receivedBy: 'u-stranger', scans: [{ scanId: 'y1', productId: 'p-curd', quantityMinor: 1 }] }, 'u-box'), 'relayed stranger')).body as { checkIn: { flags: string[]; held: { state: string } } };
    expect(r4.checkIn.flags).toContain('receiver_unknown');
    expect(r4.checkIn.held.state).toBe('pending');
    expect(await onHand('p-curd')).toBe(10);
  }, 60_000);

  it('the box carries the handheld\'s record to the synced route, named for its receiver', () => {
    expect(RELAYABLE_DEVICE_EVENTS['DsdCheckInClosed']).toEqual({ surfaces: ['warehouse'] });
    expect(HANDHELD_PERSON_FIELD['DsdCheckInClosed']).toBe('receivedBy');
    const e = makeEvent({ id: 'dsd-c-9', type: 'DsdCheckInClosed', occurredAt: '2030-06-01T00:00:00.000Z', idempotencyKey: 'dsd:c-9', source: 'warehouse-handheld', payload: { checkInId: 'c-9' } });
    expect(pathFor(e)).toBe('/v1/inventory/dsd-checkins/c-9/synced');
  });
});
