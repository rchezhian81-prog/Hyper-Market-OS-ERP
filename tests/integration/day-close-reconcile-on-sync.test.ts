import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sealedDayReopen } from '../support/store-seal';

// Store/day close reconcile-on-sync (M14-FR-04 · P-01 offline-first · §28, API-05, Slice 1). A store closes
// and LOCKS its trading day at the edge (packages/day-close: only once the trading-day cut-off has passed and
// the store is fully reconciled — no unsent items, which only the edge can know). The sync agent later relays
// that fact to POST /v1/pos/day-close/:id/synced under the store's sync token. Like the offline-refund route,
// this TRUSTS the fact that happened and never rejects it — it records the locked day. A controlled REOPEN
// (POST .../reopen/synced) is where the cloud adds the one control the edge could not fully apply: it
// re-verifies that the named approver genuinely holds the §28 authority, and RECORDS-AND-FLAGS a breach
// (hard rule #10) rather than rejecting a reopen that already happened. GET /v1/pos/day-close is the
// locked-day list the finance close (M23) and the owner (M29) read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T21:30:00.000Z';

const close = (over: Record<string, unknown> = {}) => ({
  storeId: 'store-1', tradingDay: '2026-08-07', closedBy: 'u-mgr', closedAt: AT, ...over,
});
const syncClose = (h: ApiHarness, u: string, dayCloseId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/pos/day-close/${dayCloseId}/synced`, userId: u, tenantId: A, idempotencyKey: key ?? `sc-${dayCloseId}`, body });
const syncReopen = (h: ApiHarness, u: string, dayCloseId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/pos/day-close/${dayCloseId}/reopen/synced`, userId: u, tenantId: A, idempotencyKey: `sr-${dayCloseId}`, body: sealedDayReopen(A, dayCloseId, body as Record<string, unknown>) });
const list = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/pos/day-close', userId: u, tenantId: A });

interface CloseBody { dayCloseId?: string; closed?: boolean; locked?: boolean; alreadyClosed?: boolean }
interface ReopenBody { dayCloseId?: string; reopened?: boolean; flags?: string[]; alreadyReopened?: boolean }
interface Row { dayCloseId: string; tradingDay: string; locked: boolean; reopened: boolean; reopenedBy: string | null; approvedBy: string | null; governanceFlags: string[] }
interface ListBody { dayCloses: Row[]; lockedCount: number; flaggedReopens: { dayCloseId: string; governanceFlags: string[] }[] }
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // till.dayclose.sync + .read + .approve
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // till.dayclose.sync + .read, but NOT .approve
  await h.provisionRole(A, 'u-acct', 'accountant');    // till.dayclose.read + .approve, but NOT .sync
  await h.provisionRole(A, 'u-cash', 'cashier');       // none of the day-close permissions
  return h;
}

