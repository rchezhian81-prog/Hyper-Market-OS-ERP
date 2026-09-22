import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRODUCTION_COPY, COPY_KEYS, createProductionSession,
  type ProductionPorts, type ProductionData, type ProductionRun, type ReleaseResult,
} from '../../apps/web-erp/src/production-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The production quality-release screen is usable, bilingual, and governed (M11-FR-03, API-04, §28, P-03/P-04/P-05/P-08).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: a production EXCEPTION reads as an ERROR; the only write
 * is a RELEASE (or hold) that runs ONLY on an explicit click (never on load — no AI releases food for sale); and
 * the board read stays a GET.
 */

const run = (over: Partial<ProductionRun> & Pick<ProductionRun, 'runId'>): ProductionRun => ({
  departmentId: 'bakery', outputProductId: 'p-loaf', outputBatchId: `B-${over.runId}`,
  outputQuantityMinor: 12000, outputUom: 'ea', expiresAt: '2026-09-28T00:00:00.000Z',
  outputUnitCostMinor: 25000, currency: 'INR', costKnown: true, uncostedProducts: [],
  yieldVerdict: 'as_expected', exceptions: [], ...over,
});
const board: ProductionData = { runs: [run({ runId: 'r-exc', exceptions: [{ kind: 'yield_variance', detail: 'made 8, planned 12' }] })] };
const session = (ports: Partial<ProductionPorts> = {}) =>
  createProductionSession({ userId: 'u-qc' }, {
    worklist: () => board, mayRead: () => true, mayRelease: () => true,
    releasePort: () => ({ post: async () => 'released' as ReleaseResult }), ...ports,
  });

describe('the production copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(PRODUCTION_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...PRODUCTION_COPY.en }, ta: { ...PRODUCTION_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('a production exception reads as attention, never colour alone', () => {
  it('an exception batch is an error tone with a word and an icon', () => {
    const view = session().view('en');
    const row = view.runs[0]!;
    expect(row.needsAttention).toBe(true);
    expect(row.status.tone).toBe('error');
    expect(row.status.label.length).toBeGreaterThan(0);
    expect(row.status.icon.trim().length).toBeGreaterThan(0);
    expect(row.severityWord).toBe(PRODUCTION_COPY.en.exceptionWord); // a word, not just a colour
    expect(row.exceptionDetails).toEqual(['made 8, planned 12']);
  });
});

describe('an unpermitted operator is offered no release action', () => {
  it('the view withholds mayRelease without production.release, and the model refuses even if called', async () => {
    const noPerm = session({ mayRelease: () => false });
    expect(noPerm.view('en').mayRelease).toBe(false);
    expect(await noPerm.release('r-exc', true)).toBe('refused');
    // A run the board does not hold is refused locally too.
    expect(await session().release('r-nope', true)).toBe('refused');
    // A permitted operator releasing a held batch reaches the port (which records it; the server re-checks expiry).
    expect(await session().release('r-exc', true)).toBe('released');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/production.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.productionSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('releases ONLY from an explicit click — session.release never runs at load (hard rule #5)', () => {
    const callIdx = VIEW.indexOf('session.release(');
    expect(callIdx, 'session.release( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.release( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    // The only write is the release POST — no other verb, and the board read stays a GET.
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/production.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
