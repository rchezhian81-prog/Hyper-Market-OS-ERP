import { describe, it, expect } from 'vitest';
import {
  createStoreOpsSession, wordsFor, outcomeWords, slotWords, taskWords, bandWords, splitToday, startOfToday, endOfTodayField, OB163_BANDS,
  STORE_OPS_COPY, COPY_KEYS, type FoodSafetyCheckDef, type StoreTask, type FoodSafetyBoard,
} from '../../apps/web-erp/src/store-ops-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// OB-154 (owner, 16 Oct 2026, "Add screens before pilot"): the session behind the food-safety, price-mismatch, store-task,
// my-task and waste-analytics pages. It never writes on open, sends only what a person typed, refuses only the cheap things
// before a POST, and hands head office's refusal back in head office's words.

interface Sent { method: string; path: string; body: unknown; key: string | undefined }
function fakeHttp(answer: (s: Sent) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const s = { method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body), key: init.headers['idempotency-key'] };
    sent.push(s);
    const a = answer(s);
    return { ok: a.status < 300, status: a.status, json: async () => a.body };
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const ALL = ['facilities.overdue.read', 'facilities.task.record', 'price.integrity.audit', 'workforce.task.read', 'workforce.roster.manage', 'workforce.task.complete.own', 'waste.view'];
const session = (perms: readonly string[] = ALL, http = fakeHttp(), userId: string | null = 'u-mgr') =>
  ({ http, s: createStoreOpsSession({ viewer: userId === null ? undefined : { userId, permissions: [...perms] }, fetch: http.fetch, newKey: () => 'k-1', newId: (p) => `${p}-1`, now: () => new Date('2026-10-16T09:30:00+05:30') }) });

const chiller: FoodSafetyCheckDef = { checkId: 'chiller', branchId: 'BR1', title: 'Chiller', kind: 'temperature', minTenthsC: 0, maxTenthsC: 50, items: [], active: true };
const clean: FoodSafetyCheckDef = { checkId: 'clean', branchId: 'BR1', title: 'Deli clean', kind: 'cleaning', items: [{ itemId: 'boards', label: 'Boards' }], active: true };
const dock: FoodSafetyCheckDef = { checkId: 'dock', branchId: 'BR1', title: 'Delivery', kind: 'receiving', items: [{ itemId: 'pack', label: 'Pack' }], active: true };

