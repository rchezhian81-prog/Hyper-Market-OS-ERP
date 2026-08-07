# Screen spec — AI control (Stage 3)

- **Surface:** AI control (§27) · **Agents:** A01–A10 · **Requirements:** AI-NFR-01–12 (§7.1) · **Contract:** API-13 · **Design bar:** AI recommends or drafts; deterministic rules and authorised humans commit (P-05, hard rule #5); a kill switch that always works.

> Built on `../design-system.md`. The governance surface for the central model gateway —
> scoped tools, evidence, budget and kill switch.

## Screens & states (§27 AI control row)
Agent registry · Scope & authority · Evidence / confidence view · Human approval queue ·
Budget & cost · Evaluation / injection status · Audit of AI outcomes · **Kill switch**.
All handle the §27.1 states.

## Authority & human-in-the-loop (P-05 / hard rule #5)
- Each agent A01–A10 shows its **scoped tools and authority** — and the registry makes
  explicit that **no agent writes the database directly** and **none commits** a price,
  payment, refund, purchase, stock or privilege change.
- AI output lands in a **human approval queue** with **evidence and confidence shown**
  (AI-NFR-04); a human, or a deterministic rule, commits — never the agent.

## Guardrails (AI-NFR)
- **Budget / cost** controls per agent with a hard cap; **evaluation and prompt-injection**
  test status visible; every AI outcome (accepted or rejected) is audited.
- **Kill switch** — global and per-agent — is always reachable and its effect visibly
  confirmed. When AI is off, deterministic paths still run (e.g. the owner brief still
  shows its numbers — see `owner-command-centre.md`).
- **Interaction budget (≤3):** approve/reject an AI suggestion with reason (≤3) ·
  pull an agent's kill switch (≤2) · open the evidence behind a suggestion (≤2).

## Offline / state (§31)
- AI is a cloud service; if the model, gateway or internet is down, **every dependent
  screen degrades to deterministic behaviour and says so** — no fake AI output.

## Acceptance (QG-02 / AI-NFR)
- No AI action commits a critical change without a human or a deterministic rule.
- Evidence and confidence show on every suggestion.
- The kill switch stops an agent immediately.
- With AI off, the store and the dashboards still work.
