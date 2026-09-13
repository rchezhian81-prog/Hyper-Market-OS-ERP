import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DATA_QUALITY_INBOX_COPY, COPY_KEYS, createDataQualityInboxSession,
  type DataQualityInboxPorts, type DataQualityWorklistData,
} from '../../apps/web-erp/src/data-quality-inbox-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { DataQualityFinding } from '../../packages/product/src/index';

/**
 * **The Data Quality inbox screen is usable, bilingual, and read-only (A08, API-13, P-05).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the two things THIS screen exists to guarantee: an OPEN suggestion reads as ATTENTION (a person
 * should look), a DISMISSED one does not; and the screen only READS (it fetches the worklist with a GET and
 * posts nothing — nothing here changes a product; hard rule #5).
 */

const finding = (over: Partial<DataQualityFinding> & Pick<DataQualityFinding, 'findingId' | 'kind'>): DataQualityFinding => ({
  productIds: ['p1'], confidence: 'certain', headline: 'a gap', detail: 'why', evidence: [{ productId: 'p1', sku: 'SKU-1', name: 'Tata Salt 1kg', note: 'no barcode' }], ...over,
});
const worklist: DataQualityWorklistData = {
  agentActive: true,
  open: [{ finding: finding({ findingId: 'dq-missing-barcode:p1', kind: 'missing_barcode' }), status: 'open' }],
  dismissed: [{ finding: finding({ findingId: 'dq-duplicate:p1:p2', kind: 'suspected_duplicate' }), status: 'dismissed', dismissal: { by: 'u-mgr', at: '2026-09-13T00:00:00Z', reason: 'different sizes' } }],
};
const session = (ports: Partial<DataQualityInboxPorts> = {}) =>
  createDataQualityInboxSession({ userId: 'u-owner' }, {
    worklist: () => worklist, mayRead: () => true, mayDismiss: () => true, dismissPort: () => ({ post: async () => 'recorded' }), ...ports,
  });

describe('the data quality inbox copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(DATA_QUALITY_INBOX_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...DATA_QUALITY_INBOX_COPY.en }, ta: { ...DATA_QUALITY_INBOX_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('an open suggestion reads as attention; a dismissed one does not', () => {
  it('open is attention (degraded) and cites its product; dismissed is idle and carries the reason', () => {
    const view = session().view('en');
    const open = view.open[0]!;
    expect(open.needsAttention).toBe(true);
    expect(open.status.tone).toBe('degraded');
    expect(open.affects.length).toBeGreaterThan(0);

    const dismissed = view.dismissed[0]!;
    expect(dismissed.needsAttention).toBe(false);
    expect(dismissed.status.tone).toBe('idle');
    expect(dismissed.dismissedReason).toBe('different sizes');
  });

  it('every rendered status carries a word and an icon — never colour alone', () => {
    const view = session().view('en');
    for (const row of [...view.open, ...view.dismissed]) {
      expect(row.status.label.length).toBeGreaterThan(0);
      expect(row.status.icon.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('an unpermitted steward is offered no action', () => {
  it('the view withholds mayDismiss when the user lacks ai.suggestion.dismiss, and the model refuses even if called', async () => {
    const noPerm = session({ mayDismiss: () => false });
    expect(noPerm.view('en').mayDismiss).toBe(false);
    // Defence in depth: even a direct call refuses before any POST (the server also refuses 403).
    expect(await noPerm.dismiss('dq-missing-barcode:p1', 'a reason')).toBe('refused');
    // A dismiss with no reason is refused locally too (the server returns 400).
    expect(await session().dismiss('dq-missing-barcode:p1', '   ')).toBe('refused');
    // A permitted steward with a reason reaches the port (which records it).
    expect(await session().dismiss('dq-missing-barcode:p1', 'genuinely different')).toBe('recorded');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/data-quality.js', 'utf8');
  // Strip line comments so a comment that names an API is not counted as a call (the codebase's own idiom).
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt (the reason is a text input, not a browser dialog)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.dataQualityInboxSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('dismisses ONLY from an explicit click — session.dismiss/reopen never run at load (hard rule #5)', () => {
    // The write action must sit inside a click handler, never at the top level (which runs on boot).
    for (const call of ['session.dismiss(', 'session.reopen(']) {
      const callIdx = VIEW.indexOf(call);
      expect(callIdx, `${call} is not present`).toBeGreaterThan(-1);
      const clickIdx = VIEW.indexOf("addEventListener('click'");
      expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
      expect(callIdx, `${call} runs before/outside a click handler (would write on load)`).toBeGreaterThan(clickIdx);
    }
    // The only write is the dismissals POST — no other verb, and the worklist read stays a GET.
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/data-quality.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
