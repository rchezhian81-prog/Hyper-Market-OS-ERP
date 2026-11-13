import { describe, it, expect } from 'vitest';
import { emptyPack, known, notKnown, type StorePack } from '../../edge/store-edge/src/store-pack';
import { directoryPayload } from '../../edge/store-edge/src/screen-directory';
import { injectPayload, DATA_MARKER } from '../../edge/store-edge/src/screen-server';

/**
 * **The store computer tells every office page WHO and WHERE from its signed pack (U2 · UI/UX gap audit G5 · G16 ·
 * P-01 · P-08).** `window.sreDirectory` carries the store's own people and places, the store itself, the shop's zone and
 * the person signed in, so a page lets a person PICK a colleague or a place by name and SHOWS a name where it showed an
 * id — with head office down. A register the pack never held is an empty list said as such (`known: false`), never a
 * guess; a person the pack does not name is shown by their id, never invented.
 */

const POLICIES = { storeId: 'S1', branchId: 'S1', branchName: 'SRE Hyper Market', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 30, warehouseId: 'S1-BACK' };

const pack = (over: Partial<StorePack> = {}): StorePack => ({
  ...emptyPack('never pulled'),
  policies: known(POLICIES as never),
  people: known([{ userId: 'u-cash', displayName: 'Kavitha Rajan', roleId: 'cashier' }, { userId: 'u-mgr', displayName: 'Ravi Kumar', roleId: 'store_manager' }, { userId: 'bad', displayName: '' }]),
  roles: known([{ id: 'cashier', name: 'Cashier', permissions: ['pos.sale.read'] }, { id: 'store_manager', name: 'Store manager', permissions: ['till.dayclose.read', 'inventory.count.plan'] }]),
  roleAssignments: known([{ userId: 'u-cash', roleId: 'cashier', branchScope: ['S1'] }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: ['S1'] }]),
  warehouse: known({ assignmentId: 'a1', workerId: 'u-wh', storeId: 'S1', bins: [{ binId: 'A-01', storeId: 'S1', capacityMinor: 100, pickable: true, zone: 'ambient' }, { binId: 'Q-01', storeId: 'S1', capacityMinor: 10, pickable: false, zone: 'quarantine' }] } as never),
  ...over,
});

describe('U2: the store computer names who and where', () => {
  it('U7: carries a role\'s Tamil name where the pack holds it (OB-699)', () => {
    const d = directoryPayload(pack({ roles: known([{ id: 'cashier', name: 'Cashier', nameTa: 'காசாளர்', permissions: ['pos.sale.read'] }]) }), null);
    expect(d.roles).toEqual([{ id: 'cashier', name: 'Cashier', nameTa: 'காசாளர்' }]);
  });
  it('names the store, the shop zone, the people and the places from the signed pack, and the person signed in with their roles', () => {
    const d = directoryPayload(pack(), 'u-mgr');
    expect(d.store).toEqual({ id: 'S1', name: 'SRE Hyper Market' });
    expect(d.timeZone).toBe('Asia/Kolkata');
    expect(d.people).toEqual([{ id: 'u-cash', name: 'Kavitha Rajan', roleId: 'cashier' }, { id: 'u-mgr', name: 'Ravi Kumar', roleId: 'store_manager' }]); // the blank-named row is dropped, never shown as ""
    expect(d.places).toEqual([
      { id: 'S1', name: 'SRE Hyper Market', kind: 'store' },
      { id: 'S1-BACK', name: 'S1-BACK', kind: 'warehouse' },
      { id: 'A-01', name: 'A-01 (ambient)', kind: 'bin', zone: 'ambient' },
      { id: 'Q-01', name: 'Q-01 (quarantine)', kind: 'bin', zone: 'quarantine' },
    ]);
    expect({ ...d.me, permissions: [...(d.me?.permissions ?? [])].sort() }).toEqual({ userId: 'u-mgr', name: 'Ravi Kumar', roleIds: ['store_manager'], permissions: ['inventory.count.plan', 'till.dayclose.read'] });
    // U7: the roles the pack's register holds, for the picker's role kind (several at once) — by name
    expect(d.roles).toEqual([{ id: 'cashier', name: 'Cashier' }, { id: 'store_manager', name: 'Store manager' }]);
    expect(d.known).toEqual({ people: true, places: true, store: true, roles: true });
  });

  it('a register the pack never held is an empty list said as such; a person the pack does not name is their id; nobody signed in is null', () => {
    const d = directoryPayload(pack({ people: notKnown('not sent'), warehouse: notKnown('not sent'), roleAssignments: notKnown('not sent') }), 'u-new');
    expect(d.people).toEqual([]);
    expect(d.known.people).toBe(false);
    expect(d.places).toEqual([{ id: 'S1', name: 'SRE Hyper Market', kind: 'store' }, { id: 'S1-BACK', name: 'S1-BACK', kind: 'warehouse' }]);
    expect(d.me).toEqual({ userId: 'u-new', name: 'u-new', roleIds: [], permissions: [] });
    expect(directoryPayload(pack(), null).me).toBeNull();
    const bare = directoryPayload(emptyPack('never pulled'), null);
    expect(bare.store).toBeNull();
    expect(bare.known).toEqual({ people: false, places: false, store: false, roles: false });
    expect(bare.roles).toEqual([]);
    expect(bare.places).toEqual([]);
  });

  it('rides the page as its own window global beside the others, in one script tag a reader can pull out', () => {
    const html = `<html><body>${DATA_MARKER}</body></html>`;
    const served = injectPayload(html, 'managerData', null, { sreDirectory: directoryPayload(pack(), 'u-cash'), shopTimeZone: 'Asia/Kolkata' });
    const tag = /<script>window\.sreDirectory = (.*?);<\/script>/.exec(served);
    expect(tag).not.toBeNull();
    const parsed = JSON.parse(tag![1]!) as ReturnType<typeof directoryPayload>;
    expect(parsed.me?.name).toBe('Kavitha Rajan');
    expect(parsed.people.map((p) => p.name)).toEqual(['Kavitha Rajan', 'Ravi Kumar']);
  });
});

describe('U2: an older or thinner pack never stops a page being served', () => {
  it('policies without a branch name or warehouse, and registers holding the wrong shape, give a directory, not a crash', () => {
    const thin = { ...emptyPack('never pulled'), policies: known({ tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' } as never), people: known('not a list' as never), warehouse: known({ bins: 'nope' } as never), roleAssignments: known(null as never) };
    const d = directoryPayload(thin as StorePack, 'u-owner');
    expect(d.store).toEqual({ id: 'store-1', name: 'store-1' });
    expect(d.places).toEqual([{ id: 'store-1', name: 'store-1', kind: 'store' }]);
    expect(d.people).toEqual([]);
    expect(d.me).toEqual({ userId: 'u-owner', name: 'u-owner', roleIds: [], permissions: [] });
  });
});