describe('store/day close reconciles on sync — record, lock, and re-verify the reopen (M14-FR-04, §28)', () => {
  it('records a locked day the edge closed, and the list shows it locked', async () => {
    const h = await cast();
    const res = await syncClose(h, 'u-mgr', 'dc-1', close());
    expect(res.status).toBe(202);
    expect(res.body as CloseBody).toMatchObject({ dayCloseId: 'dc-1', closed: true, locked: true });

    const body = (await list(h, 'u-owner')).body as ListBody;
    expect(body.lockedCount).toBe(1);
    expect(body.dayCloses.find((r) => r.dayCloseId === 'dc-1')).toMatchObject({ tradingDay: '2026-08-07', locked: true, reopened: false });
  });

  it('reconciles a reopen with a genuinely-authorised approver — recorded, day unlocked, the typed approver said as unverified', async () => {
    const h = await cast();
    await syncClose(h, 'u-mgr', 'dc-1', close());

    // The store manager reopened; the OWNER (a different person, holding till.dayclose.approve) approved it.
    const res = await syncReopen(h, 'u-mgr', 'dc-1', { reopenedBy: 'u-mgr', approvedBy: 'u-owner', reason: 'late supplier credit note' });
    expect(res.status).toBe(202);
    // The box vouched for the reopener (sealed); the approver's name was typed on the screen and no store computer verified
    // that person — said, never hidden (2b-vi-c-3). Their own PIN at the box is the next slice.
    expect((res.body as ReopenBody).flags).toEqual(['approver_not_verified_at_store']);

    const body = (await list(h, 'u-owner')).body as ListBody;
    const row = body.dayCloses.find((r) => r.dayCloseId === 'dc-1')!;
    expect(row).toMatchObject({ locked: false, reopened: true, reopenedBy: 'u-mgr', approvedBy: 'u-owner' });
    expect(body.lockedCount).toBe(0);
  });

  it('records-and-flags a reopen whose approver lacks the §28 authority — 202, never rejected', async () => {
    const h = await cast();
    await syncClose(h, 'u-mgr', 'dc-1', close());

    // The store manager holds sync+read but NOT approve; an unprovisioned name holds nothing either.
    const res = await syncReopen(h, 'u-mgr', 'dc-1', { reopenedBy: 'u-mgr', approvedBy: 'u-nobody', reason: 'audit correction' });
    expect(res.status).toBe(202);
    expect((res.body as ReopenBody).flags).toEqual(['approver_lacks_authority', 'approver_not_verified_at_store']);

    const body = (await list(h, 'u-owner')).body as ListBody;
    expect(body.flaggedReopens).toContainEqual(expect.objectContaining({ dayCloseId: 'dc-1', governanceFlags: ['approver_lacks_authority', 'approver_not_verified_at_store'] }));
    // Recorded (it happened): the day is reopened, not still locked.
    expect(body.dayCloses.find((r) => r.dayCloseId === 'dc-1')).toMatchObject({ locked: false, reopened: true });
  });

  it('flags a reopen given with no approver, and one self-approved (§28)', async () => {
    const h = await cast();
    await syncClose(h, 'u-mgr', 'dc-1', close());
    await syncClose(h, 'u-mgr', 'dc-2', close({ tradingDay: '2026-08-08' }));

    // No approver at all.
    expect((await syncReopen(h, 'u-mgr', 'dc-1', { reopenedBy: 'u-mgr', reason: 'no approver' })).body as ReopenBody).toMatchObject({ flags: ['given_without_approval'] });
    // The owner cannot approve their own reopen even though they hold the authority.
    expect((await syncReopen(h, 'u-owner', 'dc-2', { reopenedBy: 'u-owner', approvedBy: 'u-owner', reason: 'self' })).body as ReopenBody).toMatchObject({ flags: ['approved_by_the_reopener'] });

    expect(((await list(h, 'u-owner')).body as ListBody).flaggedReopens).toHaveLength(2);
  });

  it('a reopen whose approver keyed their own PIN at the store computer is clean; a changed approver seal is said (2b-vi-c-4)', async () => {
    const h = await cast();
    await syncClose(h, 'u-mgr', 'dc-1', close());
    await syncClose(h, 'u-mgr', 'dc-2', close({ tradingDay: '2026-08-08' }));
    const raw = (id: string, body: unknown) =>
      h.request({ method: 'POST', path: `/v1/pos/day-close/${id}/reopen/synced`, userId: 'u-mgr', tenantId: A, idempotencyKey: `pin-${id}`, body });
    const both = sealedDayReopen(A, 'dc-1', { reopenedBy: 'u-mgr', approvedBy: 'u-owner', reason: 'late credit note' }, { approverToo: true });
    expect(((await raw('dc-1', both)).body as ReopenBody).flags).toEqual([]);
    // The approver's seal copied onto another day's reopen does not fit it — and neither does the reopener's.
    expect(((await raw('dc-2', { ...both, dayCloseId: 'dc-2' })).body as ReopenBody).flags).toEqual(['decider_seal_does_not_match', 'approver_seal_does_not_match']);
  });

  it('a reopen the store computer did not seal for its reopener, or one changed after the seal, is recorded and said (2b-vi-c-3)', async () => {
    const h = await cast();
    await syncClose(h, 'u-mgr', 'dc-1', close());
    await syncClose(h, 'u-mgr', 'dc-2', close({ tradingDay: '2026-08-08' }));
    const raw = (id: string, body: unknown) =>
      h.request({ method: 'POST', path: `/v1/pos/day-close/${id}/reopen/synced`, userId: 'u-mgr', tenantId: A, idempotencyKey: `raw-${id}`, body });
    const unsealed = await raw('dc-1', { reopenedBy: 'u-mgr', reason: 'no seal' });
    expect(unsealed.status).toBe(202);
    expect((unsealed.body as ReopenBody).flags).toEqual(['decider_not_verified_at_store', 'given_without_approval']);
    const changed = { ...sealedDayReopen(A, 'dc-2', { reopenedBy: 'u-mgr', reason: 'as sealed' }), reason: 'rewritten after the seal' };
    expect(((await raw('dc-2', changed)).body as ReopenBody).flags).toEqual(['decider_seal_does_not_match', 'given_without_approval']);
  });

  it('is idempotent on the day-close id — a re-synced close records once', async () => {
    const h = await cast();
    expect((await syncClose(h, 'u-mgr', 'dc-1', close())).status).toBe(202);
    // A genuinely-separate re-relay (a fresh request key, same day-close id) is recognised as already
    // closed and records nothing again — not the kernel replaying one request, the route folding the fact.
    const again = await syncClose(h, 'u-mgr', 'dc-1', close(), 'sc-dc-1-retry');
    expect(again.status).toBe(200);
    expect((again.body as CloseBody).alreadyClosed).toBe(true);
    // Still exactly one locked day, not two.
    expect(((await list(h, 'u-owner')).body as ListBody).dayCloses).toHaveLength(1);
  });

  it('is gated, and keeps a malformed fact at the store rather than dropping it', async () => {
    const h = await cast();

    // An accountant holds no till.dayclose.sync → cannot relay a day close.
    expect((await syncClose(h, 'u-acct', 'dc-x', close())).status).toBe(403);
    // A cashier holds no till.dayclose.read → cannot read the locked-day list.
    await syncClose(h, 'u-mgr', 'dc-1', close());
    expect((await list(h, 'u-cash')).status).toBe(403);
    // A malformed close is a 400 with a named reason — kept at the store, not dropped.
    expect(codeOf(await syncClose(h, 'u-mgr', 'dc-bad', { storeId: 'store-1' }))).toBe('not_readable_as_a_day_close');
    // Reopening a day that was never closed here has no fact to place → 404.
    expect((await syncReopen(h, 'u-mgr', 'dc-never', { reopenedBy: 'u-mgr', approvedBy: 'u-owner', reason: 'x' })).status).toBe(404);
    // A reopen with no reason is malformed (a reopen is audited and needs one).
    expect(codeOf(await syncReopen(h, 'u-mgr', 'dc-1', { reopenedBy: 'u-mgr', approvedBy: 'u-owner' }))).toBe('not_readable_as_a_day_reopen');
  });
});
