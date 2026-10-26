import { describe, it, expect } from 'vitest';
import {
  createLpSignalsSession, lpSignalsWords, LP_SIGNALS_COPY, policyWords, sourceWords, rupees, percent, type LpRecordsRead,
} from '../../apps/web-erp/src/lp-signals-session';

/**
 * **The Investigations page reads the shop's own records (M15-FR-02 · M15-FR-03 · OB-301 · lane 2 RP-1).**
 *
 * The tested session behind "From the shop's own records" on the Investigations page (`lp-records.js`). On a click it
 * reads three things head office works out from its own records — the fraud signals over stored coupons, points, cash on
 * delivery and supplier bills; the staff purchases judged by the till's own rule; and bank accounts shared between
 * suppliers and staff. It only reads (hard rule #5: a signal is a reason to look, never a verdict). Proven here: a person
 * nobody named and a role without `lp.case.read` read nothing (no call is made); the three reads carry the window and come
 * back whole; a refusal is head office's own words; a lost line is "unreachable", never an empty list; the owner's two
 * staff-buying numbers say "not set" when he has not set them; a register head office could not read says "not known";
 * and every word has a Tamil twin. Synthetic data only.
 */

interface Call { readonly url: string; readonly method: string }

const SIGNALS: LpRecordsRead['signals'] = {
  signals: [{
    signalId: 'sig-1', domain: 'coupon', kind: 'coupon_beyond_limit', subjectRef: 'CPN-10', confidence: 'strong', valueMinor: 25_000,
    evidenceRefs: ['coupon:CPN-10', 'sale:S-9'], detail: 'used 4 times, limit 1', reconciles: true, unmatchedEvidence: [],
  }],
  sources: [
    { domain: 'coupon', known: true, read: 4, notValued: 1 },
    { domain: 'loyalty', known: false, read: 0, why: 'the points register did not answer' },
    { domain: 'supplier', known: true, read: 1, history: 5 },
  ],
  allReconcile: true,
};
const STAFF: LpRecordsRead['staff'] = {
  bills: [{ saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-2', cashierId: 'u-cash', employeeId: 'e-7', committedAt: '2026-10-25T05:00:00.000Z', totalMinor: 12_000, discountBps: 1_500, allowed: false, refusals: ['self_billing', 'discount_above_cap'], words: { en: 'Rang their own shopping', ta: 'தன் சொந்தப் பொருட்களுக்குப் பில் போட்டார்' } }],
  policy: { staffDiscountCapBps: null, serviceDeskLaneIds: null },
};
const BANK: LpRecordsRead['bank'] = { flags: [{ accountRef: 'XXXX1234', holders: [{ holderId: 'sup-1', holderType: 'supplier' }, { holderId: 'e-7', holderType: 'employee' }] }], employeesFolded: 12 };

/** A stand-in for head office's three read routes; it records every call. */
function headOffice(answer: (url: string) => { status: number; body: unknown } | 'throw'): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const a = answer(url);
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const records = (url: string) => ({
  status: 200,
  body: url.startsWith('/v1/fraud-signals/stored') ? SIGNALS : url.startsWith('/v1/loss-prevention/staff-purchases/exceptions') ? STAFF : BANK,
});
const investigator = { userId: 'u-lp', permissions: ['lp.case.read'] };

describe('who may read', () => {
  it('nobody named on the screen: nothing is read and no call is made', async () => {
    const ho = headOffice(records);
    const s = createLpSignalsSession({ viewer: { permissions: ['lp.case.read'] }, fetch: ho.fetch });
    expect(s.may).toEqual({ named: false, read: false });
    expect(await s.read({})).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.calls).toEqual([]);
    const none = createLpSignalsSession({ viewer: undefined, fetch: ho.fetch });
    expect(await none.read({})).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.calls).toEqual([]);
  });

  it('a role without lp.case.read (a cashier) is refused before any call', async () => {
    const ho = headOffice(records);
    const s = createLpSignalsSession({ viewer: { userId: 'u-cash', permissions: ['pos.sale.create'] }, fetch: ho.fetch });
    expect(s.may).toEqual({ named: true, read: false });
    expect(await s.read({ from: '2026-10-01', to: '2026-10-25' })).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.calls).toEqual([]);
  });
});

