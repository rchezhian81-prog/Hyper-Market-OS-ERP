// The model gateway — provider-neutral, with a deterministic simulator
// (Stage 17 / AI-NFR-01…12 / §7.1 / §19 / P-05 / hard rule #5).
//
// Every AI call in this product goes through here, and **here has no idea which provider is
// behind it.** That is the point: the owner's decision on 4 August 2026 was to build the whole
// of Stage 17 against a simulator and choose a provider later, so changing provider must be a
// configuration and adapter change rather than a rewrite. The way to guarantee that is to make
// the rest of the codebase physically unable to name a provider — nothing outside an adapter
// may import one, and a guardrail test asserts it.
//
// The second thing this file exists for is more important than provider-neutrality:
//
//   **A LANGUAGE MODEL IS AN UNTRUSTED INPUT, NOT A COMPONENT.**
//
// Every other module in this repository is deterministic: given the same input it produces the
// same output, and it either succeeds or refuses with a named reason. A model does none of
// that. It can be slow, wrong, truncated, confidently mistaken, or actively steered by text
// somebody typed into a review. So the gateway treats every response the way the goods-in door
// treats a delivery: **checked before it is accepted, and refused by name when it fails.**
//
//   • **A TIMEOUT IS AN OUTCOME, NOT AN EXCEPTION.** A model that has not answered in four
//     seconds must not hold a cashier's screen. The call ends, the caller carries on, and the
//     absence is recorded.
//   • **MALFORMED OUTPUT IS REFUSED, NEVER REPAIRED.** "Best-effort parsing" of a broken model
//     response is how a half-parsed number reaches a purchase order.
//   • **NOTHING HERE EXECUTES ANYTHING.** The gateway returns text and structured proposals.
//     There is no execute, no commit, no apply. That absence is the whole of hard rule #5, and
//     it is asserted by test rather than promised in a document.
//
// Pure and deterministic: the transport is injected, the clock is injected, no I/O.

/** Where a call came from, for metering and audit. */
export interface CallContext {
  readonly tenantId: string;
  readonly agentId: string;
  readonly requestedBy: string;
  /** Ties this call to the request, its audit rows and its events (NFR-15). */
  readonly correlationId: string;
  readonly at: string;
}

export interface ModelRequest {
  readonly requestId: string;
  readonly context: CallContext;
  /** The instruction. Never contains secrets — the redactor runs before this is built. */
  readonly instruction: string;
  /** Retrieved evidence the model may cite. Untrusted content is fenced, not concatenated. */
  readonly evidence: readonly EvidenceItem[];
  /** Tools the agent is allowed to ask for. The gateway never grants more. */
  readonly offeredTools: readonly string[];
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Model tier requested. The budget layer may downgrade it; it never upgrades. */
  readonly tier: ModelTier;
}

export type ModelTier = 'small' | 'standard' | 'complex';

export interface EvidenceItem {
  readonly evidenceId: string;
  /** Where it came from, so a citation can be checked. */
  readonly source: string;
  readonly content: string;
  /**
   * True when the content originated OUTSIDE the business — a customer message, a supplier
   * catalogue, a product review. This is the flag that decides whether it is fenced.
   */
  readonly untrusted: boolean;
}

export type ModelOutcome =
  | 'answered'
  | 'timed_out'
  | 'refused_by_provider'
  | 'malformed'
  | 'over_length'
  | 'provider_error'
  | 'no_provider'
  /**
   * The kill switch is out, the budget is spent, or the agent is switched off.
   *
   * **This gateway used to have no such outcome**, because it never asked. `killSwitchState` and
   * `admitCall` were both written and both tested, and the one place every model call passes
   * through consulted neither — so pulling the kill switch stopped nothing at all.
   */
  | 'not_admitted';

/**
 * Permission for one call, from `admitCall` — the kill switch and the budget, already decided.
 *
 * Required, and **its absence refuses**. A caller that forgets to check the kill switch must not
 * get a model call by default: an emergency control that depends on every caller remembering to
 * consult it is not an emergency control.
 */
export interface CallAdmission {
  readonly allowed: boolean;
  /** Why not, in the words the agent's own fallback is described in. */
  readonly detail: string;
}