describe('the words are complete in both languages', () => {
  it('has no gap in English or Tamil', () => {
    const gaps = bilingualGaps(STORE_OPS_COPY, COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });
  it('OB-163: the four ageing bands read in the owner\'s words, in his order', () => {
    expect(OB163_BANDS).toEqual(['under 1 day', '1-3 days', '3-7 days', 'over 7 days']);
    expect(OB163_BANDS.map((b) => bandWords('en', b))).toEqual(['Under 1 day', '1–3 days', '3–7 days', 'Over 7 days']);
    expect(bandWords('ta', 'over 7 days')).toBe('7 நாட்களுக்கு மேல்');
  });
  it('a missed check and an escalated task read as an error with a word and an icon — never colour alone', () => {
    expect(slotWords('en', { state: 'missed' })).toEqual({ label: 'MISSED', tone: 'error', icon: '✕' });
    expect(taskWords('en', { status: 'escalated' })).toMatchObject({ label: 'Escalated', tone: 'error' });
    expect(wordsFor('en', 'prChecked', { n: 3 })).toBe('3 product(s) checked');
  });
});

describe('what a person may do shapes what the pages offer', () => {
  it('nobody signed in reads nothing and sends nothing', async () => {
    const { s, http } = session(ALL, fakeHttp(), null);
    expect(s.may.named).toBe(false);
    expect(await s.foodSafetyToday()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await s.taskBoard()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(http.sent).toEqual([]);
  });
  it('a person without the read is told so, and nothing is asked', async () => {
    const { s, http } = session(['workforce.task.complete.own']);
    expect(s.may).toMatchObject({ readChecks: false, readTasks: false, ownTasks: true, readWaste: false, readPrices: false });
    expect(await s.wasteAnalytics('2026-10-01', '2026-10-16')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await s.priceAgeing('BR1')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(http.sent).toEqual([]);
  });
});

describe('food-safety checks', () => {
  it('reads today from the start of the reader\'s own day', async () => {
    const { s, http } = session();
    await s.foodSafetyToday();
    expect(http.sent[0]!.method).toBe('GET');
    expect(http.sent[0]!.path).toBe(`/v1/facilities/food-safety/status?from=${encodeURIComponent(startOfToday(new Date('2026-10-16T09:30:00+05:30')))}`);
  });
  it('splits the board into missed, due, done (with how many failed) and later', () => {
    const slot = (state: string, checkId = 'c') => ({ checkId, title: 't', kind: 'temperature', branchId: 'BR1', slotDueAt: `2026-10-16T0${state.length % 9}:00:00.000Z`, state, detail: '' });
    const board = { slots: ['missed', 'due', 'done', 'done_failed', 'done_late', 'upcoming'].map((x) => slot(x)), missedCount: 1, failedCount: 1, checks: [], receiving: [] } as unknown as FoodSafetyBoard;
    const split = splitToday(board);
    expect([split.missed.length, split.due.length, split.done.length, split.later.length, split.failed]).toEqual([1, 1, 3, 1, 1]);
  });
  it('a reading is sent in tenths of a degree; a failure with no action is refused before a POST', async () => {
    const { s, http } = session(ALL, fakeHttp(() => ({ status: 201, body: { record: { outcome: 'pass', late: false } } })));
    expect(await s.recordCheck(chiller, { checkId: 'chiller', slotDueAt: 'T', readingC: 'warm', itemResults: {}, correctiveAction: '' })).toEqual({ result: 'invalid', why: 'badNumber' });
    expect(await s.recordCheck(chiller, { checkId: 'chiller', slotDueAt: 'T', readingC: '9.2', itemResults: {}, correctiveAction: ' ' })).toEqual({ result: 'invalid', why: 'needAction' });
    expect(await s.recordCheck(clean, { checkId: 'clean', slotDueAt: 'T', readingC: '', itemResults: { boards: '' }, correctiveAction: '' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.recordCheck(clean, { checkId: 'clean', slotDueAt: 'T', readingC: '', itemResults: { boards: 'fail' }, correctiveAction: '' })).toEqual({ result: 'invalid', why: 'needAction' });
    expect(http.sent).toEqual([]);
    expect(await s.recordCheck(chiller, { checkId: 'chiller', slotDueAt: '2026-10-16T03:00:00.000Z', readingC: '3.5', itemResults: {}, correctiveAction: '' })).toEqual({ result: 'ok', value: { outcome: 'pass', late: false } });
    expect(http.sent[0]).toEqual({ method: 'POST', path: '/v1/facilities/food-safety/checks/chiller/records/fsr-1', body: { slotDueAt: '2026-10-16T03:00:00.000Z', readingTenthsC: 35 }, key: 'k-1' });
  });
  it('a delivery checklist names its goods receipt, never a slot', async () => {
    const { s, http } = session(ALL, fakeHttp(() => ({ status: 201, body: { record: { outcome: 'pass', late: false } } })));
    expect(await s.recordCheck(dock, { checkId: 'dock', subjectRef: ' ', readingC: '', itemResults: { pack: 'pass' }, correctiveAction: '' })).toEqual({ result: 'invalid', why: 'needAll' });
    await s.recordCheck(dock, { checkId: 'dock', subjectRef: 'GRN-9', readingC: '', itemResults: { pack: 'pass' }, correctiveAction: '' });
    expect(http.sent[0]!.body).toEqual({ subjectRef: 'GRN-9', itemResults: { pack: 'pass' } });
  });
  it('head office\'s refusal comes back in its own words', async () => {
    const { s } = session(ALL, fakeHttp(() => ({ status: 422, body: { error: { code: 'corrective_action_required', whatHappened: 'write it down' } } })));
    const out = await s.recordCheck(chiller, { checkId: 'chiller', slotDueAt: 'T', readingC: '3', itemResults: {}, correctiveAction: '' });
    expect(out).toEqual({ result: 'refused', status: 422, code: 'corrective_action_required', whatHappened: 'write it down' });
    expect(outcomeWords('en', out)).toBe('Head office refused: write it down');
  });
});

describe('store tasks and my tasks', () => {
  const task: StoreTask = { taskId: 't1', branchId: 'BR1', title: 'Face aisle 4', assignedTo: 'u-ravi', assignedBy: 'u-mgr', dueAt: '2026-10-16T10:00:00.000Z', critical: true, evidenceRequired: true, steps: [{ stepId: 's1', label: 'Front' }], status: 'pending', detail: '' };
  it('assigns with the steps the manager wrote, one per line; a blank field is refused before a POST', async () => {
    const { s, http } = session(ALL, fakeHttp(() => ({ status: 201, body: {} })));
    expect(await s.assignTask({ branchId: 'BR1', title: '', assignedTo: 'u-ravi', dueAt: '2026-10-16T10:00', critical: false, evidenceRequired: false, steps: '' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(http.sent).toEqual([]);
    expect(await s.assignTask({ branchId: 'BR1', title: 'Face aisle 4', assignedTo: 'u-ravi', dueAt: '2026-10-16T10:00:00Z', critical: true, evidenceRequired: true, steps: 'Front\n\n Labels ' })).toEqual({ result: 'ok', value: { taskId: 'task-1' } });
    expect(http.sent[0]).toMatchObject({ method: 'POST', path: '/v1/hr/workforce/assigned-tasks/task-1', body: { branchId: 'BR1', title: 'Face aisle 4', assignedTo: 'u-ravi', dueAt: '2026-10-16T10:00:00.000Z', critical: true, evidenceRequired: true, steps: [{ stepId: 's1', label: 'Front' }, { stepId: 's2', label: 'Labels' }] } });
    expect(JSON.stringify(http.sent[0]!.body)).not.toMatch(/assignedBy/); // the assigner is the signed-in person, at head office
  });
  it('completes only with every step ticked and the evidence asked for — the doer is never named by the page', async () => {
    const { s, http } = session(ALL, fakeHttp(() => ({ status: 201, body: { completion: { lateByMinutes: 30 } } })));
    expect(await s.completeTask(task, { evidenceRef: 'photo', stepsDone: [], note: '' })).toEqual({ result: 'invalid', why: 'needSteps' });
    expect(await s.completeTask(task, { evidenceRef: ' ', stepsDone: ['s1'], note: '' })).toEqual({ result: 'invalid', why: 'needEvidence' });
    expect(http.sent).toEqual([]);
    expect(await s.completeTask(task, { evidenceRef: 'photo-aisle4', stepsDone: ['s1'], note: 'done' })).toEqual({ result: 'ok', value: { lateByMinutes: 30 } });
    expect(http.sent[0]).toEqual({ method: 'POST', path: '/v1/hr/workforce/assigned-tasks/t1/complete', body: { stepsDone: ['s1'], evidenceRefs: ['photo-aisle4'], note: 'done' }, key: 'k-1' });
  });
  it('OB-390: a new task defaults to the end of TODAY (the day startOfToday gives) and the manager\'s own store from the sign-in', async () => {
    // The deadline field holds 23:59 of the reader's own day — the same day the food-safety board calls today.
    const now = new Date('2026-10-16T09:30:00+05:30');
    const day = new Date(startOfToday(now));
    const two = (n: number) => String(n).padStart(2, '0');
    expect(endOfTodayField(now)).toBe(`${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}T23:59`);
    expect(endOfTodayField(now)).toMatch(/^\d{4}-\d{2}-\d{2}T23:59$/);
    expect(Date.parse(endOfTodayField(now))).toBeGreaterThan(Date.parse(startOfToday(now)));
    // The branch is head office's answer about who is signed in — a GET, nothing written.
    const named = session(ALL, fakeHttp(() => ({ status: 200, body: { userId: 'u-mgr', branchId: 'br-1', permissions: [] } })));
    expect(await named.s.myBranch()).toEqual({ result: 'ok', value: { branchId: 'br-1' } });
    expect(named.http.sent).toEqual([{ method: 'GET', path: '/v1/identity/me', body: undefined, key: undefined }]);
    // A sign-in that names no store (head office over several): null — the field is left to fill, never guessed.
    for (const body of [{ userId: 'u-owner' }, { userId: 'u-owner', branchId: '' }, { userId: 'u-owner', branchId: 7 }]) {
      expect(await session(ALL, fakeHttp(() => ({ status: 200, body }))).s.myBranch()).toEqual({ result: 'ok', value: { branchId: null } });
    }
    // Refused or unreachable: said as such; nobody signed in: nothing asked.
    expect(await session(ALL, fakeHttp(() => ({ status: 403, body: { error: { code: 'forbidden', whatHappened: 'no' } } }))).s.myBranch()).toMatchObject({ result: 'refused', status: 403 });
    const nobody = session(ALL, fakeHttp(), null);
    expect(await nobody.s.myBranch()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(nobody.http.sent).toEqual([]);
  });
  it('my tasks and the board are GET reads', async () => {
    const { s, http } = session();
    await s.myTasks(); await s.taskBoard();
    expect(http.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/hr/workforce/my-tasks', 'GET /v1/hr/workforce/assigned-tasks']);
  });
});

describe('price mismatches and waste analytics are reads', () => {
  it('asks for one store\'s report; a blank store is refused before asking', async () => {
    const { s, http } = session();
    expect(await s.priceAgeing(' ')).toEqual({ result: 'invalid', why: 'needAll' });
    await s.priceAgeing('BR 1');
    expect(http.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/pricing/integrity/ageing?branchId=BR%201']);
  });
  it('asks for a window of whole days; a window that runs backwards is refused', async () => {
    const { s, http } = session();
    expect(await s.wasteAnalytics('2026-10-16', '2026-10-01')).toEqual({ result: 'invalid', why: 'badDate' });
    await s.wasteAnalytics('2026-10-01', '2026-10-16');
    expect(http.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/waste/analytics?from=2026-10-01&to=2026-10-16']);
  });
  it('a lost link is said, never a guess', async () => {
    const fetch = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
    const s = createStoreOpsSession({ viewer: { userId: 'u', permissions: ALL }, fetch });
    const out = await s.wasteAnalytics('2026-10-01', '2026-10-16');
    expect(out).toEqual({ result: 'lost_link' });
    expect(outcomeWords('ta', out)).toBe(STORE_OPS_COPY.ta.unreachable);
  });
});
