// M23-FR-01 — the day-book routes over stub deps: the mapping is the accountant's to define; the day posts
// as journals through the period gate; re-runs are safe; exceptions are recorded, visible, and resolved
// only when a later posting actually covers what they held back.
import { describe, it, expect } from 'vitest';
import {
  dayBookRoutes, exceptionIdFor, fingerprint, coveredByKind, exceptionState,
  type DayBookDeps, type DayBookJournal, type DayBookExceptionRecord, type StoredPostingMap,
} from '../../services/finance/src/day-book';
import type { PeriodState } from '../../services/finance/src/index';
import { DEFAULT_RETAIL_POSTING_MAP, type DayBookSale, type DayBookReturn, type PostingMap } from '../../packages/finance/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';

const T = 't-sre';
const NOW = '2026-09-29T03:00:00.000Z';
const DAY = '2026-09-28';
const MAP_V1: StoredPostingMap = { ...DEFAULT_RETAIL_POSTING_MAP, version: 1, definedBy: 'u-acct', definedAt: '2026-09-01T00:00:00.000Z' };

const sale = (over: Partial<DayBookSale> = {}): DayBookSale => ({
  saleId: 's1', tradingDay: DAY, totalMinor: 10_500,
  lines: [{ productId: 'RICE', quantityMinor: 1, lineTotalMinor: 10_500 }], tenders: [{ kind: 'cash', amountMinor: 10_500 }], ...over,
});
const S1 = sale();
const S2 = sale({ saleId: 's2', totalMinor: 11_800, lines: [{ productId: 'SOAP', quantityMinor: 1, lineTotalMinor: 11_800 }], tenders: [{ kind: 'upi', amountMinor: 11_800 }] });
const S3 = sale({ saleId: 's3', totalMinor: 5_000, lines: [{ productId: 'MILK', quantityMinor: 2, lineTotalMinor: 5_000 }], tenders: [{ kind: 'card', amountMinor: 5_000 }] });
const R1: DayBookReturn = { returnId: 'r1', originalSaleId: 's1', refundMinor: 10_500, refundTender: 'cash', lines: [{ productId: 'RICE', quantityMinor: 1 }] };

function stub(over: { sales?: DayBookSale[]; returns?: DayBookReturn[]; rates?: Map<string, number>; map?: StoredPostingMap; closed?: readonly string[] } = {}) {
  const sales = over.sales ?? [];
  const journals: DayBookJournal[] = [];
  const exceptions: DayBookExceptionRecord[] = [];
  const maps: StoredPostingMap[] = over.map === undefined ? [] : [over.map];
  const rates = over.rates ?? new Map([['RICE', 500], ['SOAP', 1800], ['MILK', 0]]);
  const deps: DayBookDeps = {
    now: () => NOW,
    periodStates: () => new Map((over.closed ?? []).map((p) => [p, 'closed' as PeriodState])),
    nextOpenPeriod: () => '2026-10',
    appendJournal: (_t, e) => { journals.push(e as DayBookJournal); },
    postingMap: () => maps[maps.length - 1],
    definePostingMap: (_t, m) => { maps.push(m); },
    salesOn: (_t, day) => sales.filter((s) => s.tradingDay === day),
    returnsOn: () => over.returns ?? [],
    originalSales: (_t, ids) => new Map(sales.filter((s) => ids.includes(s.saleId)).map((s) => [s.saleId, s] as const)),
    taxRates: () => rates,
    dayBookJournals: (_t, day) => journals.filter((j) => j.dayBook.tradingDay === day),
    recordException: (_t, e) => { exceptions.push(e); },
    exceptionsOn: (_t, day) => exceptions.filter((e) => e.tradingDay === day),
  };
  return { deps, sales, journals, exceptions, maps, rates, routes: dayBookRoutes(deps) };
}

