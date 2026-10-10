import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { prepareTillBox, pinOf, operatorHeader, type TillPerson } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **The store day close reaches head office, through the real edge — M14-FR-04, §31, P-01 (Slice 3a).**
 *
 * This is the join slices 1 & 2 could not make on their own: the cloud route (slice 1) and the
 * transport route (slice 2) existed and were tested, but nothing in the running box PRODUCED a day
 * close. Now `startEdge` gives the box a fourth durable pipeline and an AUTHORITATIVE `edge.closeDay`,
 * which reads the box's LIVE state — the depth of ALL its outboxes and the exception register the
 * manager screen shows — and hands the tested engine the real numbers. The decision lives here because
 * the "no unsent items" gate can only be evaluated where the outbox is.
 *
 * Everything below the socket is production: the real `startEdge` opens real durable logs, the real
 * `SyncAgent` + `httpTransport` drain to a `fetch` that drives the real cloud API (router, token auth,
 * RBAC, the append-only day-close stream). Only the socket is replaced. The last thing it proves is the
 * safety property: a locked day the box could not send yet is re-queued after a restart, never lost.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';
// The box and head office hold the same pack signing key, as a real store and its head office do (ADR-0023).
const KEY = TEST_PACK_KEY;
/**
 * The people the box knows (its pack) and the till PINs issued on it (2b-vi-c-4): the owner may see and approve the locked
 * days, the accountant may approve, the store manager may only see them, the cashier neither. PINs are made at run time.
 */
const PEOPLE: readonly TillPerson[] = [
  { userId: 'u-owner', permissions: ['till.dayclose.read', 'till.dayclose.approve'] },
  { userId: 'u-acct', permissions: ['till.dayclose.read', 'till.dayclose.approve'] },
  { userId: 'u-mgr', permissions: ['till.dayclose.read'] },
  { userId: 'u-lanecash' },
];
/** The owner reopens with their own PIN; the accountant approves with theirs. */
const PINS = { reopenerPin: pinOf('u-owner'), approverPin: pinOf('u-acct') };

/** A store pack the box loads from disk: a CHECKED (empty) exception register + a 02:00 cut-off. Its
 *  presence is what lets the day close — an absent loss-prevention register is a hard block by design. */
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00' }, lossPreventionRules: [] });

/** An edge-committed sale, in the disk shape the lane writes and `toCloudSale` reads. */
const saleRecord = (saleId: string) => JSON.stringify({
  id: saleId, number: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-lanecash',
  tradingDay: '2026-08-07', committedAt: AT, total: 15000, currency: 'INR',
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amount: { minor: 15000, currency: 'INR' } }],
});

interface Row { dayCloseId: string; locked: boolean; reopened: boolean; closedBy: string; reopenedBy: string | null; approvedBy: string | null; governanceFlags: readonly string[] }
interface ListBody { dayCloses: Row[]; lockedCount: number }
const dayCloses = async (h: ApiHarness): Promise<ListBody> =>
  (await h.request({ method: 'GET', path: '/v1/pos/day-close', userId: 'u-owner', tenantId: A })).body as ListBody;

/** A fresh cloud + a temp data dir + the global `fetch` pointed at the cloud. `withPack` writes the
 *  store pack so the exception register is checked; omit it to prove the box refuses on an absent one. */
const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0)) await c();
});

async function scene(opts: { readonly withPack: boolean }): Promise<{
  h: ApiHarness;
  boot: () => Promise<EdgeProcess>;
  setOnline: (v: boolean) => void;
}> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // till.dayclose.sync + .read + .approve
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // till.dayclose.sync + .read — the sync identity
  const dir = await mkdtemp(join(tmpdir(), 'sre-edge-day-close-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  // With a pack: the box's people and their PINs, a lane, and its lane socket (where the PIN register lives).
  const tillEnv = opts.withPack
    ? { ...(await prepareTillBox({ dir, key: KEY, people: PEOPLE, pack: JSON.parse(PACK_JSON) as Record<string, unknown> })), EDGE_LANE_PORT: '0' }
    : {};

  let online = true;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'],
      path: new URL(url).pathname,
      token: hdr['authorization']?.replace(/^Bearer /, ''),
      idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: 'https://cloud.example.test',
    // The store's sync token — a store manager who holds till.dayclose.sync. The cloud authenticates it.
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-mgr', tenantId: A }),
    ...tillEnv,
  });

  return {
    h,
    boot: async () => {
      const edge = (await startEdge(env(), () => {}))!;
      cleanups.push(async () => { await edge.stop(); });
      return edge;
    },
    setOnline: (v: boolean) => { online = v; },
  };
}

