import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M06-FR-03 (D03-FR-03 · M23): supplier rebates on the live API — the money the shop has already EARNED
// and not yet collected. A scheme is recorded; an accrual for a measured period runs the tested
// accrueRebate — nothing accrues below the threshold (and it says how far short), a growth scheme
// measures against its baseline (never the raw total), and the OUTSTANDING (accrued − received) is the
// earned-not-claimed headline. Recording gated purchase.contract.manage; reads purchase.commitment.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const money = (minor: number) => ({ minor, currency: INR });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Accrual = { accrued: { minor: number }; received: { minor: number }; outstanding: { minor: number }; thresholdMet: boolean; detail: string };
const accrualOf = (res: { body: unknown }): Accrual => (res.body as { accrual: Accrual }).accrual;

const scheme = (over: Record<string, unknown> = {}) =>
  ({ supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, thresholdMinor: 1_000_000, startsOn: '2026-01-01', endsOn: '2026-12-31', approvedBy: 'u-owner', ...over });

const putScheme = (h: ApiHarness, u: string, id: string, b: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/rebate-schemes/${id}`, userId: u, tenantId: A, idempotencyKey: key, body: b });
const postAccrual = (h: ApiHarness, u: string, schemeId: string, accrualId: string, b: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/rebate-schemes/${schemeId}/accruals/${accrualId}`, userId: u, tenantId: A, idempotencyKey: key, body: b });
const listSchemes = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/purchase/rebate-schemes', userId: u, tenantId: A });
const listAccruals = (h: ApiHarness, u: string, schemeId: string) =>
  h.request({ method: 'GET', path: `/v1/purchase/rebate-schemes/${schemeId}/accruals`, userId: u, tenantId: A });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds contract.manage + commitment.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // holds neither
  return h;
}

describe('supplier rebates (M06-FR-03)', () => {
  it('accrues nothing below the threshold, and says how far short', async () => {
    const h = await cast();
    await putScheme(h, 'u-owner', 'rb-1', scheme(), 'k1');
    const res = await postAccrual(h, 'u-mgr', 'rb-1', 'a1', { basisAmount: money(800_000) }, 'k2');
    expect(res.status).toBe(201);
    expect(accrualOf(res).thresholdMet).toBe(false);
    expect(accrualOf(res).accrued).toEqual(money(0));
    expect(accrualOf(res).detail).toContain('200000 more to earn anything');
  });

  it('accrues above the threshold and shows the money earned and NOT yet claimed', async () => {
    const h = await cast();
    await putScheme(h, 'u-owner', 'rb-1', scheme(), 'k1');
    const res = await postAccrual(h, 'u-mgr', 'rb-1', 'a1', { basisAmount: money(2_000_000) }, 'k2');
    expect(accrualOf(res).accrued).toEqual(money(60_000)); // 3% of ₹20,000
    expect(accrualOf(res).outstanding).toEqual(money(60_000));
    expect(accrualOf(res).detail).toContain('NOT YET CLAIMED');
    // The scheme's outstanding headline totals it.
    const list = await listAccruals(h, 'u-owner', 'rb-1');
    expect((list.body as { outstandingMinor: number }).outstandingMinor).toBe(60_000);
  });

  it('reconciles against what finance actually received (a re-measure supersedes)', async () => {
    const h = await cast();
    await putScheme(h, 'u-owner', 'rb-1', scheme(), 'k1');
    await postAccrual(h, 'u-mgr', 'rb-1', 'a1', { basisAmount: money(2_000_000) }, 'k2'); // outstanding 60000
    // Finance later pays it — same accrual id, now with received.
    const paid = await postAccrual(h, 'u-mgr', 'rb-1', 'a1', { basisAmount: money(2_000_000), received: money(60_000) }, 'k3');
    expect(accrualOf(paid).outstanding).toEqual(money(0));
    expect(accrualOf(paid).detail).toBe('fully claimed and received');
    // The accrual superseded rather than doubling — one accrual, zero outstanding.
    const list = await listAccruals(h, 'u-owner', 'rb-1');
    expect((list.body as { count: number; outstandingMinor: number }).count).toBe(1);
    expect((list.body as { outstandingMinor: number }).outstandingMinor).toBe(0);
  });

  it('measures a growth scheme against its baseline, never the raw total', async () => {
    const h = await cast();
    await putScheme(h, 'u-owner', 'grow', scheme({ basis: 'growth_over_baseline', thresholdMinor: 0 }), 'k1');
    const res = await postAccrual(h, 'u-mgr', 'grow', 'a1', { basisAmount: money(2_000_000), baselineAmount: money(1_500_000) }, 'k2');
    expect(accrualOf(res).accrued).toEqual(money(15_000)); // 3% of the ₹5,000 of growth
  });

  it('gates recording and reading, and refuses a malformed scheme / an accrual on an unknown scheme', async () => {
    const h = await cast();
    // A cashier can neither record a scheme nor read the register.
    expect((await putScheme(h, 'u-cash', 'rb-x', scheme(), 'k1')).status).toBe(403);
    expect((await listSchemes(h, 'u-cash')).status).toBe(403);
    // A bad basis is refused.
    expect(codeOf(await putScheme(h, 'u-owner', 'rb-y', scheme({ basis: 'made_up' }), 'k2'))).toBe('not_readable_as_a_rebate_scheme');
    // An accrual against a scheme that was never recorded is a 404.
    expect((await postAccrual(h, 'u-mgr', 'nope', 'a1', { basisAmount: money(2_000_000) }, 'k3')).status).toBe(404);
  });

  it('survives a restart: the scheme and its accruals rebuild from the event store', async () => {
    const h = await cast();
    await putScheme(h, 'u-owner', 'rb-1', scheme(), 'k1');
    await postAccrual(h, 'u-mgr', 'rb-1', 'a1', { basisAmount: money(2_000_000) }, 'k2');
    const restarted = apiHarness({ store: h.store });
    expect((await listSchemes(restarted, 'u-owner')).body as { count: number }).toMatchObject({ count: 1 });
    expect((await listAccruals(restarted, 'u-owner', 'rb-1')).body as { outstandingMinor: number }).toMatchObject({ outstandingMinor: 60_000 });
  });
});
