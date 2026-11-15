import { describe, it, expect } from 'vitest';
import {
  MOVE_WORD, NARROWED_MOVEMENT_ROLES, RECEIVER_QC_ROLE, WAREHOUSE_USER_ROLE, movementReachOfRoles, reachAllows,
} from '../../packages/rbac/src/index';
import { ROLE_CATALOGUE, RECEIVER_QC_ROLE_ID, WAREHOUSE_USER_ROLE_ID, STORE_MANAGER_ROLE_ID } from '../../services/api/src/roles';
import { movementReachOf, NARROWED_MOVEMENT_ROLES as HEAD_OFFICE_NARROWED } from '../../services/api/src/w2-movement-jobs';
import { asPhoneHolder, phoneReceivingOf } from '../../edge/store-edge/src/handheld-sign-in';
import { known, notKnown, type StorePack } from '../../edge/store-edge/src/store-pack';
import { WarehouseSession, FEEDBACK_CODES, NOT_YOURS_TO_RECEIVE } from '../../apps/warehouse-app/src/warehouse-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **OB-740 (pilot audit B-3): a Warehouse user is told on the handheld, BEFORE any scan, that a delivery is not theirs to
 * receive.** Head office refuses every goods receipt from a person whose stock work comes only through the Warehouse user
 * role (`not_your_kind_of_stock_movement`, owner decision OB-623 — kept). The handheld used to let them scan anyway, and
 * the scans sat at the store as refused items — a dead end. Now the store computer judges the person signed in by the SAME
 * rule (one table in @sre/rbac), offline, from the store setup's roles; the phone refuses "Receive a delivery" in English
 * and Tamil, says who receives (Receiver / QC or the store manager) and that nothing was recorded, and queues nothing.
 * Put-away, counts, picks and issues stay theirs.
 */

