import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LP_INBOX_COPY, COPY_KEYS, createLpInboxSession,
  type LpInboxPorts, type LpWorklistData, type LpCaseView,
} from '../../apps/web-erp/src/loss-prevention-inbox-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The loss-prevention investigations inbox screen is usable, bilingual, and governed (M15-FR-04, API-05, §28).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: an OPEN case reads as ATTENTION; the only write is a
 * CLOSE that runs ONLY on an explicit click (never on load — hard rule #6, evidence kept); and the worklist
 * read stays a GET.
 */

const caseView = (over: Partial<LpCaseView> & Pick<LpCaseView, 'caseId'>): LpCaseView => ({
  subjectRef: 'SUBJ-till-3', assignedTo: 'u-mgr', summary: 'Till 3 came up short', valueMinor: 120000,
  raisedFromRef: 'shift-close:till-3', openedBy: 'system', openedAt: '2026-09-16T21:00:00Z', evidenceCount: 0, ...over,
});
const worklist: LpWorklistData = { openCount: 1, totalValueMinor: 120000, cases: [caseView({ caseId: 'C-1' })] };
const session = (ports: Partial<LpInboxPorts> = {}) =>
  createLpInboxSession({ userId: 'u-mgr' }, {
    worklist: () => worklist, mayRead: () => true, mayManage: () => true, closePort: () => ({ post: async () => 'closed' }), ...ports,
  });

describe('the loss-prevention inbox copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(LP_INBOX_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...LP_INBOX_COPY.en }, ta: { ...LP_INBOX_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('an open case reads as attention, never colour alone', () => {
  it('an open case is attention (degraded) with a word and an icon', () => {
    const view = session().view('en');
    const row = view.open[0]!;
    expect(row.needsAttention).toBe(true);
    expect(row.status.tone).toBe('degraded');
    expect(row.status.label.length).toBeGreaterThan(0);
    expect(row.status.icon.trim().length).toBeGreaterThan(0);
    expect(row.subjectRef).toBe('SUBJ-till-3'); // an opaque reference, never a name (P-04)
  });
});

describe('an unpermitted manager is offered no close action', () => {
  it('the view withholds mayManage without lp.case.manage, and the model refuses even if called', async () => {
    const noPerm = session({ mayManage: () => false });
    expect(noPerm.view('en').mayManage).toBe(false);
    expect(await noPerm.close('C-1', 'unfounded', 'a reason')).toBe('refused');
    // A close with no note, or an unknown outcome, is refused locally too (the server also refuses 400).
    expect(await session().close('C-1', 'unfounded', '   ')).toBe('refused');
    expect(await session().close('C-1', 'not-an-outcome', 'a reason')).toBe('refused');
    // A permitted manager with a known outcome and a note reaches the port (which records it).
    expect(await session().close('C-1', 'unfounded', 'reviewed the CCTV — nothing to it')).toBe('closed');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/loss-prevention.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt (the note is a text input, not a browser dialog)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.lossPreventionInboxSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('closes ONLY from an explicit click — session.close never runs at load (hard rule #6, evidence kept)', () => {
    const callIdx = VIEW.indexOf('session.close(');
    expect(callIdx, 'session.close( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.close( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    // The only write is the close POST — no other verb, and the worklist read stays a GET.
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/loss-prevention.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
