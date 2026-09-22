import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FACILITIES_COPY, COPY_KEYS, createFacilitiesSession,
  type FacilitiesPorts, type FacilitiesData, type OverdueTask, type CompleteResult,
} from '../../apps/web-erp/src/facilities-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The facilities maintenance & compliance screen is usable, bilingual, and governed (M26-FR-03, API-11, §28, P-03/P-04/P-05/P-08).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: a COMPLIANCE RISK reads as an ERROR; the only write is a
 * MARK-DONE that runs ONLY on an explicit click (never on load); and the board read stays a GET.
 */

const task = (over: Partial<OverdueTask> & Pick<OverdueTask, 'taskId'>): OverdueTask => ({
  scheduleId: `s-${over.taskId}`, title: `Check ${over.taskId}`, category: 'cleaning',
  dueOn: '2026-09-20', daysOverdue: 2, level: 'overdue', complianceLinked: false,
  detail: `"Check ${over.taskId}" is 2 day(s) late`, ...over,
});
const board: FacilitiesData = { overdue: [task({ taskId: 't-fire', level: 'compliance_risk', category: 'fire_safety', complianceLinked: true, daysOverdue: 9, escalateTo: 'owner', detail: '"Fire check" is 9 day(s) overdue and a regulator would care — escalated to owner' })] };
const session = (ports: Partial<FacilitiesPorts> = {}) =>
  createFacilitiesSession({ userId: 'u-fm' }, {
    worklist: () => board, mayRead: () => true, mayComplete: () => true,
    completePort: () => ({ post: async () => 'completed' as CompleteResult }), ...ports,
  });

describe('the facilities copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(FACILITIES_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...FACILITIES_COPY.en }, ta: { ...FACILITIES_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('a compliance risk reads as attention, never colour alone', () => {
  it('a compliance-linked overdue check is an error tone with a word and an icon', () => {
    const view = session().view('en');
    const row = view.tasks[0]!;
    expect(row.needsAttention).toBe(true);
    expect(row.status.tone).toBe('error');
    expect(row.status.label.length).toBeGreaterThan(0);
    expect(row.status.icon.trim().length).toBeGreaterThan(0);
    expect(row.severityWord).toBe(FACILITIES_COPY.en.complianceWord); // a word, not just a colour
    expect(view.complianceRiskCount).toBe(1);
  });
});

describe('an unpermitted operator is offered no mark-done action', () => {
  it('the view withholds mayComplete without the record permission, and the model refuses even if called', async () => {
    const noPerm = session({ mayComplete: () => false });
    expect(noPerm.view('en').mayComplete).toBe(false);
    expect(await noPerm.complete('t-fire')).toBe('refused');
    // A task the board does not hold is refused locally too.
    expect(await session().complete('t-nope')).toBe('refused');
    // A permitted operator marking a held task done reaches the port (which records it; the server re-checks evidence/§28).
    expect(await session().complete('t-fire', { evidenceRef: 'photo-1', verifiedBy: 'u-two' })).toBe('completed');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/facilities.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.facilitiesSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('completes ONLY from an explicit click — session.complete never runs at load (P-05)', () => {
    const callIdx = VIEW.indexOf('session.complete(');
    expect(callIdx, 'session.complete( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.complete( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    // The only write is the complete POST — no other verb, and the board read stays a GET.
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/facilities.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
