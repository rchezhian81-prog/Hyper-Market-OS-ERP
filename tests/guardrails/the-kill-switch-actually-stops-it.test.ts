import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PULL_REFUSAL_KINDS, DECIDE_REFUSAL_KINDS } from '../../apps/web-erp/src/ai-session';
import {
  callModel, FORBIDDEN_TOOLS, grantTools, AGENTS,
  type AgentId, type ModelRequest, type ModelTransport,
} from '../../packages/ai/src/index';

/**
 * **The kill switch, guarded — and the emergency control that stopped nothing.**
 *
 * `killSwitchState` decides which agents are stopped. `admitCall` refuses a call that is killed,
 * over budget, or from a switched-off agent. Both were written the day the module was created and
 * both were tested that day — and **`callModel`, the one place every model call in this product
 * passes through, consulted neither.**
 *
 * So pulling the kill switch stopped nothing. The switch existed, the state was computed, the
 * screen would have drawn it in red, and the gateway carried on calling the provider.
 *
 * Six things must stay true, and each of them is a way that could come back:
 *
 *   1. **an admission decision is REQUIRED, and its absence refuses** — an emergency control that
 *      depends on every caller remembering to consult it is not an emergency control;
 *   2. **the refusal happens before the transport is touched**, so a stopped agent costs nothing
 *      and cannot return a proposal;
 *   3. **no agent may ever be granted a forbidden tool**, whatever anybody configures;
 *   4. **nothing on this screen commits under a name nobody holds**, and the agent is recorded as
 *      the drafter while the person is the actor (P-05, hard rule #5);
 *   5. **absent is not nought** — no ceiling, no metered spend, no evaluation and no platform
 *      ceiling each read as never set rather than as a comfortable zero;
 *   6. **one number, one source** — what an agent has spent comes from the metered calls filtered
 *      to the period, and from nowhere else. A real box found the alternative: a carried per-agent
 *      map with no period on it read 95,000 spent on the assistants tab while the cost tab beside
 *      it read nought, and it was the figure deciding whether the agent could spend again.
 */

const GATEWAY = readFileSync('packages/ai/src/gateway.ts', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/ai-session.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/ai.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/ai.html', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');

const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const expectWordsFor = (vocabulary: readonly string[], mapName: string): void => {
  const from = code(VIEW).indexOf(`const ${mapName}`);
  expect(from, `${mapName} is missing from the view`).toBeGreaterThan(-1);
  const words = code(VIEW).slice(from);
  expect(vocabulary.length, `${mapName} guards nothing`).toBeGreaterThan(1);
  for (const member of vocabulary) {
    const at = words.indexOf(`${member}: {`);
    expect(at, `"${member}" has no words in ${mapName}`).toBeGreaterThan(-1);
    const entry = words.slice(at, words.indexOf('\n  },', at));
    expect(entry, `"${member}" has no English`).toMatch(/\ben:/);
    expect(entry, `"${member}" has no Tamil`).toMatch(/\bta:/);
  }
};

const request = (): ModelRequest => ({
  requestId: 'R-1',
  context: {
    tenantId: 't1', agentId: 'A02', requestedBy: 'u-buyer',
    correlationId: 'c-1', at: '2026-08-06T14:00:00.000Z',
  },
  instruction: 'What should we reorder?',
  evidence: [],
  offeredTools: ['draft_purchase_order'],
  maxOutputTokens: 400,
  timeoutMs: 4_000,
  tier: 'standard',
});

// ── 1 & 2. The switch reaches the one place every call goes through ─────────

