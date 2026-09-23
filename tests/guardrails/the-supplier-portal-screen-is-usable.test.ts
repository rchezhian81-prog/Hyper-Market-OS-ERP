import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SUPPLIER_PORTAL_COPY, COPY_KEYS, createSupplierPortalSession,
  type SupplierPortalData,
} from '../../apps/supplier-app/src/supplier-portal-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The supplier portal (M24-FR-01 · API-03 · §35 · P-03 · P-04) is the one PUBLIC-ish surface a party outside the
// business uses, and it is READ-ONLY: a supplier reads its OWN submissions and statement and changes nothing.
// These are static checks on the shipped view + shell — that it reads from the tested session (never
// re-deciding), issues NO write verb, shows every state as a word+icon (never colour alone), and is offered in
// both languages. They cannot prove the screen is good — a real supplier does that — only that the deliberate
// decisions are still there.

const RAW = readFileSync('apps/supplier-app/web/app.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/supplier-app/web/index.html', 'utf8');

const withAwaiting: SupplierPortalData = {
  submissions: [{ submissionId: 'sub-1', kind: 'invoice', requiresReview: true, receivedAt: '2026-09-21T09:00:00Z' }],
  statement: { partnerId: 'p-1', accessible: true, openingMinor: 0, invoicedMinor: 500000, debitedMinor: 0, creditedMinor: 0, paidMinor: 200000, closingMinor: 300000, disputedMinor: 0, reconciles: true, detail: '300000 outstanding' },
  asAt: '2026-09-22T10:00:00Z',
};
const session = (data: SupplierPortalData, mayRead = true) =>
  createSupplierPortalSession({ userId: 'u-supplier' }, { portal: () => data, mayRead: () => mayRead });

describe('the supplier portal is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(SUPPLIER_PORTAL_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...SUPPLIER_PORTAL_COPY.en }, ta: { ...SUPPLIER_PORTAL_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('every state reads as a state, never colour alone', () => {
  it('an awaiting submission carries a tone AND a non-blank icon AND a non-blank word', () => {
    const s = session(withAwaiting).view('en').awaiting[0]!;
    expect(s.status.tone).toBe('degraded');           // waiting on the buyer, never a false "accepted"
    expect(s.status.needsAttention).toBe(true);
    expect(s.status.label.length).toBeGreaterThan(0);
    expect(s.status.icon.trim().length).toBeGreaterThan(0);
  });

  it('a non-supplier login gets a not-permitted state and nothing else', () => {
    const view = session(withAwaiting, false).view('en');
    expect(view.awaiting).toEqual([]);
    expect(view.processed).toEqual([]);
    expect(view.statement).toBeNull();
    expect(view.screenState.tone).toBe('error');
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.supplierPortalSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.supplierPortalSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('issues NO write verb — this screen is read-only (a supplier submits through separate routes)', () => {
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
    expect(HTML).toMatch(/supplier-app\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
  });

  it('labels the language toggle and the submission lists, and offers a skip link', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="awaiting"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="processed"[^>]*aria-label=/);
    expect(HTML).toMatch(/class="skip"/);
  });
});
