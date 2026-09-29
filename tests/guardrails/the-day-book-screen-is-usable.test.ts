import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DAY_BOOK_COPY, COPY_KEYS, createDayBookSession,
  type DayBookPorts, type DayBookReadData,
} from '../../apps/web-erp/src/day-book-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The day-book screen is usable, bilingual, and governed (M23-FR-01, API-09, §28).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: an OPEN exception reads as an ERROR (money the accounts
 * have not taken, P-08); an unposted day never shows figures that look booked; the only write is the POST of
 * the day that runs ONLY on an explicit click (never on load — the journals are append-only, hard rule #2);
 * and the day read stays a GET.
 */

const READ: DayBookReadData = {
  tradingDay: '2026-09-28',
  journals: [{ entryId: 'daybook:2026-09-28:sale:1', kind: 'sale', sourceKind: 'sale', sources: 2, period: '2026-09', documentDate: '2026-09-28', components: { total: 200_00, net: 190_48, tax: 9_52, cgst: 4_76, sgst: 4_76 }, lines: [{ accountCode: '1210', debitMinor: 200_00, creditMinor: 0 }, { accountCode: '4000', debitMinor: 0, creditMinor: 190_48 }, { accountCode: '2310', debitMinor: 0, creditMinor: 9_52 }], postedBy: 'u-acct', narrative: 'sale' }],
  accounts: [{ accountCode: '1210', debitMinor: 200_00, creditMinor: 0, balanceMinor: 200_00 }],
  covered: 2,
  exceptions: [{ exceptionId: 'e-open', tradingDay: '2026-09-28', sourceKind: 'sale', sourceIds: ['S-3'], reason: 'tax_rate_unknown', detail: 'tax rate unknown', raisedAt: '2026-09-29T02:00:00Z', raisedBy: 'u-acct', state: 'open' }],
  open: 1, asAt: '2026-09-29T09:00:00Z',
};
const session = (ports: Partial<DayBookPorts> = {}) =>
  createDayBookSession({ userId: 'u-acct' }, {
    dayBook: () => READ, mayRead: () => true, mayPost: () => true,
    postPort: () => ({ post: async () => ({ result: 'posted', body: { tradingDay: '2026-09-28', postedTo: '2026-09', journals: READ.journals, exceptions: [], skipped: 0, zeroValue: [], counted: { sales: 2, returns: 0 } } }) }),
    ...ports,
  });

describe('the day-book copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(DAY_BOOK_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...DAY_BOOK_COPY.en }, ta: { ...DAY_BOOK_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('an open exception reads as an error, a posted journal as ok — never colour alone; an unposted day never looks booked', () => {
  it('open → error with a word and an icon; posted → ok with a word and an icon', () => {
    const v = session().view('en');
    expect(v.exceptions[0]!.status.tone).toBe('error');
    expect(v.journals[0]!.status.tone).toBe('ok');
    for (const s of [v.exceptions[0]!.status, v.journals[0]!.status]) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.icon.trim().length).toBeGreaterThan(0);
    }
  });
  it('a day with nothing posted has no totals — no figure that could pass for a booked day (P-08)', () => {
    const v = session({ dayBook: () => ({ ...READ, journals: [], accounts: [], covered: 0, exceptions: [], open: 0 }) }).view('en');
    expect(v.posted).toBe(false);
    expect(v.salesTotal).toBeNull();
    expect(v.returnsTotal).toBeNull();
    expect(v.journals).toEqual([]);
  });
});

describe('an unpermitted user is offered no posting, and a bad day is refused before any POST', () => {
  it('the view withholds mayPost without finance.journal.post, and the model refuses even if called', async () => {
    const noPerm = session({ mayPost: () => false });
    expect(noPerm.view('en').mayPost).toBe(false);
    expect(await noPerm.post('2026-09-28')).toEqual({ result: 'refused' });
    expect(await session().post('yesterday')).toEqual({ result: 'refused' });
    expect((await session().post('2026-09-28')).result).toBe('posted');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/day-book.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });
  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.dayBookSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });
  it('posts ONLY from an explicit click — session.post never runs at load (journals are append-only, hard rule #2)', () => {
    const callIdx = VIEW.indexOf('session.post(');
    expect(callIdx, 'session.post( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.post( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });
  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
  it('the shell loads the shared bundle, carries the data marker, and labels the toggle, the lists and the table', () => {
    const HTML = readFileSync('apps/web-erp/web/day-book.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="journals"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="exceptions"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="accounts"[^>]*aria-label=/);
    expect(HTML).toMatch(/<label for="day">/);
  });
});
