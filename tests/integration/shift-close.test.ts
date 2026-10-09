import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { assessShiftClose } from '../../packages/till/src/index';

// Shift close, end to end through the real API (M14-FR-02, API-05). The cashier counts the drawer
// WITHOUT seeing the expected figure (a blind count protects integrity). Since PF-08 (owner decision OB-27 "A",
// 9 Oct 2026) a shift closes ONLY at the till, through the store box, which works out expected = float + cash
// sales − pickups − cash refunds from its own logs and refuses a material over/short with no reason (proved in
// `tests/unit/edge-till-cash.test.ts`). Head office RECORDS the close the box relays, re-runs the same rule over
// it — a disagreement or a missing reason is a visible flag, never a silent correction — and raises the
// reconciliation exception the cash office works. The retired direct route, which took every figure from the
// caller, is gone. Proves the recording surface against the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// expected = 50000 + 100000 − 30000 − 5000 = 115000; tolerance 500.
const base = (over: Record<string, unknown> = {}) => ({
  tillId: 'T1', cashierId: 'cashier-1', tradingDay: '2026-08-07',
  openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000,
  countedCashMinor: 115_000, toleranceMinor: 500, ...over,
});

/** The close as the store box relays it: the box's own figures, decided with the same rule (so they follow). */
const relayed = (b: Record<string, unknown>): Record<string, unknown> => {
  const n = (k: string): number => b[k] as number;
  const decided = assessShiftClose({
    openingFloatMinor: n('openingFloatMinor'), cashSalesMinor: n('cashSalesMinor'), pickupsMinor: n('pickupsMinor'), cashRefundsMinor: n('cashRefundsMinor'),
    countedCashMinor: n('countedCashMinor'), toleranceMinor: n('toleranceMinor'), ...(typeof b['reasonCode'] === 'string' ? { reasonCode: b['reasonCode'] } : {}),
  });
  const { countedCashMinor, ...rest } = b;
  return {
    ...rest, laneId: b['tillId'], openedAt: '2026-08-07T03:00:00Z', closedAt: '2026-08-07T20:00:00Z',
    countedMinor: countedCashMinor, expectedMinor: decided.expectedMinor, varianceMinor: decided.varianceMinor, exceptionRaised: decided.exceptionRaised,
  };
};

