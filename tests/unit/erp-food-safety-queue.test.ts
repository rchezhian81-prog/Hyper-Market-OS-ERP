import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { createFoodSafetyQueue, FOOD_SAFETY_COPY, foodSafetyKeyFor, tenthsOf, type HeldFoodSafety } from '../../apps/web-erp/src/food-safety-queue';
import type { FoodSafetyCheck } from '../../packages/facilities/src/food-safety';

// OB-288 lane 2 · P2 — M10-FR-02 "evidence captured offline; queued": the facilities screen works out today's food-safety
// slots from head office's checks in force (the same engine), refuses what head office would refuse BEFORE saving, saves a
// check once on this device in the person's name, timed by when it was done, and says every state in English and Tamil.

const NOW = '2026-10-23T05:10:00.000Z';
const CHILLER: FoodSafetyCheck = {
  checkId: 'chk-chiller', branchId: 'S1', title: 'Dairy chiller temperature', kind: 'temperature', everyMinutes: 240,
  startsAt: '2026-10-22T00:00:00.000Z', graceMinutes: 30, minTenthsC: 0, maxTenthsC: 50, items: [], assignedRole: 'store_manager',
  escalatesTo: 'u-owner', active: true,
};
const CLEAN: FoodSafetyCheck = {
  checkId: 'chk-slicer', branchId: 'S1', title: 'Slicer clean-down', kind: 'cleaning', everyMinutes: 1440,
  startsAt: '2026-10-22T05:00:00.000Z', graceMinutes: 60, items: [{ itemId: 'blade', label: 'Blade washed' }, { itemId: 'guard', label: 'Guard sanitised' }],
  assignedRole: 'store_manager', escalatesTo: 'u-owner', active: true,
};
const HELD: HeldFoodSafety = {
  asAt: '2026-10-23T05:00:00.000Z', ageMinutes: 10, checks: [CHILLER, CLEAN],
  slots: [{ checkId: 'chk-chiller', slotDueAt: '2026-10-23T00:00:00.000Z', state: 'done', performedBy: 'u-mgr' }],
};
const queueOf = (held: HeldFoodSafety | null = HELD, userId: string | null = 'u-mgr', storeId: string | null = 'S1') => {
  const outbox = new SyncOutbox();
  let n = 0;
  return { outbox, q: createFoodSafetyQueue({ userId, storeId, now: () => NOW, freshId: () => `fs-${++n}` }, held, outbox) };
};

