import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { createBoxQueue, STATE_KEYS } from '../../apps/web-erp/src/lpw-box-queue';
import { createHelpSession, ackKeyFor, HELP_COPY, type HeldLibrary } from '../../apps/web-erp/src/help-session';
import { createEquipmentReadingQueue, createFacilitiesOfficeSession, tenthsOf, degrees } from '../../apps/web-erp/src/facilities-office-session';
import { createWriteOffQueue, createWriteOffDecideSession } from '../../apps/web-erp/src/write-off-queue-session';
import { createRelabelSession, paiseOf, relabelAssigneeWords } from '../../apps/web-erp/src/relabel-session';
import { createAppointmentLettersSession } from '../../apps/web-erp/src/appointment-letters-session';
import { createRelatedPartiesSession } from '../../apps/web-erp/src/related-parties-session';
import { RELAYABLE_DEVICE_EVENTS } from '../../packages/sync/src/device-relay';
import { EVENT_ROUTES } from '../../edge/sync-agent/src/http-transport';

// The OB-288 LP/workforce package's page sessions (DOM-free): what each sends, what it refuses before sending, and the box
// queues that keep work done with the line down (§31 · P-01 · P-08). Synthetic data only.

type Sent = { method: string; path: string; body: unknown; key: string | null };
function fakeFetch(answer: (s: Sent) => { status: number; body: unknown } = () => ({ status: 200, body: {} })): { fetch: typeof globalThis.fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const s: Sent = { method: init?.method ?? 'GET', path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), key: headers['idempotency-key'] ?? null };
    sent.push(s);
    const a = answer(s);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const NOW = '2026-10-24T05:00:00.000Z';

describe('the box queue (lpw-box-queue)', () => {
  it('saves once per key, says where each item has got to, and keeps a refusal with its reason', () => {
    const outbox = new SyncOutbox();
    const q = createBoxQueue<{ n: number }>('SopAcknowledged', 'web-erp/help', outbox);
    q.enqueue('k1', { n: 1 }, NOW);
    q.enqueue('k1', { n: 2 }, NOW); // the same key is the same item
    expect(q.items().map((i) => [i.key, i.payload.n, i.state])).toEqual([['k1', 1, 'saved_here']]);
    outbox.acknowledge('k1');
    expect(q.items()[0]!.state).toBe('handed_to_box');
    expect(q.handedKeys()).toEqual(['k1']);
    q.noteBoxStatus([{ key: 'k1', state: 'refused', attempts: 1, reason: 'u-it holds no right to acknowledge SOPs here' }]);
    expect(q.items()[0]).toMatchObject({ state: 'refused', reason: 'u-it holds no right to acknowledge SOPs here' });
    expect(STATE_KEYS.refused).toBe('stRefused');
  });

  it('every event a page queues is on the box\'s allow-list and has a head-office route', () => {
    for (const type of ['SopAcknowledged', 'EquipmentReadingRecorded', 'WriteOffCaptured']) {
      expect(RELAYABLE_DEVICE_EVENTS[type]?.surfaces, type).toContain('manager');
      expect(EVENT_ROUTES[type], type).toBeDefined();
    }
  });
});