const AT = '2026-11-15T06:00:00.000Z';
const roleOf = (id: string) => {
  const r = ROLE_CATALOGUE.find((x) => x.id === id)!;
  return { id: r.id, name: r.name, permissions: [...r.permissions] };
};
const ROLES = [roleOf(WAREHOUSE_USER_ROLE_ID), roleOf(RECEIVER_QC_ROLE_ID), roleOf(STORE_MANAGER_ROLE_ID), { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.sync'] }];
const POLICIES = known({ storeId: 'store-1', branchId: 'b1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 15, warehouseId: 'wh-1' }) as StorePack['policies'];
/** Only the registers the decision reads; every other section unknown, as on a box that pulled nothing else. */
const packWith = (over: Partial<Pick<StorePack, 'roles' | 'roleAssignments' | 'policies'>>): StorePack =>
  new Proxy({} as Record<string, unknown>, { get: (_t, key) => (key in over ? over[key as keyof typeof over] : notKnown('not pulled')) }) as unknown as StorePack;
const PACK = packWith({
  roles: known(ROLES), policies: POLICIES,
  roleAssignments: known([
    { userId: 'u-wh', roleId: WAREHOUSE_USER_ROLE_ID, branchScope: ['b1'] },
    { userId: 'u-qc', roleId: RECEIVER_QC_ROLE_ID, branchScope: ['b1'] },
    { userId: 'u-mgr', roleId: STORE_MANAGER_ROLE_ID, branchScope: ['b1'] },
    { userId: 'u-both', roleId: WAREHOUSE_USER_ROLE_ID, branchScope: ['b1'] },
    { userId: 'u-both', roleId: RECEIVER_QC_ROLE_ID, branchScope: ['b1'] },
    { userId: 'u-wh-mgr-elsewhere', roleId: WAREHOUSE_USER_ROLE_ID, branchScope: ['b1'] },
    { userId: 'u-wh-mgr-elsewhere', roleId: STORE_MANAGER_ROLE_ID, branchScope: ['b2'] },
  ]),
});

describe('one rule for head office and the store computer (OB-623 · @sre/rbac)', () => {
  it('the shared table is head office\'s table, keyed by head office\'s own role ids', () => {
    expect([RECEIVER_QC_ROLE, WAREHOUSE_USER_ROLE]).toEqual([RECEIVER_QC_ROLE_ID, WAREHOUSE_USER_ROLE_ID]);
    expect(HEAD_OFFICE_NARROWED).toBe(NARROWED_MOVEMENT_ROLES);
    expect(ROLE_CATALOGUE.find((r) => r.id === WAREHOUSE_USER_ROLE_ID)!.permissions).toContain(MOVE_WORD);
  });

  it('a Warehouse user may not receive; Receiver / QC, the store manager, and anyone holding both narrowed roles may', () => {
    const reachFor = (...ids: string[]) => movementReachOfRoles(ids.map((id) => ({ roleId: id, permissions: roleOf(id).permissions })));
    expect(reachAllows(reachFor(WAREHOUSE_USER_ROLE_ID), 'receive')).toBe(false);
    expect(reachAllows(reachFor(WAREHOUSE_USER_ROLE_ID), 'move_in_store')).toBe(true);
    expect(reachAllows(reachFor(WAREHOUSE_USER_ROLE_ID), 'count')).toBe(true);
    expect(reachAllows(reachFor(RECEIVER_QC_ROLE_ID), 'receive')).toBe(true);
    expect(reachAllows(reachFor(STORE_MANAGER_ROLE_ID), 'receive')).toBe(true);
    expect(reachAllows(reachFor(WAREHOUSE_USER_ROLE_ID, RECEIVER_QC_ROLE_ID), 'receive')).toBe(true);
    expect(reachAllows(reachFor('cashier'), 'receive')).toBe(false);
    // Head office's judgement over its grants agrees, word for word.
    const g = (u: string, r: string) => ({ userId: u, roleId: r, branchScope: ['b1'] as readonly string[] });
    expect(movementReachOf([g('a', WAREHOUSE_USER_ROLE_ID)], 'a', 'b1')).toEqual(reachFor(WAREHOUSE_USER_ROLE_ID));
  });
});

describe('the store computer tells the warehouse phone, offline, whether the person signed in may receive', () => {
  it('a Warehouse user: refused, in English and Tamil, saying who receives and that nothing was recorded', () => {
    const r = phoneReceivingOf('u-wh', PACK);
    expect(r.allowed).toBe(false);
    expect(r.en).toContain('your role (Warehouse user) does not receive goods');
    expect(r.en).toContain('Receiver / QC or the store manager');
    expect(r.en).toContain('Nothing was scanned or recorded');
    expect(r.en).toContain('You can still put away, pick, count and issue stock to the floor');
    expect(r.ta).toContain('கிடங்கு பயனர்');
    expect(r.ta).toContain('பெறுநர் / தரச் சோதனை அல்லது கடை மேலாளர்');
    expect(r.ta).toContain('எதுவும் ஸ்கேன் செய்யப்படவில்லை');
  });

  it('Receiver / QC, the store manager, and a person with both narrowed roles may; a store-manager grant for ANOTHER branch does not count here', () => {
    expect(phoneReceivingOf('u-qc', PACK)).toEqual({ allowed: true });
    expect(phoneReceivingOf('u-mgr', PACK)).toEqual({ allowed: true });
    expect(phoneReceivingOf('u-both', PACK)).toEqual({ allowed: true });
    expect(phoneReceivingOf('u-wh-mgr-elsewhere', PACK).allowed).toBe(false);
    expect(phoneReceivingOf('u-nobody', PACK).allowed).toBe(false);
  });

  it('a store setup with no role register cannot say — refused (fail closed), with the words', () => {
    const r = phoneReceivingOf('u-qc', packWith({ policies: POLICIES }));
    expect(r.allowed).toBe(false);
    expect(r.en).toContain('does not hold the staff roles');
  });

  it('the served warehouse page carries the decision for the person signed in; other screens and a call without the setup do not', () => {
    const served = { assignmentId: 'A-1', workerId: 'someone-else', storeId: 'store-1', bins: [] };
    expect(asPhoneHolder('warehouse', served, 'u-wh', PACK)).toMatchObject({ workerId: 'u-wh', receiving: { allowed: false } });
    expect(asPhoneHolder('warehouse', served, 'u-qc', PACK)).toMatchObject({ workerId: 'u-qc', receiving: { allowed: true } });
    expect(asPhoneHolder('warehouse', served, 'u-wh')).not.toHaveProperty('receiving');
    expect(asPhoneHolder('picker', { pickerId: 'u-wh' }, 'u-wh', PACK)).not.toHaveProperty('receiving');
  });
});

describe('the warehouse handheld refuses "Receive a delivery" before any scan — nothing queued', () => {
  const session = (receiving?: { allowed: boolean; en?: string; ta?: string }) => {
    const outbox = new SyncOutbox();
    const s = new WarehouseSession({
      assignmentId: 'A-1', workerId: 'u-wh', storeId: 'store-1', grnId: 'g-1',
      bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
      ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000, currency: 'INR' } }],
      barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
      packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }],
      goodsIn: [{ productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'on_hand', expiry: null, recalled: false }],
      ...(receiving === undefined ? {} : { receiving }),
    }, outbox, { now: () => AT });
    return { s, outbox };
  };
  const words = phoneReceivingOf('u-wh', PACK);

  it('not allowed: the refusal is ready before the scan panel opens; a scan and "Delivery complete" are refused and queue nothing', () => {
    const { s, outbox } = session(words);
    const before = s.receivingRefusal()!;
    expect(before.code).toBe(NOT_YOURS_TO_RECEIVE);
    expect(before.feedback).toBe('reject');
    expect(before.detail).toBe(words.en);
    expect(before.detailTa).toBe(words.ta);
    expect(FEEDBACK_CODES).toContain(NOT_YOURS_TO_RECEIVE);
    const scanned = s.receive({ commandId: 'c-1', grnId: 'g-1', barcode: '890RICE', scannedQuantity: 1, source: 'po' });
    expect([scanned.result.accepted, scanned.result.outcome, scanned.signal.code]).toEqual([false, NOT_YOURS_TO_RECEIVE, NOT_YOURS_TO_RECEIVE]);
    expect(s.completeReceiving({ grnId: 'g-1' }).signal.code).toBe(NOT_YOURS_TO_RECEIVE);
    expect(outbox.all()).toEqual([]);
    // Their own work stays: put a good item away.
    const moved = s.putAway({ commandId: 'm-1', scannedProductId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', scannedBinId: 'BIN-A', at: AT });
    expect(moved.signal.feedback).toBe('accept');
    expect(outbox.all()).toHaveLength(1);
  });

  it('allowed — or not told (an older store computer: head office decides, as before): the scan is received and queued', () => {
    for (const receiving of [{ allowed: true }, undefined]) {
      const { s, outbox } = session(receiving);
      expect(s.receivingRefusal()).toBeUndefined();
      expect(s.receive({ commandId: 'c-1', grnId: 'g-1', barcode: '890RICE', scannedQuantity: 1, source: 'po' }).result.accepted).toBe(true);
      expect(outbox.all()).toHaveLength(1);
    }
  });
});
