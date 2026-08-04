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
    const r = callModel({ request: request(), transport: transport('answer') });
    expect(r.outcome).toBe('answered');
    expect(r.text).toBeDefined();
    expect(r.citedEvidenceIds).toEqual(['ev-1']);
  });

  it('treats a TIMEOUT as an outcome, not an exception', () => {
    const r = callModel({ request: request(), transport: transport('timeout') });
    expect(r.outcome).toBe('timed_out');
    // A model must never hold a cashier's screen.
    expect(r.detail).toContain("hold a cashier's screen");
  });

  it('REFUSES malformed output rather than repairing it', () => {
    const noTool = callModel({ request: request(), transport: transport('malformed_no_tool') });
    expect(noTool.outcome).toBe('malformed');
    expect(noTool.detail).toContain('refused rather than guessed at');

    const noWhy = callModel({ request: request(), transport: transport('malformed_no_rationale') });
    expect(noWhy.outcome).toBe('malformed');
    expect(noWhy.detail).toContain('cannot be reviewed');
  });

  it('refuses a truncated over-length answer', () => {
    const r = callModel({ request: request(), transport: transport('over_length') });
    expect(r.outcome).toBe('over_length');
    expect(r.detail).toContain('almost certainly truncated');
  });

  it('reports a provider refusal and a provider error distinctly', () => {
    expect(callModel({ request: request(), transport: transport('refuse') }).outcome).toBe('refused_by_provider');
    expect(callModel({ request: request(), transport: transport('error') }).outcome).toBe('provider_error');
  });

  it('carries on with NO provider configured at all', () => {
    const r = callModel({ request: request() });
    expect(r.outcome).toBe('no_provider');
    // Every agent is built to work without AI. This is that promise, at the gateway.
    expect(r.detail).toContain('carry on without AI');
  });
});

describe('THE line: a tool that was never granted cannot be proposed through', () => {
  it('DROPS a proposal for an ungranted tool and records it', () => {
    const r = callModel({ request: request(), transport: transport('propose_ungranted_tool') });
    expect(r.outcome).toBe('answered');
    // The model asked for commit_price_change. It does not come out the other side.
    expect(r.proposals).toEqual([]);
    expect(r.detail).toContain('commit_price_change');
    expect(r.detail).toContain('DROPPED and recorded');
  });

  it('holds even when the model has been FULLY STEERED by injected text', () => {
    const r = callModel({
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
    const r = callModel({ request: request(), transport: transport('fabricate_citation') });
    expect(r.citedEvidenceIds).toEqual([]);
    expect(r.detail).toContain('fabricated');
  });

  it('keeps citations that match supplied evidence', () => {
    const r = callModel({
      request: request({ evidence: [evidence({ evidenceId: 'ev-a' }), evidence({ evidenceId: 'ev-b' })] }),
      transport: transport('answer'),
    });
    expect(r.citedEvidenceIds).toEqual(['ev-a', 'ev-b']);
  });
});

describe('the simulator is DETERMINISTIC, which is what makes any of this testable', () => {
  it('returns the same thing every time for the same input', () => {
    const t = transport('answer');
    const a = callModel({ request: request(), transport: t });
    const b = callModel({ request: request(), transport: t });
    expect(a).toEqual(b);
  });

  it('derives token counts from real lengths, so a budget test asserts a real number', () => {
    const short = callModel({ request: request({ instruction: 'Hi.' }), transport: transport('answer') });
    const long = callModel({
      request: request({ instruction: 'Hi.'.repeat(400) }), transport: transport('answer'),
    });
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens);
  });

  it('reproduces every way a real provider misbehaves', () => {
    const behaviours = [
      'answer', 'timeout', 'refuse', 'error', 'malformed_no_tool',
      'malformed_no_rationale', 'over_length', 'propose_ungranted_tool', 'fabricate_citation',
    ] as const;
    const outcomes = behaviours.map((b) => callModel({ request: request(), transport: transport(b) }).outcome);
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