describe('the help page (M25-FR-04 · D11-FR-06)', () => {
  const library: HeldLibrary = {
    asAt: NOW, ageMinutes: 5, contactsSet: true, emergencyContacts: [{ label: 'Fire service', labelTa: 'தீயணைப்பு', phone: '101' }],
    sops: [
      { sopId: 'EM-FIRE', title: 'Fire', titleTa: 'தீ', version: 2, forRoles: ['cashier'], category: 'emergency', bodyEn: 'Get out.', bodyTa: 'வெளியேறு.' },
      { sopId: 'SOP-01', title: 'PC down', titleTa: 'கணினி', version: 1, forRoles: ['cashier', 'store_manager'], category: 'procedure', bodyEn: 'Paper.', bodyTa: 'காகிதம்.' },
      { sopId: 'SOP-03', title: 'Owner only', titleTa: 'உரிமையாளர்', version: 1, forRoles: ['owner'], category: 'procedure', bodyEn: 'x', bodyTa: 'x' },
    ],
    people: [{ employeeId: 'u-cash', roles: ['cashier'] }],
    acknowledgements: [{ employeeId: 'u-cash', sopId: 'EM-FIRE', version: 1 }],
  };

  it('on the store computer: the person\'s own roles only, an old version is still to read, an acknowledgement is saved here for the box', async () => {
    const outbox = new SyncOutbox();
    const s = createHelpSession({ data: { userId: 'u-cash', permissions: ['workforce.help.read', 'workforce.sop.ack.self'], storeId: 'br-1', library }, onBox: true, outbox, now: () => NOW });
    expect(s.may).toMatchObject({ named: true, onBox: true, manage: false });
    const v = await s.view('en');
    if (v.result !== 'ok') throw new Error('view');
    expect(v.value.rows.map((r) => [r.sopId, r.upToDate])).toEqual([['EM-FIRE', false], ['SOP-01', false]]); // never the owner's sheet
    expect(v.value.outstanding).toBe(2);
    const ta = await s.view('ta');
    expect(ta.result === 'ok' && ta.value.contacts.list[0]!.label).toBe('தீயணைப்பு');
    expect((await s.acknowledge('EM-FIRE', 2)).result).toBe('ok');
    const item = outbox.all()[0]!;
    expect([item.key, item.event.type, item.event.payload]).toEqual([ackKeyFor('u-cash', 'EM-FIRE', 2), 'SopAcknowledged', { sopId: 'EM-FIRE', employeeId: 'u-cash', version: 2, acknowledgedAt: NOW }]);
    const after = await s.view('en');
    expect(after.result === 'ok' && after.value.rows[0]).toMatchObject({ upToDate: true, saved: { state: 'saved_here', stateWord: HELP_COPY.en.stSavedHere } });
  });

  it('the box never told: said, never an empty list passed off as "nothing to read"; nobody signed in acknowledges nothing', async () => {
    const outbox = new SyncOutbox();
    const unknown = createHelpSession({ data: { permissions: [], storeId: 'br-1', library: null }, onBox: true, outbox });
    const v = await unknown.view('en');
    expect(v.result === 'ok' && [v.value.known, v.value.asAtWords]).toEqual([false, HELP_COPY.en.noLibrary]);
    expect((await unknown.acknowledge('SOP-01', 1)).result).toBe('invalid');
    expect(outbox.all()).toEqual([]);
  });

  it('at head office: reads live, acknowledges directly; a manager writes a procedure only with both languages', async () => {
    const f = fakeFetch((s) => ({ status: 200, body: s.path === '/v1/hr/workforce/help' ? { sops: [{ sopId: 'SOP-01', forMe: true, upToDate: false }, { sopId: 'SOP-03', forMe: false, upToDate: false }], outstanding: 1, emergencyContacts: { set: false, contacts: [] } } : {} }));
    const s = createHelpSession({ data: { userId: 'u-mgr', permissions: ['workforce.help.read', 'workforce.roster.manage', 'workforce.training.manage'] }, onBox: false, fetch: f.fetch, newKey: () => 'k' });
    expect(s.may).toMatchObject({ manage: true, drills: true, contacts: false, onBox: false });
    const v = await s.view('en');
    expect(v.result === 'ok' && v.value.rows.map((r) => r.sopId)).toEqual(['SOP-01']);
    await s.acknowledge('SOP-01', 1);
    expect(f.sent.at(-1)).toMatchObject({ method: 'POST', path: '/v1/hr/workforce/sops/SOP-01/acknowledge', body: { version: 1 }, key: 'k' });
    expect((await s.write({ sopId: 'EM-1', title: 'Fire', titleTa: '', version: '1', roles: 'cashier', category: 'emergency', bodyEn: 'Out', bodyTa: 'வெளியே' })).result).toBe('invalid');
    expect((await s.recordDrill({ sopId: 'EM-1', branchId: 'br-1', heldOn: '2026-10-20', participants: '', findings: 'ok' })).result).toBe('invalid');
    expect((await s.setContacts('Fire service 101')).result).toBe('invalid'); // no comma: which part is the phone is not guessed
    const sentBefore = f.sent.length;
    await s.write({ sopId: 'EM-1', title: 'Fire', titleTa: 'தீ', version: '1', roles: 'cashier, store_manager', category: 'emergency', bodyEn: 'Out', bodyTa: 'வெளியே' });
    expect(f.sent.length).toBe(sentBefore + 1);
    expect(f.sent.at(-1)).toMatchObject({ path: '/v1/hr/workforce/help/sops/EM-1', body: { forRoles: ['cashier', 'store_manager'], version: 1, category: 'emergency' } });
  });
});