const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({ tenantId: T, userId: 'u-acct', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
const POST = '/v1/finance/day-book/:tradingDay/post';
const GET = '/v1/finance/day-book/:tradingDay';
const MAP = '/v1/finance/posting-map';
const run = (routes: readonly Route[], method: string, path: string, over: Partial<RequestContext> = {}) =>
  routeFor(routes, method, path).handler(ctx(over));
const post = (routes: readonly Route[], day = DAY) => run(routes, 'POST', POST, { params: { tradingDay: day } });
const read = (routes: readonly Route[], day = DAY) => run(routes, 'GET', GET, { params: { tradingDay: day } });

interface Thrown { status: number; body: { code: string; whatHappened: string; nextSafeAction: string } }
const thrown = async (fn: () => unknown): Promise<Thrown> => {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
};
interface Journal { entryId: string; kind: string; period: string; documentDate: string; belongsTo?: string; sources: number; lines: { accountCode: string; debitMinor: number; creditMinor: number }[]; postedBy: string; narrative: string }
interface PostBody { postedTo: string; postedLate?: { belongsTo: string }; journals: Journal[]; exceptions: DayBookExceptionRecord[]; skipped: number; zeroValue: string[]; counted: { sales: number; returns: number } }
interface ReadBody { journals: Journal[]; accounts: { accountCode: string; debitMinor: number; creditMinor: number; balanceMinor: number }[]; covered: number; exceptions: (DayBookExceptionRecord & { state: 'open' | 'resolved' })[]; open: number }

describe('the day-book routes — shape and permissions (API-09)', () => {
  it('four routes: read/define the mapping, post a day, read a day — finance permissions, writes idempotent', () => {
    const { routes } = stub();
    expect(routes.map((r) => [r.method, r.path, r.permission, r.idempotent === true, r.api])).toEqual([
      ['GET', MAP, 'finance.period.read', false, 'API-09'],
      ['PUT', MAP, 'finance.posting.configure', true, 'API-09'],
      ['POST', POST, 'finance.journal.post', true, 'API-09'],
      ['GET', GET, 'finance.period.read', false, 'API-09'],
    ]);
  });

  it('a trading day that is not a date is refused on both the post and the read', async () => {
    const { routes } = stub({ map: MAP_V1 });
    for (const bad of ['28-09-2026', '2026-09', 'today', '']) {
      expect((await thrown(() => post(routes, bad))).body.code).toBe('bad_trading_day');
      expect((await thrown(() => read(routes, bad))).body.code).toBe('bad_trading_day');
    }
  });
});

describe('the mapping is the accountant\'s to define (AVR-09, P-05)', () => {
  it('with nothing defined the read offers the suggested map and posting is refused — nothing guessed, nothing posted', async () => {
    const s = stub({ sales: [S1] });
    const got = await run(s.routes, 'GET', MAP);
    expect(got.body).toMatchObject({ map: null, suggested: DEFAULT_RETAIL_POSTING_MAP });
    const refused = await thrown(() => post(s.routes));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('posting_map_not_defined');
    expect(refused.body.nextSafeAction).toMatch(/PUT \/v1\/finance\/posting-map/);
    expect(s.journals).toEqual([]);
    expect(s.exceptions).toEqual([]);
  });

  it('a malformed mapping is refused with every problem named and the mapping in force unchanged', async () => {
    const s = stub({ map: MAP_V1 });
    const bad = await thrown(() => run(s.routes, 'PUT', MAP, { body: { rules: [{ kind: 'sale', legs: [{ account: 'a', side: 'debit', component: 'total' }] }] } }));
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('posting_map_invalid');
    expect(bad.body.whatHappened).toMatch(/at least two legs/);
    expect(s.maps).toEqual([MAP_V1]);
  });

  it('a valid mapping is stored as the next version by the person who defined it; the latest is in force', async () => {
    const s = stub({ map: MAP_V1 });
    const trimmed: PostingMap = { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => r.kind !== 'tender:upi') };
    const res = await run(s.routes, 'PUT', MAP, { userId: 'u-owner', body: trimmed });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, rules: trimmed.rules.length });
    expect(s.maps[1]).toMatchObject({ version: 2, definedBy: 'u-owner', definedAt: NOW, rules: trimmed.rules });
    expect(((await run(s.routes, 'GET', MAP)).body as { map: StoredPostingMap }).map.version).toBe(2);
  });
});

