import { describe, it, expect } from 'vitest';
import {
  createGstDeskSession, monthDates, fyOfMonth, isFy, paiseOf, bpsOf, gstnFileName, gstDeskWords, gstDeskOutcomeWords, GST_DESK_COPY,
} from '../../apps/web-erp/src/gst-desk-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The GST and statutory tax desk session (W5 · route audit section 2, bundle 2).** API-09 · M23 · A14 · A17 · A18 · A19 ·
 * A24 · OB-143 · OB-191 · OB-428 · OB-432 · OB-433.
 *
 * Every figure is head office's; the session only turns the typed month into dates, rupees into paise and percent into
 * basis points, refuses what head office would refuse before sending, and sends each write ONCE (its key kept while the
 * answer is lost). The CA's lists are never filled with a default: an empty list is sent as the CA typed it.
 */

type Call = { method: string; path: string; body?: unknown; key?: string };
function fakeFetch(answer: (c: Call) => { status: number; body: unknown } | 'lost') {
  const calls: Call[] = [];
  const fetch = (async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const c: Call = { method: init.method, path, ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}), ...(init.headers['idempotency-key'] !== undefined ? { key: init.headers['idempotency-key'] } : {}) };
    calls.push(c);
    const a = answer(c);
    if (a === 'lost') throw new Error('network down');
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const ALL = ['finance.gstr.read', 'finance.gst.timebar.set', 'finance.gstr.generate', 'finance.rcm.read', 'finance.rcm.configure', 'finance.rcm.record', 'finance.rcm.pay',
  'finance.tds.read', 'finance.tds.configure', 'finance.tds.switch', 'finance.tds.challan.record', 'finance.itc.read', 'finance.itc.action'];
let n = 0;
const desk = (answer: Parameters<typeof fakeFetch>[0] = () => ({ status: 200, body: {} }), permissions: readonly string[] = ALL, userId: string | null = 'u-ca') => {
  const f = fakeFetch(answer);
  const s = createGstDeskSession({ viewer: { ...(userId === null ? {} : { userId }), permissions }, fetch: f.fetch, newKey: () => `k${++n}` });
  return { s, calls: f.calls };
};

describe('the pure conversions', () => {
  it('a filing month is its calendar month — the shop\'s MMYYYY, never a clock', () => {
    expect(monthDates('022028')).toEqual({ from: '2028-02-01', to: '2028-02-29', ym: '2028-02' });
    expect(monthDates('052026')).toEqual({ from: '2026-05-01', to: '2026-05-31', ym: '2026-05' });
    expect(monthDates('132026')).toBeUndefined();
    expect(fyOfMonth('032027')).toBe('2026-27');
    expect(fyOfMonth('042026')).toBe('2026-27');
    expect(isFy('2026-27')).toBe(true);
    expect(isFy('2026-28')).toBe(false);
  });

  it('rupees to paise and percent to basis points, refusing anything that is not a plain number', () => {
    expect(paiseOf('₹1,23,456.5')).toBe(12_345_650);
    expect(paiseOf('80')).toBe(8_000);
    expect(paiseOf('-5')).toBeUndefined();
    expect(paiseOf('1.234')).toBeUndefined();
    expect(bpsOf('18')).toBe(1_800);
    expect(bpsOf('2.5%')).toBe(250);
    expect(bpsOf('101')).toBeUndefined();
    expect(gstnFileName('33ABCDE1234F1Z5', '052026')).toBe('GSTR1_33ABCDE1234F1Z5_052026.json');
  });
});