describe('a call that was not admitted never reaches a provider', () => {
  it('refuses when the kill switch is out', () => {
    // A transport that would answer perfectly well. The point is that it is never asked.
    const transport: ModelTransport = () => ({ kind: 'reply', text: 'order 40 bags' });
    const response = callModel({
      request: request(),
      transport,
      admission: { allowed: false, detail: 'A02 is stopped — the buyer orders as they did before' },
    });
    expect(response.outcome).toBe('not_admitted');
    expect(response.proposals).toEqual([]);
    expect(response.detail).toContain('buyer');
  });

  it('refuses when NOBODY DECIDED — the absence of a decision is not permission', () => {
    // This is the whole finding. Before this guard, a caller that forgot to consult the kill
    // switch got a model call, and the caller that forgets is the one running when it is pulled.
    const response = callModel({ request: request(), transport: () => ({ kind: 'reply', text: 'hello' }) });
    expect(response.outcome).toBe('not_admitted');
    expect(response.detail).toMatch(/never after|before a model is reached/);
  });

  it('costs nothing, so a stopped agent cannot spend', () => {
    const response = callModel({ request: request(), admission: { allowed: false, detail: 'stopped' } });
    expect(response.inputTokens).toBe(0);
    expect(response.outputTokens).toBe(0);
  });

  it('proves the transport is never touched — it throws if it is', () => {
    const exploding: ModelTransport = () => { throw new Error('the provider was called'); };
    expect(() => callModel({
      request: request(), transport: exploding, admission: { allowed: false, detail: 'stopped' },
    })).not.toThrow();
  });

  it('checks admission BEFORE the transport, in the source, not merely by luck of ordering', () => {
    const fn = code(GATEWAY).slice(code(GATEWAY).indexOf('export function callModel'));
    const admitted = fn.indexOf('input.admission === undefined');
    const transported = fn.indexOf('input.transport(r)');
    expect(admitted, 'the gateway never checks admission').toBeGreaterThan(-1);
    expect(transported, 'the gateway never calls a transport').toBeGreaterThan(-1);
    expect(admitted, 'admission is checked after the provider was already called')
      .toBeLessThan(transported);
  });

  it('tripwire — an admitted call really does reach the transport', () => {
    // Otherwise every assertion above would pass on a gateway that answers nothing at all.
    let reached = false;
    const transport: ModelTransport = () => { reached = true; return { kind: 'reply', text: 'ok' }; };
    const response = callModel({
      request: request(), transport, admission: { allowed: true, detail: 'within budget' },
    });
    expect(reached, 'the gateway no longer calls the transport — update this guard').toBe(true);
    expect(response.outcome).not.toBe('not_admitted');
  });
});

// ── 3. What no configuration can ever grant ─────────────────────────────────

