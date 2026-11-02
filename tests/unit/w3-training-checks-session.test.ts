import { describe, it, expect } from 'vitest';
import { createTrainingChecksSession, itemsFromLines, passMarkOf, TRAINING_CHECKS_COPY } from '../../apps/web-erp/src/training-checks-session';

/**
 * W3 · OB-675 (QG-02): the DOM-free session behind the Training checks page. It refuses the cheap things before anything
 * is sent, asks only with the permission its page holds, sends exactly what head office's route reads, and never reads a
 * pass from a missing word.
 */

type Sent = { method: string; path: string; body: unknown };
function fakeHeadOffice(answer: (method: string, path: string) => { status?: number; body: unknown } = () => ({ body: {} })) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const a = answer(init.method, path);
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const v = (...permissions: string[]) => ({ userId: 'u-x', permissions });

describe('Training checks (OB-675)', () => {
  it('every word has a Tamil twin', () => {
    expect(Object.keys(TRAINING_CHECKS_COPY.ta).sort()).toEqual(Object.keys(TRAINING_CHECKS_COPY.en).sort());
  });

  it('reads the lines as questions and tasks, and a pass mark only as a whole 1–100', () => {
    expect(itemsFromLines(' What is a void?\n\nWhen is a manager needed? ', 'Ring up a weighed item')).toEqual([
      { itemId: 'q1', kind: 'question', text: 'What is a void?' }, { itemId: 'q2', kind: 'question', text: 'When is a manager needed?' },
      { itemId: 't1', kind: 'task', text: 'Ring up a weighed item' },
    ]);
    expect([passMarkOf('80'), passMarkOf(' 100 '), passMarkOf('0'), passMarkOf('101'), passMarkOf('75.5'), passMarkOf('')]).toEqual([80, 100, undefined, undefined, undefined, undefined]);
  });

  it('asks only with its permissions, refuses the cheap things before sending, and sends what the route reads', async () => {
    const ho = fakeHeadOffice((m) => (m === 'POST' ? { status: 201, body: { check: { version: 2 }, attempt: { scorePercent: 75, passMarkPercent: 80, passed: false } } } : { body: {} }));
    const nobody = createTrainingChecksSession({ viewer: undefined, fetch: ho.fetch });
    expect(await nobody.read()).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createTrainingChecksSession({ viewer: v('workforce.roster.read'), fetch: ho.fetch });
    expect(await reader.setCheck('cashier', 'a', '')).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(await reader.setPassMark('cashier', '80')).toEqual({ result: 'invalid', why: 'cannotMark' });
    const mgr = createTrainingChecksSession({ viewer: v('workforce.roster.read', 'workforce.training.manage'), fetch: ho.fetch, newAttemptId: () => 'att-1' });
    expect(await mgr.setCheck('cashier', ' \n ', '')).toEqual({ result: 'invalid', why: 'needLines' });
    expect(await mgr.record('cashier', ' ', [{ itemId: 'q1', passed: true }], '')).toEqual({ result: 'invalid', why: 'needPerson' });
    const owner = createTrainingChecksSession({ viewer: v('workforce.roster.read', 'workforce.curriculum.approve'), fetch: ho.fetch });
    expect(await owner.setPassMark('cashier', 'ninety')).toEqual({ result: 'invalid', why: 'needMark' });
    expect(ho.sent).toEqual([]);

    expect(await mgr.setCheck('cashier', 'Q one', 'T one')).toEqual({ result: 'ok', value: { version: 2 } });
    expect(await owner.setPassMark('cashier', '80')).toEqual({ result: 'ok', value: { passMarkPercent: 80 } });
    expect(await mgr.record('cashier', ' u-cash-1 ', [{ itemId: 'q1', passed: true }, { itemId: 't1', passed: false }], ' retake ')).toEqual({ result: 'ok', value: { scorePercent: 75, passMarkPercent: 80, passed: false } });
    expect(ho.sent).toEqual([
      { method: 'POST', path: '/v1/hr/workforce/role-checks/cashier', body: { items: [{ itemId: 'q1', kind: 'question', text: 'Q one' }, { itemId: 't1', kind: 'task', text: 'T one' }] } },
      { method: 'POST', path: '/v1/hr/workforce/role-checks/cashier/pass-mark', body: { passMarkPercent: 80 } },
      { method: 'POST', path: '/v1/hr/workforce/role-checks/cashier/attempts/att-1', body: { employeeId: 'u-cash-1', results: [{ itemId: 'q1', passed: true }, { itemId: 't1', passed: false }], note: 'retake' } },
    ]);
  });

  it('reads the reading — and anything but an explicit "passed" is not passed', async () => {
    const ho = fakeHeadOffice(() => ({ body: { asAt: '2026-11-02T08:00:00.000Z', roles: [
      { roleId: 'cashier', check: null, items: [], passMarkPercent: null, trained: [], passedCount: 0, passedPercent: null, pilot: 'passed?', why: ['cashier: no check has been set for this role'] },
    ] } }));
    const s = createTrainingChecksSession({ viewer: v('workforce.roster.read'), fetch: ho.fetch });
    const out = await s.read();
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.roles[0]).toMatchObject({ roleId: 'cashier', check: null, passMarkPercent: null, pilot: 'not_passed', final: 'not_passed', why: ['cashier: no check has been set for this role'] });
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/hr/workforce/role-checks', body: undefined }]);
  });
});