describe('posting the day', () => {
  it('posts one balanced voucher per kind into the day\'s own period, by the caller, listing the receipts each covers', async () => {
    const s = stub({ sales: [S1, S2], returns: [R1], map: MAP_V1 });
    const res = await post(s.routes);
    expect(res.status).toBe(201);
    const body = res.body as PostBody;
    expect(body.postedTo).toBe('2026-09');
    expect(body.postedLate).toBeUndefined();
    expect(body.journals.map((j) => j.entryId)).toEqual([
      `daybook:${DAY}:refund:cash:1`, `daybook:${DAY}:sale:1`, `daybook:${DAY}:sale_return:1`, `daybook:${DAY}:tender:cash:1`, `daybook:${DAY}:tender:upi:1`,
    ]);
    const saleVoucher = body.journals[1]!;
    expect(saleVoucher).toMatchObject({ kind: 'sale', period: '2026-09', documentDate: DAY, sources: 2, postedBy: 'u-acct' });
    expect(saleVoucher.lines).toEqual([
      { accountCode: 'sales_clearing', debitMinor: 22_300, creditMinor: 0 },
      { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: 20_000 },
      { accountCode: 'gst_output_cgst', debitMinor: 0, creditMinor: 1_150 },
      { accountCode: 'gst_output_sgst', debitMinor: 0, creditMinor: 1_150 },
    ]);
    expect(saleVoucher.narrative).toBe(`Day book ${DAY} — sale: 2 sale(s)`);
    expect(s.journals[1]!.dayBook).toEqual({
      tradingDay: DAY, kind: 'sale', sourceKind: 'sale', sourceIds: ['s1', 's2'],
      components: { total: 22_300, net: 20_000, tax: 2_300, cgst: 1_150, sgst: 1_150 },
    });
    expect(body.exceptions).toEqual([]);
    expect(body.counted).toEqual({ sales: 2, returns: 1 });
    // The day's accounts: tenders cover sales, so the clearing nets to zero.
    const day = (await read(s.routes)).body as ReadBody;
    expect(day.journals).toHaveLength(5);
    expect(day.covered).toBe(3);
    expect(day.accounts.find((a) => a.accountCode === 'sales_clearing')).toMatchObject({ debitMinor: 32_800, creditMinor: 32_800, balanceMinor: 0 });
    expect(day.accounts.find((a) => a.accountCode === 'sales_revenue')).toMatchObject({ debitMinor: 10_000, creditMinor: 20_000, balanceMinor: -10_000 });
    expect(day.accounts.find((a) => a.accountCode === 'cash_in_hand')).toMatchObject({ debitMinor: 10_500, creditMinor: 10_500 });
    expect(day.open).toBe(0);
  });

  it('a re-run posts nothing twice; a receipt synced late posts as a supplementary voucher covering only itself', async () => {
    const s = stub({ sales: [S1, S2], map: MAP_V1 });
    await post(s.routes);
    const again = await post(s.routes);
    expect(again.status).toBe(200);
    expect((again.body as PostBody).journals).toEqual([]);
    expect((again.body as PostBody).skipped).toBe(2);
    expect(s.journals).toHaveLength(3);
    s.sales.push(S3);
    const late = await post(s.routes);
    expect(late.status).toBe(201);
    expect((late.body as PostBody).journals.map((j) => [j.entryId, j.sources])).toEqual([
      [`daybook:${DAY}:sale:2`, 1], [`daybook:${DAY}:tender:card:1`, 1],
    ]);
    expect(s.journals[3]!.dayBook.sourceIds).toEqual(['s3']);
    expect((late.body as PostBody).skipped).toBe(2);
  });

  it('a closed month stays closed: the day posts to the next open period carrying its real date, and says so', async () => {
    const s = stub({ sales: [S1], map: MAP_V1, closed: ['2026-09'] });
    const body = (await post(s.routes)).body as PostBody;
    expect(body.postedTo).toBe('2026-10');
    expect(body.postedLate).toEqual({ belongsTo: '2026-09' });
    expect(body.journals[0]).toMatchObject({ period: '2026-10', documentDate: DAY, belongsTo: '2026-09' });
    expect(body.journals[0]!.narrative).toContain('posted to 2026-10: 2026-09 is closed');
    expect(s.journals[0]!.dayBook.belongsTo).toBe('2026-09');
  });

  it('a zero-value return is reported as having nothing to post, never as lost', async () => {
    const s = stub({ sales: [S1], returns: [{ ...R1, returnId: 'z1', refundMinor: 0 }], map: MAP_V1 });
    const body = (await post(s.routes)).body as PostBody;
    expect(body.zeroValue).toEqual(['z1']);
    expect(body.journals.map((j) => j.kind)).toEqual(['sale', 'tender:cash']);
  });
});

