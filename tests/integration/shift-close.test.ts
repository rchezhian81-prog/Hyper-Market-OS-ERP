import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Shift close, end to end through the real API (M14-FR-02, API-05). The cashier counts the drawer
// WITHOUT seeing the expected figure (a blind count protects integrity); the cloud computes expected
// = float + cash sales − pickups − cash refunds, the variance against the count, and requires a reason
// for a MATERIAL over/short — raising a reconciliation exception the cash office can see. Proves the
// wired shift-close surface against the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// expected = 50000 + 100000 − 30000 − 5000 = 115000; tolerance 500.
const base = (over: Record<string, unknown> = {}) => ({
  tillId: 'T1', cashierId: 'cashier-1', tradingDay: '2026-08-07',
  openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000,
  countedCashMinor: 115_000, toleranceMinor: 500, ...over,
});

const close = (h: ApiHarness, tenantId: string, userId: string, shiftId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/shifts/${shiftId}/close`, userId, tenantId, idempotencyKey: key ?? `sc-${shiftId}`, body });

const overShort = (h: ApiHarness, tenantId: string, userId: string) =>
  h.request({ method: 'GET', path: '/v1/shifts/over-short', userId, tenantId });

const review = (h: ApiHarness, tenantId: string, userId: string, shiftId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/shifts/${shiftId}/over-short/review`, userId, tenantId, idempotencyKey: key ?? `rv-${shiftId}`, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Closed { varianceMinor: number; exceptionRaised: boolean; expectedMinor: number }
interface OverShort { overShort: { shiftId: string; varianceMinor: number }[]; totalVarianceMinor: number }

describe('a shift closes on a blind count, over/short valued and explained (M14-FR-02, API-05)', () => {
  it('closes a balanced drawer clean', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await close(h, A, 'u-owner', 'S1', base());
    expect(res.status).toBe(201);
    expect(res.body as Closed).toMatchObject({ expectedMinor: 115_000, varianceMinor: 0, exceptionRaised: false });
  });

  it('closes clean within tolerance without a reason', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // +300 over, tolerance 500 → within tolerance, no reason needed, no exception.
    const res = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 115_300 }));
    expect(res.status).toBe(201);
    expect(res.body as Closed).toMatchObject({ varianceMinor: 300, exceptionRaised: false });
  });

  it('refuses a material over/short with no reason, and records it once a reason is given', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // −1000 short, tolerance 500 → material.
    const noReason = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000 }));
    expect(noReason.status).toBe(422);
    expect(codeOf(noReason)).toBe('material_variance_needs_a_reason');

    const withReason = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'gave_wrong_change_on_a_note' }), 'sc-S1-b');
    expect(withReason.status).toBe(201);
    expect((withReason.body as Closed).exceptionRaised).toBe(true);

    // The cash office sees the over/short on its reconciliation list.
    const list = (await overShort(h, A, 'u-owner')).body as OverShort;
    expect(list.overShort.map((r) => r.shiftId)).toContain('S1');
    expect(list.totalVarianceMinor).toBe(-1_000);
  });

  it('captures the blind count BY DENOMINATION when the breakdown sums to the count, and surfaces it to the cash office', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // A material −1000 short (expected 115000, counted 114000), broken down note-by-note: the drawer
    // is missing exactly two ₹500 notes. 2×500 + 1×100 + 4×10 = 100000 + 10000 + 4000 = 114000.
    const denominations = [
      { denominationMinor: 50_000, count: 2 },
      { denominationMinor: 10_000, count: 1 },
      { denominationMinor: 1_000, count: 4 },
    ];
    const res = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'two_500_notes_missing', denominations }));
    expect(res.status).toBe(201);
    expect((res.body as { denominationsRecorded?: boolean }).denominationsRecorded).toBe(true);

    // The cash office's reconciliation list carries the breakdown, so it sees WHAT was short.
    const list = (await overShort(h, A, 'u-owner')).body as { overShort: { shiftId: string; denominations: unknown }[] };
    const row = list.overShort.find((r) => r.shiftId === 'S1');
    expect(row?.denominations).toEqual(denominations);
  });

  it('refuses a breakdown that does not sum to the counted total (entry error caught at the drawer)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Notes add to 110000 but the cashier declared 115000 counted.
    const res = await close(h, A, 'u-owner', 'S1', base({
      denominations: [{ denominationMinor: 50_000, count: 2 }, { denominationMinor: 10_000, count: 1 }],
    }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('does_not_sum_to_the_count');
    // Nothing was recorded — the drawer is not on the over/short list.
    expect(((await overShort(h, A, 'u-owner')).body as OverShort).overShort).toEqual([]);
  });

  it('refuses an unknown denomination and a malformed breakdown', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // ₹300 note does not exist.
    const unknown = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 30_000, denominations: [{ denominationMinor: 30_000, count: 1 }] }));
    expect(unknown.status).toBe(422);
    expect(codeOf(unknown)).toBe('unknown_denomination');

    // Not a list of {denominationMinor, count} pairs.
    const malformed = await close(h, A, 'u-owner', 'S2', base({ denominations: [{ denominationMinor: 50_000 }] }));
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed)).toBe('denominations_not_readable');
  });

  it('still closes on the total alone when no breakdown is sent (offline lane compatibility)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await close(h, A, 'u-owner', 'S1', base());
    expect(res.status).toBe(201);
    expect((res.body as { denominationsRecorded?: boolean }).denominationsRecorded).toBe(false);
  });

  it('is idempotent per shift — a re-sent close does not record it twice on a different figure', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await close(h, A, 'u-owner', 'S1', base(), 'k1')).status).toBe(201);
    const again = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 999 }), 'k2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyClosed?: boolean }).alreadyClosed).toBe(true);
    expect((again.body as { varianceMinor: number }).varianceMinor).toBe(0); // the first, balanced close stands
  });

  it('is authorized and per-tenant, and refuses a malformed close', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant does not close shifts
    await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }));

    expect((await close(h, A, 'u-acct', 'S2', base())).status).toBe(403);
    expect((await overShort(h, A, 'u-acct')).status).toBe(403);
    expect((await close(h, A, 'u-owner', 'S3', { tillId: 'T1', cashierId: 'c1', tradingDay: '2026-08-07' })).status).toBe(400); // no figures

    // Tenant B has no over/short of its own.
    await h.seedOwner(B, 'u-owner-b');
    expect(((await overShort(h, B, 'u-owner-b')).body as OverShort).overShort).toEqual([]);
  });
});