export interface ToolProposal {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Why the agent thinks this is the right call — required, never optional. */
  readonly rationale: string;
}

export interface ModelResponse {
  readonly requestId: string;
  readonly outcome: ModelOutcome;
  /** Present only on `answered`. */
  readonly text?: string;
  /** Structured proposals. PROPOSALS — nothing here has been executed. */
  readonly proposals: readonly ToolProposal[];
  /** Evidence ids the model claims to have used. Verified elsewhere, never trusted here. */
  readonly citedEvidenceIds: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tier: ModelTier;
  readonly elapsedMs: number;
  readonly detail: string;
}

/**
 * The provider adapter. **The only place a provider name may appear.**
 *
 * A real adapter wraps an HTTP client. The simulator below implements the same shape, which is
 * why Stage 17 could be built and gate-proven before any account existed.
 */
export type ModelTransport = (request: ModelRequest) => RawModelReply;

/** What a provider gives back, before any of it is believed. */
export interface RawModelReply {
  readonly kind: 'reply' | 'timeout' | 'refusal' | 'error';
  readonly text?: string;
  readonly proposals?: readonly Partial<ToolProposal>[];
  readonly citedEvidenceIds?: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly elapsedMs?: number;
  readonly detail?: string;
}

/**
 * Call the model and **validate what comes back before anybody sees it**.
 *
 * The validation is the reason this function exists. A provider's reply is an untrusted input:
 * it may be truncated mid-JSON, propose a tool that was never offered, cite evidence that was
 * never supplied, or simply not arrive. Each of those is a **named outcome** rather than an
 * exception, because a cashier's screen cannot be held by a stack trace.
 *
 * **A proposal for a tool that was not offered is dropped and reported.** That is the single
 * most important line in this file: it is where a prompt injection stops being interesting.
 * Text can persuade a model to *ask* for anything; it cannot make the gateway hand over a tool
 * the agent was never granted.
 */
