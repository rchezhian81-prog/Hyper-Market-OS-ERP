import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * **WF-20 "… monitor → rollback / incident / post-mortem" · M35-FR-04 "alert ownership, escalation, incident/postmortem".**
 *
 * When something goes wrong — here, a release that went red and dead letters piling up — the incident record keeps what
 * happened and who decided it is over. On the real API (in memory, and on real PostgreSQL through the production
 * assembly):
 *
 *   • OPEN by a named person, linked to the alert head office really raised (an alert it never raised is refused), and to
 *     the release commit it followed; a body naming somebody else as the opener is refused.
 *   • LINK, TIMELINE, ACTIONS — each entry by its author; the linked alert's own raise and acknowledgement appear in the
 *     timeline without being retyped; an action must be owned by a person who works here.
 *   • POST-MORTEM — cause, impact, what to change; a re-statement is a second version, the first stays.
 *   • CLOSE — refused without a post-mortem; refused when the body names another closer; done by the caller, who is
 *     recorded; nothing changes afterwards (409), and a cashier can neither open nor close one.
 *   • REPLAY — the same request under its key is the same answer; the same fact under a new key is the same one fact; a
 *     DIFFERENT fact under a used id is a visible conflict (409), never an overwrite.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash';
const RELEASE = 'a'.repeat(40);
const RULE = { alertId: 'dl-release', component: 'dead_letter', firesAt: 'degraded', ownerUserId: OWNER, ownerName: 'Owner', ackWithinMinutes: 15 };

interface Reply { readonly status: number; readonly body: unknown }
type Raw = (method: HttpRequest['method'], path: string, user: string, body?: unknown, key?: string) => Promise<Reply>;
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

