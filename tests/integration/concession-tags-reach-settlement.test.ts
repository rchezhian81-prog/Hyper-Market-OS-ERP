// M27-FR-03 through the real authenticated API: the till's docket tags land on the cloud once, a cashier's
// correction is refused and recorded while a manager's reversal stands, and the tagged lines reach the
// period charge and the settlement statement without anyone re-keying them.
import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa27';
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash'; const ACCT = 'u-acct';
const CT = '/v1/concession/contracts/ct-gold';
const WINDOW = 'from=2026-08-01&to=2026-08-31';

const post = (h: ApiHarness, path: string, u: string, key: string, body?: unknown) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, ...(body === undefined ? {} : { body }) });
const get = (h: ApiHarness, pathAndQuery: string, u: string) => {
  const [path = '', qs = ''] = pathAndQuery.split('?');
  const query = Object.fromEntries(qs === '' ? [] : qs.split('&').map((kv) => kv.split('=') as [string, string]));
  return h.request({ method: 'GET', path, userId: u, tenantId: A, query });
};
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const line = (over: Record<string, unknown> = {}) => ({
  saleId: 'sale-1', lineId: 'l1', productId: 'RING-22K', counterId: 'gold-1', tillId: 'till-3', shiftId: 'shift-a',
  qty: 1, grossMinor: 100_000, discountMinor: 20_000, taxMinor: 2_400, source: 'docket-7781', at: '2026-08-07T09:00:00.000Z', ...over,
});
// A correction is dated when it is made (the API's clock, which is the real one here), so a check that must see
// corrections reads a window open to the far future rather than August alone.
const OPEN_WINDOW = 'from=2026-08-01&to=2099-12-31';

async function cast(entitled = true): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, OWNER);
  await h.provisionRole(A, MGR, 'store_manager');
  await h.provisionRole(A, CASH, 'cashier');
  await h.provisionRole(A, ACCT, 'accountant');
  if (entitled) await h.enableFeature(A, 'dept.concession');
  return h;
}
const contract = (h: ApiHarness, over: Record<string, unknown> = {}, key = 'ct-gold') => post(h, CT, OWNER, key, {
  concessionaireId: 'cx-gold', name: 'Gold counter', branchId: 'br-1', startsOn: '2026-01-01', endsOn: '2026-12-31',
  basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 0, insuranceUntil: '2027-12-31', licenceUntil: '2027-12-31', approvedBy: 'u-owner', ...over,
});

interface Tag { tagId: string; kind: string; netMinor: number; commissionMinor: number; history: { op: string; byRole: string }[]; settlementStatus: string }
interface Stream { tags: Tag[]; totals: { tags: number; netMinor: number; commissionMinor: number } }

