import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  RISK_ACCEPTANCE_COPY, COPY_KEYS, createRiskAcceptanceSession,
  type RiskAcceptancePorts, type BlockedGatesData, type GateBlockView,
} from '../../apps/web-erp/src/risk-acceptance-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The risk-acceptance / compliance-gates screen is usable, bilingual, and governed (M34-FR-04, API-11, §28).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: a blocked gate reads as ATTENTION; the only write is an
 * ACCEPT that runs ONLY on an explicit click (never on load) and needs a rationale; and the screen itself issues
 * no write verbs — the audited POST lives in the injected port.
 */

const block = (over: Partial<GateBlockView> & Pick<GateBlockView, 'gate' | 'riskId'>): GateBlockView => ({
  title: 'Unencrypted backups', severity: 'critical', ownerUserId: 'u-seclead', reason: 'open critical risk on this gate', ...over,
});
const worklist: BlockedGatesData = { count: 1, blocked: [block({ gate: 'QG-04', riskId: 'RISK-1' })] };
const session = (ports: Partial<RiskAcceptancePorts> = {}) =>
  createRiskAcceptanceSession({ userId: 'u-seclead' }, {
    worklist: () => worklist, mayRead: () => true, mayManage: () => true, acceptPort: () => ({ post: async () => 'accepted' }), ...ports,
  });

describe('the risk-acceptance copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(RISK_ACCEPTANCE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...RISK_ACCEPTANCE_COPY.en }, ta: { ...RISK_ACCEPTANCE_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('a blocked gate reads as attention, never colour alone', () => {
  it('a blocked gate is attention (degraded) with a word and an icon, and a severity word', () => {
    const view = session().view('en');
    const r = view.blocked[0]!;
    expect(r.needsAttention).toBe(true);
    expect(r.status.tone).toBe('degraded');
    expect(r.status.label.length).toBeGreaterThan(0);
    expect(r.status.icon.trim().length).toBeGreaterThan(0);
    expect(r.severity).toBe('Critical'); // a word, not a colour
  });
});

describe('an unpermitted user is offered no accept action, and the model refuses', () => {
  it('withholds mayManage without compliance.risk.manage, and refuses locally without a rationale', async () => {
    const noPerm = session({ mayManage: () => false });
    expect(noPerm.view('en').mayManage).toBe(false);
    expect(await noPerm.accept('RISK-1', 'we will carry it')).toBe('refused');
    // An empty rationale, or an empty risk id, is refused locally too (the server also refuses 400).
    expect(await session().accept('RISK-1', '   ')).toBe('refused');
    expect(await session().accept('   ', 'a reason')).toBe('refused');
    // A permitted user with a risk and a rationale reaches the port (which records it).
    expect(await session().accept('RISK-1', 'compensating control in place; owner signed off')).toBe('accepted');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/risk-acceptance.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt (the rationale is a text input, not a browser dialog)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.riskAcceptanceSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('accepts ONLY from an explicit click — session.accept never runs at load', () => {
    const callIdx = VIEW.indexOf('session.accept(');
    expect(callIdx, 'session.accept( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.accept( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
    // The screen issues no write verbs itself — the audited POST lives in the injected port (browser-entry).
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/risk-acceptance.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