describe('the store day close reaches head office through the real edge (M14-FR-04, §31, P-01)', () => {
  it('locks the day on the box and it reaches the cloud, recorded locked', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();

    const outcome = await edge.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
    expect(outcome.closed).toBe(true);
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(1); // queued, not yet drained

    await edge.syncOnce!();
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(0); // acknowledged by the cloud

    const body = await dayCloses(s.h);
    expect(body.lockedCount).toBe(1);
    expect(body.dayCloses[0]).toMatchObject({ dayCloseId: 'dc-1', locked: true, reopened: false, closedBy: 'u-mgr' });
  });

  it('round 4 (P-04 · hard rule #4): the close is the closer\'s OWN act — a typed name, a wrong PIN, a cashier and a session without the authority are refused on the box, offline, and nothing is locked or sent', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();
    s.setOnline(false);
    const lane = `http://127.0.0.1:${edge.lane!.port}/lane/day-close`;
    const post = async (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      (await savedFetch(lane, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).json() as Promise<{ closed: boolean; reason?: string }>;
    // A name typed on a screen closes nothing.
    expect(await post({ dayCloseId: 'dc-typed', closedBy: 'u-mgr' })).toMatchObject({ closed: false, reason: expect.stringMatching(/till PIN/) });
    // The manager's name with somebody else's PIN.
    expect(await post({ dayCloseId: 'dc-wrong', closedBy: 'u-mgr', closerPin: pinOf('u-lanecash') })).toMatchObject({ closed: false, reason: expect.stringMatching(/not confirmed/) });
    // The cashier's own, correct PIN: a cashier does not hold the day-close authority in the store's setup.
    expect(await post({ dayCloseId: 'dc-cash', closedBy: 'u-lanecash', closerPin: pinOf('u-lanecash') })).toMatchObject({ closed: false, reason: expect.stringMatching(/not confirmed/) });
    // The cashier signed in at the till (a verified session) is still not a closer — and cannot close in the manager's name.
    const signIn = await (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/operator/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staffId: 'u-lanecash', pin: pinOf('u-lanecash') }) })).json() as { token: string };
    const token = signIn.token;
    expect(await post({ dayCloseId: 'dc-sess', closedBy: 'u-lanecash' }, operatorHeader(token))).toMatchObject({ closed: false, reason: expect.stringMatching(/authority/) });
    expect(await post({ dayCloseId: 'dc-sess2', closedBy: 'u-mgr' }, operatorHeader(token))).toMatchObject({ closed: false, reason: expect.stringMatching(/till PIN|person signed in/) });
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(0);
    expect(await readLog(edge.dayCloseLog.path)).toEqual([]);
    // The manager, with their OWN PIN, offline: locked on the box, in the name the box verified.
    expect(await post({ dayCloseId: 'dc-ok', closedBy: 'u-mgr', closerPin: pinOf('u-mgr') })).toMatchObject({ closed: true, locked: true });
    const written = (await readLog(edge.dayCloseLog.path)).map((r) => JSON.parse((r as { record: string }).record) as Record<string, unknown>);
    expect(written).toEqual([expect.objectContaining({ dayCloseId: 'dc-ok', closedBy: 'u-mgr' })]);
    expect(JSON.stringify(written)).not.toContain(pinOf('u-mgr'));
    s.setOnline(true);
    await edge.syncOnce!();
    expect((await dayCloses(s.h)).dayCloses).toEqual([expect.objectContaining({ dayCloseId: 'dc-ok', closedBy: 'u-mgr', locked: true })]);
  });

  it('REFUSES to close when the exception register was never checked (no loss-prevention rules) — nothing reaches the cloud', async () => {
    const s = await scene({ withPack: false }); // emptyPack → lossPreventionRules not known
    const edge = await s.boot();

    const outcome = await edge.closeDay({ dayCloseId: 'dc-x', closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
    expect(outcome.closed).toBe(false);
    if (outcome.closed) return;
    expect(outcome.reason).toMatch(/loss-prevention rules/);

    await edge.syncOnce!();
    expect((await dayCloses(s.h)).dayCloses).toHaveLength(0); // never recorded — the day did not close
  });

  it('REFUSES to close while a sale is still unsent — a gate only the box can evaluate', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();

    // A sale committed but not drained sits in the sales outbox — the box knows it, the cloud cannot.
    await edge.node.commit('S9', saleRecord('S9'));
    expect(edge.outbox.pending().length).toBe(1);

    const outcome = await edge.closeDay({ dayCloseId: 'dc-2', closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
    expect(outcome.closed).toBe(false);
    if (outcome.closed) return;
    expect(outcome.reason).toMatch(/unsent|not yet reconciled/i);
  });

  it('waits out an outage and, after a restart, still sends the locked day (§31, hard rule #6)', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();

    s.setOnline(false);
    const outcome = await edge.closeDay({ dayCloseId: 'dc-3', closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
    expect(outcome.closed).toBe(true); // the day LOCKS locally with the cable out (P-01)
    await edge.syncOnce!(); // cannot reach the cloud — stays queued, durable on the disk
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(1);
    expect((await dayCloses(s.h)).dayCloses).toHaveLength(0);
    await edge.stop(); // process goes; the locked day is on the disk

    // A fresh box on the SAME data dir re-queues the locked day from its log, and sends it when the line returns.
    s.setOnline(true);
    const restarted = await s.boot();
    await restarted.syncOnce!();
    expect(restarted.dayCloseAgent?.health().unsentCount).toBe(0);
    const body = await dayCloses(s.h);
    expect(body.lockedCount).toBe(1);
    expect(body.dayCloses[0]).toMatchObject({ dayCloseId: 'dc-3', locked: true });
  });
});

describe('the controlled reopen reaches head office through the real edge (M14-FR-04 / §28)', () => {
  it('reopens a locked day and it reaches the cloud, recorded unlocked with NO §28 breach', async () => {
    const s = await scene({ withPack: true });
    await s.h.provisionRole(A, 'u-acct', 'accountant'); // holds till.dayclose.approve — a genuine approver
    const edge = await s.boot();

    // Close first, and let it reach the cloud (a day must be locked before it can be reopened).
    expect((await edge.closeDay({ dayCloseId: 'dc-r1', closedBy: 'u-owner', closerPin: pinOf('u-owner') })).closed).toBe(true);
    await edge.syncOnce!();
    expect((await dayCloses(s.h)).lockedCount).toBe(1);

    // Reopen it: the owner reopens, a DIFFERENT authority (the accountant) approved it (§28).
    const outcome = await edge.reopenDay({ dayCloseId: 'dc-r1', reopenedBy: 'u-owner', reason: 'wrong float found next morning', approvedBy: 'u-acct', ...PINS });
    expect(outcome.reopened).toBe(true);
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(1); // the reopen is queued, not yet drained
    await edge.syncOnce!();
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(0);

    const body = await dayCloses(s.h);
    // A reopened day is open again (locked:false) and the approver is recorded. The box verified BOTH people by their own
    // PINs and sealed them (2b-vi-c-4), so head office has nothing to say.
    expect(body.lockedCount).toBe(0);
    expect(body.dayCloses[0]).toMatchObject({ dayCloseId: 'dc-r1', locked: false, reopened: true, reopenedBy: 'u-owner', approvedBy: 'u-acct' });
    expect(body.dayCloses[0]?.governanceFlags).toEqual([]);
  });

  it('REFUSES at the box an approver without the authority in the pack, a missing approver PIN, a wrong PIN, and an unconfirmed reopener (2b-vi-c-4)', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();
    expect((await edge.closeDay({ dayCloseId: 'dc-r2', closedBy: 'u-owner', closerPin: pinOf('u-owner') })).closed).toBe(true);
    await edge.syncOnce!();
    const ask = (over: Record<string, unknown>) => edge.reopenDay({ dayCloseId: 'dc-r2', reopenedBy: 'u-owner', reason: 'recount', approvedBy: 'u-acct', ...PINS, ...over });
    // The store manager may see the locked days but not approve a reopen: the box says so, before anything is written.
    expect(await ask({ approvedBy: 'u-mgr', approverPin: pinOf('u-mgr') })).toMatchObject({ reopened: false, reason: expect.stringMatching(/approver was not confirmed/) });
    // A typed approver with no PIN of their own is not an approval.
    expect(await ask({ approverPin: undefined })).toMatchObject({ reopened: false, reason: expect.stringMatching(/their own till PIN/) });
    // A wrong PIN for the approver, and a reopener who neither signed in nor gave their PIN.
    const wrong = pinOf('u-acct') === pinOf('u-lanecash') ? pinOf('u-mgr') : pinOf('u-lanecash');
    expect(await ask({ approverPin: wrong })).toMatchObject({ reopened: false });
    expect(await ask({ reopenerPin: undefined })).toMatchObject({ reopened: false, reason: expect.stringMatching(/must confirm it is them/) });
    await edge.syncOnce!();
    expect((await dayCloses(s.h)).dayCloses.find((r) => r.dayCloseId === 'dc-r2')?.reopened).toBe(false);
  });

  it('REFUSES a self-approved reopen at the box (§28) — nothing reaches the cloud', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();
    expect((await edge.closeDay({ dayCloseId: 'dc-r3', closedBy: 'u-owner', closerPin: pinOf('u-owner') })).closed).toBe(true);
    await edge.syncOnce!();

    // The reopener names themselves as the approver — the engine's §28 gate throws, the box refuses.
    const outcome = await edge.reopenDay({ dayCloseId: 'dc-r3', reopenedBy: 'u-owner', reason: 'recount', approvedBy: 'u-owner', reopenerPin: pinOf('u-owner'), approverPin: pinOf('u-owner') });
    expect(outcome.reopened).toBe(false);
    if (outcome.reopened) return;
    expect(outcome.reason).toMatch(/different person|approval/i);
    await edge.syncOnce!();
    // The day is still locked at the cloud — no reopen was recorded.
    const body = await dayCloses(s.h);
    expect(body.lockedCount).toBe(1);
    expect(body.dayCloses.find((r) => r.dayCloseId === 'dc-r3')?.reopened).toBe(false);
  });

  it('on the hosted copy the signed-in reopener needs no PIN; the approver still keys theirs; both are sealed (2b-vi-c-4)', async () => {
    const s = await scene({ withPack: true });
    await s.h.provisionRole(A, 'u-acct', 'accountant');
    const edge = await s.boot();
    expect((await edge.closeDay({ dayCloseId: 'dc-r5', closedBy: 'u-owner', closerPin: pinOf('u-owner') })).closed).toBe(true);
    await edge.syncOnce!();
    // The person the box verified for the request is the owner (the hosted sign-in) — but somebody else's session does not count.
    expect(await edge.reopenDay({ dayCloseId: 'dc-r5', reopenedBy: 'u-owner', reason: 'recount', approvedBy: 'u-acct', approverPin: pinOf('u-acct'), verifiedPerson: { userId: 'u-lanecash', via: 'verified_sign_in', laneId: 'lane-1' } }))
      .toMatchObject({ reopened: false });
    const outcome = await edge.reopenDay({ dayCloseId: 'dc-r5', reopenedBy: 'u-owner', reason: 'recount', approvedBy: 'u-acct', approverPin: pinOf('u-acct'), verifiedPerson: { userId: 'u-owner', via: 'verified_sign_in', laneId: 'lane-1' } });
    expect(outcome.reopened).toBe(true);
    await edge.syncOnce!();
    const row = (await dayCloses(s.h)).dayCloses.find((r) => r.dayCloseId === 'dc-r5');
    expect(row?.governanceFlags).toEqual([]);
  });

  it('refuses to reopen a day this box never closed', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();
    const outcome = await edge.reopenDay({ dayCloseId: 'dc-never', reopenedBy: 'u-owner', reason: 'x', approvedBy: 'u-acct' });
    expect(outcome.reopened).toBe(false);
    if (outcome.reopened) return;
    expect(outcome.reason).toMatch(/not closed on this box/i);
  });

  it('after a restart, re-queues BOTH the close and the reopen with their correct types (never a reopen as a close)', async () => {
    const s = await scene({ withPack: true });
    await s.h.provisionRole(A, 'u-acct', 'accountant');
    const edge = await s.boot();
    expect((await edge.closeDay({ dayCloseId: 'dc-r4', closedBy: 'u-owner', closerPin: pinOf('u-owner') })).closed).toBe(true);
    const reopen = await edge.reopenDay({ dayCloseId: 'dc-r4', reopenedBy: 'u-owner', reason: 'recount', approvedBy: 'u-acct', ...PINS });
    expect(reopen.reopened).toBe(true);
    await edge.stop(); // both the close and the reopen are on the disk, undrained

    // A fresh box re-reads its log and re-queues both — the reopen record must re-mint as StoreDayReopened,
    // never as a close, or a locked day would silently come back. Draining leaves the cloud recorded reopened.
    const restarted = await s.boot();
    await restarted.syncOnce!();
    expect(restarted.dayCloseAgent?.health().unsentCount).toBe(0);
    const body = await dayCloses(s.h);
    expect(body.lockedCount).toBe(0);
    expect(body.dayCloses[0]).toMatchObject({ dayCloseId: 'dc-r4', reopened: true, locked: false, approvedBy: 'u-acct' });
    // The seals on both people survived the restart: re-minted from the disk exactly as written.
    expect(body.dayCloses[0]?.governanceFlags).toEqual([]);
  });
});
