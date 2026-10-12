import { describe, it, expect } from 'vitest';
import { createIncidentsSession, INCIDENTS_COPY, wordsFor, outcomeWords, summarise, type IncidentRow, type DrillRegister } from '../../apps/web-erp/src/incidents-session';

/**
 * **M35-FR-02/04 · WF-20 — the incidents and recovery-drills screen's session (DOM-free).** It reads and writes head
 * office's own routes in the signed-in person's session; it refuses only blank or malformed input before a POST (so
 * nothing is sent); every POST carries its own idempotency key; head office's refusal comes back in its own words; a
 * screen with nobody named sends nothing; and every word has a Tamil twin.
 */

interface Sent { method: string; path: string; key: string | undefined; body: unknown }
function fakeHeadOffice(answer: (s: Sent) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const s: Sent = { method: init.method ?? 'GET', path, key: headers['idempotency-key'], body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
    sent.push(s);
    const a = answer(s);
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const OPS = { userId: 'u-mgr', permissions: ['platform.health.read', 'platform.alert.manage', 'backup.verify.read', 'backup.drill.record'] };
let n = 0;
const ids = { newKey: () => `key-${++n}`, newIncidentId: () => 'inc-1', newActionId: () => 'act-1' };

describe('the incidents session', () => {
  it('reads without writing; the board, one incident, the drills and the targets are head office\'s GETs', async () => {
    const ho = fakeHeadOffice((s) => ({ status: 200, body: s.path === '/v1/platform/incidents/inc-1' ? { incident: { incidentId: 'inc-1' } } : s.path === '/v1/platform/recovery-targets' ? { targets: [{ service: 'cloud', rpoSeconds: 900, rtoSeconds: 14400 }] } : { incidents: [], open: 0 } }));
    const s = createIncidentsSession({ viewer: OPS, fetch: ho.fetch, ...ids });
    expect(s.may).toEqual({ named: true, readIncidents: true, manageIncidents: true, readDrills: true, recordDrills: true });
    expect(await s.board()).toEqual({ result: 'ok', value: { incidents: [], open: 0 } });
    expect(await s.incident('inc-1')).toEqual({ result: 'ok', value: { incidentId: 'inc-1' } });
    await s.drills();
    expect(await s.targets()).toEqual({ result: 'ok', value: [{ service: 'cloud', rpoSeconds: 900, rtoSeconds: 14400 }] });
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/platform/incidents', 'GET /v1/platform/incidents/inc-1', 'GET /v1/platform/dr-drills', 'GET /v1/platform/recovery-targets']);
    expect(ho.sent.every((x) => x.key === undefined)).toBe(true);
  });

  it('every act posts once to head office\'s own route with its own idempotency key, never naming an author', async () => {
    const ho = fakeHeadOffice((s) => ({ status: 201, body: s.path.endsWith('/postmortem') ? { version: 1 } : s.path === '/v1/platform/dr-drills' ? { recorded: { result: { detail: 'met both targets', passed: true } } } : {} }));
    const s = createIncidentsSession({ viewer: OPS, fetch: ho.fetch, ...ids });
    expect(await s.openIncident({ title: ' Sync stopped ', severity: 'sev2', summary: 'S1 silent' })).toEqual({ result: 'ok', value: { incidentId: 'inc-1' } });
    await s.addTimeline('inc-1', { happenedAt: '2026-10-12T09:00', note: 'noticed' });
    await s.addAction('inc-1', { description: 'Replace router', ownerUserId: 'u-mgr', dueOn: '2026-10-20' });
    await s.markActionDone('inc-1', 'act-1', 'replaced');
    expect(await s.writePostmortem('inc-1', { cause: 'c', impact: 'i', whatToChange: 'w', whatWentWell: '' })).toEqual({ result: 'ok', value: { version: 1 } });
    await s.close('inc-1', 'resolved');
    expect(await s.recordDrill({ drillId: 'q4', service: 'cloud', dataLossSeconds: '0', recoveryMinutes: '20' })).toEqual({ result: 'ok', value: { detail: 'met both targets', passed: true } });
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /v1/platform/incidents/inc-1', 'POST /v1/platform/incidents/inc-1/timeline', 'POST /v1/platform/incidents/inc-1/actions/act-1',
      'POST /v1/platform/incidents/inc-1/actions/act-1/done', 'POST /v1/platform/incidents/inc-1/postmortem', 'POST /v1/platform/incidents/inc-1/close', 'POST /v1/platform/dr-drills',
    ]);
    expect(new Set(ho.sent.map((x) => x.key)).size).toBe(ho.sent.length);
    expect(ho.sent[0]!.body).toEqual({ title: 'Sync stopped', severity: 'sev2', summary: 'S1 silent' });
    expect(ho.sent[4]!.body).toEqual({ cause: 'c', impact: 'i', whatToChange: 'w' });
    expect(ho.sent.at(-1)!.body).toEqual({ drillId: 'q4', service: 'cloud', dataLossSeconds: 0, recoverySeconds: 1200 });
    for (const x of ho.sent) expect(JSON.stringify(x.body)).not.toMatch(/openedBy|closedBy|writtenBy|drilledBy/);
  });

  it('refuses blank or malformed input before any POST — nothing is sent', async () => {
    const ho = fakeHeadOffice();
    const s = createIncidentsSession({ viewer: OPS, fetch: ho.fetch, ...ids });
    expect(await s.openIncident({ title: '', severity: 'sev2', summary: 'x' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.openIncident({ title: 'x', severity: 'sev9', summary: 'x' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.addAction('inc-1', { description: 'x', ownerUserId: 'u', dueOn: '' })).toEqual({ result: 'invalid', why: 'badDate' });
    expect(await s.writePostmortem('inc-1', { cause: 'c', impact: '', whatToChange: 'w', whatWentWell: '' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.close('inc-1', '  ')).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.recordDrill({ drillId: 'q4', service: 'cloud', dataLossSeconds: '-1', recoveryMinutes: '20' })).toEqual({ result: 'invalid', why: 'badNumber' });
    expect(ho.sent).toEqual([]);
  });

  it('head office\'s refusal comes back in its own words; a lost link says nothing changed', async () => {
    const ho = fakeHeadOffice(() => ({ status: 422, body: { error: { code: 'incident_needs_postmortem', whatHappened: 'Incident inc-1 has no post-mortem yet.' } } }));
    const s = createIncidentsSession({ viewer: OPS, fetch: ho.fetch, ...ids });
    const out = await s.close('inc-1', 'done');
    expect(out).toEqual({ result: 'refused', status: 422, code: 'incident_needs_postmortem', whatHappened: 'Incident inc-1 has no post-mortem yet.' });
    expect(outcomeWords('en', out)).toBe('Head office refused: Incident inc-1 has no post-mortem yet.');
    const dead = createIncidentsSession({ viewer: OPS, fetch: (async () => { throw new Error('down'); }) as unknown as typeof globalThis.fetch, ...ids });
    expect(outcomeWords('ta', await dead.board())).toBe(INCIDENTS_COPY.ta.unreachable);
  });

  it('nobody named: nothing is offered and nothing is sent; a reader without the manage right is offered no change', async () => {
    const ho = fakeHeadOffice();
    const s = createIncidentsSession({ viewer: undefined, fetch: ho.fetch, ...ids });
    expect(s.may).toEqual({ named: false, readIncidents: false, manageIncidents: false, readDrills: false, recordDrills: false });
    expect(await s.board()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await s.openIncident({ title: 'x', severity: 'sev1', summary: 'y' })).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.sent).toEqual([]);
    const reader = createIncidentsSession({ viewer: { userId: 'u-admin', permissions: ['platform.health.read'] }, fetch: ho.fetch });
    expect(reader.may).toMatchObject({ readIncidents: true, manageIncidents: false, readDrills: false, recordDrills: false });
  });

  it('summarises what is open, what is still to do, and how the drills stand', () => {
    const row = (over: Partial<IncidentRow>): IncidentRow => ({ incidentId: 'i', title: 't', severity: 'sev2', state: 'open', openedBy: 'u', openedAt: '', closedBy: null, alertIds: [], openActions: 0, hasPostmortem: false, ...over });
    const register: DrillRegister = { drills: [], posture: [{ service: 'cloud', passed: false, drillId: 'q4', drilledAt: '', detail: 'missed' }], summary: { recorded: 2, passed: 1, missed: 1, servicesCovered: 1 } };
    expect(summarise([row({ openActions: 2 }), row({ state: 'closed', openActions: 1 })], register)).toEqual({ openIncidents: 1, openActions: 3, drills: { passed: 1, missed: 1 }, posture: register.posture });
    expect(summarise(null, null)).toEqual({ openIncidents: null, openActions: null, drills: null, posture: null });
  });

  it('every word has a Tamil twin, and slots are filled', () => {
    const en = Object.keys(INCIDENTS_COPY.en).sort();
    expect(Object.keys(INCIDENTS_COPY.ta).sort()).toEqual(en);
    for (const k of en) expect((INCIDENTS_COPY.ta as Record<string, string>)[k]!.trim(), k).not.toBe('');
    expect(wordsFor('ta', 'title')).toBe('சம்பவங்களும் மீட்பு ஒத்திகைகளும்');
    expect(wordsFor('en', 'pmSaved', { v: 2 })).toBe('Post-mortem saved — version 2.');
  });
});
