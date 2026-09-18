import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { SyncAgent } from '../../edge/sync-agent/src/agent';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { closeDay, reopenDay } from '../../packages/day-close/src/index';
import { makeTradingDayRule } from '../../packages/calendar/src/index';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';

/**
 * **The store day close reaches the cloud and reconciles — M14-FR-04, §31, §28 (Slice 2, the transport wire).**
 *
 * The store LOCKS its trading day at the edge: `closeDay` (packages/day-close) checks the trading-day
 * cut-off and that the store is fully reconciled — no unsent items, a gate only the edge can evaluate —
 * and QUEUES a `StoreDayClosed` event. Until this increment that event had **nowhere to go**:
 * `EVENT_ROUTES` had no entry, so the sync agent would dead-letter it and a locked day never reached the
 * cloud. This is the wire — the agent now routes `StoreDayClosed` to `POST /v1/pos/day-close/:id/synced`
 * and `StoreDayReopened` to `.../reopen/synced`, the record-and-flag routes that re-verify the §28
 * approver on the cloud.
 *
 * Exercised through the REAL parts: the real `closeDay`/`reopenDay` mint the events, the real `SyncOutbox`
 * queues them, the real `SyncAgent` + `httpTransport` drain them, and `fetch` drives the real cloud API
 * (router, token auth, permission check, append-only day-close stream). Only the socket is replaced.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RULE = makeTradingDayRule('02:00'); // trading day D runs 02:00 D → 02:00 D+1

const baseClose = (over: Record<string, unknown> = {}) => ({
  id: 'dc-1', storeId: 'store-1', tradingDay: '2026-08-02', closedBy: 'u-mgr',
  // 03:00 on 2026-08-03 is trading day 2026-08-03 → 2026-08-02 has ended and may close.
  closedAtLocal: '2026-08-03T03:00', closedAt: '2026-08-02T21:30:00Z',
  tradingDayRule: RULE, unresolvedExceptions: 0, unsentSyncItems: 0, ...over,
});

/** A §28 reopen approval for `subjectRef`, decided by `by` (must differ from the reopener). */
function reopenApproval(subjectRef: string, by: string) {
  const req = requestApproval({ id: subjectRef, subjectType: 'day_reopen', subjectRef, requestedBy: 'u-mgr', value: money(0, 'INR') });
  const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
  const outcome = decide(req, approver, 'approved', 'audit correction', '2026-08-03T10:00:00Z');
  if (!outcome.ok) throw new Error('expected approval');
  return outcome.request;
}

const list = (h: ApiHarness, u: string) => h.request({ method: 'GET', path: '/v1/pos/day-close', userId: u, tenantId: A });
interface Row { dayCloseId: string; tradingDay: string; locked: boolean; reopened: boolean; reopenedBy: string | null; approvedBy: string | null; governanceFlags: string[] }
interface ListBody { dayCloses: Row[]; lockedCount: number; flaggedReopens: { dayCloseId: string; governanceFlags: string[] }[] }

/**
 * A fresh cloud + a sync agent bound to it. The store relays under `u-mgr` (a store_manager, who holds
 * `till.dayclose.sync`); `u-owner` holds the §28 `till.dayclose.approve` and the read. Below the socket is production.
 */
