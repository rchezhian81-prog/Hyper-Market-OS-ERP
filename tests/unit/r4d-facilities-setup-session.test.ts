import { describe, it, expect } from 'vitest';
import { createFacilitiesSetupSession, tenthsOf, itemsOf, paiseOf, wholeOf, FACILITIES_SETUP_COPY } from '../../apps/web-erp/src/facilities-setup-session';
import { drawProblem, sparesView, onHandOf, type SparePart, type SpareMovement } from '../../packages/facilities/src/spares';

/**
 * Round 4d (M26-FR-01/02/03 · D-6 · Screen D): the facilities set-up session refuses the cheap mistakes before anything is
 * sent (a temperature that is not one, a range upside down, a check with nothing to tick), and sends exactly what each head
 * office route reads — °C as whole tenths, ₹ as paise, the spares a service used. And the spare-parts rule itself.
 */

function fakeHeadOffice(answer: (method: string, path: string) => unknown = () => ({})) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => answer(init.method, path) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const MANAGER = { userId: 'u-mgr', permissions: ['facilities.asset.read', 'facilities.asset.manage', 'facilities.overdue.read', 'facilities.schedule.manage', 'facilities.task.record'] };

describe('every word has a Tamil twin', () => {
  it('in the facilities set-up word table', () => { expect(Object.keys(FACILITIES_SETUP_COPY.ta).sort()).toEqual(Object.keys(FACILITIES_SETUP_COPY.en).sort()); });
});

describe('what a person types becomes what head office reads', () => {
  it('°C to whole tenths; anything else is not a temperature', () => {
    expect(tenthsOf('3.5')).toBe(35); expect(tenthsOf('-18')).toBe(-180); expect(tenthsOf('4,5')).toBe(45);
    expect(tenthsOf('3.55')).toBeUndefined(); expect(tenthsOf('cold')).toBeUndefined(); expect(tenthsOf('')).toBeUndefined();
  });
  it('rupees to paise, whole numbers, and a checklist one item per line with its own ids', () => {
    expect(paiseOf('1,250.50')).toBe(125050); expect(paiseOf('12.345')).toBeUndefined();
    expect(wholeOf('-2', { signed: true })).toBe(-2); expect(wholeOf('-2')).toBeUndefined(); expect(wholeOf('0', { min: 1 })).toBeUndefined();
    expect(itemsOf('Floor mopped\n\n  Bins emptied \nFloor mopped')).toEqual([{ itemId: 'floor-mopped', label: 'Floor mopped' }, { itemId: 'bins-emptied', label: 'Bins emptied' }, { itemId: 'floor-mopped-2', label: 'Floor mopped' }]);
  });
});