describe('concession docket tags reach settlement (M27-FR-03, API-09)', () => {
  it('a cashier records the counter\'s lines once; the charge and the settlement read them as the counter\'s sales', async () => {
    const h = await cast();
    expect((await contract(h)).status).toBe(201);
    const first = await post(h, `${CT}/tags/tag-1`, CASH, 'till-3:sale-1:l1', line());
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ captured: true, tag: expect.objectContaining({ netMinor: 80_000, commissionMinor: 12_000, capturedBy: CASH }), trading: { mayTrade: true } });
    // The lane resends the same line (its outbox replayed): same key → the original, nothing charged twice.
    const resend = await post(h, `${CT}/tags/tag-1`, CASH, 'till-3:sale-1:l1', line());
    expect(resend.status).toBe(201); // the kernel replays the stored first answer for the same key
    expect((await post(h, `${CT}/tags/tag-1b`, CASH, 'till-3:sale-1:l1-again', line({ idempotencyKey: 'till-3:sale-1:l1' }))).status).toBe(201);
    expect((await post(h, `${CT}/tags/tag-2`, CASH, 'till-3:sale-2:l1', line({ saleId: 'sale-2', grossMinor: 50_000, discountMinor: 0, taxMinor: 1_200 }))).status).toBe(201);

    const stream = (await get(h, `${CT}/tags?${WINDOW}`, ACCT)).body as Stream;
    expect(stream.tags.map((t) => t.tagId)).toEqual(['tag-1', 'tag-1b', 'tag-2']);
    expect(stream.totals).toMatchObject({ tags: 3, netMinor: 210_000, commissionMinor: 31_500 });

    // The period charge and the settlement see the tagged lines — nobody re-keyed them.
    const charge = (await get(h, `${CT}/charge?${WINDOW}`, OWNER)).body as { grossSalesMinor: number; chargeMinor: number };
    expect(charge).toMatchObject({ grossSalesMinor: 210_000, chargeMinor: 31_500 });
    const settle = (await get(h, `${CT}/settlement?${WINDOW}&bankedForThemMinor=210000`, OWNER)).body as { collectedForThemMinor: number; payableToThemMinor: number; reconciles: boolean };
    expect(settle).toMatchObject({ collectedForThemMinor: 210_000, payableToThemMinor: 178_500, reconciles: true });
    // A cold restart over the same ledger reads the same counter.
    const h2 = apiHarness({ store: h.store });
    expect(((await get(h2, `${CT}/tags`, CASH)).body as Stream).totals.tags).toBe(3);
  });

  it('a cashier\'s reversal is refused and written on the line; the store manager\'s reversal backs the money out of the settlement', async () => {
    const h = await cast();
    await contract(h);
    await post(h, `${CT}/tags/tag-1`, CASH, 'k1', line());
    const refused = await post(h, `${CT}/tags/tag-1/reverse`, CASH, 'rev-cash', { reasonCode: 'WRONG-COUNTER' });
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('correction_not_permitted_for_role');
    let stream = (await get(h, `${CT}/tags`, MGR)).body as Stream;
    expect(stream.tags[0]!.history.map((e) => e.op)).toEqual(['captured', 'correct_refused']);
    expect(stream.totals.netMinor).toBe(80_000);

    const reversed = await post(h, `${CT}/tags/tag-1/reverse`, MGR, 'rev-mgr', { reasonCode: 'WRONG-COUNTER' });
    expect(reversed.status).toBe(201);
    expect(reversed.body).toMatchObject({ corrected: true, correction: expect.objectContaining({ tagId: 'tag-1~rev', kind: 'reversal', netMinor: -80_000 }) });
    stream = (await get(h, `${CT}/tags`, MGR)).body as Stream;
    expect(stream.tags.map((t) => [t.tagId, t.kind])).toEqual([['tag-1', 'sale'], ['tag-1~rev', 'reversal']]);
    expect(stream.totals).toMatchObject({ netMinor: 0, commissionMinor: 0 });
    const charge = (await get(h, `${CT}/charge?${OPEN_WINDOW}`, OWNER)).body as { grossSalesMinor: number; chargeMinor: number };
    expect(charge).toMatchObject({ grossSalesMinor: 0, chargeMinor: 0 });
    const august = (await get(h, `${CT}/charge?${WINDOW}`, OWNER)).body as { grossSalesMinor: number };
    expect(august.grossSalesMinor).toBe(80_000); // the sale stays in August; the reversal is dated when it was made
    expect(codeOf(await post(h, `${CT}/tags/tag-1/reverse`, MGR, 'rev-mgr-2', { reasonCode: 'AGAIN', newTagId: 'tag-1~rev2' }))).toBe('already_reversed');
  });

  it('a sale the desk recorded by hand is left to that record — the same receipt is never counted twice; the settlement run marks the window', async () => {
    const h = await cast();
    await contract(h);
    await post(h, `${CT}/tags/tag-1`, CASH, 'k1', line());
    expect((await post(h, `${CT}/sales`, OWNER, 'manual-1', { saleId: 'sale-1', grossMinor: 80_000, taxMinor: 2_400, tenderedTo: 'store_till', at: '2026-08-07T09:00:00Z' })).status).toBe(201);
    await post(h, `${CT}/tags/tag-2`, CASH, 'k2', line({ saleId: 'sale-2', lineId: 'l1', grossMinor: 30_000, discountMinor: 0, taxMinor: 720 }));
    const charge = (await get(h, `${CT}/charge?${WINDOW}`, OWNER)).body as { grossSalesMinor: number };
    expect(charge.grossSalesMinor).toBe(110_000); // 80_000 by hand + 30_000 tagged; not 190_000
    const marked = await post(h, `${CT}/tag-settlement`, ACCT, 'mark-1', { status: 'included_in_charge', from: '2026-08-01', to: '2026-08-31' });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({ marked: 2 });
    const stream = (await get(h, `${CT}/tags`, ACCT)).body as Stream;
    expect(stream.tags.map((t) => t.settlementStatus)).toEqual(['included_in_charge', 'included_in_charge']);
  });

  it('who may, and what is refused: a supplier-less login cannot record; a bad docket is refused; the mapping of GROSS is honoured; entitlement off → nothing', async () => {
    const h = await cast();
    await contract(h, { commissionOn: 'gross' });
    expect((await post(h, `${CT}/tags/tag-1`, 'u-nobody', 'k0', line())).status).toBe(403);
    const bad = await post(h, `${CT}/tags/tag-1`, CASH, 'k1', line({ qty: 0 }));
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_concession_tag');
    const ok = await post(h, `${CT}/tags/tag-1`, CASH, 'k1', line());
    expect(ok.body).toMatchObject({ tag: expect.objectContaining({ commissionBaseMinor: 100_000, commissionMinor: 15_000 }) });
    expect((await post(h, `${CT}/tag-settlement`, CASH, 'mark-x', { status: 'settled', from: '2026-08-01', to: '2026-08-31' })).status).toBe(403);
    expect(codeOf(await contract(h, { commissionOn: 'sideways' }, 'ct-gold-bad'))).toBe('not_readable_as_a_contract');

    const off = await cast(false);
    await post(off, CT, OWNER, 'ct-gold', { concessionaireId: 'cx-gold', name: 'Gold', branchId: 'br-1', startsOn: '2026-01-01', endsOn: '2026-12-31', basis: 'fixed_rent', fixedRentMinor: 1, depositMinor: 0 });
    const gated = await post(off, `${CT}/tags/tag-1`, CASH, 'k1', line());
    expect(gated.status).toBe(403);
    expect(codeOf(gated)).toBe('feature_not_entitled');
  });
});