describe('exceptions — recorded, visible, resolved only by what actually covers them (P-08, hard rule #6)', () => {
  it('a receipt with no GST rate is recorded and stays open until the catalogue knows the product and the day is re-posted', async () => {
    const s = stub({ sales: [S1, sale({ saleId: 's9', lines: [{ productId: 'MYSTERY', quantityMinor: 1, lineTotalMinor: 10_500 }] })], map: MAP_V1 });
    const first = (await post(s.routes)).body as PostBody;
    const id = `${DAY}:tax_rate_unknown:sale:${fingerprint(['s9'])}`;
    expect(first.exceptions).toEqual([expect.objectContaining({
      exceptionId: id, tradingDay: DAY, reason: 'tax_rate_unknown', sourceKind: 'sale', sourceIds: ['s9'], raisedBy: 'u-acct', raisedAt: NOW,
    })]);
    expect(first.exceptions[0]!.detail).toMatch(/MYSTERY has no GST rate/);
    expect(first.journals.map((j) => j.kind)).toEqual(['sale', 'tender:cash']); // s1 posted regardless
    await post(s.routes); // the same problem again is the same exception, once on the screen
    expect(s.exceptions).toHaveLength(2);
    let day = (await read(s.routes)).body as ReadBody;
    expect(day.exceptions.map((e) => [e.exceptionId, e.state])).toEqual([[id, 'open']]);
    expect(day.open).toBe(1);
    s.rates.set('MYSTERY', 500);
    const fixed = (await post(s.routes)).body as PostBody;
    expect(fixed.journals.map((j) => [j.entryId, j.sources])).toEqual([[`daybook:${DAY}:sale:2`, 1], [`daybook:${DAY}:tender:cash:2`, 1]]);
    day = (await read(s.routes)).body as ReadBody;
    expect(day.exceptions.map((e) => [e.exceptionId, e.state])).toEqual([[id, 'resolved']]);
    expect(day.open).toBe(0);
  });

  it('an unmapped tender kind is ONE exception naming the receipts; the sale voucher posting does NOT resolve it — only the tender voucher does', async () => {
    const noUpi: StoredPostingMap = { ...MAP_V1, rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => r.kind !== 'tender:upi') };
    const s = stub({ sales: [S1, S2], map: noUpi });
    const first = (await post(s.routes)).body as PostBody;
    expect(first.journals.map((j) => j.kind)).toEqual(['sale', 'tender:cash']);
    const id = `${DAY}:unmapped_kind:tender:upi:${fingerprint(['s2'])}`;
    expect(first.exceptions).toEqual([expect.objectContaining({ exceptionId: id, kind: 'tender:upi', reason: 'unmapped_kind', sourceIds: ['s2'] })]);
    let day = (await read(s.routes)).body as ReadBody;
    expect(day.exceptions[0]).toMatchObject({ exceptionId: id, state: 'open' }); // s2 IS in the sale voucher — not enough
    await run(s.routes, 'PUT', MAP, { body: DEFAULT_RETAIL_POSTING_MAP });
    const fixed = (await post(s.routes)).body as PostBody;
    expect(fixed.journals.map((j) => [j.entryId, j.sources])).toEqual([[`daybook:${DAY}:tender:upi:1`, 1]]);
    expect(fixed.skipped).toBe(1); // s1 — every leg of it already posted
    expect(s.journals[2]!.dayBook.sourceIds).toEqual(['s2']);
    day = (await read(s.routes)).body as ReadBody;
    expect(day.exceptions[0]).toMatchObject({ exceptionId: id, state: 'resolved' });
    expect(day.accounts.find((a) => a.accountCode === 'sales_clearing')!.balanceMinor).toBe(0);
  });

  it('the helpers: coverage per kind, ids stable across order, state per exception shape', () => {
    const j = (kind: string, ids: string[]): DayBookJournal => ({
      entryId: `x-${kind}`, period: '2026-09', documentDate: DAY, narrative: 'a day-book voucher', lines: [], postedBy: 'u',
      dayBook: { tradingDay: DAY, kind, sourceKind: 'sale', sourceIds: ids, components: {} },
    });
    const journals = [j('sale', ['s1', 's2']), j('tender:cash', ['s1'])];
    expect([...coveredByKind(journals)].map(([k, v]) => [k, [...v]])).toEqual([['sale', ['s1', 's2']], ['tender:cash', ['s1']]]);
    expect(fingerprint(['b', 'a'])).toBe(fingerprint(['a', 'b']));
    expect(fingerprint(['a'])).not.toBe(fingerprint(['b']));
    expect(exceptionIdFor(DAY, { sourceKind: 'sale', sourceIds: ['s2'], reason: 'tax_rate_unknown', detail: '' })).toBe(`${DAY}:tax_rate_unknown:sale:${fingerprint(['s2'])}`);
    expect(exceptionState({ sourceKind: 'sale', sourceIds: ['s2'], reason: 'tax_rate_unknown', detail: '' }, journals)).toBe('resolved');
    expect(exceptionState({ sourceKind: 'sale', sourceIds: ['s2'], kind: 'tender:upi', reason: 'unmapped_kind', detail: '' }, journals)).toBe('open');
    expect(exceptionState({ sourceKind: 'sale', sourceIds: ['s1'], kind: 'tender:cash', reason: 'unmapped_kind', detail: '' }, journals)).toBe('resolved');
  });
});
