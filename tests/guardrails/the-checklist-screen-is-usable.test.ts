import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CHECKLIST_COPY, COPY_KEYS, createChecklistSession,
  type ChecklistPorts, type ChecklistData, type StoredChecklist, type SubmitResult,
} from '../../apps/web-erp/src/checklist-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { ChecklistItem } from '../../packages/workforce/src/workforce';

/**
 * **The manager checklist screen is usable, bilingual, and governed (M25-FR-02, API-11, §28, P-03/P-04/P-05/P-08).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: a BLOCKING item still outstanding reads as an ERROR;
 * the only write is a SIGN that runs ONLY on an explicit click (never on load — no AI signs a checklist); and
 * the worklist read stays a GET.
 */

const item = (over: Partial<ChecklistItem> & Pick<ChecklistItem, 'itemId'>): ChecklistItem => ({
  description: `do ${over.itemId}`, done: false, blocking: false, ...over,
});
const list = (over: Partial<StoredChecklist> & Pick<StoredChecklist, 'checklistId'>): StoredChecklist => ({
  kind: 'closing', items: [item({ itemId: 'safe', description: 'lock the safe', done: false, blocking: true }), item({ itemId: 'lights', done: true })], ...over,
});
const worklist: ChecklistData = { checklists: [list({ checklistId: 'C-close' })] };
const session = (ports: Partial<ChecklistPorts> = {}) =>
  createChecklistSession({ userId: 'u-manager' }, {
    worklist: () => worklist, mayRead: () => true, mayManage: () => true,
    submitPort: () => ({ post: async () => 'recorded' as SubmitResult }), ...ports,
  });

describe('the checklist copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(CHECKLIST_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...CHECKLIST_COPY.en }, ta: { ...CHECKLIST_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('a blocking item reads as attention, never colour alone', () => {
  it('a blocked checklist is an error tone with a word and an icon', () => {
    const view = session().view('en');
    const row = view.checklists[0]!;
    expect(row.needsAttention).toBe(true);
    expect(row.status.tone).toBe('error');
    expect(row.status.label.length).toBeGreaterThan(0);
    expect(row.status.icon.trim().length).toBeGreaterThan(0);
    expect(row.severityWord).toBe(CHECKLIST_COPY.en.blockedWord); // a word, not just a colour
    expect(row.outstanding.find((i) => i.itemId === 'safe')!.blocking).toBe(true);
  });
});

describe('an unpermitted manager is offered no sign action', () => {
  it('the view withholds mayManage without workforce.roster.manage, and the model refuses even if called', async () => {
    const noPerm = session({ mayManage: () => false });
    expect(noPerm.view('en').mayManage).toBe(false);
    expect(await noPerm.submit('C-close', ['safe'], true)).toBe('refused');
    // A checklist the box does not hold is refused locally too (the server also refuses).
    expect(await session().submit('C-nope', ['safe'], true)).toBe('refused');
    // A permitted manager signing a held checklist reaches the port (which records it; the server re-checks blocking).
    expect(await session().submit('C-close', ['safe'], true)).toBe('recorded');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/checklist.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.checklistSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('signs ONLY from an explicit click — session.submit never runs at load (hard rule #5)', () => {
    const callIdx = VIEW.indexOf('session.submit(');
    expect(callIdx, 'session.submit( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.submit( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    // The only write is the sign POST — no other verb, and the worklist read stays a GET.
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/checklist.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
