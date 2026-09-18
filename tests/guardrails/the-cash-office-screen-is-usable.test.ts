import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CASH_OFFICE_COPY, COPY_KEYS, createCashOfficeSession,
  type CashOfficePorts, type CashOverShortData, type OverShortView,
} from '../../apps/web-erp/src/cash-office-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The cash-office over/short sign-off screen is usable, bilingual, and governed (M14-FR-02, API-05, §28).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: an OPEN over/short reads as ATTENTION; the only write is
 * a SIGN-OFF that runs ONLY on an explicit click (never on load); a reviewer may never sign off their OWN drawer
 * (§28); and the screen itself issues no write verbs — the audited POST lives in the injected port.
 */

const row = (over: Partial<OverShortView> & Pick<OverShortView, 'shiftId'>): OverShortView => ({
  tillId: 'till-3', cashierId: 'u-cashier', tradingDay: '2026-09-17', varianceMinor: -120000, reasonCode: 'gave_wrong_change', ...over,
});
const worklist: CashOverShortData = { openCount: 1, totalVarianceMinor: -120000, open: [row({ shiftId: 'S-1' })] };
const session = (ports: Partial<CashOfficePorts> = {}, userId: string | null = 'u-cashoffice') =>
  createCashOfficeSession({ userId }, {
    worklist: () => worklist, mayRead: () => true, mayReview: () => true, signOffPort: () => ({ post: async () => 'signed' }), ...ports,
  });

describe('the cash-office copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(CASH_OFFICE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...CASH_OFFICE_COPY.en }, ta: { ...CASH_OFFICE_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('an open over/short reads as attention, never colour alone', () => {
  it('an open row is attention (degraded) with a word and an icon, and a direction', () => {
    const view = session().view('en');
    const r = view.open[0]!;
    expect(r.needsAttention).toBe(true);
    expect(r.status.tone).toBe('degraded');
    expect(r.status.label.length).toBeGreaterThan(0);
    expect(r.status.icon.trim().length).toBeGreaterThan(0);
    expect(r.direction).toBe('Short'); // varianceMinor < 0 — a word, not a colour
  });
});

describe('an unpermitted or own-drawer reviewer is offered no sign-off, and the model refuses', () => {
  it('withholds mayReview without permission, and refuses locally without a finding or on the reviewer’s own drawer', async () => {
    const noPerm = session({ mayReview: () => false });
    expect(noPerm.view('en').mayReview).toBe(false);
    expect(await noPerm.signOff('S-1', 'miscount', 'a note')).toBe('refused');
    // An unknown finding is refused locally too (the server also refuses 400).
    expect(await session().signOff('S-1', 'not-a-finding', 'a note')).toBe('refused');
    // §28: a reviewer who counted the drawer cannot sign it off (the cashier is u-me here).
    const ownDrawer = createCashOfficeSession({ userId: 'u-me' }, {
      worklist: () => ({ openCount: 1, totalVarianceMinor: -120000, open: [row({ shiftId: 'S-1', cashierId: 'u-me' })] }),
      mayRead: () => true, mayReview: () => true, signOffPort: () => ({ post: async () => 'signed' }),
    });
    expect(await ownDrawer.signOff('S-1', 'miscount', 'I counted it')).toBe('refused');
    // A permitted reviewer, a known finding, someone else's drawer → reaches the port (which records it).
    expect(await session().signOff('S-1', 'miscount', 'reviewed the till roll')).toBe('signed');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/cash-office.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt (the note is a text input, not a browser dialog)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.cashOfficeSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('signs off ONLY from an explicit click — session.signOff never runs at load', () => {
    const callIdx = VIEW.indexOf('session.signOff(');
    expect(callIdx, 'session.signOff( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.signOff( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    // The screen issues no write verbs itself — the audited POST lives in the injected port (browser-entry).
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/cash-office.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