describe('the facilities page — office read and manual readings (M26-FR-01/02/04)', () => {
  it('a temperature is read as typed, never guessed', () => {
    expect([tenthsOf('3.5'), tenthsOf('-18'), tenthsOf('4,2'), tenthsOf(' 0 '), tenthsOf('3.55'), tenthsOf('cold'), tenthsOf('')]).toEqual([35, -180, 42, 0, undefined, undefined, undefined]);
    expect(degrees(-180)).toBe('-18.0°C');
  });

  it('a reading is saved here for the box in the person\'s name, timed when taken; refused for a person without the right', () => {
    const held = { asAt: NOW, ageMinutes: 2, items: [{ assetId: 'cold-1', name: 'Cold room 1', range: { minTenthsC: 0, maxTenthsC: 80 }, lastReadingAt: null }] };
    const outbox = new SyncOutbox();
    const q = createEquipmentReadingQueue({ userId: 'u-mgr', storeId: 'br-1', permissions: ['facilities.reading.record'], now: () => NOW }, held, outbox);
    expect(q.record('en', { assetId: 'cold-1', reading: 'warm', source: 'manual_probe' })).toMatchObject({ ok: false });
    expect(q.record('en', { assetId: 'cold-1', reading: '4', source: 'manual_probe' })).toEqual({ ok: true });
    const item = outbox.all()[0]!;
    expect([item.event.type, item.event.payload]).toEqual(['EquipmentReadingRecorded', { assetId: 'cold-1', readingId: item.key, tenthsC: 40, at: NOW, source: 'manual_probe', recordedBy: 'u-mgr', storeId: 'br-1' }]);
    expect(q.view('en').rows[0]!.saved.map((s) => s.state)).toEqual(['saved_here']);
    const cashier = createEquipmentReadingQueue({ userId: 'u-cash', storeId: 'br-1', permissions: [], now: () => NOW }, held, new SyncOutbox());
    expect([cashier.canRecord, cashier.record('ta', { assetId: 'cold-1', reading: '4', source: 'manual_probe' }).ok]).toEqual([false, false]);
    expect(createEquipmentReadingQueue({ userId: 'u-mgr', storeId: 'br-1', permissions: ['facilities.reading.record'], now: () => NOW }, null, new SyncOutbox()).view('en').known).toBe(false);
  });

  it('the office read names the store and is a read only', async () => {
    const f = fakeFetch();
    const s = createFacilitiesOfficeSession({ viewer: { userId: 'u-mgr', permissions: ['facilities.asset.read'] }, fetch: f.fetch });
    expect((await s.read(' ', '')).result).toBe('invalid');
    await s.read('br-1', '2026-10-20');
    expect(f.sent).toEqual([{ method: 'GET', path: '/v1/facilities/office?branchId=br-1&asOf=2026-10-20', body: undefined, key: null }]);
    expect(createFacilitiesOfficeSession({ viewer: { userId: 'u-cash', permissions: [] } }).may.read).toBe(false);
  });
});

describe('the write-off capture page with the line down (M28-FR-01)', () => {
  it('a loss is saved here only with the closed lists chosen — never typed or defaulted — and carries who and when', () => {
    const outbox = new SyncOutbox();
    const q = createWriteOffQueue({ userId: 'u-mgr', storeId: 'br-1', permissions: ['inventory.movement.append'], now: () => NOW, newId: () => 'WO-1' }, outbox);
    const base = { productId: 'MILK', locationId: 'br-1', qty: '2', uom: 'ea', lossType: 'damage', reasonCode: 'damage', evidenceRef: '' };
    expect(q.save('en', { ...base, reasonCode: '' }).ok).toBe(false);
    expect(q.save('en', { ...base, reasonCode: 'leaking' }).ok).toBe(false);
    expect(q.save('en', { ...base, qty: '1.5' }).ok).toBe(false);
    expect(q.save('en', base)).toEqual({ ok: true, writeOffId: 'WO-1' });
    expect(outbox.all()[0]!.event.payload).toEqual({ writeOffId: 'WO-1', productId: 'MILK', locationId: 'br-1', qty: 2, uom: 'ea', lossType: 'damage', reasonCode: 'damage', raisedBy: 'u-mgr', capturedAt: NOW, storeId: 'br-1' });
    expect(q.saved('ta')[0]!.words).toContain('இந்தத் திரையில் சேமிக்கப்பட்டது');
    expect(createWriteOffQueue({ userId: 'u-cash', storeId: 'br-1', permissions: [], now: () => NOW }, new SyncOutbox()).save('en', base).ok).toBe(false);
  });

  it('the second person decides with a reason', async () => {
    const f = fakeFetch();
    const s = createWriteOffDecideSession({ viewer: { userId: 'u-mgr2', permissions: ['waste.view', 'inventory.movement.append'] }, fetch: f.fetch, newKey: () => 'k' });
    expect((await s.decide('WO-3', 'approved', ' ')).result).toBe('invalid');
    await s.decide('WO-3', 'approved', 'saw the crate');
    expect(f.sent).toEqual([{ method: 'POST', path: '/v1/inventory/write-off-captures/WO-3/decide', body: { decision: 'approved', reason: 'saw the crate' }, key: 'k' }]);
  });
});