describe('no agent may ever be granted a forbidden tool (AI-NFR-12)', () => {
  const ALL = Object.keys(AGENTS) as AgentId[];

  it('holds for every agent, however the tenant is configured', () => {
    for (const agentId of ALL) {
      const granted = grantTools({ agentId, tenantEnabled: true, agentEnabled: true });
      for (const tool of granted.tools) {
        expect(FORBIDDEN_TOOLS, `${agentId} was granted ${tool}`).not.toContain(tool);
      }
    }
  });

  it('the screen SHOWS the list — a rule nobody can see is a rule nobody trusts', () => {
    expect(code(MODEL)).toMatch(/forbidden: \(\) => FORBIDDEN_TOOLS/);
    expect(code(VIEW)).toMatch(/session\.forbidden\(\)/);
    expect(HTML).toMatch(/id="forbidden-box"/);
  });

  it('the screen grants through the SAME function the runtime uses', () => {
    // A screen with its own idea of an agent's tools shows a list the runtime would refuse.
    const agents = code(MODEL).slice(code(MODEL).indexOf('agents: () =>'));
    expect(agents).toMatch(/grantTools\(\{ agentId, tenantEnabled: true, agentEnabled: budget\?\.enabled !== false \}\)/);
    expect(agents, 'the screen builds its own tool list').not.toMatch(/allowedTools/);
  });

  it('reviews a draft through the same function too, against VERIFIED citations', () => {
    const queue = code(MODEL).slice(code(MODEL).indexOf('queue: () =>'));
    expect(queue).toMatch(/reviewProposals\(\{/);
    expect(queue).toMatch(/verifiedCitations: pending\.verifiedCitations/);
    // Never what the model claimed to have cited.
    expect(queue, 'the screen trusts the model’s own citation list').not.toMatch(/citedEvidenceIds/);
  });
});

// ── 4. AI drafts; a named person commits ────────────────────────────────────

describe('nothing here commits, and nothing commits under a name nobody holds', () => {
  it('the screen has no way to execute anything itself', () => {
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(code(VIEW), `the view calls ${forbidden}`).not.toMatch(new RegExp(`\\b${forbidden}\\s*\\(`));
    }
    expect(code(MODEL), 'the session executes a proposal').not.toMatch(/\bexecute\s*\(/);
  });

  it('records the PERSON as the actor and the agent as the drafter', () => {
    expect(code(MODEL)).toMatch(/approvedBy: config\.userId/);
    expect(code(MODEL)).toMatch(/agentIdentities: ALL/);
    expect(code(VIEW)).toMatch(/outcome\.record\.actor/);
    expect(code(VIEW)).toMatch(/outcome\.record\.draftedBy/);
  });

  it('stops and accepts nothing under a name nobody holds', () => {
    expect(code(MODEL)).toMatch(/readonly userId: string \| null/);
    for (const fn of ['pull: (input)', 'lift: (input)', 'decide: (input)']) {
      const body = code(MODEL).slice(code(MODEL).indexOf(fn));
      expect(body.indexOf('config.userId === null'), `${fn} does not check who is asking`)
        .toBeGreaterThan(-1);
    }
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    expect(HTML).toMatch(/id="nobody"/);
  });

  it('never lets the same person pull a switch and decide the problem is over', () => {
    expect(code(MODEL)).toMatch(/liftKillSwitch\(\{ killSwitch, liftedBy: config\.userId/);
  });

  it('offers stopping ON THE SCREEN, so the control is not worked around', () => {
    // A capability the session has and the screen does not is the fault this codebase keeps
    // finding — twelve times now.
    expect(HTML).toMatch(/id="pull"/);
    expect(HTML).toMatch(/id="pull-reason"/);
    expect(code(VIEW)).toMatch(/session\.pull\(/);
    expect(code(VIEW)).toMatch(/session\.lift\(/);
    expect(code(VIEW)).toMatch(/session\.decide\(/);
  });

  it('shows what the shop does without each agent, beside the switch', () => {
    // "What breaks if I do this?" is the only question anybody will ask before pulling it.
    expect(code(MODEL)).toMatch(/export function fallbackFor/);
    expect(code(VIEW)).toMatch(/agent\.fallback/);
  });
});

// ── 5. Absent is not nought ─────────────────────────────────────────────────

describe('what has never been set is never served as a zero', () => {
  it('serves no kill-switch list at all rather than an empty one', () => {
    // A substituted empty list draws ten assistants running while one of them is stopped.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function aiPayload'));
    expect(builder).toMatch(/if \(input\.pack\.killSwitches\.known\) payload\['killSwitches'\]/);
    expect(builder, 'the box invents an answer').not.toMatch(/\?\? \[\]|\?\? 0|\?\? \{\}/);
  });

  it('serves the screen nothing at all without the shop’s own AI policy', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function aiPayload'));
    expect(builder.slice(0, 200)).toMatch(/if \(!input\.pack\.aiPolicy\.known\) return null;/);
  });

  it('never defaults the owner’s platform ceiling (D3)', () => {
    expect(code(ENTRY)).toMatch(/platformCeilingMinor: \(\) => data\?\.platformCeilingMinor,/);
    expect(code(ENTRY)).not.toMatch(/platformCeilingMinor: \(\) => data\?\.platformCeilingMinor \?\?/);
    // No ceiling means no summary. A share of a limit nobody agreed is not reassurance.
    expect(code(MODEL)).toMatch(/if \(ceiling === undefined\) return undefined;/);
    expect(code(VIEW)).toMatch(/noPlatformCeiling/);
  });

  it('an agent with no ceiling, and one never metered, are told apart', () => {
    // Two different absences with two different fixes. A single `undefined` would have somebody
    // setting a ceiling that was already set, while the meter stayed broken.
    expect(code(MODEL)).toMatch(/'no_ceiling_set' \| 'spend_not_known'/);
    expect(code(VIEW)).toMatch(/agent\.budget\.why === 'no_ceiling_set'/);
    expect(code(VIEW)).toMatch(/noBudget/);
    expect(code(VIEW)).toMatch(/spendNotKnown/);
  });

  it('there is exactly ONE source for what an agent has spent', () => {
    // The fault a real box found: a carried per-agent map with no period on it read 95,000 spent
    // on the assistants tab while the cost tab beside it read nought. Same screen, same agent.
    expect(code(MODEL), 'a second spend source is back').not.toMatch(/spentThisPeriod\(\)/);
    expect(code(ENTRY), 'the box serves a second spend source').not.toMatch(/spentThisPeriod:/);
    const spentBy = code(MODEL).slice(code(MODEL).indexOf('const spentBy'));
    expect(spentBy, 'spend is not filtered to the period').toMatch(/u\.period === ports\.period\(\)/);
    expect(spentBy, 'spend is not filtered to the tenant').toMatch(/u\.tenantId === config\.tenantId/);
  });

  it('never converts "never metered" into "has spent nothing"', () => {
    expect(code(ENTRY)).toMatch(/usage: \(\) => data\?\.usage,/);
    expect(code(ENTRY)).not.toMatch(/usage: \(\) => data\?\.usage \?\?/);
    // And a ceiling cannot be enforced against a figure nobody measured.
    const admission = code(MODEL).slice(code(MODEL).indexOf('export function admissionFor'));
    expect(admission).toMatch(/input\.spentThisPeriodMinor === undefined/);
    expect(admission.indexOf('input.spentThisPeriodMinor === undefined'))
      .toBeLessThan(admission.indexOf('admitCall('));
  });

  it('an agent never evaluated says so, rather than scoring nought', () => {
    expect(code(MODEL)).toMatch(/readonly evaluation: \{ readonly passed: number; readonly total: number; readonly at: string \} \| undefined/);
    expect(code(VIEW)).toMatch(/agent\.evaluation === undefined/);
    expect(code(VIEW)).toMatch(/noEvaluation/);
  });
});

// ── The screen somebody uses at eight in the evening ────────────────────────

describe('the screen a duty manager reaches for in a hurry', () => {
  it('opens on the switch, not three levels down a settings menu', () => {
    expect(code(VIEW)).toMatch(/show\('switch'\)/);
    expect(HTML.indexOf('id="tab-switch"')).toBeLessThan(HTML.indexOf('id="tab-agents"'));
  });

  it('lists stopped assistants FIRST', () => {
    const agents = code(MODEL).slice(code(MODEL).indexOf('agents: () =>'));
    expect(agents).toMatch(/\.sort\(\(a, b\) => \(a\.stopped === b\.stopped \? 0 : a\.stopped \? -1 : 1\)\)/);
  });

  it('has words for every refusal it can produce, in both languages', () => {
    expectWordsFor(PULL_REFUSAL_KINDS, 'PULL_REFUSAL_WORDS');
    expectWordsFor(DECIDE_REFUSAL_KINDS, 'DECIDE_REFUSAL_WORDS');
    expectWordsFor(
      ['accepted_for_approval', 'forbidden_tool', 'tool_not_granted', 'read_only_agent', 'no_evidence', 'no_rationale'],
      'VERDICT_WORDS',
    );
  });

  it('opens with no network and says where the page came from', () => {
    expect(HTML).toMatch(/<!--SCREEN-DATA-->/);
    expect(code(VIEW)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    expect(code(VIEW)).toMatch(/window\.shellCachedAt/);
  });

  it('never interrupts anybody with a browser dialog', () => {
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(code(VIEW)).toMatch(/function tell\(/);
  });

  it('is offered in Tamil everywhere it is offered in English', () => {
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    const ta = code(VIEW).slice(code(VIEW).indexOf('ta: {'), code(VIEW).indexOf('};'));
    const keys = (block: string): string[] => [...block.matchAll(/(\w+):\s*['"]/g)].map((m) => m[1]!);
    expect(keys(en).length).toBeGreaterThan(25);
    expect(keys(ta).length).toBe(keys(en).length);
    for (const key of keys(en)) expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
  });
});
