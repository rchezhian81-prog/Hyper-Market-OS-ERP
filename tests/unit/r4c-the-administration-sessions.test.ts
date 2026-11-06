import { describe, it, expect } from 'vitest';
import { createSettingsSession, SETTINGS_COPY } from '../../apps/web-erp/src/settings-session';
import { createPoshCommitteeSession, POSH_COMMITTEE_COPY } from '../../apps/web-erp/src/posh-committee-session';
import { createBranchesSession, changeBody, NEXT, BRANCHES_COPY } from '../../apps/web-erp/src/branches-session';
import { createDncSession, DNC_COPY } from '../../apps/web-erp/src/do-not-contact-session';
import { createCertInCapacitySession, wholeOrNotSet, CERT_IN_COPY } from '../../apps/web-erp/src/cert-in-capacity-session';
import { createHelpSession } from '../../apps/web-erp/src/help-session';

/**
 * Round 4c: the Settings, Committee report, Branches, Do not contact, CERT-In and Help sessions — each refuses the cheap
 * things before anything is sent, and sends exactly what head office's route reads.
 */

function fakeHeadOffice(answer: (method: string, path: string) => unknown = () => ({})) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => answer(init.method, path) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const v = (...permissions: string[]) => ({ userId: 'u-x', permissions });

describe('every word has a Tamil twin', () => {
  it('in each of the six word tables', () => {
    for (const c of [SETTINGS_COPY, POSH_COMMITTEE_COPY, BRANCHES_COPY, DNC_COPY, CERT_IN_COPY]) expect(Object.keys(c.ta).sort()).toEqual(Object.keys(c.en).sort());
  });
});

describe('Settings: going back asks the owner for a high-impact setting with exactly the rollback\'s details', () => {
  it('refuses a blank reason and the version in force; a refused high-impact rollback becomes an ask', async () => {
    const ho = fakeHeadOffice();
    const s = createSettingsSession({ viewer: v('platform.setup.read', 'platform.setup.write'), fetch: ho.fetch });
    expect(await s.goBack('locale.time_zone', 1, ' ', 2)).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.goBack('locale.time_zone', 2, 'x', 2)).toEqual({ result: 'invalid', why: 'current' });
    expect(ho.sent).toEqual([]);
    const refusing = (async () => ({ ok: false, status: 422, json: async () => ({ error: { code: 'high_impact_change_needs_owner_approval', whatHappened: 'high-impact' } }) })) as unknown as typeof globalThis.fetch;
    const r = await createSettingsSession({ viewer: v('platform.setup.read', 'platform.setup.write'), fetch: refusing }).goBack('locale.time_zone', 1, ' tz ', 2);
    expect(r).toEqual({ result: 'ok', value: { kind: 'needs_owner', ask: { key: 'locale.time_zone', toVersion: 1, reason: 'tz' } } });
    await s.askOwner({ key: 'locale.time_zone', toVersion: 1, reason: 'tz' });
    expect(ho.sent[0]).toMatchObject({ path: '/v1/approvals/requests', body: { kind: 'config_change', subjectRef: 'setting:locale.time_zone', details: { toVersion: 1, reason: 'tz', key: 'locale.time_zone', action: 'rollback' } } });
    expect(await createSettingsSession({ viewer: v('platform.setup.read'), fetch: ho.fetch }).goBack('k', 1, 'x', 2)).toEqual({ result: 'invalid', why: 'cannotWrite' });
  });
});

describe('the Committee report: the committee alone, a real year', () => {
  it('refuses the owner\'s words and a year that is not four figures; makes with an empty body', async () => {
    const ho = fakeHeadOffice(() => ({ report: { year: 2025, receivedInYear: 1 } }));
    expect(await createPoshCommitteeSession({ viewer: v('posh.report.read', 'posh.report.file'), fetch: ho.fetch }).years()).toEqual({ result: 'invalid', why: 'cannotRead' });
    const s = createPoshCommitteeSession({ viewer: v('posh.report.generate', 'posh.report.read'), fetch: ho.fetch });
    expect(await s.make(25)).toEqual({ result: 'invalid', why: 'badYear' });
    expect(ho.sent).toEqual([]);
    const made = await s.make(2025);
    expect(made.result === 'ok' && made.value.receivedInYear).toBe(1);
    expect(ho.sent).toEqual([{ method: 'POST', path: '/v1/hr/posh/annual-reports/2025', body: {} }]);
  });
});