describe('relabel tasks, appointment letters, related parties', () => {
  it('relabel: the label\'s price as typed in rupees, and the photo, before anything is sent', async () => {
    expect([paiseOf('18'), paiseOf('18.5'), paiseOf('18.50'), paiseOf('18.505'), paiseOf('₹18'), paiseOf('')]).toEqual([1_800, 1_850, 1_850, undefined, undefined, undefined]);
    const f = fakeFetch();
    const s = createRelabelSession({ viewer: { userId: 'u-mgr', permissions: ['workforce.task.read', 'workforce.task.complete.own'] }, fetch: f.fetch, newKey: () => 'k' });
    expect((await s.close('RL-1', '18', '')).result).toBe('invalid');
    await s.close('RL-1', '18', 'photo-1');
    expect(f.sent).toEqual([{ method: 'POST', path: '/v1/pricing/relabel-tasks/RL-1/done', body: { shelfPriceMinor: 1_800, evidenceRef: 'photo-1' }, key: 'k' }]);
    // OB-358: a floor champion who is not a manager reads only their OWN relabel tasks (the My tasks page), and closes them.
    expect(createRelabelSession({ viewer: { userId: 'u-cash', permissions: ['workforce.task.complete.own'] } }).may).toEqual({ read: false, close: true, readMine: true });
    expect(createRelabelSession({ viewer: { userId: 'u-x', permissions: [] } }).may).toEqual({ read: false, close: false, readMine: false });
    await s.mine();
    expect(f.sent.at(-1)).toMatchObject({ method: 'GET', path: '/v1/pricing/relabel-tasks/mine' });
  });

  it('OB-358: who a relabel task is for, in words — the champion, or the store manager and why; mine marked; nobody in the role said', () => {
    expect(relabelAssigneeWords('en', { assignee: { to: 'floor_champion', departmentId: 'D-dairy', employeeId: 'u-asha' }, assignedToMe: true }))
      .toBe('For: u-asha (floor champion of D-dairy) · ✓ yours');
    expect(relabelAssigneeWords('en', { assignee: { to: 'store_manager', departmentId: 'D-grocery', because: 'no_champion_named' }, storeManagers: ['u-mgr'] }))
      .toBe('For: the store manager (u-mgr) — no floor champion named for D-grocery');
    expect(relabelAssigneeWords('en', { assignee: { to: 'store_manager', departmentId: null, because: 'no_department_owns_it' }, storeManagers: [] }))
      .toBe('For: the store manager — ⚠ nobody holds the store manager role here (not set) — no department owns this product here');
    expect(relabelAssigneeWords('en', { assignee: null })).toBe('For: not assigned (raised before tasks were assigned)');
    expect(relabelAssigneeWords('ta', { assignee: { to: 'store_manager', departmentId: 'D-dairy', because: 'champion_left' }, storeManagers: ['u-mgr'] })).toMatch(/^யாருக்கு: கடை மேலாளர் \(u-mgr\) — தளச் சாம்பியன் விலகிவிட்டார் — D-dairy$/);
  });

  it('appointment letters: a letter needs the person and the day; the signed copy must be chosen first', async () => {
    const f = fakeFetch();
    const s = createAppointmentLettersSession({ viewer: { userId: 'u-mgr', permissions: ['hr.appointmentletter.issue'] }, fetch: f.fetch, newKey: () => 'k', newLetterId: () => 'AL-1' });
    expect(s.may).toEqual({ named: true, open: true, wording: false });
    expect((await s.make('u-cash', '24/10/2026')).result).toBe('invalid');
    expect((await s.keepSignedCopy('AL-1', null)).result).toBe('invalid');
    expect((await s.setWording('Dear {{employeeName}}', '')).result).toBe('invalid');
    await s.make('u-cash', '2026-11-01');
    expect(f.sent).toEqual([{ method: 'POST', path: '/v1/hr/workforce/employees/u-cash/appointment-letters/AL-1', body: { effectiveFrom: '2026-11-01' }, key: 'k' }]);
  });

  it('related parties: an entry comes off the list by its own door, with a reason — its facts are never re-sent', async () => {
    const f = fakeFetch();
    const s = createRelatedPartiesSession({ viewer: { userId: 'u-owner', permissions: ['lp.case.read', 'lp.relatedparty.manage'] }, fetch: f.fetch, newKey: () => 'k' });
    expect((await s.takeOff('RP-1', '')).result).toBe('invalid');
    await s.takeOff('RP-1', 'no longer related');
    expect(f.sent).toEqual([{ method: 'POST', path: '/v1/loss-prevention/related-parties/RP-1/take-off', body: { reason: 'no longer related' }, key: 'k' }]);
  });
});