describe('GSTR-1 for the month (route audit rows 155–158)', () => {
  it('reads the return and Table 12 for the month\'s dates, and Table 12 from the till with the typed turnover', async () => {
    const { s, calls } = desk();
    await s.gstr1Return('052026');
    await s.table12('052026');
    await s.table12FromSales('052026', '7,50,00,000');
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['GET', '/v1/finance/gstr1/return?from=2026-05-01&to=2026-05-31', undefined],
      ['GET', '/v1/finance/gstr1/table-12?from=2026-05-01&to=2026-05-31', undefined],
      ['POST', '/v1/finance/gstr1/from-sales/table-12', { from: '2026-05-01', to: '2026-05-31', annualTurnoverMinor: 7_500_000_000 }],
    ]);
  });

  it('never invents a turnover: Table 12 from sales waits for one to be typed', async () => {
    const { s, calls } = desk();
    expect(await s.table12FromSales('052026', '')).toEqual({ result: 'invalid', why: 'badTurnover' });
    expect(calls).toEqual([]);
  });

  it('the GSTN file is head office\'s export exactly as answered, named by GSTIN and month — nothing is filed', async () => {
    const file = { gstin: '33ABCDE1234F1Z5', fp: '052026', b2b: [], b2cs: [{ rt: 5, txval: 200 }] };
    const { s, calls } = desk(() => ({ status: 200, body: file }));
    expect(await s.gstnFile('052026', 'bad')).toEqual({ result: 'invalid', why: 'badGstin' });
    const out = await s.gstnFile('052026', '33abcde1234f1z5');
    expect(calls.map((c) => c.path)).toEqual(['/v1/finance/gstr1/export?from=2026-05-01&to=2026-05-31&gstin=33ABCDE1234F1Z5&fp=052026']);
    expect(out).toEqual({ result: 'ok', value: { fileName: 'GSTR1_33ABCDE1234F1Z5_052026.json', text: JSON.stringify(file, null, 2) } });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('a refusal (OB-428 · OB-432: a place of supply not judged) is head office\'s own sentence', async () => {
    const { s } = desk(() => ({ status: 422, body: { error: { code: 'gstr1_place_of_supply_not_judged', whatHappened: 'The GSTN file was not made: invoice B2B-1 …', nextSafeAction: 'No file was made and nothing was filed.' } } }));
    const out = await s.gstnFile('052026', '33ABCDE1234F1Z5');
    expect(gstDeskOutcomeWords('en', out)).toBe('Head office refused: The GSTN file was not made: invoice B2B-1 … No file was made and nothing was filed.');
  });
});