// The cash-office sign-off on a material over/short (M14 / P-03 control by exception). A shortage that
// is only listed is a shortage nobody worked; this closes it — by a second, accountable person who is
// NOT the cashier who counted the drawer, with a stated finding, recorded append-only.
interface ReviewRow { shiftId: string; reviewed: boolean; reviewedBy: string | null; disposition: string | null }
interface OverShortList { overShort: ReviewRow[]; openCount: number }
const codeOfReview = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('a material over/short is signed off by the cash office (M14 / P-03, API-05)', () => {
  it('lets a second person sign off a cashier’s short, and the list then shows it reviewed with none open', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // cashier-1 counted the drawer; it came up ₹1,000 short (material).
    await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short_at_count' }));
    let list = (await overShort(h, A, 'u-owner')).body as OverShortList;
    expect(list.openCount).toBe(1);
    expect(list.overShort[0]!.reviewed).toBe(false);

    const signed = await review(h, A, 'u-owner', 'S1', { disposition: 'gave_wrong_change_on_a_note', note: 'CCTV confirms overpayment' });
    expect(signed.status).toBe(201);

    list = (await overShort(h, A, 'u-owner')).body as OverShortList;
    expect(list.openCount).toBe(0);
    const row = list.overShort.find((r) => r.shiftId === 'S1')!;
    expect(row.reviewed).toBe(true);
    expect(row.reviewedBy).toBe('u-owner');
    expect(row.disposition).toBe('gave_wrong_change_on_a_note');
  });

  it('refuses the cashier signing off their OWN drawer (separation of duties)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-sm', 'store_manager'); // a store manager who also ran a till
    // u-sm is the cashier on this shift.
    await close(h, A, 'u-owner', 'S1', base({ cashierId: 'u-sm', countedCashMinor: 114_000, reasonCode: 'short' }));

    const ownReview = await review(h, A, 'u-sm', 'S1', { disposition: 'i_recount_it' });
    expect(ownReview.status).toBe(422);
    expect(codeOfReview(ownReview)).toBe('cannot_review_your_own_drawer');

    // A different accountable person (the owner) may sign it off.
    expect((await review(h, A, 'u-owner', 'S1', { disposition: 'reviewed_ok' })).status).toBe(201);
  });

  it('refuses a sign-off on a drawer that balanced within tolerance, and 404s an unknown shift', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await close(h, A, 'u-owner', 'S1', base()); // variance 0, no exception
    const clean = await review(h, A, 'u-owner', 'S1', { disposition: 'nothing_wrong' });
    expect(clean.status).toBe(422);
    expect(codeOfReview(clean)).toBe('nothing_to_review');

    const missing = await review(h, A, 'u-owner', 'S-none', { disposition: 'x' });
    expect(missing.status).toBe(404);
  });

  it('a cashier cannot reach the sign-off at all (least privilege), and it is idempotent once signed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }));

    expect((await review(h, A, 'u-cash', 'S1', { disposition: 'let_me_clear_it' })).status).toBe(403);

    expect((await review(h, A, 'u-owner', 'S1', { disposition: 'signed' }, 'rv-1')).status).toBe(201);
    const again = await review(h, A, 'u-owner', 'S1', { disposition: 'signed_again' }, 'rv-2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyReviewed?: boolean }).alreadyReviewed).toBe(true);
    expect((again.body as { disposition: string }).disposition).toBe('signed'); // the first sign-off stands
  });
});