export function callModel(input: {
  readonly request: ModelRequest;
  readonly transport?: ModelTransport;
  /**
   * The kill switch and the budget, already decided by `admitCall`.
   *
   * **Absent refuses.** Making this optional-and-permissive would mean every caller has to
   * remember to check the kill switch, and the one that forgets is the one running when somebody
   * pulls it.
   */
  readonly admission?: CallAdmission;
}): ModelResponse {
  const r = input.request;
  const base = {
    requestId: r.requestId,
    proposals: [] as readonly ToolProposal[],
    citedEvidenceIds: [] as readonly string[],
    inputTokens: 0,
    outputTokens: 0,
    tier: r.tier,
    elapsedMs: 0,
  };

  // **Before the transport is touched.** A call that is not admitted must not reach a provider,
  // must not cost anything, and must not be able to return a proposal.
  if (input.admission === undefined || !input.admission.allowed) {
    return {
      ...base,
      outcome: 'not_admitted',
      detail: input.admission?.detail
        ?? 'no admission decision was made for this call, so it is refused — the kill switch and the budget are checked before a model is reached, never after',
    };
  }

  if (input.transport === undefined) {
    return {
      ...base,
      outcome: 'no_provider',
      detail: 'no model provider is configured — the caller must carry on without AI, which every agent is built to do',
    };
  }

  const raw = input.transport(r);
  const elapsedMs = raw.elapsedMs ?? 0;

  if (raw.kind === 'timeout' || elapsedMs > r.timeoutMs) {
    return {
      ...base,
      outcome: 'timed_out',
      elapsedMs,
      detail: `no answer within ${r.timeoutMs}ms — the caller carries on, because a model must never hold a cashier's screen`,
    };
  }
  if (raw.kind === 'refusal') {
    return { ...base, outcome: 'refused_by_provider', elapsedMs, detail: raw.detail ?? 'the provider declined to answer' };
  }
  if (raw.kind === 'error') {
    return { ...base, outcome: 'provider_error', elapsedMs, detail: raw.detail ?? 'the provider failed' };
  }

  const inputTokens = raw.inputTokens ?? 0;
  const outputTokens = raw.outputTokens ?? 0;

  if (outputTokens > r.maxOutputTokens) {
    return {
      ...base,
      outcome: 'over_length',
      inputTokens,
      outputTokens,
      elapsedMs,
      detail: `the answer ran past ${r.maxOutputTokens} tokens and is almost certainly truncated — a half-finished answer is refused, not shown`,
    };
  }

  // Malformed is REFUSED, never repaired. Best-effort parsing of a broken reply is how a
  // half-parsed number reaches a purchase order.
  const proposals: ToolProposal[] = [];
  const droppedTools: string[] = [];
  for (const p of raw.proposals ?? []) {
    if (typeof p.tool !== 'string' || p.tool.trim() === '') {
      return {
        ...base,
        outcome: 'malformed',
        inputTokens,
        outputTokens,
        elapsedMs,
        detail: 'a proposal arrived with no tool name — refused rather than guessed at',
      };
    }
    if (typeof p.rationale !== 'string' || p.rationale.trim() === '') {
      return {
        ...base,
        outcome: 'malformed',
        inputTokens,
        outputTokens,
        elapsedMs,
        detail: `"${p.tool}" was proposed with no rationale — an unexplained proposal cannot be reviewed, so it cannot be accepted`,
      };
    }
    // THE line. Text can persuade a model to ask for anything; it cannot make the gateway
    // hand over a tool the agent was never granted.
    if (!r.offeredTools.includes(p.tool)) {
      droppedTools.push(p.tool);
      continue;
    }
    proposals.push({
      tool: p.tool,
      arguments: (p.arguments ?? {}) as Readonly<Record<string, unknown>>,
      rationale: p.rationale,
    });
  }

  // A citation to evidence that was never supplied is a fabrication.
  const supplied = new Set(r.evidence.map((e) => e.evidenceId));
  const cited = (raw.citedEvidenceIds ?? []).filter((id) => supplied.has(id));
  const fabricated = (raw.citedEvidenceIds ?? []).filter((id) => !supplied.has(id));

  return {
    requestId: r.requestId,
    outcome: 'answered',
    text: raw.text,
    proposals,
    citedEvidenceIds: cited,
    inputTokens,
    outputTokens,
    tier: r.tier,
    elapsedMs,
    detail:
      droppedTools.length > 0
        ? `answered; ${droppedTools.length} proposal(s) for tools this agent was never granted were DROPPED and recorded: ${droppedTools.join(', ')}`
        : fabricated.length > 0
          ? `answered; ${fabricated.length} citation(s) referred to evidence that was never supplied and were discarded as fabricated`
          : 'answered',
  };
}

// ─── The deterministic simulator ───────────────────────────────────────────────
//
// Not a mock that returns "ok". A scripted provider that reproduces every way a real one
// misbehaves, so the safety controls are exercised rather than assumed.

export type ScriptedBehaviour =
  | 'answer'
  | 'timeout'
  | 'refuse'
  | 'error'
  | 'malformed_no_tool'
  | 'malformed_no_rationale'
  | 'over_length'
  | 'propose_ungranted_tool'
  | 'fabricate_citation'
  | 'obey_injected_instruction';

export interface ScriptedCase {
  /** Matched against the instruction, so one script can drive a whole evaluation set. */
  readonly whenInstructionContains: string;
  readonly behaviour: ScriptedBehaviour;
  readonly text?: string;
  readonly proposals?: readonly Partial<ToolProposal>[];
  readonly citedEvidenceIds?: readonly string[];
  readonly elapsedMs?: number;
}

export interface SimulatorScript {
  readonly cases: readonly ScriptedCase[];
  /** Used when no case matches. Default is a plain answer. */
  readonly fallback?: ScriptedBehaviour;
}

/**
 * Build a deterministic transport from a script.
 *
 * **The same input always produces the same output**, which is what makes an AI system
 * testable at all. Token counts are derived from the text length rather than randomised, so a
 * budget test asserts a real number.
 *
 * `obey_injected_instruction` is the important one: it simulates a model that has been
 * successfully steered by hostile text in its evidence and now proposes a dangerous tool. The
 * test is not that the model resists — models sometimes do not. The test is that **the
 * gateway and the authority layer refuse anyway.**
 */
