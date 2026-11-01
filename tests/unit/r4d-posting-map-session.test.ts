import { describe, it, expect } from 'vitest';
import { createPostingMapSession, kindRows, mapToSave, accountRows, kindWords, POSTING_MAP_COPY, type Rule } from '../../apps/web-erp/src/posting-map-session';
import { postingMapHistory } from '../../services/finance/src/day-book';
import { ledgerNamesHistory } from '../../services/finance/src/tally-export';

/**
 * Round 4d (M23-FR-01 · Screen D): the accounts set-up session — which account each kind of posting goes to, and what each
 * account is called in Tally. Nothing is filled in for the accountant; a save carries the version it was edited from.
 */

function fakeHeadOffice(answer: (method: string, path: string) => { status?: number; body: unknown }) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const a = answer(init.method, path);
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const v = (...permissions: string[]) => ({ userId: 'u-acct', permissions });
const SALE: Rule = { kind: 'sale', legs: [{ account: 'sales_clearing', side: 'debit', component: 'total' }, { account: 'sales_revenue', side: 'credit', component: 'net' }] };
const CASH: Rule = { kind: 'tender:cash', legs: [{ account: 'cash_in_hand', side: 'debit', component: 'amount' }, { account: 'sales_clearing', side: 'credit', component: 'amount' }] };

describe('every word has a Tamil twin', () => {
  it('in the accounts set-up word table', () => { expect(Object.keys(POSTING_MAP_COPY.ta).sort()).toEqual(Object.keys(POSTING_MAP_COPY.en).sort()); });
  it('a tender\'s takings and refunds are named by the tender', () => {
    expect(kindWords('en', 'tender:upi')).toBe('Takings in UPI (Day book)');
    expect(kindWords('ta', 'refund:cash')).toMatch(/ரொக்கம்/);
    expect(kindWords('en', 'something_new')).toBe('something_new');
  });
});

describe('the kinds in one list', () => {
  it('in force first, then suggested only, then the kinds nothing suggests — those start with no account at all', () => {
    const rows = kindRows([SALE], [SALE, CASH], [{ kind: 'promotion_funding', components: ['amount'] }, { kind: 'sale', components: ['total'] }]);
    expect(rows.map((r) => [r.kind, r.state])).toEqual([['sale', 'in_force'], ['tender:cash', 'suggested'], ['promotion_funding', 'to_map']]);
    expect(rows[2]!.legs).toEqual([{ account: '', side: 'debit', component: 'amount' }, { account: '', side: 'credit', component: 'amount' }]);
    expect(rows[1]!.inForce).toBeNull();
  });
  it('every account the map in force posts to, with its Tally name or none', () => {
    expect(accountRows([SALE, CASH], { sales_clearing: 'Sales Clearing A/c' })).toEqual([
      { account: 'sales_clearing', tallyName: 'Sales Clearing A/c', kinds: ['sale', 'tender:cash'] },
      { account: 'sales_revenue', tallyName: null, kinds: ['sale'] },
      { account: 'cash_in_hand', tallyName: null, kinds: ['tender:cash'] },
    ]);
  });
});

describe('the map to save is the map in force with the changes laid over it', () => {
  it('a changed kind replaces its rule, a left-out kind goes, a new kind is added at the end', () => {
    const changes = new Map<string, Rule['legs'] | null>([
      ['tender:cash', null],
      ['promotion_funding', [{ account: 'bank', side: 'debit', component: 'amount' }, { account: 'offer_income', side: 'credit', component: 'amount' }]],
    ]);
    const out = mapToSave([SALE, CASH], changes);
    expect(out).toEqual({ ok: true, rules: [SALE, { kind: 'promotion_funding', legs: [{ account: 'bank', side: 'debit', component: 'amount' }, { account: 'offer_income', side: 'credit', component: 'amount' }] }] });
  });
  it('refuses, by name, a figure with no account and a rule with only one side; and nothing changed at all', () => {
    expect(mapToSave([SALE], new Map())).toEqual({ ok: false, why: 'noChange' });
    expect(mapToSave([], new Map([['promotion_funding', [{ account: ' ', side: 'debit' as const, component: 'amount' }, { account: 'x', side: 'credit' as const, component: 'amount' }]]]))).toEqual({ ok: false, why: 'blankAccount', kind: 'promotion_funding' });
    expect(mapToSave([], new Map([['k', [{ account: 'a', side: 'debit' as const, component: 'amount' }, { account: 'b', side: 'debit' as const, component: 'amount' }]]]))).toEqual({ ok: false, why: 'needBothSides', kind: 'k' });
    expect(mapToSave([SALE], new Map([['sale', null]]))).toEqual({ ok: false, why: 'empty' });
  });
});

