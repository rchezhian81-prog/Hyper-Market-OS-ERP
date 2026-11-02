import { describe, it, expect } from 'vitest';
import { createEmergencyAccessSession, storesFrom, EMERGENCY_COPY } from '../../apps/web-erp/src/emergency-access-session';
import { createSafetyIncidentsSession, SAFETY_COPY } from '../../apps/web-erp/src/safety-incidents-session';
import { createOpsAlertsSession, ruleIdOf, OPS_ALERTS_COPY } from '../../apps/web-erp/src/ops-alerts-session';
import { createDocumentRetentionSession, RETENTION_COPY } from '../../apps/web-erp/src/document-retention-session';
import { createSalesCommissionSession, bpsOf, paiseOf, COMMISSION_COPY } from '../../apps/web-erp/src/sales-commission-session';
import { createBriefSession, BRIEF_COPY } from '../../apps/web-erp/src/morning-brief-session';

/**
 * Wave 3 (security, people and operations): the DOM-free sessions behind the new office screens — D11-FR-02 Emergency
 * access, D11-FR-06 Safety incidents, M35-FR-04 Operational alerts, M31-FR-01 Document retention, M22-FR-03 Sales
 * commission, and D13-FR-01..06 the Morning brief's schedule. Each refuses the cheap things before anything is sent, asks
 * only with the permission its page holds, and sends exactly what head office's route reads.
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

describe('every word has a Tamil twin', () => {
  it('in each of the six word tables', () => {
    for (const c of [EMERGENCY_COPY, SAFETY_COPY, OPS_ALERTS_COPY, RETENTION_COPY, COMMISSION_COPY, BRIEF_COPY]) expect(Object.keys(c.ta).sort()).toEqual(Object.keys(c.en).sort());
  });
});

describe('Emergency access (D11-FR-02): ask the owner for exactly the grant, give it with his approval, end it early', () => {
  it('reads the stores typed', () => {
    expect(storesFrom(' ALL ')).toBe('all');
    expect(storesFrom('store-1, store-2 store-1')).toEqual(['store-1', 'store-2']);
    expect(storesFrom('  ')).toBeUndefined();
  });

  it('refuses the cheap things before anything is sent, and asks with the grant\'s exact details', async () => {
    const ho = fakeHeadOffice(() => ({ status: 201, body: { requestId: 'req-1' } }));
    const s = createEmergencyAccessSession({ viewer: v('identity.role.request'), fetch: ho.fetch, newGrantId: () => 'eg-1' });
    const base = { userId: 'u-support', roleId: 'store_manager', stores: 'store-1', minutes: '30', reason: 'fix the till freeze on lane 3' };
    expect(await s.ask({ ...base, userId: ' ' })).toEqual({ result: 'invalid', why: 'needPerson' });
    expect(await s.ask({ ...base, stores: '' })).toEqual({ result: 'invalid', why: 'needStores' });
    expect(await s.ask({ ...base, minutes: '0' })).toEqual({ result: 'invalid', why: 'needMinutes' });
    expect(await s.ask({ ...base, minutes: 'ten' })).toEqual({ result: 'invalid', why: 'needMinutes' });
    expect(await s.ask({ ...base, reason: ' ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.sent).toEqual([]);
    expect(await s.ask(base)).toEqual({ result: 'ok', value: { requestId: 'req-1', grantId: 'eg-1' } });
    expect(ho.sent).toEqual([{ method: 'POST', path: '/v1/approvals/requests', body: {
      kind: 'emergency_access', subjectRef: 'eg-1', valueMinor: null, reason: 'fix the till freeze on lane 3',
      details: { userId: 'u-support', roleId: 'store_manager', branchScope: ['store-1'], reason: 'fix the till freeze on lane 3', minutes: 30, grantId: 'eg-1' },
      summary: 'Emergency access: u-support as store_manager for 30 minutes',
    } }]);
  });

  it('gives an approved ask with the same body and the approval; lists only emergency asks; a manager cannot end one', async () => {
    const mine = [
      { requestId: 'req-1', kind: 'emergency_access', subjectRef: 'eg-1', status: 'approved', decidedBy: 'u-owner', details: { userId: 'u-support', roleId: 'store_manager', branchScope: 'all', reason: 'why', minutes: 30, grantId: 'eg-1' } },
      { requestId: 'req-2', kind: 'branch_transition', subjectRef: 'b-1', status: 'waiting', details: {} },
    ];
    const ho = fakeHeadOffice((m, p) => (m === 'GET' && p === '/v1/approvals/requests' ? { body: { mine } } : { status: 201, body: { expiresAt: '2026-11-02T10:30:00.000Z' } }));
    const s = createEmergencyAccessSession({ viewer: v('identity.role.request'), fetch: ho.fetch });
    const asks = await s.myAsks();
    expect(asks.result === 'ok' && asks.value).toEqual([{ requestId: 'req-1', grantId: 'eg-1', status: 'approved', decidedBy: 'u-owner', body: { userId: 'u-support', roleId: 'store_manager', branchScope: 'all', reason: 'why', minutes: 30 } }]);
    if (asks.result !== 'ok') throw new Error('no asks');
    expect(await s.give(asks.value[0]!)).toEqual({ result: 'ok', value: { expiresAt: '2026-11-02T10:30:00.000Z' } });
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/access/emergency/eg-1', body: { userId: 'u-support', roleId: 'store_manager', branchScope: 'all', reason: 'why', minutes: 30, approvalId: 'req-1' } });
    expect(await s.end('eg-1')).toEqual({ result: 'invalid', why: 'cannotEnd' });
    expect(await s.review()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createEmergencyAccessSession({ viewer: undefined, fetch: ho.fetch }).ask({ userId: 'a', roleId: 'b', stores: 'all', minutes: '1', reason: 'c' })).toEqual({ result: 'invalid', why: 'nobody' });
  });
});

describe('Safety incidents (D11-FR-06): raise with the shop\'s clock, close with what was done', () => {
  it('refuses a missing time, reporter or description; raises in shop time with the caller never typed', async () => {
    const ho = fakeHeadOffice(() => ({ status: 201, body: {} }));
    const s = createSafetyIncidentsSession({ viewer: v('facilities.incident.record', 'facilities.asset.read'), fetch: ho.fetch, newIncidentId: () => 'inc-1', now: () => '2026-11-02T05:00:00.000Z', timeZone: 'Asia/Kolkata' });
    const f = { branchId: 'store-1', kind: 'injury', severity: 'serious', occurredAt: '2026-11-02T10:15', reportedBy: 'Meena', description: 'cut hand on a crate', evidence: 'photo-1, photo-1, form-7', assetId: '' };
    expect(await s.raise({ ...f, occurredAt: '' })).toEqual({ result: 'invalid', why: 'needWhen' });
    expect(await s.raise({ ...f, reportedBy: ' ' })).toEqual({ result: 'invalid', why: 'needWho' });
    expect(await s.raise({ ...f, description: '' })).toEqual({ result: 'invalid', why: 'needWhat' });
    expect(await s.raise({ ...f, branchId: '' })).toEqual({ result: 'invalid', why: 'needStore' });
    expect(ho.sent).toEqual([]);
    expect(await s.raise(f)).toEqual({ result: 'ok', value: { incidentId: 'inc-1' } });
    // 10:15 at the shop is 04:45 UTC — never the device's clock (OB-608).
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/facilities/incidents/inc-1', body: {
      branchId: 'store-1', kind: 'injury', severity: 'serious', occurredAt: '2026-11-02T04:45:00.000Z', reportedAt: '2026-11-02T05:00:00.000Z',
      reportedBy: 'Meena', description: 'cut hand on a crate', evidenceRefs: ['photo-1', 'form-7'],
    } });
  });

  it('sends a blank action for head office to refuse, refuses a bad date, and a reader cannot record', async () => {
    const ho = fakeHeadOffice(() => ({ body: { closed: true } }));
    const s = createSafetyIncidentsSession({ viewer: v('facilities.incident.record', 'facilities.asset.read'), fetch: ho.fetch });
    expect(await s.close('inc-1', ' ', '1 Nov')).toEqual({ result: 'invalid', why: 'badDate' });
    expect(await s.close('inc-1', ' ', '')).toEqual({ result: 'ok', value: { closed: true } });
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/facilities/incidents/inc-1/close', body: { actionTaken: '' } });
    await s.close('inc-1', 'guard fitted', '2026-11-02');
    expect(ho.sent.at(-1)?.body).toEqual({ actionTaken: 'guard fitted', authorityNotifiedOn: '2026-11-02' });
    expect(await createSafetyIncidentsSession({ viewer: v('facilities.asset.read'), fetch: ho.fetch }).close('inc-1', 'x', '')).toEqual({ result: 'invalid', why: 'cannotRecord' });
  });
});

describe('Operational alerts (M35-FR-04): tick as seen, and change who owns an alert on the version read', () => {
  const rules = { version: 3, rules: [{ alertId: 'shop:backup:down', component: 'backup', firesAt: 'down', ownerUserId: 'u-it', ownerName: 'IT', ackWithinMinutes: 30, escalatesToUserId: 'u-owner' }], builtIn: [], thresholds: { queueDepthWarn: 5 }, backupMaxAgeSeconds: 86_400 };

  it('changes one owner and sends the whole set based on the version read; refuses a blank owner first', async () => {
    const ho = fakeHeadOffice(() => ({ body: { version: 4 } }));
    const s = createOpsAlertsSession({ viewer: v('platform.health.read', 'platform.alert.manage'), fetch: ho.fetch });
    expect(await s.setOwner(rules, 'shop:backup:down', { ownerUserId: '', ownerName: 'x', ackWithinMinutes: '10', escalatesToUserId: '' })).toEqual({ result: 'invalid', why: 'needOwner' });
    expect(await s.setOwner(rules, 'shop:backup:down', { ownerUserId: 'u-mgr', ownerName: 'Manager', ackWithinMinutes: '0', escalatesToUserId: '' })).toEqual({ result: 'invalid', why: 'needMinutes' });
    expect(ho.sent).toEqual([]);
    expect(await s.setOwner(rules, 'shop:backup:down', { ownerUserId: 'u-mgr', ownerName: 'Manager', ackWithinMinutes: '15', escalatesToUserId: '' })).toEqual({ result: 'ok', value: { version: 4 } });
    expect(ho.sent[0]).toEqual({ method: 'PUT', path: '/v1/platform/alert-rules', body: {
      rules: [{ alertId: 'shop:backup:down', component: 'backup', firesAt: 'down', ownerUserId: 'u-mgr', ownerName: 'Manager', ackWithinMinutes: 15 }],
      thresholds: { queueDepthWarn: 5 }, backupMaxAgeSeconds: 86_400, basedOnVersion: 3,
    } });
    expect(await s.addRule(rules, { component: 'backup', firesAt: 'down', ownerUserId: 'u', ownerName: 'n', ackWithinMinutes: '5', escalatesToUserId: '' })).toEqual({ result: 'invalid', why: 'exists' });
    await s.setBackupAge(rules, '12');
    expect((ho.sent.at(-1)?.body as { backupMaxAgeSeconds: number }).backupMaxAgeSeconds).toBe(43_200);
    expect(ruleIdOf(' Store Computer ', 'degraded')).toBe('shop:store-computer:degraded');
    await s.acknowledge('built-in:x');
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/platform/alerts/built-in%3Ax/acknowledge', body: {} });
  });

  it('a reader may read but not tick', async () => {
    const ho = fakeHeadOffice(() => ({ body: { alerts: [{ alert: { alertId: 'a-1', component: 'backup', status: 'down', ownerUserId: 'u-it', ownerName: 'IT', detail: 'd', ackDueBy: 'x' }, state: 'open' }] } }));
    const s = createOpsAlertsSession({ viewer: v('platform.health.read'), fetch: ho.fetch });
    const board = await s.board();
    expect(board.result === 'ok' && board.value[0]).toMatchObject({ alertId: 'a-1', level: 'down', state: 'open', builtIn: false });
    expect(await s.acknowledge('a-1')).toEqual({ result: 'invalid', why: 'cannotManage' });
  });
});

describe('Document retention (M31-FR-01): a disposal needs a reason and the permission', () => {
  it('refuses a blank reason before sending; a reader cannot dispose', async () => {
    const ho = fakeHeadOffice(() => ({ body: { disposed: true } }));
    const s = createDocumentRetentionSession({ viewer: v('document.template.read', 'document.retention.dispose'), fetch: ho.fetch });
    expect(await s.dispose('doc-1', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.sent).toEqual([]);
    expect(await s.dispose('doc-1', ' past its keeping time ')).toEqual({ result: 'ok', value: { disposed: true } });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/documents/doc-1/disposal', body: { reason: 'past its keeping time' } });
    expect(await createDocumentRetentionSession({ viewer: v('document.template.read'), fetch: ho.fetch }).dispose('doc-1', 'x')).toEqual({ result: 'invalid', why: 'cannotDispose' });
  });
});

describe('Sales commission (M22-FR-03): rates in hundredths of a per cent, money in paise', () => {
  it('reads a rate and a cap exactly', () => {
    expect(bpsOf('2.5')).toBe(250); expect(bpsOf('100')).toBe(10_000); expect(bpsOf('100.01')).toBeUndefined(); expect(bpsOf('-1')).toBeUndefined(); expect(bpsOf('1.234')).toBeUndefined();
    expect(paiseOf('500')).toBe(50_000); expect(paiseOf('1,250.5')).toBe(125_050); expect(paiseOf('abc')).toBeUndefined();
  });

  it('proposes with the rule id and the exact body; nothing earned yet is "nothing yet", never 0', async () => {
    const ho = fakeHeadOffice((m, p) => (p.endsWith('/rules') ? { body: { rules: [], inForce: null } } : m === 'GET' ? { status: 404, body: { error: { code: 'not_found' } } } : { status: 201, body: {} }));
    const s = createSalesCommissionSession({ viewer: v('b2b.commission.read', 'b2b.commission.record'), fetch: ho.fetch, newRuleId: () => 'cr-1' });
    expect(await s.propose('sp-1', '2.5', 'lots')).toEqual({ result: 'invalid', why: 'needCap' });
    expect(await s.propose('sp-1', '', '')).toEqual({ result: 'invalid', why: 'needRate' });
    expect(ho.sent).toEqual([]);
    expect(await s.propose('sp-1', '2.5', '500')).toEqual({ result: 'ok', value: { ruleId: 'cr-1' } });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/b2b/commissions/sp-1/rules/cr-1', body: { rateBps: 250, capMinor: 50_000 } });
    expect(await s.look('sp-1')).toEqual({ result: 'ok', value: { salespersonId: 'sp-1', rules: [], earned: null } });
    expect(await s.approve('sp-1', 'cr-1')).toEqual({ result: 'invalid', why: 'cannotApprove' });
  });
});

describe('the Morning brief\'s schedule (D13-FR-01..06): not set is "not set"; the owner sets the shop time', () => {
  it('reads head office\'s "no schedule" as not set, and sends the time as [hour, minute]', async () => {
    const ho = fakeHeadOffice((m) => (m === 'GET' ? { status: 404, body: { error: { code: 'no_brief_schedule', whatHappened: 'none' } } } : { body: {} }));
    const s = createBriefSession({ viewer: v('owner.kpi.read', 'owner.brief.manage'), fetch: ho.fetch });
    expect(await s.schedule()).toEqual({ result: 'ok', value: { set: false } });
    expect(await s.setSchedule({ dueAt: '25:00', language: 'en', staleMinutes: '' })).toEqual({ result: 'invalid', why: 'needTime' });
    expect(await s.setSchedule({ dueAt: '07:30', language: 'ta', staleMinutes: '0' })).toEqual({ result: 'invalid', why: 'needStale' });
    expect(await s.setSchedule({ dueAt: '07:30', language: 'ta', staleMinutes: '90' })).toEqual({ result: 'ok', value: { dueAt: '07:30' } });
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/reporting/brief-schedule', body: { dueAt: [7, 30], language: 'ta', staleAfterMinutes: 90 } });
    expect(await createBriefSession({ viewer: v('owner.kpi.read'), fetch: ho.fetch }).setSchedule({ dueAt: '07:30', language: 'en', staleMinutes: '' })).toEqual({ result: 'invalid', why: 'cannotManage' });
  });
});
