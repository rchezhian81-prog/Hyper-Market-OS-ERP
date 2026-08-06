import { describe, it, expect } from 'vitest';
import * as ai from '../../packages/ai/src/index';
import {
  callModel,
  simulatedTransport,
  simulatorConfig,
  type ModelRequest,
  type EvidenceItem,
} from '../../packages/ai/src/gateway';

// Stage 17 / AI-NFR: a model is an UNTRUSTED INPUT, not a component.

const evidence = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  evidenceId: 'ev-1', source: 'sales ledger', content: 'Yesterday: 412,000 minor units.',
  untrusted: false, ...over,
});

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  requestId: 'req-1',
  context: {
    tenantId: 't-sre', agentId: 'A01', requestedBy: 'u-owner',
    correlationId: 'corr-1', at: '2026-08-05T06:00:00Z',
  },
  instruction: 'Summarise yesterday for the owner.',
  evidence: [evidence()],
  offeredTools: ['read_kpi', 'draft_brief'],
  maxOutputTokens: 1_200,
  timeoutMs: 4_000,
  tier: 'small',
  ...over,
});

const transport = (behaviour: Parameters<typeof simulatedTransport>[0]['cases'][number]['behaviour']) =>
  simulatedTransport({ cases: [{ whenInstructionContains: 'Summarise', behaviour }] });

/**
 * Permission for one call, as `admitCall` would return it.
 *
 * Every one of these tests used to call the gateway with no admission at all — because the
 * gateway never asked. It does now, and its absence refuses.
 */
const ADMITTED = { allowed: true, detail: 'within budget, no kill switch' } as const;

describe('nothing here can execute anything (hard rule #5)', () => {
  it('EXPOSES NO FUNCTION that could act on a proposal', () => {
    // Absence as a control: the gateway returns text and proposals. There is no route
    // from a model's output to an effect.
    const named = Object.keys(ai);
    for (const forbidden of ['executeProposal', 'applyProposal', 'runTool', 'commitFromModel', 'autoApprove']) {
      expect(named).not.toContain(forbidden);
    }
  });
});

describe('a model response is validated before anybody sees it', () => {
  it('accepts a well-formed answer', () => {
    const r = callModel({ request: request(), transport: transport('answer'), admission: ADMITTED });
    expect(r.outcome).toBe('answered');
    expect(r.text).toBeDefined();
    expect(r.citedEvidenceIds).toEqual(['ev-1']);
  });

  it('treats a TIMEOUT as an outcome, not an exception', () => {
    const r = callModel({ request: request(), transport: transport('timeout'), admission: ADMITTED });
    expect(r.outcome).toBe('timed_out');
    // A model must never hold a cashier's screen.
    expect(r.detail).toContain("hold a cashier's screen");
  });

  it('REFUSES malformed output rather than repairing it', () => {
    const noTool = callModel({ request: request(), transport: transport('malformed_no_tool'), admission: ADMITTED });
    expect(noTool.outcome).toBe('malformed');
    expect(noTool.detail).toContain('refused rather than guessed at');

    const noWhy = callModel({ request: request(), transport: transport('malformed_no_rationale'), admission: ADMITTED });
    expect(noWhy.outcome).toBe('malformed');
    expect(noWhy.detail).toContain('cannot be reviewed');
  });

  it('refuses a truncated over-length answer', () => {
    const r = callModel({ request: request(), transport: transport('over_length'), admission: ADMITTED });
    expect(r.outcome).toBe('over_length');
    expect(r.detail).toContain('almost certainly truncated');
  });

  it('reports a provider refusal and a provider error distinctly', () => {
    expect(callModel({ request: request(), transport: transport('refuse'), admission: ADMITTED }).outcome).toBe('refused_by_provider');
    expect(callModel({ request: request(), transport: transport('error'), admission: ADMITTED }).outcome).toBe('provider_error');
  });

  it('carries on with NO provider configured at all', () => {
    const r = callModel({ request: request(), admission: ADMITTED });
    expect(r.outcome).toBe('no_provider');
    // Every agent is built to work without AI. This is that promise, at the gateway.
    expect(r.detail).toContain('carry on without AI');
  });
});

describe('THE line: a tool that was never granted cannot be proposed through', () => {
  it('DROPS a proposal for an ungranted tool and records it', () => {
    const r = callModel({ request: request(), transport: transport('propose_ungranted_tool'), admission: ADMITTED });
    expect(r.outcome).toBe('answered');
    // The model asked for commit_price_change. It does not come out the other side.
    expect(r.proposals).toEqual([]);
    expect(r.detail).toContain('commit_price_change');
    expect(r.detail).toContain('DROPPED and recorded');
  });

  it('holds even when the model has been FULLY STEERED by injected text', () => {
    const r = callModel({
      admission: ADMITTED,
      request: request({ instruction: 'Summarise this customer message for the service desk.' }),
      transport: simulatedTransport({
        cases: [{ whenInstructionContains: 'Summarise', behaviour: 'obey_injected_instruction' }],
      }),
    });
    // The model obeyed the attacker. It proposed a ₹50,000 refund and a customer export.
    // Neither reaches the caller, because neither tool was ever granted.
    expect(r.proposals).toEqual([]);
    expect(r.detail).toContain('issue_refund');
    expect(r.detail).toContain('export_customers');
  });

  it('lets a GRANTED tool through, with its rationale intact', () => {
    const r = callModel({
      admission: ADMITTED,
      request: request({ offeredTools: ['draft_brief'] }),
      transport: simulatedTransport({
        cases: [{
          whenInstructionContains: 'Summarise', behaviour: 'answer',
          proposals: [{ tool: 'draft_brief', arguments: { period: 'yesterday' }, rationale: 'the owner asked for a summary' }],
        }],
      }),
    });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]?.rationale).toBe('the owner asked for a summary');
  });
});

