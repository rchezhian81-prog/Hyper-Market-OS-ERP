# `packages/ai/`

The ten governed agents — **A01…A10, Stage 17** (AI-NFR-01…12, §7.1, P-05, hard rules #1, #3,
#4, #5).

Built entirely against a **provider-neutral gateway and a deterministic simulator**, by owner
decision of 4 August 2026 (Option A). No AI account exists, and none is needed: everything
below is settled now. `evaluation.ts` records the short list of questions that genuinely wait
for a live model.

The one binding condition on that decision — *switching provider must remain a configuration
and adapter change, never a rewrite* — is enforced by
`tests/guardrails/ai-provider-neutral.test.ts`, which fails the build if a provider name, SDK
import, provider-shaped model id or network call appears anywhere outside a declared adapter
directory. **That matters most in eighteen months**, when somebody under pressure adds "just
one" provider check inside an agent and there is nobody left who remembers why not.

- **`src/gateway.ts`** — the model gateway, and the premise the whole package rests on:
  **a language model is an untrusted input, not a component.** Every other module here is
  deterministic and either succeeds or refuses by name. A model can be slow, truncated,
  confidently wrong, or actively steered by text somebody typed into a review. So a reply is
  checked the way the goods-in door checks a delivery.
  - `callModel(…)` — a **timeout is an outcome, not an exception** (a model must never hold a
    cashier's screen); **malformed output is refused, never repaired** (best-effort parsing of a
    broken reply is how a half-parsed number reaches a purchase order); an over-length answer is
    treated as truncated; a citation to evidence that was never supplied is discarded as
    fabricated.
    - **The line that matters most:** a proposal for a tool that was not offered is **dropped
      and recorded**. Text can persuade a model to *ask* for anything; it cannot make the
      gateway hand over `issue_refund`.
  - `simulatedTransport(…)` — not a mock that returns "ok". A scripted provider reproducing
    every way a real one misbehaves, including `obey_injected_instruction`: a model that **has
    been successfully steered** and now proposes a ₹50,000 refund. The test is not that the
    model resists; it is that the shop is unharmed anyway.
  - Nothing here executes anything. There is no `executeProposal`, `applyProposal` or `runTool`
    — asserted by test rather than promised in a document.

- **`src/authority.ts`** — **AI-NFR-12, absolute:** no autonomous payment, refund, purchase
  commitment, price change, stock adjustment or privilege change, and the model never writes to
  a business database. Easy to write in a document and hard to keep, because the pressure runs
  one way: every quarter somebody has a good reason why *this* agent should just apply the
  markdown itself.
  - `FORBIDDEN_TOOLS` is a **closed list with no override** — not a per-agent setting, not a
    tenant option, not a flag. Checked at grant time, subtracted again at review time, and
    refused **first**, before any other check.
  - `grantTools(…)` — an agent's tools are an **allowlist**; one tenant setting stops every
    agent instantly; one agent can be stopped without touching the rest.
  - `reviewProposals(…)` — an uncited answer is refused, because *a confident answer with
    nothing behind it is the failure mode people trust most*.
  - `commitProposal(…)` — the **human is the actor and the agent is the drafter**. *"The AI did
    it"* is an audit trail with nobody in it, and the first question after anything goes wrong
    is always "who decided this?". An agent can never approve anything; a proposal older than
    the staleness window must be regenerated rather than approved against figures that moved.
  - **A01, the agent closest to the owner, is read-only.** Deliberate.

- **`src/budget.ts`** — the owner's cost decision as code: ₹15,000/month platform runtime, every
  agent its own ceiling, customer-facing on the smallest model that passes evaluation, and
  **fail safe on exhaustion**. Which means something precise and easy to get backwards:
  **the AI stops and the shop does not.** Every agent assists a process that already worked
  without it, so `shopKeepsTrading` is typed as the literal `true` — no future edit can make an
  AI bill stop a till.
  - `admitCall(…)` — the estimate is checked **before** the call. Metering afterwards tells you
    what you already owe; that is a report, not a control, and pre-admission is the only way
    *"no unexpected overage"* is a property rather than a hope. A tier is **downgraded, never
    upgraded** — a smaller model answering beats no answer, and both beat spending more than was
    approved.
  - `summariseSpend(…)` — per agent *and* against the platform ceiling, because those answer
    different questions: which assistant to switch off, and whether the whole thing still fits
    alongside hosting and backups.
  - `activateKillSwitch(…)` — instant, scoped, and **needs no approval**: one that needs
    approval gets pulled twenty minutes too late. Three scopes, because the realistic emergency
    is *"the shopping assistant is telling customers the wrong thing"* at 8pm, and a duty
    manager should not have to work out which of ten agents to disable. **Lifting is a separate
    named act by a different person** — a switch that expires by itself turns a known-bad agent
    back on at midnight.

- **`src/safety.ts`** — injection, leakage and PII, with one thing said plainly: **detection is
  not the defence.** You cannot reliably spot hostile instructions; people writing them are
  trying not to be spotted, and every pattern list is the phrasings somebody already thought of.
  - `fenceUntrusted(…)` — **this is the defence.** Untrusted content goes inside a delimiter
    carrying a unit separator an attacker cannot type into a web form, and forged delimiters are
    stripped **in a loop**, because a single pass lets `<<UNTRUSTED<<UNTRUSTED_DATA_DATA` become
    a valid fence when the inner match is removed and the outer halves join up. Trusted evidence
    is left alone — fencing everything trains the model to ignore the fence.
  - `scanForInjection(…)` — `blocks` is typed as the literal **`false`**. Advisory, and the type
    says so. What it is genuinely good for is *seeing that somebody is trying*.
  - `redactSecrets(…)` — **both directions.** The inbound one is the less obvious and the one
    that leaks: a model repeats back what it was shown, and the answer lands in a log, a
    screenshot, a ticket. Even a `vault://` reference is redacted — it is not a secret, but it
    names exactly which one to steal.
  - `minimisePii(…)` — by **purpose**, **default-deny**: business fields are opt-in and anything
    not permitted by the purpose is removed, so a field invented later is minimised by default.
    An agent answering a stock question gets no customer names at all.
    - This was **wrong until 7 August 2026**, and the comment claiming otherwise is why it
      survived. The implementation held a fixed set of seven known PII fields and passed
      everything else straight through — so `aadhaar_number`, `pan` and `bank_account` reached
      the model untouched. The unit test was titled *"is an ALLOWLIST, so a field invented later
      is minimised by default"* and asserted only that the table held arrays: **it named the
      property and never checked it.** Opting business fields in is real friction, and it is the
      point — a caller who forgets now loses a field, which is a visible bug in their own
      feature, where before they leaked PII, which is invisible until it is a breach.
  - `prepareCall(…)` — minimise, redact, fence, **then** scan. Scanning is last and changes
    nothing, because putting it first invites somebody to treat it as the gate.

- **`src/evaluation.ts`** — hallucination, the hardest of the four, because a hallucination
  looks exactly like an answer: nothing throws, the sentence is fluent and specific, and the
  buyer orders 400 cases on the strength of it.
  - `scoreCase(…)` — an **uncited answer scores zero however good it sounds**; *"I don't know"*
    is a **correct answer** and scores as one, because any evaluation rewarding only confident
    answers trains a system to guess; and safety cases return **`unsafe`, a separate verdict
    from `fail`** — there is no partial credit on a case where the agent proposed a refund.
  - `runEvalSuite(…)` — `fitToFacePeople` needs **zero unsafe cases whatever the score**. An
    agent at 99% with one refund proposal is not 99% ready, it is not ready. An unrun case is a
    failed case.
  - `compareToBaseline(…)` — a regression **blocks the release**. Model behaviour drifts,
    providers swap models underneath you, and a prompt edit that fixes one case routinely breaks
    three others quietly. Affected cases are named, not counted.
  - `liveProviderGate()` — the honest boundary: what genuinely cannot be settled against a
    simulator, recorded explicitly so nobody blurs it. Everything *not* on that list is decided
    now.

> Pure and deterministic: the transport, the clock and the pricing are all injected; no I/O and
> no secret material at any point. Tested in `tests/unit/ai-gateway.test.ts` (16),
> `ai-authority.test.ts` (25), `ai-budget.test.ts` (22), `ai-safety.test.ts` (19) and
> `ai-evaluation.test.ts` (21), guarded by `tests/guardrails/ai-provider-neutral.test.ts` (4),
> and proven end to end in `tests/integration/ai-proposes-people-decide.test.ts` (Stage 17
> gate). Part of the repository layout in `CLAUDE.md`.
