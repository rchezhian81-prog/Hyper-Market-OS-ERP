import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { recordingTransport, type NotificationTransport, type OutboundMessage } from '../../packages/notifications/src/index';

/**
 * **PA-12 — a failed backup and a store's refused sync items reach the NAMED person who owns them, escalate when
 * nobody answers, and are kept (M35-FR-01/03/04 · §32 · P-03 · P-08 · hard rule #6).**
 *
 * The REAL API (`startApi`) on REAL PostgreSQL. The owner's alert rules name who owns the backup and the store's sync
 * queue (Priya, the store manager `u-hr`) and who is above her (the owner). Then NOBODY presses "raise", "escalate" or
 * "deliver" — the ops-alert worker the API runs on its own timer does it:
 *   • a failed backup is raised to Priya at once (even though last night's good backup is still within its 24 hours),
 *     lands in HER inbox and, through the message provider handed in (the recording test adapter — real providers are
 *     an external gate), as a message to her;
 *   • unacknowledged past its 15 minutes, it escalates to the owner — his inbox and a message to him;
 *   • the owner acknowledges it: it stops escalating, leaves Priya's inbox, and stays on the board (never deleted);
 *   • a store computer reporting refused (dead-lettered) sync items is a lane alert to Priya the same way;
 *   • across a restart of the API nothing is delivered twice, the history is all there, a good backup CLEARS the
 *     backup alert (kept, marked cleared) and the next failure is a NEW occurrence, delivered to Priya again.
 * Off-site storage, its custodians and a restore on a spare store machine remain owner/operator actions (external).
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
const KEY = ['alerts', 'reach', 'their', 'owner', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const PRIYA = 'u-hr'; // the second initial admin — the store manager — named owner of these alerts
const T0 = Date.parse('2026-10-12T20:30:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const travel = (minutes: number): void => { vi.setSystemTime(new Date(T0 + minutes * 60_000)); };

const RULES = {
  rules: [
    { alertId: 'backup', component: 'backup', firesAt: 'degraded', ownerUserId: PRIYA, ownerName: 'Priya (store manager)', ackWithinMinutes: 15, escalatesToUserId: OWNER },
    { alertId: 'store-sync-refused', component: 'dead_letter', firesAt: 'degraded', ownerUserId: PRIYA, ownerName: 'Priya (store manager)', ackWithinMinutes: 15, escalatesToUserId: OWNER },
  ],
};

interface Live { alert: { alertId: string; ownerUserId: string; detail: string; status: string }; state: string; occurrence: number; escalatedTo?: string; acknowledgedBy?: string; deliveries: { to: string; via: string; stage: string }[]; deliveredToMe?: { via: string; stage: string }[] }

function countingTransport(): NotificationTransport & { readonly sent: OutboundMessage[]; readonly calls: OutboundMessage[] } {
  const inner = recordingTransport();
  const calls: OutboundMessage[] = [];
  return { name: inner.name, sent: inner.sent, calls, send: (m) => { calls.push(m); return inner.send(m); } };
}

describeOrSkip('PA-12 — alerts reach their named owner and escalate — real API, real PostgreSQL, across a restart', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); vi.useRealTimers(); });

  it('a failed backup and a store\'s refused sync items go to Priya, escalate to the owner, are acknowledged, kept, and recur as new', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    travel(0);
    const tenantId = randomUUID();
    const transport = countingTransport();
    const boot = async (): Promise<RealCloud> => {
      const c = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY, providers: { notificationTransport: transport, opsAlertWorkerIntervalMs: 50 } });
      clouds.push(c);
      return c;
    };
    let cloud = await boot();
    expect(cloud.opsAlertWorker).toBeDefined();

    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${Math.random()}` }) });
    const passes = async (n = 2): Promise<void> => {
      const target = cloud.opsAlertWorker!.total() + n;
      for (let i = 0; i < 400 && cloud.opsAlertWorker!.total() < target; i += 1) await sleep(10);
      expect(cloud.opsAlertWorker!.total()).toBeGreaterThanOrEqual(target);
    };
    const inbox = async (who: string): Promise<Live[]> => ((await call('GET', '/v1/platform/alerts/inbox', who)).body as { alerts: Live[] }).alerts;
    const board = async (): Promise<Live[]> => ((await call('GET', '/v1/platform/alerts', OWNER)).body as { alerts: Live[] }).alerts;
    const backup = (id: string, ok: boolean) => call('POST', `/v1/platform/backups/${id}/taken`, OWNER, { at: new Date(Date.now()).toISOString(), ok, encrypted: true, offsite: true, ...(ok ? {} : { detail: 'pg_dump exited 1: disk full' }) });
    const messagesTo = (who: string): OutboundMessage[] => transport.calls.filter((m) => m.customerId === who);

    // The owner names who owns what (§32: a person, not a team).
    expect((await call('PUT', '/v1/platform/alert-rules', OWNER, RULES)).status).toBe(200);
    // Last night's backup was good: nothing to say.
    expect((await backup('b-1', true)).status).toBe(201);
    await passes();
    expect(await inbox(PRIYA)).toEqual([]);

    // 1 — A FAILED BACKUP an hour later. Nobody presses anything: it is raised to Priya, in her inbox and to her phone.
    travel(60);
    await passes(); // a pass in flight at the old time finishes first — each pass judges at one moment
    expect((await backup('b-2', false)).body).toMatchObject({ counts: false, why: ['it did not complete'] });
    await passes();
    const mine = await inbox(PRIYA);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ state: 'open', occurrence: 1, alert: { alertId: 'backup', ownerUserId: PRIYA, status: 'degraded' } });
    expect(mine[0]!.alert.detail).toMatch(/latest backup \(b-2, .*\) did not complete/);
    expect(mine[0]!.deliveredToMe!.map((d) => d.via).sort()).toEqual(['inbox', 'recording-test-adapter']);
    expect(messagesTo(PRIYA)).toHaveLength(1);
    expect(messagesTo(PRIYA)[0]!.text).toMatch(/backup is degraded .*Please acknowledge by/);
    expect(await inbox(OWNER)).toEqual([]);                              // not the owner's — yet

    // 2 — NOBODY ANSWERS for 20 minutes: escalated to the owner — his inbox and a message to him.
    travel(80);
    await passes();
    const boss = await inbox(OWNER);
    expect(boss).toEqual([expect.objectContaining({ state: 'escalated', escalatedTo: OWNER })]);
    expect(boss[0]!.deliveredToMe!.map((d) => `${d.stage}:${d.via}`).sort()).toEqual(['escalated:inbox', 'escalated:recording-test-adapter']);
    expect(messagesTo(OWNER)).toHaveLength(1);
    expect(messagesTo(OWNER)[0]!.text).toMatch(/^ESCALATED to you: backup is degraded/);
    await passes();
    expect(messagesTo(OWNER)).toHaveLength(1);                          // delivered once, not every pass

    // 3 — The owner acknowledges: it stops, leaves both inboxes, and STAYS on the board with who took it.
    expect((await call('POST', '/v1/platform/alerts/backup/acknowledge', OWNER, {})).status).toBe(200);
    expect(await inbox(OWNER)).toEqual([]);
    expect(await inbox(PRIYA)).toEqual([]);
    expect((await board()).find((a) => a.alert.alertId === 'backup')).toMatchObject({ state: 'acknowledged', acknowledgedBy: OWNER });

    // 4 — A LANE ALERT: the store computer reports two sync items head office refused. Raised to Priya the same way.
    expect((await call('POST', '/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await call('POST', '/v1/org/nodes/S1', OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    await cloud.grant('u-box1', 'store_computer'); // round 6: only the store computer's own identity reports its sync
    travel(90);
    await passes(); // a pass in flight at the old time finishes first — each pass judges at one moment
    const report = await call('POST', '/v1/stores/S1/sync-watermarks', 'u-box1', { observedAt: at(90), domains: [{ domain: 'sales', completeThrough: at(89), unsent: 0, deadLettered: 2 }] });
    expect(report.status).toBe(200);
    await passes();
    const lane = (await inbox(PRIYA)).find((a) => a.alert.alertId === 'store-sync-refused');
    expect(lane).toMatchObject({ state: 'open', alert: { ownerUserId: PRIYA } });
    expect(messagesTo(PRIYA).map((m) => m.messageId)).toEqual(expect.arrayContaining([expect.stringContaining('store-sync-refused')]));
    const observed = (await call('GET', '/v1/platform/operational-health/observed', OWNER)).body as { observed: { provenance: Record<string, string>; signals: { deadLetterCount: number } } };
    expect(observed.observed.signals.deadLetterCount).toBe(2);
    expect(observed.observed.provenance['lastSyncAt']).toMatch(/store computer's last complete sync/);

    // 5 — RESTART the API. Nothing is delivered again; the whole history is there.
    const callsBefore = transport.calls.length;
    await cloud.stop(); clouds.pop();
    cloud = await boot();
    await passes();
    expect(transport.calls.length).toBe(callsBefore);
    expect((await board()).map((a) => [a.alert.alertId, a.state]).sort()).toEqual([['backup', 'acknowledged'], ['store-sync-refused', 'open']]);

    // 6 — A good backup CLEARS the backup alert (kept, marked cleared); the next failure is a NEW occurrence, delivered
    // to Priya again — last week's acknowledgement does not swallow tonight's failure.
    travel(120);
    await passes(); // a pass in flight at the old time finishes first — each pass judges at one moment
    expect((await backup('b-3', true)).status).toBe(201);
    await passes();
    expect((await board()).find((a) => a.alert.alertId === 'backup')).toMatchObject({ state: 'cleared' });
    travel(180);
    await passes(); // a pass in flight at the old time finishes first — each pass judges at one moment
    expect((await backup('b-4', false)).status).toBe(201);
    await passes();
    const again = (await inbox(PRIYA)).find((a) => a.alert.alertId === 'backup');
    expect(again).toMatchObject({ state: 'open', occurrence: 2 });
    expect(messagesTo(PRIYA).filter((m) => m.messageId.includes('-backup-o2-'))).toHaveLength(1);
  }, 60_000);
});