describe('the owner\'s warning window (row 150 · A19 · OB-191) and GSTR-9C reasons (row 88 · A18)', () => {
  it('only the owner\'s role may change the window, with whole days and a reason', async () => {
    const ca = desk(undefined, ['finance.gstr.read']);
    expect(await ca.s.setTimeBarDays('90', 'x')).toEqual({ result: 'invalid', why: 'notAllowed' });
    const { s, calls } = desk();
    expect(await s.setTimeBarDays('0', 'x')).toEqual({ result: 'invalid', why: 'badDays' });
    expect(await s.setTimeBarDays('90', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    await s.setTimeBarDays('90', 'the CA wants a shorter window');
    expect(calls).toMatchObject([{ method: 'PUT', path: '/v1/finance/gst/controls/time-bar-warning-days', body: { days: 90, reason: 'the CA wants a shorter window' } }]);
  });

  it('a GSTR-9C reason names the month and the difference, with the reason in words', async () => {
    const { s, calls } = desk();
    expect(await s.give9cReason('2026-27', '052026', 'made_up', 'x')).toEqual({ result: 'invalid', why: 'badCode' });
    await s.give9cReason('2026-27', '052026', 'books_differ_from_till', 'day 12 posted late');
    expect(calls).toMatchObject([{ method: 'POST', path: '/v1/finance/gstr9c/2026-27/reasons', body: { period: '052026', code: 'books_differ_from_till', reason: 'day 12 posted late' } }]);
  });
});

describe('reverse charge (rows 151–153, 213–215 · A14 · OB-143)', () => {
  it('the CA lists a head with its rate in basis points and its citation; retiring needs a reason', async () => {
    const { s, calls } = desk();
    expect(await s.setRcmHead({ headCode: 'g t a', name: 'Goods transport', rate: '5', notifiedUnder: 'x' })).toEqual({ result: 'invalid', why: 'badHeadCode' });
    expect(await s.setRcmHead({ headCode: 'gta', name: 'Goods transport', rate: '5', notifiedUnder: '' })).toEqual({ result: 'invalid', why: 'needCitation' });
    await s.setRcmHead({ headCode: 'gta', name: 'Goods transport', rate: '5', notifiedUnder: 'Notfn 13/2017-CT(R) entry 1' });
    expect(await s.retireRcmHead('GTA', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(calls).toMatchObject([{ method: 'POST', path: '/v1/finance/rcm/heads/GTA', body: { name: 'Goods transport', rateBps: 500, notifiedUnder: 'Notfn 13/2017-CT(R) entry 1' } }]);
  });

  it('a purchase is recorded once: a lost answer keeps its id AND its key, so pressing again is the same record', async () => {
    let lose = true;
    const { s, calls } = desk(() => { if (lose) { lose = false; return 'lost'; } return { status: 201, body: { purchase: { purchaseId: 'x' } } }; });
    const p = { supplierId: 'SUP-1', headCode: '', supplyDate: '2026-05-04', taxable: '1,000', placeOfSupply: 'intra_state', description: 'freight' };
    expect(await s.recordRcmPurchase(p)).toEqual({ result: 'lost_link' });
    expect((await s.recordRcmPurchase(p)).result).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.path).toBe(calls[0]!.path);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls[0]!.body).toEqual({ supplierId: 'SUP-1', supplyDate: '2026-05-04', taxableMinor: 100_000, placeOfSupply: 'intra_state', description: 'freight' });
  });

  it('a definite answer drops the key — the next, different act is a new one', async () => {
    const { s, calls } = desk(() => ({ status: 201, body: {} }));
    await s.markRcmPaid('RCM-1', 'CPIN-1', '2026-06-05');
    await s.markRcmPaid('RCM-2', 'CPIN-2', '2026-06-05');
    expect(calls[0]!.key).not.toBe(calls[1]!.key);
    expect(calls.map((c) => c.path)).toEqual(['/v1/finance/rcm/purchases/RCM-1/paid', '/v1/finance/rcm/purchases/RCM-2/paid']);
  });

  it('the register is for the typed month', async () => {
    const { s, calls } = desk();
    await s.rcmRegister('052026');
    expect(calls.map((c) => c.path)).toEqual(['/v1/finance/rcm/register?period=052026']);
  });
});

describe('income-tax TDS (rows 242–245 · A24 · OB-143: the CA fills it, "not set" until then)', () => {
  it('the CA\'s list is sent whole, thresholds blank = none, never a default rate', async () => {
    const { s, calls } = desk();
    await s.setTdsList(
      [{ section: '194c', label: 'Contractors', rate: '1', single: '30,000', aggregate: '', onCrossing: 'whole_aggregate' }],
      [{ supplierId: 'SUP-9', tdsApplicable: true, section: '194c', pan: 'abcde1234f' }],
    );
    expect(calls).toMatchObject([{ method: 'POST', path: '/v1/finance/tds/config', body: {
      sections: [{ section: '194C', label: 'Contractors', rateBps: 100, singleThresholdMinor: 3_000_000, aggregateThresholdMinor: null, onCrossing: 'whole_aggregate' }],
      payees: [{ supplierId: 'SUP-9', tdsApplicable: true, section: '194C', pan: 'ABCDE1234F' }],
    } }]);
    expect(Object.keys((calls[0]!.body as Record<string, unknown>))).toEqual(['sections', 'payees']); // never the switch
  });

  it('a section without a rate is refused, not guessed', async () => {
    const { s, calls } = desk();
    expect(await s.setTdsList([{ section: '194J', label: 'Professional fees', rate: '', single: '', aggregate: '', onCrossing: 'this_payment' }], [])).toEqual({ result: 'invalid', why: 'badRate' });
    expect(calls).toEqual([]);
  });

  it('only the owner\'s role switches it, with a reason; the CA cannot', async () => {
    const ca = desk(undefined, ['finance.tds.read', 'finance.tds.configure']);
    expect(await ca.s.switchTds(true, 'list filled')).toEqual({ result: 'invalid', why: 'notAllowed' });
    const { s, calls } = desk();
    await s.switchTds(true, 'the CA filled the list');
    expect(calls).toMatchObject([{ method: 'POST', path: '/v1/finance/tds/switch', body: { enabled: true, reason: 'the CA filled the list' } }]);
  });

  it('a challan names the payments it deposits and its amount; the 26Q is read by year and quarter', async () => {
    const { s, calls } = desk();
    expect(await s.recordTdsChallan({ challanRef: 'BSR 0001234 07/06/2026 00042', depositedOn: '2026-06-07', paymentIds: ' ', amount: '300' })).toEqual({ result: 'invalid', why: 'needPayments' });
    await s.recordTdsChallan({ challanRef: 'BSR 0001234 07/06/2026 00042', depositedOn: '2026-06-07', paymentIds: 'PAY-1, PAY-2', amount: '300' });
    await s.form26q('2026-27', 'Q1');
    expect(calls).toMatchObject([
      { method: 'POST', path: '/v1/finance/tds/challans/BSR-0001234-07-06-2026-00042', body: { challanRef: 'BSR 0001234 07/06/2026 00042', depositedOn: '2026-06-07', paymentIds: ['PAY-1', 'PAY-2'], amountMinor: 30_000 } },
      { method: 'GET', path: '/v1/finance/tds/26q/2026-27/Q1' },
    ]);
  });
});

describe('input tax credit (rows 180–181 · A17)', () => {
  it('reads the claim for the month and records a reversal as its own record, at least one amount above zero', async () => {
    const { s, calls } = desk();
    await s.itcClaim('2026-05');
    expect(await s.itcReversal('2026-05', { rule: 'rule_42', sourceRef: 'INV-7', reason: 'exempt use', igst: '', cgst: '', sgst: '', cess: '' })).toEqual({ result: 'invalid', why: 'badAmount' });
    expect(await s.itcReversal('2026-05', { rule: 'rule_99', sourceRef: 'INV-7', reason: 'x', igst: '1', cgst: '', sgst: '', cess: '' })).toEqual({ result: 'invalid', why: 'badRule' });
    await s.itcReversal('2026-05', { rule: 'rule_42', sourceRef: 'INV-7', reason: 'exempt use', igst: '', cgst: '45', sgst: '45', cess: '' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/finance/itc/2026-05/claim' });
    expect(calls[1]!.path).toMatch(/^\/v1\/finance\/itc\/2026-05\/reversals\/REV-[A-Za-z0-9]+$/);
    expect(calls[1]!.body).toEqual({ rule: 'rule_42', sourceRef: 'INV-7', reason: 'exempt use', igstMinor: 0, cgstMinor: 4_500, sgstMinor: 4_500, cessMinor: 0 });
  });

  it('a role that may only read ITC is offered no reversal', async () => {
    const { s, calls } = desk(undefined, ['finance.itc.read']);
    expect(s.may.actItc).toBe(false);
    expect(await s.itcReversal('2026-05', { rule: 'rule_42', sourceRef: 'x', reason: 'y', igst: '1', cgst: '', sgst: '', cess: '' })).toEqual({ result: 'invalid', why: 'notAllowed' });
    expect(calls).toEqual([]);
  });
});

describe('who is looking', () => {
  it('nobody signed in can read or do nothing', async () => {
    const { s, calls } = desk(undefined, ALL, null);
    expect(s.may.named).toBe(false);
    expect(await s.tds()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(calls).toEqual([]);
  });

  it('every word has a Tamil twin', () => {
    const keys = Object.keys(GST_DESK_COPY.en) as (keyof typeof GST_DESK_COPY.en)[];
    const gaps = bilingualGaps(GST_DESK_COPY as never, keys as never);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
    expect(gstDeskWords('ta', 'notSet')).not.toBe(gstDeskWords('en', 'notSet'));
  });
});
