import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ROSTERING_COPY, COPY_KEYS, createRosteringSession,
  type RosteringPorts, type RosteringData, type AssignResult,
} from '../../apps/web-erp/src/rostering-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { Employee, ShiftRequirement, ShiftAssignment, RosterGap } from '../../packages/workforce/src/workforce';

/**
 * **The manager rostering screen is usable, bilingual, and governed (M25-FR-01, API-11, §28, P-03/P-04/P-08).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: a roster GAP reads as ATTENTION; the only write is an
 * ASSIGN that runs ONLY on an explicit click (never on load — no AI writes a roster, hard rule #5); and the
 * worklist read stays a GET.
 */

const emp = (over: Partial<Employee> & Pick<Employee, 'employeeId'>): Employee => ({
  name: 'Staff', branchId: 'br-1', roles: ['cashier'], active: true, ...over,
});
const gap = (over: Partial<RosterGap> & Pick<RosterGap, 'shiftId' | 'role'>): RosterGap => ({
  startsAt: '2026-09-27T06:00:00.000Z', needed: 1, assigned: 0, short: 1,
  detail: '2026-09-27 06:00 has NOBODY rostered as cashier', ...over,
});
const worklist: RosteringData = {
  gaps: [gap({ shiftId: 'S-1', role: 'cashier' })],
  employees: [emp({ employeeId: 'e-asha', name: 'Asha', roles: ['cashier'] })],
  shifts: [] as readonly ShiftRequirement[],
  assignments: [] as readonly ShiftAssignment[],
};
const session = (ports: Partial<RosteringPorts> = {}) =>
  createRosteringSession({ userId: 'u-manager' }, {
    worklist: () => worklist, mayRead: () => true, mayManage: () => true,
    assignPort: () => ({ post: async () => 'assigned' as AssignResult }), ...ports,
  });

describe('the rostering copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(ROSTERING_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...ROSTERING_COPY.en }, ta: { ...ROSTERING_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('a roster gap reads as attention, never colour alone', () => {
  it('an unstaffed role is attention (error) with a word and an icon', () => {
    const view = session().view('en');
    const row = view.gaps[0]!;
    expect(row.needsAttention).toBe(true);
    expect(row.status.tone).toBe('error');
    expect(row.status.label.length).toBeGreaterThan(0);
    expect(row.status.icon.trim().length).toBeGreaterThan(0);
    expect(row.severityWord).toBe(ROSTERING_COPY.en.nobodyWord); // a word, not just a colour
    expect(row.eligible.map((e) => e.label)).toEqual(['Asha']);
  });
});

describe('an unpermitted manager is offered no assign action', () => {
  it('the view withholds mayManage without workforce.roster.manage, and the model refuses even if called', async () => {
    const noPerm = session({ mayManage: () => false });
    expect(noPerm.view('en').mayManage).toBe(false);
    expect(await noPerm.assign('S-1', 'e-asha', 'cashier')).toBe('refused');
    // An ineligible person, or a shift/role that is not actually short, is refused locally too (server also 400s).
    expect(await session().assign('S-1', 'e-nobody', 'cashier')).toBe('refused');
    expect(await session().assign('S-9', 'e-asha', 'cashier')).toBe('refused');
    // A permitted manager assigning an eligible person reaches the port (which records it).
    expect(await session().assign('S-1', 'e-asha', 'cashier')).toBe('assigned');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/rostering.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.rosteringSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('assigns ONLY from an explicit click — session.assign never runs at load (hard rule #5)', () => {
    const callIdx = VIEW.indexOf('session.assign(');
    expect(callIdx, 'session.assign( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.assign( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    // The only write is the assign POST — no other verb, and the worklist read stays a GET.
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/rostering.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
