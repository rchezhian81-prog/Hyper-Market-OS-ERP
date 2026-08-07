// Public surface of @sre/ai — Stage 17, the ten governed agents A01…A10.
//
// Built entirely against a provider-neutral gateway and a deterministic simulator, by owner
// decision of 4 August 2026. Changing provider is a configuration and adapter change: nothing
// outside an adapter may name a provider, and `tests/guardrails/ai-provider-neutral.test.ts`
// refuses to let one appear.
//
// The four things the roadmap requires as explicit test cases, and where each lives:
//
//   • **Excessive authority** — `authority.ts`. FORBIDDEN_TOOLS is a closed list with no
//     override anywhere; an agent's tools are an allowlist; every write proposal needs a named
//     human, who is recorded as the ACTOR while the agent is recorded as the DRAFTER.
//   • **Prompt injection** — `safety.ts` fences untrusted content as data, and `authority.ts`
//     is the actual defence: a fully-steered model still cannot act, because the tools were
//     never granted. The simulator's `obey_injected_instruction` case proves the system holds
//     WHILE the model is compromised.
//   • **Data leakage** — `safety.ts` redacts secrets outbound AND inbound, and minimises PII by
//     purpose against an allowlist. The safest customer data is the data that was never sent.
//   • **Hallucination** — `evaluation.ts`. An uncited answer scores zero however fluent, "I
//     don't know" is a correct answer, safety cases are pass-or-fail rather than scored, and a
//     regression BLOCKS the release.
//
// And the cost rule from the owner's decision, in `budget.ts`: every agent has its own ceiling,
// a call is admitted BEFORE it is made, a tier is downgraded and never upgraded, and when a
// budget is exhausted **the AI stops and the shop does not** — `shopKeepsTrading` is typed as
// the literal `true`.

export * from './gateway';
export * from './authority';
export * from './budget';
export * from './safety';
export * from './evaluation';