describe('the session', () => {
  it('reads both maps; sends the whole map with the version it was edited from and the note', async () => {
    const ho = fakeHeadOffice((method, path) => {
      if (method === 'PUT') return { body: { version: 3 } };
      if (path === '/v1/finance/posting-map') return { body: { map: { version: 2, definedBy: 'u-acct', definedAt: '2026-11-01T05:00:00Z', rules: [SALE] }, suggested: { rules: [SALE, CASH] }, toMap: [{ kind: 'promotion_funding', components: ['amount'] }], history: [{ version: 2, definedBy: 'u-acct', definedAt: 'x', rules: 1, added: [], changed: ['sale'], dropped: [] }], asAt: 'now' } };
      return { body: { ledgerNames: { companyName: 'SRE', names: { sales_revenue: 'Sales' }, version: 1, setBy: 'u-acct', setAt: 'y' }, families: [{ family: 'sales', words: { en: 'Sales', ta: 'விற்பனை' } }], history: [] } };
    });
    const s = createPostingMapSession({ viewer: v('finance.period.read', 'finance.posting.configure'), fetch: ho.fetch });
    const read = await s.read();
    expect(read.result).toBe('ok');
    if (read.result !== 'ok') return;
    expect(read.value.mapVersion).toBe(2);
    expect(read.value.rows.map((r) => r.state)).toEqual(['in_force', 'suggested', 'to_map']);
    expect(read.value.accounts.find((a) => a.account === 'sales_revenue')?.tallyName).toBe('Sales');
    expect(read.value.mapHistory[0]!.changed).toEqual(['sale']);
    const saved = await s.saveMap({ basedOn: 2, inForce: [SALE], changes: new Map([['tender:cash', CASH.legs]]), note: ' cash goes to the till float ' });
    expect(saved).toEqual({ result: 'ok', value: { version: 3 } });
    expect(ho.sent.at(-1)).toEqual({ method: 'PUT', path: '/v1/finance/posting-map', body: { rules: [SALE, CASH], basedOn: 2, note: 'cash goes to the till float' } });
  });

  it('says plainly when somebody saved a newer version meanwhile', async () => {
    const ho = fakeHeadOffice(() => ({ status: 409, body: { error: { code: 'posting_map_changed_since', whatHappened: 'x' } } }));
    const s = createPostingMapSession({ viewer: v('finance.period.read', 'finance.posting.configure'), fetch: ho.fetch });
    expect(await s.saveMap({ basedOn: 1, inForce: [SALE], changes: new Map([['tender:cash', CASH.legs]]), note: '' })).toEqual({ result: 'invalid', why: 'changedSince' });
  });

  it('sends the Tally names with blanks left out, blank voucher types meaning "Journal", and the version edited from', async () => {
    const ho = fakeHeadOffice(() => ({ status: 201, body: { ledgerNames: { version: 2 } } }));
    const s = createPostingMapSession({ viewer: v('finance.period.read', 'finance.posting.configure'), fetch: ho.fetch });
    expect(await s.saveNames({ basedOn: 1, companyName: '  ', names: { a: 'A' }, voucherTypes: {}, note: '' })).toEqual({ result: 'invalid', why: 'needCompany' });
    expect(await s.saveNames({ basedOn: 1, companyName: 'SRE', names: { a: ' ' }, voucherTypes: {}, note: '' })).toEqual({ result: 'invalid', why: 'needName' });
    expect(ho.sent).toHaveLength(0);
    expect(await s.saveNames({ basedOn: 1, companyName: ' SRE Hyper Market ', names: { a: 'Cash', b: '' }, voucherTypes: { sales: 'Sales', cash: ' ' }, note: '' })).toEqual({ result: 'ok', value: { version: 2 } });
    expect(ho.sent[0]!.body).toEqual({ companyName: 'SRE Hyper Market', names: { a: 'Cash' }, basedOn: 1, voucherTypes: { sales: 'Sales' } });
  });

  it('sends nothing for a viewer without the words, or nobody', async () => {
    const ho = fakeHeadOffice(() => ({ body: {} }));
    const reader = createPostingMapSession({ viewer: v('finance.period.read'), fetch: ho.fetch });
    expect(reader.may).toEqual({ named: true, read: true, configure: false });
    expect(await reader.saveMap({ basedOn: 0, inForce: [], changes: new Map([['sale', SALE.legs]]), note: '' })).toEqual({ result: 'invalid', why: 'cannotConfigure' });
    expect(await createPostingMapSession({ viewer: undefined, fetch: ho.fetch }).read()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createPostingMapSession({ viewer: v(), fetch: ho.fetch }).read()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.sent).toHaveLength(0);
  });
});

describe('head office lists every version against the one before', () => {
  it('the posting map: added, changed and left-out kinds, newest first', () => {
    const h = postingMapHistory([
      { version: 2, definedBy: 'u-b', definedAt: 't2', note: 'cash to float', rules: [{ ...SALE, legs: [SALE.legs[0]!, { ...SALE.legs[1]!, account: 'revenue_2' }] }, { kind: 'x', legs: CASH.legs }] },
      { version: 1, definedBy: 'u-a', definedAt: 't1', rules: [SALE, CASH] },
    ]);
    expect(h.map((x) => [x.version, x.added, x.changed, x.dropped, x.note])).toEqual([[2, ['x'], ['sale'], ['tender:cash'], 'cash to float'], [1, ['sale', 'tender:cash'], [], [], undefined]]);
  });
  it('the Tally names: named, renamed and left-out accounts', () => {
    const h = ledgerNamesHistory([
      { version: 1, setBy: 'u-a', setAt: 't1', companyName: 'SRE', names: { a: 'A', b: 'B' } },
      { version: 2, setBy: 'u-a', setAt: 't2', companyName: 'SRE', names: { a: 'A2', c: 'C' } },
    ]);
    expect(h.map((x) => [x.version, x.added, x.renamed, x.dropped])).toEqual([[2, ['c'], ['a'], ['b']], [1, ['a', 'b'], [], []]]);
  });
});