async function scene() {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // till.dayclose.sync + .read + .approve
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // till.dayclose.sync + .read (the relay identity), NOT .approve

  const token = TEST_IDP.issue({ sub: 'u-mgr', tenantId: A });
  let online = true;

  const apiFetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (!online) throw new Error('ENETUNREACH');
    const hdr = init.headers as Record<string, string>;
    const res = await h.raw({
      method: 'POST', path: new URL(url).pathname,
      token: hdr['authorization']?.replace(/^Bearer /, ''),
      idempotencyKey: hdr['idempotency-key'],
      body: JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const transport = httpTransport({ baseUrl: 'https://cloud.example.test', token, fetch: apiFetch, timeoutMs: 5_000 });

  return {
    h,
    setOnline: (v: boolean) => { online = v; },
    /** Close the day offline through the REAL engine; returns the outbox holding StoreDayClosed. */
    closeOffline: (over: Record<string, unknown> = {}): SyncOutbox => {
      const outbox = new SyncOutbox();
      closeDay(baseClose(over) as Parameters<typeof closeDay>[0], outbox);
      return outbox;
    },
    /** Reopen the day offline through the REAL engine; returns the outbox holding StoreDayReopened. */
    reopenOffline: (approvedBy: string): SyncOutbox => {
      const outbox = new SyncOutbox();
      reopenDay({ id: 'dc-1', storeId: 'store-1', tradingDay: '2026-08-02', reopenedBy: 'u-mgr', reopenedAt: '2026-08-03T10:05:00Z', reason: 'late supplier credit note', approval: reopenApproval('dc-1', approvedBy) }, outbox);
      return outbox;
    },
    drain: (outbox: SyncOutbox) => new SyncAgent(outbox, transport).drain({ at: '2026-08-03T03:05:00Z' }),
    agentFor: (outbox: SyncOutbox) => new SyncAgent(outbox, transport),
  };
}

describe('store day close reaches the cloud and reconciles on sync (M14-FR-04, §31, §28)', () => {
  it('delivers a locked day close to the cloud, and it is recorded as locked', async () => {
    const s = await scene();
    const outbox = s.closeOffline();
    expect(outbox.unsentCount()).toBe(1);
    expect(outbox.pending()[0]?.event.type).toBe('StoreDayClosed');

    const result = await s.drain(outbox);
    // Before this increment StoreDayClosed had no route and dead-lettered here. Now it is delivered.
    expect(result.acknowledged).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(result.remaining).toBe(0);

    const body = (await list(s.h, 'u-owner')).body as ListBody;
    expect(body.lockedCount).toBe(1);
    expect(body.dayCloses.find((r) => r.dayCloseId === 'dc-1')).toMatchObject({ tradingDay: '2026-08-02', locked: true, reopened: false });
  });

  it('delivers a controlled reopen approved by a genuine authority — recorded, no flags, day unlocked', async () => {
    const s = await scene();
    expect((await s.drain(s.closeOffline())).acknowledged).toBe(1);

    // u-owner genuinely holds till.dayclose.approve and is not the reopener (u-mgr) — a clean §28 reopen.
    const result = await s.drain(s.reopenOffline('u-owner'));
    expect(result.acknowledged).toBe(1);
    expect(result.deadLettered).toBe(0);

    const body = (await list(s.h, 'u-owner')).body as ListBody;
    expect(body.dayCloses.find((r) => r.dayCloseId === 'dc-1')).toMatchObject({ locked: false, reopened: true, reopenedBy: 'u-mgr', approvedBy: 'u-owner' });
    expect(body.flaggedReopens).toHaveLength(0);
  });

  it('reconciles a reopen whose approver lacks authority, AND flags it as a visible §28 exception', async () => {
    const s = await scene();
    expect((await s.drain(s.closeOffline())).acknowledged).toBe(1);

    // The edge engine only checks the approver differs from the reopener; u-nobody does, so it emits.
    // The cloud re-verifies authority: u-nobody holds no till.dayclose.approve. The reopen already
    // happened at the store, so it is RECORDED (never rejected) and flagged for a person.
    const result = await s.drain(s.reopenOffline('u-nobody'));
    expect(result.acknowledged).toBe(1); // recorded, not refused
    expect(result.deadLettered).toBe(0);

    const body = (await list(s.h, 'u-owner')).body as ListBody;
    expect(body.dayCloses.find((r) => r.dayCloseId === 'dc-1')).toMatchObject({ locked: false, reopened: true });
    expect(body.flaggedReopens).toContainEqual(expect.objectContaining({ dayCloseId: 'dc-1', governanceFlags: ['approver_lacks_authority'] }));
  });

  it('waits out an outage, then reconciles once the line returns (§31)', async () => {
    const s = await scene();
    const outbox = s.closeOffline();

    s.setOnline(false);
    const offlinePass = await s.drain(outbox);
    // A slow link never says the close was bad: nothing acknowledged, nothing dead-lettered, still queued.
    expect(offlinePass.acknowledged).toBe(0);
    expect(offlinePass.deadLettered).toBe(0);
    expect(offlinePass.remaining).toBe(1);
    expect(((await list(s.h, 'u-owner')).body as ListBody).lockedCount).toBe(0);

    s.setOnline(true);
    const backPass = await s.drain(outbox);
    expect(backPass.acknowledged).toBe(1);
    expect(s.agentFor(outbox).health().unsentCount).toBe(0);
    expect(((await list(s.h, 'u-owner')).body as ListBody).lockedCount).toBe(1);
  });
});