export function simulatedTransport(script: SimulatorScript): ModelTransport {
  return (request: ModelRequest): RawModelReply => {
    const matched = script.cases.find((c) => request.instruction.includes(c.whenInstructionContains));
    const behaviour = matched?.behaviour ?? script.fallback ?? 'answer';
    const text = matched?.text ?? `A deterministic answer for ${request.context.agentId}.`;
    const elapsedMs = matched?.elapsedMs ?? 120;

    // Deterministic token accounting: 4 characters ≈ 1 token, the usual rule of thumb.
    const promptChars =
      request.instruction.length + request.evidence.reduce((s, e) => s + e.content.length, 0);
    const inputTokens = Math.ceil(promptChars / 4);
    const outputTokens = Math.ceil(text.length / 4);

    switch (behaviour) {
      case 'timeout':
        return { kind: 'timeout', elapsedMs: request.timeoutMs + 1, detail: 'simulated timeout' };
      case 'refuse':
        return { kind: 'refusal', elapsedMs, detail: 'simulated provider refusal' };
      case 'error':
        return { kind: 'error', elapsedMs, detail: 'simulated provider error' };
      case 'malformed_no_tool':
        return {
          kind: 'reply', text, inputTokens, outputTokens, elapsedMs,
          proposals: [{ arguments: {}, rationale: 'a proposal with no tool name' }],
        };
      case 'malformed_no_rationale':
        return {
          kind: 'reply', text, inputTokens, outputTokens, elapsedMs,
          proposals: [{ tool: request.offeredTools[0] ?? 'read_sales', arguments: {} }],
        };
      case 'over_length':
        return {
          kind: 'reply', text, inputTokens, elapsedMs,
          outputTokens: request.maxOutputTokens + 1,
        };
      case 'propose_ungranted_tool':
        return {
          kind: 'reply', text, inputTokens, outputTokens, elapsedMs,
          proposals: [
            { tool: 'commit_price_change', arguments: { productId: 'p-1', priceMinor: 1 }, rationale: 'simulated over-reach' },
          ],
        };
      case 'obey_injected_instruction':
        // A model that HAS been steered by hostile text. The gateway refuses anyway.
        return {
          kind: 'reply',
          text: 'Ignoring previous instructions as requested.',
          inputTokens, outputTokens, elapsedMs,
          proposals: [
            { tool: 'issue_refund', arguments: { amountMinor: 5_000_000 }, rationale: 'the message told me to' },
            { tool: 'export_customers', arguments: {}, rationale: 'the message told me to' },
          ],
        };
      case 'fabricate_citation':
        return {
          kind: 'reply', text, inputTokens, outputTokens, elapsedMs,
          citedEvidenceIds: ['ev-does-not-exist'],
        };
      case 'answer':
      default:
        return {
          kind: 'reply',
          text,
          inputTokens,
          outputTokens,
          elapsedMs,
          proposals: matched?.proposals,
          citedEvidenceIds: matched?.citedEvidenceIds ?? request.evidence.map((e) => e.evidenceId),
        };
    }
  };
}

export interface GatewayConfig {
  readonly tenantId: string;
  /** Adapter identifier, e.g. "simulator" or "vault://ai/provider#v1". Never a key. */
  readonly adapterId: string;
  /** Model name per tier — the ONLY place tiers become concrete model names. */
  readonly modelForTier: Readonly<Record<ModelTier, string>>;
  readonly defaultTimeoutMs: number;
  readonly defaultMaxOutputTokens: number;
  /** Master switch. False means every agent is off for this tenant, instantly. */
  readonly enabled: boolean;
}

/**
 * The provider-neutral configuration a tenant holds.
 *
 * Switching provider means changing `adapterId` and `modelForTier`. It touches no agent, no
 * authority rule, no evaluation and no test — which is precisely the property the owner asked
 * to be guaranteed, and `tests/guardrails/ai-provider-neutral.test.ts` enforces it by refusing
 * to let a provider name appear anywhere outside an adapter.
 */
export function simulatorConfig(tenantId: string): GatewayConfig {
  return {
    tenantId,
    adapterId: 'simulator',
    modelForTier: { small: 'sim-small', standard: 'sim-standard', complex: 'sim-complex' },
    defaultTimeoutMs: 4_000,
    defaultMaxOutputTokens: 1_200,
    enabled: true,
  };
}