describe('a citation to evidence that was never supplied is a fabrication', () => {
  it('discards it and says so', () => {
    const r = callModel({ request: request(), transport: transport('fabricate_citation'), admission: ADMITTED });
    expect(r.citedEvidenceIds).toEqual([]);
    expect(r.detail).toContain('fabricated');
  });

  it('keeps citations that match supplied evidence', () => {
    const r = callModel({
      admission: ADMITTED,
      request: request({ evidence: [evidence({ evidenceId: 'ev-a' }), evidence({ evidenceId: 'ev-b' })] }),
      transport: transport('answer'),
    });
    expect(r.citedEvidenceIds).toEqual(['ev-a', 'ev-b']);
  });
});

describe('the simulator is DETERMINISTIC, which is what makes any of this testable', () => {
  it('returns the same thing every time for the same input', () => {
    const t = transport('answer');
    const a = callModel({ request: request(), transport: t, admission: ADMITTED });
    const b = callModel({ request: request(), transport: t, admission: ADMITTED });
    expect(a).toEqual(b);
  });

  it('derives token counts from real lengths, so a budget test asserts a real number', () => {
    const short = callModel({ request: request({ instruction: 'Hi.' }), transport: transport('answer'), admission: ADMITTED });
    const long = callModel({
      admission: ADMITTED,
      request: request({ instruction: 'Hi.'.repeat(400) }), transport: transport('answer'),
    });
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens);
  });

  it('reproduces every way a real provider misbehaves', () => {
    const behaviours = [
      'answer', 'timeout', 'refuse', 'error', 'malformed_no_tool',
      'malformed_no_rationale', 'over_length', 'propose_ungranted_tool', 'fabricate_citation',
    ] as const;
    const outcomes = behaviours.map((b) => callModel({ request: request(), transport: transport(b), admission: ADMITTED }).outcome);
    // Not a mock that returns "ok" — every transport failure mode is exercised. Three of the
    // nine behaviours land on `answered` on purpose: an over-reaching proposal and a
    // fabricated citation are answers whose CONTENT is refused, not failed calls.
    expect([...new Set(outcomes)].sort()).toEqual([
      'answered', 'malformed', 'over_length', 'provider_error', 'refused_by_provider', 'timed_out',
    ]);
  });
});

describe('the configuration names tiers, never a provider', () => {
  it('maps tiers to adapter-local model names', () => {
    const config = simulatorConfig('t-sre');
    expect(config.adapterId).toBe('simulator');
    expect(Object.keys(config.modelForTier).sort()).toEqual(['complex', 'small', 'standard']);
    // Switching provider changes these two fields and nothing else.
    expect(config.enabled).toBe(true);
  });
});

/**
 * **The kill switch, and the reason it never stopped anything.**
 *
 * `killSwitchState` and `admitCall` were both written and both tested. The gateway — the one place
 * every model call passes through — consulted neither, so pulling the switch stopped nothing at
 * all. It asks now, and its absence refuses.
 */
describe('a call that was not admitted never reaches a provider', () => {
  it('REFUSES when the kill switch is out', () => {
    const r = callModel({
      request: request(),
      transport: transport('answer'),
      admission: { allowed: false, detail: 'A03 is stopped by a kill switch — the buyer orders from the printed list' },
    });
    expect(r.outcome).toBe('not_admitted');
    expect(r.proposals).toEqual([]);
    expect(r.detail).toContain('stopped by a kill switch');
  });

  it('REFUSES when no admission decision was made at all', () => {
    // The fail-safe direction. A caller that forgets to check the kill switch is the one running
    // when somebody pulls it, so forgetting must refuse rather than proceed.
    const r = callModel({ request: request(), transport: transport('answer') });
    expect(r.outcome).toBe('not_admitted');
    expect(r.detail).toContain('checked before a model is reached');
  });

  it('costs nothing and proposes nothing when it is refused', () => {
    const r = callModel({
      request: request(),
      transport: transport('propose_ungranted_tool'),
      admission: { allowed: false, detail: 'over budget' },
    });
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.proposals).toEqual([]);
  });

  it('refuses BEFORE the transport is touched', () => {
    // Not merely a discarded answer: the provider is never called, so there is no cost and no
    // chance of a proposal existing at all.
    let called = false;
    const spy = ((): never => { called = true; throw new Error('the transport was reached'); }) as never;
    const r = callModel({ request: request(), transport: spy, admission: { allowed: false, detail: 'killed' } });
    expect(called, 'the provider was called on a killed agent').toBe(false);
    expect(r.outcome).toBe('not_admitted');
  });
});