async function theIncident(raw: Raw): Promise<void> {
  const post = (user: string, path: string, body: unknown, key = `k-${randomUUID()}`) => raw('POST', path, user, body, key);
  const get = (user: string, path: string) => raw('GET', path, user);
  const I = '/v1/platform/incidents/INC-1';

  // The alert head office raised when the dead letters piled up.
  expect((await post(OWNER, '/v1/platform/alerts/raise', { signals: { deadLetterCount: 40 }, alertRules: [RULE] }, 'raise-1')).status).toBe(200);
  expect((await post(OWNER, '/v1/platform/alerts/dl-release/acknowledge', {}, 'ack-1')).status).toBe(200);

  // OPEN — refused for a phantom alert, for a body naming another opener, for a cashier; opened by the manager.
  const opening = { title: 'Release went red; sales queue backed up', severity: 'sev2', summary: 'After the 10:00 release the box dead-lettered sales for 20 minutes.', alertIds: ['dl-release'], releaseSha: RELEASE };
  const phantom = await post(MGR, I, { ...opening, alertIds: ['never-raised'] });
  expect(phantom.status).toBe(422);
  expect(codeOf(phantom)).toBe('unknown_alert');
  expect(codeOf(await post(MGR, I, { ...opening, openedBy: OWNER }))).toBe('actor_is_the_caller');
  expect((await post(CASHIER, I, opening)).status).toBe(403);
  expect((await post(MGR, I, { ...opening, severity: 'bad' })).status).toBe(400);
  const opened = await post(MGR, I, opening, 'open-1');
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  expect(opened.body).toMatchObject({ incidentId: 'INC-1', state: 'open', openedBy: MGR, alertIds: ['dl-release'] });
  expect((await post(MGR, I, opening, 'open-1')).body).toEqual(opened.body);                            // replay: the same answer
  expect((await post(OWNER, I, opening, 'open-2')).body).toMatchObject({ alreadyOpen: true, openedBy: MGR }); // same fact, new key
  const changed = await post(MGR, I, { ...opening, title: 'Something else' });
  expect(changed.status).toBe(409);
  expect(codeOf(changed)).toBe('incident_fact_conflict');

  // TIMELINE — by its author; the linked alert's own facts are read in, never retyped.
  expect((await post(MGR, `${I}/timeline`, { entryId: 't1', happenedAt: '2026-10-11T10:05:00.000Z', note: 'Box stopped draining sales.' }, 'tl-1')).status).toBe(201);
  expect((await post(OWNER, `${I}/timeline`, { entryId: 't2', happenedAt: '2026-10-11T10:25:00.000Z', note: 'Rolled back to the previous release; queue drained.' }, 'tl-2')).status).toBe(201);
  expect((await post(OWNER, `${I}/timeline`, { entryId: 't2', happenedAt: '2026-10-11T10:25:00.000Z', note: 'A different story' })).status).toBe(409);

  // ACTIONS — owned by a person who works here, by a date.
  const nobody = await post(MGR, `${I}/actions/A1`, { description: 'Add a canary bake', ownerUserId: 'u-stranger', dueOn: '2026-10-20' });
  expect(nobody.status).toBe(422);
  expect(codeOf(nobody)).toBe('action_owner_unknown');
  expect((await post(MGR, `${I}/actions/A1`, { description: 'Bake each release on the canary box for ten minutes', ownerUserId: OWNER, dueOn: '2026-10-20' }, 'act-1')).status).toBe(201);
  expect((await post(MGR, `${I}/actions/A2`, { description: 'Alert on dead letters within five minutes', ownerUserId: MGR, dueOn: '2026-10-25' }, 'act-2')).status).toBe(201);
  expect((await post(OWNER, `${I}/actions/A1/done`, { note: 'SRE_BAKE_SECONDS=600 on the canary box' }, 'done-1')).body).toMatchObject({ doneBy: OWNER });

  // CLOSE — not before the post-mortem.
  const early = await post(OWNER, `${I}/close`, { note: 'all good' });
  expect(early.status).toBe(422);
  expect(codeOf(early)).toBe('incident_needs_postmortem');

  // POST-MORTEM — a re-statement is a second version; the first stays.
  expect((await post(MGR, `${I}/postmortem`, { cause: 'A migration ran slow on the box.', impact: '20 minutes of sales waiting; none lost.', whatToChange: 'Canary bake before full rollout.' }, 'pm-1')).body).toMatchObject({ version: 1, writtenBy: MGR });
  expect((await post(OWNER, `${I}/postmortem`, { cause: 'A migration ran slow on the box under load.', impact: '20 minutes of sales waiting; none lost.', whatToChange: 'Canary bake before full rollout.', whatWentWell: 'The rollback was automatic.' }, 'pm-2')).body).toMatchObject({ version: 2, writtenBy: OWNER });

  // CLOSE — only by the caller, by name; a cashier cannot; afterwards nothing changes.
  expect(codeOf(await post(OWNER, `${I}/close`, { note: 'Rolled back and understood.', closedBy: MGR }))).toBe('actor_is_the_caller');
  expect((await post(CASHIER, `${I}/close`, { note: 'done' })).status).toBe(403);
  const closed = await post(OWNER, `${I}/close`, { note: 'Rolled back and understood; A2 still open with its owner.' }, 'close-1');
  expect(closed.status).toBe(200);
  expect(closed.body).toMatchObject({ state: 'closed', closedBy: OWNER, openActions: [{ actionId: 'A2', ownerUserId: MGR, dueOn: '2026-10-25' }] });
  expect((await post(MGR, `${I}/timeline`, { entryId: 't3', happenedAt: '2026-10-11T11:00:00.000Z', note: 'late' })).status).toBe(409);
  expect((await post(MGR, `${I}/close`, { note: 'again' })).body).toMatchObject({ alreadyClosed: true, closedBy: OWNER });

  // The record as anybody with the health view reads it.
  const read = (await get(MGR, I)).body as { incident: { state: string; closedBy: string; releaseSha: string; alertIds: string[]; openActions: number; postmortems: { version: number; by: string }[]; postmortem: { version: number }; timeline: { note: string; by: string; source: string }[] } };
  expect(read.incident).toMatchObject({ state: 'closed', closedBy: OWNER, releaseSha: RELEASE, alertIds: ['dl-release'], openActions: 1, postmortem: { version: 2 } });
  expect(read.incident.postmortems.map((p) => [p.version, p.by])).toEqual([[1, MGR], [2, OWNER]]);
  expect(read.incident.timeline.filter((t) => t.source === 'person').map((t) => [t.note, t.by])).toEqual([['Box stopped draining sales.', MGR], ['Rolled back to the previous release; queue drained.', OWNER]]);
  expect(read.incident.timeline.filter((t) => t.source === 'alert').map((t) => t.note)).toEqual(expect.arrayContaining([expect.stringMatching(/^alert dl-release raised/), 'alert dl-release acknowledged']));
  const board = (await get(OWNER, '/v1/platform/incidents')).body as { incidents: { incidentId: string; state: string; hasPostmortem: boolean }[]; open: number };
  expect(board.incidents).toContainEqual(expect.objectContaining({ incidentId: 'INC-1', state: 'closed', hasPostmortem: true }));
  expect((await get(CASHIER, I)).status).toBe(403);
}

describe('WF-20 / M35-FR-04 — an incident: opened, linked, kept, closed by a named person (real API, in memory)', () => {
  it('runs the whole record', async () => {
    const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0f20';
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASHIER, 'cashier');
    await theIncident((method, path, user, body, key) => h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }) }));
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
describeOrSkip('WF-20 / M35-FR-04 — the same record on real PostgreSQL, through the production API assembly', () => {
  let cloud: RealCloud;
  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: ['wf20', 'pack', 'key'].join('-').padEnd(48, '0') });
    await cloud.grant(MGR, 'store_manager');
    await cloud.grant(CASHIER, 'cashier');
  }, 120_000);
  afterAll(async () => { await cloud?.stop(); });
  it('runs the whole record', async () => {
    await theIncident(async (method, path, user, body, key) => {
      const res = await fetch(`${cloud.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${TEST_IDP.issue({ sub: user, tenantId: cloud.tenantId })}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    });
  }, 120_000);
});