describe('the facilities screen\'s food-safety checks through the store computer', () => {
  it('lays head office\'s word over today\'s slots: done there, due now, and what is missed', () => {
    const { q } = queueOf();
    const v = q.view('en');
    expect(v.known).toBe(true);
    expect(v.asAtWords).toContain(HELD.asAt);
    const chiller = v.rows.filter((r) => r.checkId === 'chk-chiller');
    expect(chiller.find((r) => r.slotDueAt === '2026-10-23T00:00:00.000Z')).toMatchObject({ state: 'done_ho', canRecord: false, icon: '✓' });
    expect(chiller.find((r) => r.slotDueAt === '2026-10-23T04:00:00.000Z')).toMatchObject({ state: 'missed', canRecord: true, icon: '✕', stateWord: 'Missed — do it now' });
    expect(v.rows.find((r) => r.checkId === 'chk-slicer' && r.slotDueAt === '2026-10-23T05:00:00.000Z')).toMatchObject({ state: 'due', canRecord: true, items: CLEAN.items });
    // Missed first: a person sees what is late at the top.
    expect(v.rows[0]!.state).toBe('missed');
  });

  it('saves a check once in the person\'s name, timed when it was done, and the slot reads "saved on this screen"', () => {
    const { outbox, q } = queueOf();
    const out = q.record('en', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: '3.5' });
    expect(out).toEqual({ ok: true, recordId: 'fs-1' });
    expect(outbox.all().map((i) => i.key)).toEqual([foodSafetyKeyFor('fs-1')]);
    expect(outbox.all()[0]!.event).toMatchObject({
      type: 'FoodSafetyCheckRecorded', idempotencyKey: 'food-safety:fs-1',
      payload: { recordId: 'fs-1', checkId: 'chk-chiller', storeId: 'S1', performedBy: 'u-mgr', at: NOW, slotDueAt: '2026-10-23T04:00:00.000Z', readingTenthsC: 35, source: 'facilities-screen' },
    });
    const row = q.view('ta').rows.find((r) => r.slotDueAt === '2026-10-23T04:00:00.000Z' && r.checkId === 'chk-chiller')!;
    expect(row).toMatchObject({ state: 'saved_here', canRecord: false, saved: { state: 'saved_here', stateWord: FOOD_SAFETY_COPY.ta.stSavedHere } });
  });

  it('refuses what head office would refuse, in the screen\'s language, and saves nothing', () => {
    const { outbox, q } = queueOf();
    expect(q.record('en', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: '' })).toMatchObject({ ok: false, code: 'reading_required' });
    expect(q.record('ta', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: '9' })).toEqual({ ok: false, code: 'corrective_action_required', words: FOOD_SAFETY_COPY.ta.rf_corrective_action_required });
    expect(q.record('en', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: 'cold' })).toMatchObject({ ok: false, code: 'bad_reading' });
    expect(q.record('en', { checkId: 'chk-slicer', slotDueAt: '2026-10-23T05:00:00.000Z', itemResults: { blade: 'pass' } })).toMatchObject({ ok: false, code: 'items_incomplete', words: FOOD_SAFETY_COPY.en.rf_items_incomplete });
    expect(q.record('en', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T05:30:00.000Z', readingC: '3' })).toMatchObject({ ok: false, code: 'not_a_slot' });
    expect(q.record('en', { checkId: 'chk-nope', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: '3' })).toMatchObject({ ok: false, code: 'unknown_check' });
    expect(outbox.all()).toHaveLength(0);
    // A failed check WITH the corrective action written down is saved — the failure is kept, never hidden.
    expect(q.record('en', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: '9', correctiveAction: 'Moved stock to the walk-in; engineer called' }).ok).toBe(true);
  });

  it('saves nothing in nobody\'s name or for no store, and says when head office\'s checks were never heard', () => {
    expect(queueOf(HELD, null).q.record('en', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: '3' })).toMatchObject({ ok: false, code: 'nobody' });
    expect(queueOf(HELD, null).q.view('en').rows.every((r) => !r.canRecord)).toBe(true);
    expect(queueOf(HELD, 'u-mgr', null).q.record('en', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: '3' })).toMatchObject({ ok: false, code: 'no_store' });
    const unknown = queueOf(null).q.view('ta');
    expect(unknown).toEqual({ known: false, asAtWords: FOOD_SAFETY_COPY.ta.fsNotKnown, rows: [] });
  });

  it('shows the box\'s word, and a refusal with its reason opens the slot again', () => {
    const { outbox, q } = queueOf();
    q.record('en', { checkId: 'chk-chiller', slotDueAt: '2026-10-23T04:00:00.000Z', readingC: '4' });
    outbox.acknowledge('food-safety:fs-1');
    expect(q.handedKeys()).toEqual(['food-safety:fs-1']);
    q.noteBoxStatus([{ key: 'food-safety:fs-1', state: 'refused', attempts: 1, reason: 'check_already_recorded' }]);
    const row = q.view('en').rows.find((r) => r.checkId === 'chk-chiller' && r.slotDueAt === '2026-10-23T04:00:00.000Z')!;
    expect(row).toMatchObject({ state: 'missed', canRecord: true, saved: { state: 'refused', stateWord: 'Refused — a person must look' } });
    expect(row.saved!.reason).toContain('check_already_recorded');
    q.noteBoxStatus([{ key: 'food-safety:fs-1', state: 'posted', attempts: 1 }]);
    expect(q.view('en').rows.find((r) => r.checkId === 'chk-chiller' && r.slotDueAt === '2026-10-23T04:00:00.000Z')!.saved!.stateWord).toBe('Booked at head office');
  });

  it('reads a typed temperature exactly, and has every word in English and Tamil', () => {
    expect([tenthsOf('4'), tenthsOf('3.5'), tenthsOf('-18'), tenthsOf(' 0.5 '), tenthsOf('3.55'), tenthsOf('x')]).toEqual([40, 35, -180, 5, undefined, undefined]);
    expect(Object.keys(FOOD_SAFETY_COPY.ta).sort()).toEqual(Object.keys(FOOD_SAFETY_COPY.en).sort());
    for (const v of Object.values(FOOD_SAFETY_COPY.ta)) expect(v).toMatch(/[஀-௿]/);
  });
});