describe('the session', () => {
  it('a temperature check is sent with its limits in tenths, its schedule and the store; a wrong one is refused first', async () => {
    const ho = fakeHeadOffice(() => ({ check: {} }));
    const s = createFacilitiesSetupSession({ viewer: MANAGER, storeId: 'store-1', fetch: ho.fetch });
    const base = { title: 'Dairy chiller temperature', kind: 'temperature', everyMinutes: '240', startsAt: '2026-11-01T08:00:00Z', graceMinutes: '30', minC: '0', maxC: '5', items: '', equipmentId: 'chiller-1', assignedRole: 'store_manager', escalatesTo: 'u-owner', active: true };
    expect(await s.saveCheck({ ...base, maxC: 'warm' })).toEqual({ result: 'invalid', why: 'badTemperature' });
    expect(await s.saveCheck({ ...base, minC: '6' })).toEqual({ result: 'invalid', why: 'rangeInverted' });
    expect(await s.saveCheck({ ...base, everyMinutes: '' })).toEqual({ result: 'invalid', why: 'needSchedule' });
    expect(await s.saveCheck({ ...base, kind: 'cleaning', minC: '', maxC: '' })).toEqual({ result: 'invalid', why: 'needItems' });
    expect(ho.sent).toHaveLength(0);
    const out = await s.saveCheck({ ...base, checkId: 'fsc-dairy' });
    expect(out).toEqual({ result: 'ok', value: { checkId: 'fsc-dairy', unchanged: false } });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/facilities/food-safety/checks/fsc-dairy', body: {
      branchId: 'store-1', title: 'Dairy chiller temperature', kind: 'temperature', graceMinutes: 30, items: [], assignedRole: 'store_manager', escalatesTo: 'u-owner', active: true,
      everyMinutes: 240, startsAt: '2026-11-01T08:00:00.000Z', minTenthsC: 0, maxTenthsC: 50, equipmentId: 'chiller-1',
    } });
  });

  it('a receiving checklist has no clock; a room range is in tenths; a service names the spares it used', async () => {
    const ho = fakeHeadOffice();
    const s = createFacilitiesSetupSession({ viewer: MANAGER, storeId: 'store-1', fetch: ho.fetch });
    await s.saveCheck({ checkId: 'rcv', title: 'Receiving', kind: 'receiving', everyMinutes: '240', startsAt: 'x', graceMinutes: '0', minC: '', maxC: '', items: 'Seal intact\nTemperature on arrival', equipmentId: '', assignedRole: 'receiver_qc', escalatesTo: 'u-mgr', active: true });
    expect(ho.sent[0]!.body).not.toHaveProperty('everyMinutes');
    expect(ho.sent[0]!.body).not.toHaveProperty('startsAt');
    await s.saveRoom({ assetId: 'chiller-1', name: 'Dairy chiller', minC: '0', maxC: '4.5', graceMinutes: '15', expectEvery: '', onBackup: true });
    expect(ho.sent[1]).toEqual({ method: 'POST', path: '/v1/facilities/equipment/chiller-1/range', body: { branchId: 'store-1', name: 'Dairy chiller', minTenthsC: 0, maxTenthsC: 45, graceMinutes: 15, onBackup: true } });
    expect(await s.logService('chiller-1', { performedOn: '2026-10-31', performedBy: 'Cool Air', kind: 'breakdown', notes: '', cost: '', spares: { 'fan-motor': '1.5' } })).toEqual({ result: 'invalid', why: 'needQty' });
    await s.logService('chiller-1', { performedOn: '2026-10-31', performedBy: 'Cool Air', kind: 'breakdown', notes: 'fan changed', cost: '1,800', spares: { 'fan-motor': '1', gasket: '', relay: '0' } });
    expect(ho.sent[2]!.body).toEqual({ performedOn: '2026-10-31', performedBy: 'Cool Air', kind: 'breakdown', notes: 'fan changed', costMinor: 180000, sparesUsed: [{ sparePartId: 'fan-motor', qty: 1 }] });
    expect(await s.correctSpare('fan-motor', '-1', '2026-10-31', '')).toEqual({ result: 'invalid', why: 'needReason' });
    await s.raiseTask('pest', '2026-11-05');
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/facilities/schedules/pest/tasks/pest-2026-11-05', body: { dueOn: '2026-11-05' } });
  });

  it('sends nothing for a viewer without the words, with no store, or nobody; and reads only what the role may', async () => {
    const ho = fakeHeadOffice(() => ({ assets: [], equipment: [], spares: [], schedules: [], checks: [] }));
    const reader = createFacilitiesSetupSession({ viewer: { userId: 'u-x', permissions: ['facilities.asset.read'] }, storeId: 'store-1', fetch: ho.fetch });
    expect(await reader.saveAsset({ name: 'x', kind: 'other', criticality: 'routine', installedOn: '2026-01-01', warrantyUntil: '', amcUntil: '', amcVendor: '', serviceEveryDays: '', protectsValue: '', active: true })).toEqual({ result: 'invalid', why: 'cannotManage' });
    const read = await reader.read();
    expect(read.assets.result).toBe('ok');
    expect(read.schedules).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.sent.map((x) => x.path)).toEqual(['/v1/facilities/office?branchId=store-1', '/v1/facilities/spares?branchId=store-1']);
    expect((await createFacilitiesSetupSession({ viewer: MANAGER, fetch: ho.fetch }).read()).assets).toEqual({ result: 'invalid', why: 'noStore' });
    expect((await createFacilitiesSetupSession({ viewer: undefined, storeId: 's', fetch: ho.fetch }).read()).checks).toEqual({ result: 'invalid', why: 'nobody' });
  });
});

describe('the spare-parts rule (M26-FR-01)', () => {
  const part = (over: Partial<SparePart> = {}): SparePart => ({ sparePartId: 'fan', branchId: 'store-1', name: 'Fan motor', compatibleAssetIds: ['chiller-1'], minimumLevel: 2, unit: 'each', active: true, definedBy: 'u', definedAt: 't', ...over });
  const mv = (qty: number, id: string): SpareMovement => ({ movementId: id, sparePartId: 'fan', kind: qty > 0 ? 'received' : 'used', qty, on: '2026-10-31', by: 'u', at: 't' });
  it('on hand is the sum of the movements; low below the level wanted', () => {
    const ms = [mv(3, 'a'), mv(-2, 'b')];
    expect(onHandOf('fan', ms)).toBe(1);
    expect(sparesView([part()], ms, 'store-1')[0]).toMatchObject({ onHand: 1, low: true });
    expect(sparesView([part({ minimumLevel: 0 })], ms, 'store-1')[0]!.low).toBe(false);
  });
  it('a draw is refused when the part is unknown, not in use, does not fit, or two lines together are more than on hand', () => {
    const ms = [mv(2, 'a')];
    expect(drawProblem([{ sparePartId: 'x', qty: 1 }], 'chiller-1', [part()], ms)).toEqual({ problem: 'unknown_part', sparePartId: 'x' });
    expect(drawProblem([{ sparePartId: 'fan', qty: 1 }], 'chiller-1', [part({ active: false })], ms)).toEqual({ problem: 'part_inactive', sparePartId: 'fan' });
    expect(drawProblem([{ sparePartId: 'fan', qty: 1 }], 'dg-1', [part()], ms)).toEqual({ problem: 'not_compatible', sparePartId: 'fan', assetId: 'dg-1' });
    expect(drawProblem([{ sparePartId: 'fan', qty: 1 }, { sparePartId: 'fan', qty: 2 }], 'chiller-1', [part()], ms)).toEqual({ problem: 'not_enough', sparePartId: 'fan', onHand: 2, wanted: 3 });
    expect(drawProblem([{ sparePartId: 'fan', qty: 2 }], 'chiller-1', [part()], ms)).toBeNull();
  });
});
