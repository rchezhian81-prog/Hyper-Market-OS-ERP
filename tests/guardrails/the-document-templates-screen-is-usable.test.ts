import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DOCUMENT_TEMPLATES_COPY, COPY_KEYS, createDocumentTemplatesSession,
  type DocumentTemplatePorts, type TemplateRegisterData, type TemplateKindData, type TemplateVersionView,
} from '../../apps/web-erp/src/document-templates-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The document-templates screen is usable, bilingual, and governed (M01-FR-02, API-01, §28, P-08).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules every
 * screen carries — no browser dialogs, defers to the tested session, colour is never the only signal — and pins
 * the things THIS screen exists to guarantee: a kind with NOTHING in force reads as a warning (documents print
 * with defaults, P-08); the maker of a draft is offered NO approve button and is told why (§28); publish is offered
 * only on an approved version; the three writes run ONLY on an explicit click (never on load — a template version
 * is append-only, hard rule #2), and are POSTs.
 */

const V = (over: Partial<TemplateVersionView> = {}): TemplateVersionView => ({
  kind: 'receipt', version: 1, state: 'draft', content: { header: ['SRE Hyper Market'], footer: ['Thanks'], language: 'en' },
  authoredBy: 'u-owner', authoredAt: '2026-09-28T09:00:00.000Z', ...over,
});
const REGISTER: TemplateRegisterData = { kinds: [{ kind: 'receipt', current: null, versions: 2 }, { kind: 'invoice', current: V({ kind: 'invoice', state: 'published' }), versions: 1 }], asAt: '2026-09-29T09:00:00.000Z' };
const KIND: TemplateKindData = { kind: 'receipt', current: null, versions: [V({ version: 1, state: 'draft' }), V({ version: 2, state: 'approved', authoredBy: 'u-padmin', approvedBy: 'u-owner' })], asAt: '2026-09-29T09:00:00.000Z' };
const session = (userId = 'u-owner', ports: Partial<DocumentTemplatePorts> = {}) =>
  createDocumentTemplatesSession({ userId }, {
    register: () => REGISTER, kind: () => KIND, mayRead: () => true, mayWrite: () => true,
    actPort: () => ({ draft: async () => ({ result: 'drafted', version: V({ version: 3 }) }), approve: async () => ({ result: 'approved', version: V({ state: 'approved' }) }), publish: async () => ({ result: 'published', version: V({ version: 2, state: 'published' }) }) }),
    ...ports,
  });

describe('the document-templates copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(DOCUMENT_TEMPLATES_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...DOCUMENT_TEMPLATES_COPY.en }, ta: { ...DOCUMENT_TEMPLATES_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('nothing in force is a warning, never a blank; every state carries a word and an icon', () => {
  it('a kind with no published version → degraded with words; one in force → ok', () => {
    const v = session().view('en');
    expect(v.kinds[0]!.status.tone).toBe('degraded');
    expect(v.kinds[0]!.status.label).toContain('defaults');
    expect(v.kinds[1]!.status.tone).toBe('ok');
    for (const s of [...v.kinds.map((k) => k.status), ...v.versions.map((x) => x.status)]) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.icon.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the §28 split and the state rules are on the surface, not only on the server', () => {
  it('the maker is offered no approve and is told why; a second person is; publish only on an approved version', async () => {
    const maker = session('u-owner').view('en');
    const draft = maker.versions.find((x) => x.version === 1)!;
    expect(draft.mayApprove).toBe(false);
    expect(draft.approveWithheldWhy).toBeTruthy();
    expect(session('u-padmin').view('en').versions.find((x) => x.version === 1)!.mayApprove).toBe(true);
    expect(maker.versions.map((x) => [x.version, x.mayPublish])).toEqual([[2, true], [1, false]]);
    expect(await session('u-owner').approve('receipt', 1)).toEqual({ result: 'maker_cannot_approve' });
    expect(await session('u-owner').publish('receipt', 1)).toEqual({ result: 'state_conflict', code: 'not_approved' });
  });
  it('without platform.setup.write nothing is offered and every act is refused locally; a bad GSTIN never leaves the screen', async () => {
    const reader = session('u-mgr', { mayWrite: () => false });
    expect(reader.view('en').mayWrite).toBe(false);
    expect((await reader.draft('receipt', { header: 'SRE', footer: 'x', terms: '', language: 'en', paperFormat: '', note: '' })).result).toBe('refused');
    const bad = await session().draft('receipt', { header: 'SRE Hyper Market\nGSTIN: 12', footer: 'x', terms: '', language: 'en', paperFormat: '', note: '' });
    expect(bad.result).toBe('content_invalid');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/document-templates.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });
  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.documentTemplatesSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });
  it('drafts, approves and publishes ONLY from explicit clicks — none runs at load (versions are append-only, hard rule #2)', () => {
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    for (const call of ['session.draft(', 'session.approve(', 'session.publish(']) {
      const idx = VIEW.indexOf(call);
      expect(idx, `${call} is not present`).toBeGreaterThan(-1);
      expect(idx, `${call} runs before/outside a click handler (would write on load)`).toBeGreaterThan(clickIdx);
    }
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });
  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
  it('the shell loads the shared bundle, carries the data marker, and labels the toggle, the lists and the form', () => {
    const HTML = readFileSync('apps/web-erp/web/document-templates.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="kinds"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="versions"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="draft-form"[^>]*aria-label=/);
    expect(HTML).toMatch(/<label for="kind">/);
    expect(HTML).toMatch(/<label for="header">/);
  });
});