const close = (h: ApiHarness, tenantId: string, userId: string, shiftId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/shifts/${shiftId}/close/synced`, userId, tenantId, idempotencyKey: key ?? `sc-${shiftId}`, body: Number.isInteger(body['countedCashMinor']) ? relayed(body) : body });

const overShort = (h: ApiHarness, tenantId: string, userId: string) =>
  h.request({ method: 'GET', path: '/v1/shifts/over-short', userId, tenantId });

const review = (h: ApiHarness, tenantId: string, userId: string, shiftId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/shifts/${shiftId}/over-short/review`, userId, tenantId, idempotencyKey: key ?? `rv-${shiftId}`, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Closed { varianceMinor: number; exceptionRaised: boolean; expectedMinor: number; flags: string[] }
interface OverShort { overShort: { shiftId: string; varianceMinor: number }[]; totalVarianceMinor: number }

describe('a shift closes on a blind count, over/short valued and explained (M14-FR-02, API-05)', () => {
  it('closes a balanced drawer clean', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await close(h, A, 'u-owner', 'S1', base());
    expect(res.status).toBe(202);
    expect(res.body as Closed).toMatchObject({ expectedMinor: 115_000, varianceMinor: 0, exceptionRaised: false });
  });

  it('closes clean within tolerance without a reason', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // +300 over, tolerance 500 → within tolerance, no reason needed, no exception.
    const res = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 115_300 }));
    expect(res.status).toBe(202);
    expect(res.body as Closed).toMatchObject({ varianceMinor: 300, exceptionRaised: false });
  });

  it('a material over/short arriving with no reason is recorded and FLAGGED (the box should have refused it); with a reason it is clean', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // −1000 short, tolerance 500 → material.
    const noReason = await close(h, A, 'u-owner', 'S0', base({ countedCashMinor: 114_000 }));
    expect(noReason.status).toBe(202);
    expect((noReason.body as Closed).flags).toContain('material_variance_without_reason');

    const withReason = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'gave_wrong_change_on_a_note' }));
    expect(withReason.status).toBe(202);
    expect((withReason.body as Closed).exceptionRaised).toBe(true);
    expect((withReason.body as Closed).flags).not.toContain('material_variance_without_reason');

    // The cash office sees the over/short on its reconciliation list.
    const list = (await overShort(h, A, 'u-owner')).body as OverShort;
    expect(list.overShort.map((r) => r.shiftId)).toContain('S1');
    expect(list.totalVarianceMinor).toBe(-2_000);
  });

  it('PF-08: head office has no direct close — a caller cannot type in a balanced drawer', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const direct = await h.request({ method: 'POST', path: '/v1/shifts/S1/close', userId: 'u-owner', tenantId: A, idempotencyKey: 'direct', body: base() });
    expect(direct.status).toBe(404);
    // And a relayed close whose figures do not follow (a "zero variance" typed over a short drawer) is flagged, and the
    // cloud's own arithmetic stands on the record.
    const invented = await close(h, A, 'u-owner', 'S2', { ...relayed(base({ countedCashMinor: 100_000, reasonCode: 'x' })), expectedMinor: 100_000, varianceMinor: 0, exceptionRaised: false });
    expect(invented.status).toBe(202);
    expect(invented.body as Closed).toMatchObject({ varianceMinor: -15_000, exceptionRaised: true });
    expect((invented.body as Closed).flags).toContain('figures_inconsistent');
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
    expect(res.status).toBe(202);

    // The cash office's reconciliation list carries the breakdown, so it sees WHAT was short.
    const list = (await overShort(h, A, 'u-owner')).body as { overShort: { shiftId: string; denominations: unknown }[] };
    const row = list.overShort.find((r) => r.shiftId === 'S1');
    expect(row?.denominations).toEqual(denominations);
  });

  it('a breakdown that does not sum, or names a note that does not exist, is flagged (the box refuses it at the drawer)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Notes add to 110000 but the box relayed 115000 counted.
    const res = await close(h, A, 'u-owner', 'S1', base({
      denominations: [{ denominationMinor: 50_000, count: 2 }, { denominationMinor: 10_000, count: 1 }],
    }));
    expect(res.status).toBe(202);
    expect((res.body as Closed).flags).toContain('denominations_do_not_sum');
    // ₹300 note does not exist.
    const unknown = await close(h, A, 'u-owner', 'S2', base({ countedCashMinor: 30_000, reasonCode: 'x', denominations: [{ denominationMinor: 30_000, count: 1 }] }));
    expect((unknown.body as Closed).flags).toContain('denominations_do_not_sum');
  });

  it('still closes on the total alone when no breakdown is sent (offline lane compatibility)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await close(h, A, 'u-owner', 'S1', base());
    expect(res.status).toBe(202);
    expect((res.body as Closed).flags).not.toContain('denominations_do_not_sum');
  });

  it('is idempotent per shift — a re-sent close does not record it twice on a different figure', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await close(h, A, 'u-owner', 'S1', base(), 'k1')).status).toBe(202);
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
    const malformed = await close(h, A, 'u-owner', 'S3', { tillId: 'T1', cashierId: 'c1', tradingDay: '2026-08-07' }); // no figures
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed)).toBe('not_readable_as_a_synced_shift_close');

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
    expect(res.status).toBe(202);
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
    expect(res.status).toBe(202); // the close succeeds regardless
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
    expect((await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }), 'k1')).status).toBe(202);
    // Re-sent close is a no-op (alreadyClosed) and does not re-run the auto-open.
    const again = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }), 'k2');
    expect((again.body as { alreadyClosed?: boolean }).alreadyClosed).toBe(true);
    // Exactly one case exists.
    expect((await readCase(h, A, 'u-owner', 'shortage-S1')).status).toBe(200);
  });
});