// A material SHORT auto-opens a loss-prevention investigation assigned to the store manager (M15-FR-04,
// P-03). The close never fails — the shop keeps trading — and the outcome is reported alongside; the
// case is an ordinary LP case, readable through the existing loss-prevention surface.
interface CloseWithInvestigation {
  investigation?: { opened: boolean; caseId?: string; assignedTo?: string; blockedReason?: string };
}
const readCase = (h: ApiHarness, tenantId: string, userId: string, caseId: string) =>
  h.request({ method: 'GET', path: `/v1/loss-prevention/cases/${caseId}`, userId, tenantId });

describe('a material short auto-opens an investigation, assigned to the store manager (M15-FR-04)', () => {
  it('opens a case on the cashier, assigned to the store manager, and it is a real readable LP case', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-sm', 'store_manager');
    // cashier-1 counted the drawer; ₹1,000 short (material).
    const res = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }));
    expect(res.status).toBe(201);
    const inv = (res.body as CloseWithInvestigation).investigation!;
    expect(inv.opened).toBe(true);
    expect(inv.assignedTo).toBe('u-sm');
    expect(inv.caseId).toBe('shortage-S1');

    // The case exists in the ordinary loss-prevention surface, on the cashier, assigned to the manager.
    const c = await readCase(h, A, 'u-owner', 'shortage-S1');
    expect(c.status).toBe(200);
    expect((c.body as { subjectRef: string; assignedTo: string; state: string }).subjectRef).toBe('cashier-1');
    expect((c.body as { assignedTo: string }).assignedTo).toBe('u-sm');
    expect((c.body as { state: string }).state).toBe('open');
  });

  it('opens no investigation for an over, or for a within-tolerance close', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-sm', 'store_manager');
    // +1000 over, material → exception raised, but an over is not a loss.
    const over = await close(h, A, 'u-owner', 'S-over', base({ countedCashMinor: 116_000, reasonCode: 'over' }));
    expect((over.body as CloseWithInvestigation).investigation).toBeUndefined();
    // within tolerance → no exception, no investigation.
    const clean = await close(h, A, 'u-owner', 'S-clean', base());
    expect((clean.body as CloseWithInvestigation).investigation).toBeUndefined();
  });

  it('still closes the drawer when there is no store manager, and reports the gap (P-01 keeps trading, P-08 no silent gap)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner'); // no store manager granted
    const res = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }));
    expect(res.status).toBe(201); // the close succeeds regardless
    const inv = (res.body as CloseWithInvestigation).investigation!;
    expect(inv.opened).toBe(false);
    expect(inv.blockedReason).toBe('no_eligible_investigator');
    // No case was opened.
    expect((await readCase(h, A, 'u-owner', 'shortage-S1')).status).toBe(404);
  });

  it('is idempotent — re-closing the same shift does not open a second investigation', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-sm', 'store_manager');
    expect((await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }), 'k1')).status).toBe(201);
    // Re-sent close is a no-op (alreadyClosed) and does not re-run the auto-open.
    const again = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }), 'k2');
    expect((again.body as { alreadyClosed?: boolean }).alreadyClosed).toBe(true);
    // Exactly one case exists.
    expect((await readCase(h, A, 'u-owner', 'shortage-S1')).status).toBe(200);
  });
});
