import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  B2B_PORTAL_COPY, COPY_KEYS, createB2BPortalSession,
  type B2BPortalData,
} from '../../apps/b2b-app/src/b2b-portal-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The business-customer portal (M22-FR-04 · API-09 · §35 · P-03 · P-04 · P-08) is a PUBLIC-ish surface a party
// outside the business uses, and it is READ-ONLY: a credit customer reads its OWN account, invoices, statement
// and documents and changes nothing. These are static checks on the shipped view + shell — that it reads from
// the tested session (never re-deciding), issues NO write verb, shows every state as a word+icon (never colour
// alone), says "your login cannot see this" instead of a zero, and is offered in both languages. They cannot
// prove the screen is good — a real customer does that — only that the deliberate decisions are still there.

const RAW = readFileSync('apps/b2b-app/web/app.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/b2b-app/web/index.html', 'utf8');

const full: B2BPortalData = {
  account: { customerId: 'c-1', hasCreditAccount: true, creditLimitMinor: 5_000_000, currency: 'INR', outstandingMinor: 1_250_000, availableCreditMinor: 3_750_000 },
  invoices: [{ invoiceId: 'i-1', number: 'INV-1', issuedOn: '2026-08-01', dueOn: '2026-08-15', grossMinor: 750_000, settledMinor: 0, outstandingMinor: 750_000, disputed: false }],
  statement: { customerId: 'c-1', asAt: '2026-09-29', ageing: { totalOutstandingMinor: 750_000, overdueMinor: 750_000, disputedMinor: 0, buckets: { not_due: 0, due_0_30: 0, due_31_60: 750_000, due_61_90: 0, due_90_plus: 0 }, detail: 'overdue' } },
  documents: [{ documentId: 'd-1', kind: 'tax_invoice', number: 'INV-1', grossMinor: 750_000 }],
  refusals: {}, asAt: '2026-09-29T10:00:00.000Z',
};
const session = (d: B2BPortalData, mayRead = true) => createB2BPortalSession({ userId: 'u-caterer' }, { portal: () => d, mayRead: () => mayRead });

describe('the B2B portal is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(B2B_PORTAL_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...B2B_PORTAL_COPY.en }, ta: { ...B2B_PORTAL_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('every state reads as a state, never colour alone', () => {
  it('an overdue invoice is an error with a non-blank icon and word; the statement and account carry a tone + icon + word too', () => {
    const v = session(full).view('en');
    expect(v.invoices[0]!.status.tone).toBe('error');
    for (const s of [v.invoices[0]!.status, v.statement!.status, v.account!.status]) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.icon.trim().length).toBeGreaterThan(0);
    }
  });
  it('a refused statement is a permission answer, NOT a balance of zero (P-08)', () => {
    const v = session({ ...full, statement: null, refusals: { statement: 'no_grant' } }).view('en');
    expect(v.statement).toBeNull();
    expect(v.feeds.statement).toBe('no_grant');
    expect(v.feedNotes.statement).toMatch(/cannot see the statement/);
    expect(v.invoices).toHaveLength(1); // the other feeds still show
  });
  it('a non-B2B login gets a not-permitted state and nothing else', () => {
    const v = session(full, false).view('en');
    expect(v.screenState.tone).toBe('error');
    expect(v.account).toBeNull();
    expect(v.invoices).toEqual([]);
    expect(v.statement).toBeNull();
    expect(v.documents).toEqual([]);
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.b2bPortalSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.b2bPortalSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });
  it('issues NO write verb — this screen is read-only (a customer orders and pays through separate routes)', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });
  it('never asks its questions with a browser dialog', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });
  it('labels each status for a screen reader and hides the decorative icon', () => {
    expect(VIEW).toMatch(/setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
});

describe('the shell is wired to the bundle and the injected login, and is accessible', () => {
  it('loads the app bundle and carries the login-data marker', () => {
    expect(HTML).toMatch(/b2b-app\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
  });
  it('labels the language toggle, the lists and the panels, and offers a skip link', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="invoices"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="documents"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="statement"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="account"[^>]*aria-label=/);
    expect(HTML).toMatch(/class="skip"/);
  });
});
