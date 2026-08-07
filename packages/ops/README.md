# `packages/ops/`

Observability — **M35-FR-03/04 / P-08 / SEC-04 / hard rules #3 and #4**. Stage 5 work: the
roadmap builds this *before* features, because you cannot operate what you cannot see.

## Health is computed from evidence (`src/health.ts`)

The failure this exists to prevent is specific:

> Everything looks green. The store keeps trading. The till keeps printing. And **41 sales
> have not reached the cloud since 11am**, because one poison message stalled the queue
> behind them.

Nobody finds that on a screen full of green ticks. So health is derived from **evidence** —
the age of the last successful sync, queue depth, dead letters, catalogue age, backup age —
and a component with **no signal is `unknown`, never `ok`**. The absence of a heartbeat is
not a heartbeat.

One deliberate asymmetry: **degraded is not down.** `canTrade` is separate from `status`,
because losing the cloud must never read as "stop selling" (P-01). The **only** signal that
stops a lane is `localStoreWritable: false` — a lane that cannot record a sale must not take
one, since an unrecorded sale is worse than a refused one.

Every threshold is per-tenant; the defaults come from roadmap §32 (cloud RPO ≤ 15 min).

**Alerts have a named person, not a team** (the same rule as compliance obligations), an
acknowledgement deadline (§32: 15 minutes), and an escalation path — and when nobody is
configured above the owner, the alert says *that*, rather than silently going nowhere.

## Logs are where secrets escape (`src/logging.ts`)

Not through a breach — through a well-meaning `log.info('request', req)` written at 2am,
which ships a card number into an aggregator a dozen people can read. The usual defence is a
code-review rule, and it fails, because it depends on everyone remembering forever.

So this logger **redacts by construction**:

| Case | Behaviour |
|---|---|
| Field named like a secret (`password`, `token`, `authorization`, `otp`…) | Removed, at any depth, any casing |
| A **value** that is a card number, under an innocent field name | Removed — `{ reference: '4111…' }` is the real-world leak; nobody calls it `cardNumber` when they leak it |
| A 16-digit order id | **Kept.** The Luhn check distinguishes a PAN from an ordinary long number |
| Personal data (phone, email) | **Masked, not removed** — `98****3210` — so support can still correlate "the same customer" without reading who it is |
| The log message itself | Redacted too; a PAN interpolated into a string is the commonest leak of all |

Redaction never reports what it removed — a line saying "redacted a value starting with
4111" would defeat the purpose, and a test asserts that.

> The repository's `card-data` guardrail carries **one narrow exemption** for this file,
> declared in the guardrail test itself: to redact a field called `cvv`, the word must
> appear in the denylist. A further test proves the file **never declares a field to hold**
> card data — it only names fields to strip.

Pure and deterministic — the timestamp is injected, the sink is a port. Tested in
`tests/unit/ops-health.test.ts` (14) and `tests/unit/ops-logging.test.ts` (13).
