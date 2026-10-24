import { describe, it, expect } from 'vitest';
import { equipmentWork, helpWork } from '../../edge/store-edge/src/store-work';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { helpPayload, writeOffCapturePayload, facilitiesPayload, SCREENS, GLOBAL_FOR, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { APP_SHELL, screenOfPath } from '../../edge/store-edge/src/screen-server';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { readEquipmentFeed, readHelpFeed, readWorkFeed, WORK_FEED_NAMES, WORK_FEED_PATHS } from '../../edge/sync-agent/src/store-work-feeds';

// OB-288 LP/workforce package (§31 · P-01 · P-08): the store computer holds head office's monitored rooms (the facilities
// page's manual readings, M26-FR-02) and the help library (the help page, M25-FR-04), says how old each is, and never
// passes "not told" off as "nothing". The help page is a screen the box serves.

const NOW = '2026-10-24T08:00:00.000Z';
const HELD = '2026-10-24T07:00:00.000Z';
const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({
  pack: readPack({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' } }, NOW),
  sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-24', ...over,
});
const equipmentBody = { branchId: 'S1', asAt: HELD, equipment: [{ assetId: 'cold-1', name: 'Cold room 1', branchId: 'S1', range: { minTenthsC: 0, maxTenthsC: 80, graceMinutes: 30 }, lastReadingAt: null }] };
const helpBody = {
  storeId: 'S1', asAt: HELD, contactsSet: true, emergencyContacts: [{ label: 'Fire service', phone: '101' }],
  sops: [{ sopId: 'SOP-01', title: 'PC down', titleTa: 'கணினி', version: 1, forRoles: ['cashier'], category: 'procedure', bodyEn: 'Paper.', bodyTa: 'காகிதம்.' }],
  people: [{ employeeId: 'u-cash', roles: ['cashier'] }], acknowledgements: [],
};

describe('the two feeds, read strictly and read back', () => {
  it('the rooms and the library are taken only whole; a held one reads back as it was', () => {
    const eq = readEquipmentFeed(equipmentBody)!;
    expect(eq).toMatchObject({ name: 'equipment', asAt: HELD });
    expect(readWorkFeed(eq)).toEqual(eq);
    expect(readEquipmentFeed({ ...equipmentBody, equipment: [{ assetId: 'cold-1', name: 'x', range: { minTenthsC: 0.5, maxTenthsC: 80 } }] })).toBeUndefined();
    expect(readEquipmentFeed({ equipment: [] })).toBeUndefined();
    const help = readHelpFeed(helpBody)!;
    expect(help).toMatchObject({ name: 'help', asAt: HELD, body: { contactsSet: true } });
    expect(readWorkFeed(help)).toEqual(help);
    expect(readHelpFeed({ ...helpBody, sops: [{ sopId: 'SOP-01' }] })).toBeUndefined();
    expect(readHelpFeed({ ...helpBody, people: undefined })).toBeUndefined();
    expect(WORK_FEED_NAMES).toEqual(expect.arrayContaining(['equipment', 'help']));
    expect([WORK_FEED_PATHS.equipment('S1'), WORK_FEED_PATHS.help('S1')]).toEqual([['/v1/facilities/equipment-feed?branchId=S1'], ['/v1/hr/workforce/help-library?storeId=S1']]);
  });
});

describe('what the screens are told', () => {
  it('the rooms and the library say how old they are; never told is null, not an empty list', () => {
    const workFeeds = { equipment: { receivedAt: HELD, feed: readEquipmentFeed(equipmentBody)! }, help: { receivedAt: HELD, feed: readHelpFeed(helpBody)! } };
    expect(equipmentWork(input({ workFeeds }))).toMatchObject({ equipment: { asAt: HELD, ageMinutes: 60, items: equipmentBody.equipment } });
    expect(helpWork(input({ workFeeds }))).toMatchObject({ library: { asAt: HELD, ageMinutes: 60, sops: helpBody.sops, people: helpBody.people, contactsSet: true } });
    expect(equipmentWork(input())).toEqual({ equipment: null });
    expect(helpWork(input())).toEqual({ library: null });
  });

  it('the help page is served by the box, names its store, and holds nobody\'s permissions until a person signs in', () => {
    expect(SCREENS).toContain('help');
    expect([GLOBAL_FOR.help, APP_SHELL.help.file, screenOfPath('/help')]).toEqual(['helpData', 'help.html', 'help']);
    expect(helpPayload(input())).toEqual({ permissions: [], storeId: 'S1', library: null });
    expect(helpPayload(input({ pack: readPack({ version: 1, policies: { tradingDayCutoff: '02:00' } }, NOW) }))).toBeNull();
  });

  it('the write-off capture and facilities screens are told their store, and the facilities screen the rooms', () => {
    const pack = readPack({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' }, writeOffCapturePolicy: { permissions: [] }, facilitiesPolicy: { permissions: [] } }, NOW);
    expect((writeOffCapturePayload(input({ pack })) ?? {})['storeId']).toBe('S1');
    const fac = facilitiesPayload(input({ pack })) ?? {};
    expect([fac['storeId'], fac['equipment']]).toEqual(['S1', null]);
  });
});
