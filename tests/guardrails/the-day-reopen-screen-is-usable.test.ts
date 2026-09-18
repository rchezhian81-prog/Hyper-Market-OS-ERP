import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DAY_REOPEN_COPY, COPY_KEYS, createDayReopenSession,
  type DayReopenPorts, type DayReopenData, type LockedDayView,
} from '../../apps/web-erp/src/day-reopen-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The day-reopen screen is usable, bilingual, and governed (M14-FR-04, API-05, §28).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: the only write is a REOPEN that runs ONLY on an explicit
 * click (never on load); a reopen needs a reason and a NAMED approver; the reopener may NEVER name themselves as
 * the approver (§28); and the screen itself issues no write verbs — the audited POST to the box lives in the
 * injected port.
 */

const day = (over: Partial<LockedDayView> & Pick<LockedDayView, 'dayCloseId'>): LockedDayView => ({
  tradingDay: '2026-09-17', closedBy: 'manager', closedAt: '2026-09-18T02:05:00.000Z', ...over,
});
const worklist: DayReopenData = { lockedCount: 1, locked: [day({ dayCloseId: 'dc-1' })] };
const session = (ports: Partial<DayReopenPorts> = {}, userId: string | null = 'u-owner') =>
  createDayReopenSession({ userId }, {
    worklist: () => worklist, mayRead: () => true, mayReopen: () => true, reopenPort: () => ({ post: async () => 'reopened' }), ...ports,
  });

describe('the day-reopen copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(DAY_REOPEN_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...DAY_REOPEN_COPY.en }, ta: { ...DAY_REOPEN_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('a locked day reads as a settled state, never colour alone', () => {
  it('a locked row carries a word and an icon and is not flagged as attention', () => {
    const view = session().view('en');
    const r = view.locked[0]!;
    expect(r.status.tone).toBe('ok');
    expect(r.status.label.length).toBeGreaterThan(0);
    expect(r.status.icon.trim().length).toBeGreaterThan(0);
  });
});

describe('the reopen is governed — permission, a reason, a named DIFFERENT approver (§28)', () => {
  it('withholds mayReopen without permission and refuses locally', async () => {
    const noPerm = session({ mayReopen: () => false });
    expect(noPerm.view('en').mayReopen).toBe(false);
    expect(await noPerm.reopen('dc-1', 'a reason', 'u-acct')).toBe('refused');
  });

  it('needs a reason and a named approver before any POST', async () => {
    expect(await session().reopen('dc-1', '   ', 'u-acct')).toBe('reason_required');
    expect(await session().reopen('dc-1', 'a reason', '  ')).toBe('approver_required');
  });

  it('§28: the reopener cannot name themselves as the approver', async () => {
    // The logged-in reopener is u-owner; naming u-owner as the approver is a self-approval, refused locally.
    expect(await session({}, 'u-owner').reopen('dc-1', 'wrong float', 'u-owner')).toBe('refused_self_approval');
  });

  it('a day not on the worklist is refused, and a well-formed reopen reaches the port', async () => {
    expect(await session().reopen('dc-nope', 'a reason', 'u-acct')).toBe('refused');
    // Permitted, a reason, a DIFFERENT named approver, a known day → reaches the port (which records it).
    expect(await session().reopen('dc-1', 'wrong float found next morning', 'u-acct')).toBe('reopened');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/day-reopen.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt (the reason/approver are text inputs, not browser dialogs)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.dayReopenSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('reopens ONLY from an explicit click — session.reopen never runs at load', () => {
    const callIdx = VIEW.indexOf('session.reopen(');
    expect(callIdx, 'session.reopen( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.reopen( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    // The screen issues no write verbs itself — the audited POST to the box lives in the injected port.
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/day-reopen.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
