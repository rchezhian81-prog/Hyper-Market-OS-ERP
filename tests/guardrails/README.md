# `tests/guardrails/`

Machine-checkable versions of the rules that must never break (`CLAUDE.md` hard rules,
roadmap §18 and §20).

A guardrail is a **tripwire, not a proof**. Each one scans the shipped source for a pattern
that must never appear and fails the suite if it finds one. They exist so that a hard rule
cannot be broken *silently* — a mistake still has to be possible to make, it just cannot be
possible to make quietly.

**Every guardrail asserts two things**, and the second matters as much as the first:

1. the real codebase is clean today; and
2. the detector **fires on a known-bad sample**, so a green result means *"the tripwire
   works and found nothing"* rather than *"the tripwire is broken"*.

| Guardrail | Rule it defends |
| --- | --- |
| `card-data.test.ts` | Hard rule #3 — never store a card number, CVV or expiry; provider tokens only |
| `secrets.test.ts` | Hard rule #4 — no secrets in code, config, images or logs |
| `shared-login.test.ts` | Hard rule #4 — no shared or generic logins |
| `ledger-append-only.test.ts` | Hard rule #2 — ledgers are append-only; a correction is a compensating event |
| `pos-offline.test.ts` | Hard rule #1 — a core POS sale never depends on a network call |
| `ai-agent-db-write.test.ts` | Hard rule #5 — an AI agent never writes to the database directly |
| `plain-text-source.test.ts` | Hard rule #8 — a pull request is only a control if a human can read the diff |

`lib/scan.ts` holds the shared file walker and the line-oriented matcher. By default the
scan surface is `apps/ services/ packages/ edge/ db/ infra/` — the directories that hold
shippable code. `plain-text-source.test.ts` deliberately widens that to `tests/` and
`scripts/` as well: an unreadable diff in a test is worse than one in a module, because the
test is what proves the rule still holds.

## Exemptions

There is exactly one, and it is declared **in the guardrail test itself** rather than as a
magic comment in the exempted file — so removing the exemption is a visible change to the
rule, not a quiet edit to the code it protects. `card-data.test.ts` exempts
`packages/ops/src/logging.ts`, whose redaction denylist must name the card fields in order
to strip them, and guards that exemption with two further tests: the list must stay tiny and
justified, and the exempted file must never declare a field that could actually hold card
data.

`scripts/secret-scan.mjs` additionally scans the **whole repository** — docs and config
included — in the pre-commit hook and in CI.

> Part of the SRE Retail OS repository layout defined in `CLAUDE.md`.

- **`traceability-integrity.test.ts`** — the Definition of Done requires a traceability row for
  every item, which makes `docs/traceability.md` load-bearing: it is what an auditor is handed at
  a quality gate. **A traceability document nobody checks is one that drifts**, always in the
  same direction — a file is renamed, the row still names the old path, nothing fails, and the
  claim stands for a year. This replaces the counting and path-checking that used to be done by
  hand after every stage; a ritual somebody performs is one somebody eventually skips, on the
  stage where they are in a hurry.

  It caught a real defect the day it was written: `scripts/build-pos.mjs`, renamed to
  `build-app.mjs` and never updated in the document. Five further paths were written unqualified
  (`stock/position.ts` rather than `packages/stock/src/position.ts`) — which is exactly how the
  stale one hid, since an unverifiable path cannot be checked.