describe('the three reads', () => {
  it('reads the signals, the staff purchases and the shared bank accounts — GET only, the window on the two that take one', async () => {
    const ho = headOffice(records);
    const out = await createLpSignalsSession({ viewer: investigator, fetch: ho.fetch }).read({ from: '2026-10-01', to: '2026-10-25' });
    expect(out).toEqual({ result: 'ok', value: { signals: SIGNALS, staff: STAFF, bank: BANK } });
    expect(ho.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(ho.calls.map((c) => c.url).sort()).toEqual([
      '/v1/fraud-signals/duplicate-bank',
      '/v1/fraud-signals/stored?from=2026-10-01&to=2026-10-25',
      '/v1/loss-prevention/staff-purchases/exceptions?from=2026-10-01&to=2026-10-25',
    ]);
  });

  it('with no window typed, asks for head office\'s default (no empty from/to in the address)', async () => {
    const ho = headOffice(records);
    await createLpSignalsSession({ viewer: investigator, fetch: ho.fetch }).read({ from: '', to: '' });
    expect(ho.calls.map((c) => c.url).sort()).toEqual(['/v1/fraud-signals/duplicate-bank', '/v1/fraud-signals/stored', '/v1/loss-prevention/staff-purchases/exceptions']);
  });

  it('a refusal on any of the three is head office\'s own words — never a partial page', async () => {
    const ho = headOffice((url) => url.startsWith('/v1/fraud-signals/duplicate-bank')
      ? { status: 403, body: { error: { code: 'forbidden', whatHappened: 'Your role may not read bank accounts.' } } }
      : records(url));
    const out = await createLpSignalsSession({ viewer: investigator, fetch: ho.fetch }).read({});
    expect(out).toEqual({ result: 'refused', status: 403, code: 'forbidden', whatHappened: 'Your role may not read bank accounts.' });
  });

  it('head office unreachable: "lost link" — the page says so, never "no signal"', async () => {
    const ho = headOffice(() => 'throw');
    expect(await createLpSignalsSession({ viewer: investigator, fetch: ho.fetch }).read({})).toEqual({ result: 'lost_link' });
    expect(lpSignalsWords('en', 'unreachable')).toBe('Head office cannot be reached — nothing was read.');
    expect(lpSignalsWords('ta', 'unreachable')).toMatch(/[஀-௿]/);
  });
});

describe('the words', () => {
  it('the owner\'s two staff-buying numbers say "not set" when he has not set them, and the figures when he has', () => {
    expect(policyWords('en', { staffDiscountCapBps: null, serviceDeskLaneIds: null })).toEqual({ cap: 'Staff discount (owner): not set', desk: 'Service-desk till (owner): not set' });
    expect(policyWords('ta', { staffDiscountCapBps: null, serviceDeskLaneIds: null }).cap).toBe('பணியாளர் தள்ளுபடி (உரிமையாளர்): அமைக்கப்படவில்லை');
    expect(policyWords('en', { staffDiscountCapBps: 1_250, serviceDeskLaneIds: ['lane-9', 'lane-10'] })).toEqual({ cap: 'Staff discount (owner): 12.5%', desk: 'Service-desk till (owner): lane-9, lane-10' });
  });

  it('a register head office could not read is "not known — why", never "0 read"; history and unvalued coupons are named', () => {
    expect(sourceWords('en', SIGNALS.sources[1]!)).toBe('Points: not known — the points register did not answer');
    expect(sourceWords('en', SIGNALS.sources[0]!)).toBe('Coupons: 4 read · 1 counted but not valued (a percentage coupon)');
    expect(sourceWords('en', SIGNALS.sources[2]!)).toBe('Supplier bills: 1 read (+5)');
    expect(sourceWords('ta', SIGNALS.sources[1]!)).toMatch(/^புள்ளிகள்: தெரியவில்லை —/);
  });

  it('money and percentages read as a person reads them', () => {
    expect(rupees(25_000)).toBe('₹250.00');
    expect(rupees(1_23_45_600)).toBe('₹1,23,456.00');
    expect(percent(1_000)).toBe('10%');
  });

  it('every English word has a Tamil twin in Tamil script, and an unknown key falls back rather than vanishing', () => {
    const en = Object.keys(LP_SIGNALS_COPY.en).sort();
    expect(Object.keys(LP_SIGNALS_COPY.ta).sort()).toEqual(en);
    for (const k of en) expect((LP_SIGNALS_COPY.ta as Record<string, string>)[k], k).toMatch(/[஀-௿]/);
    expect(lpSignalsWords('ta', 'no-such-key')).toBe('no-such-key');
  });
});