describe('Branches: a change is asked of the owner with exactly the body it will send; a reopen needs none', () => {
  it('needs a reason and, for a close for now, the day it reopens', async () => {
    expect(NEXT).toEqual({ draft: ['open'], open: ['temporarily_close', 'permanently_close'], temporarily_closed: ['reopen', 'permanently_close'], permanently_closed: [] });
    const ho = fakeHeadOffice((m, p) => (p.endsWith('/transition') ? { transition: { toState: 'open' } } : { requestId: 'areq-1' }));
    const s = createBranchesSession({ viewer: v('branch.transition.evaluate', 'branch.transition.execute'), fetch: ho.fetch });
    expect(await s.ask('B1', 'temporarily_close', 'paint', '')).toEqual({ result: 'invalid', why: 'needDate' });
    expect(await s.ask('B1', 'permanently_close', ' ', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.sent).toEqual([]);
    await s.ask('B1', 'temporarily_close', ' paint ', '2026-11-20');
    expect(ho.sent[0]).toMatchObject({ path: '/v1/approvals/requests', body: { kind: 'branch_transition', subjectRef: 'B1', details: { transition: 'temporarily_close', reason: 'paint', reopensOn: '2026-11-20', branchId: 'B1' } } });
    expect(await s.ask('B1', 'reopen', 'dry', '')).toEqual({ result: 'ok', value: { done: 'open' } });
    expect(ho.sent[1]).toEqual({ method: 'POST', path: '/v1/platform/branches/B1/transition', body: { transition: 'reopen', reason: 'dry' } });
    expect(changeBody('reopen', 'x', '2026-01-01')).toEqual({ transition: 'reopen', reason: 'x' });
  });
});

describe('Do not contact: a reason every time; the entry and the lift each say who and why', () => {
  it('refuses blanks before sending, and sends exactly the register\'s fields', async () => {
    const ho = fakeHeadOffice();
    const s = createDncSession({ viewer: v('notification.send.check', 'notification.suppression.manage'), fetch: ho.fetch });
    expect(await s.add({ customerId: 'c-1', channel: 'sms', source: 'customer_request', reason: ' ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.lift('c-1', 'sms', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.sent).toEqual([]);
    await s.add({ customerId: ' c-1 ', channel: 'sms', source: 'customer_request', reason: 'asked' });
    await s.lift('c-1', 'sms', 'asked again');
    expect(ho.sent).toEqual([
      { method: 'POST', path: '/v1/notifications/suppressions/c-1', body: { channel: 'sms', reason: 'asked', source: 'customer_request' } },
      { method: 'POST', path: '/v1/notifications/suppressions/c-1/lift', body: { channel: 'sms', reason: 'asked again' } },
    ]);
    expect(await createDncSession({ viewer: v('notification.send.check'), fetch: ho.fetch }).add({ customerId: 'c', channel: 'all', source: 'staff', reason: 'x' })).toEqual({ result: 'invalid', why: 'cannotManage' });
  });
});

describe('CERT-In and capacity: the clock runs from a time on the shop\'s clock; the plan is whole numbers or "not set"', () => {
  it('reads the typed time in the shop\'s zone and refuses words for numbers', async () => {
    const ho = fakeHeadOffice(() => ({ clock: { incidentId: 'inc-1', reportable: true }, plan: { version: 1 } }));
    const s = createCertInCapacitySession({ viewer: v('platform.health.read', 'platform.certin.manage', 'platform.service.manage'), fetch: ho.fetch, timeZone: 'Asia/Kolkata' });
    expect(await s.classify({ incidentId: 'inc-1', reportable: true, category: 'phishing', reason: 'x', noticedAt: 'yesterday' })).toEqual({ result: 'invalid', why: 'badTime' });
    expect(await s.savePlan('ten', {})).toEqual({ result: 'invalid', why: 'badNumber' });
    expect(ho.sent).toEqual([]);
    await s.classify({ incidentId: 'inc-1', reportable: true, category: 'phishing', reason: 'x', noticedAt: '2026-11-01T10:00' });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/platform/incidents/inc-1/cert-in', body: { reportable: true, category: 'phishing', reason: 'x', noticedAt: '2026-11-01T04:30:00.000Z' } });
    await s.savePlan('10', { products: '50000' });
    expect(ho.sent[1]).toMatchObject({ method: 'PUT', path: '/v1/platform/capacity-plan', body: { growthPercentPerYear: 10, provisioned: { products: 50000, lanes: null, bills_per_day: null } } });
    expect([wholeOrNotSet(''), wholeOrNotSet('7'), wholeOrNotSet('7.5')]).toEqual([null, 7, undefined]);
    expect(await createCertInCapacitySession({ viewer: v('platform.health.read'), fetch: ho.fetch }).classify({ incidentId: 'i', reportable: false, category: 'c', reason: 'r', noticedAt: '2026-11-01T10:00' })).toEqual({ result: 'invalid', why: 'cannotClassify' });
  });
});

describe('Help on the store computer: the manager\'s tools are offered there too (Round 4c)', () => {
  it('a manager on the box may manage, record drills and set contacts by their own words; a cashier may not', () => {
    const library = { asAt: '2026-11-01T00:00:00Z', ageMinutes: 0, sops: [], people: [], acknowledgements: [], emergencyContacts: [], contactsSet: false };
    const mgr = createHelpSession({ data: { userId: 'u-m', permissions: ['workforce.help.read', 'workforce.roster.manage', 'workforce.training.manage', 'workforce.emergency.manage'], library }, onBox: true });
    expect(mgr.may).toMatchObject({ onBox: true, manage: true, drills: true, contacts: true });
    const cash = createHelpSession({ data: { userId: 'u-c', permissions: ['workforce.help.read'], library }, onBox: true });
    expect(cash.may).toMatchObject({ onBox: true, manage: false, drills: false, contacts: false });
  });
});
