# `packages/integration/`

The safe seams between us and the outside world — **M32-FR-01…04** (§30, §31.1, §35, D14,
hard rules #1, #3, #4, #6).

- **`src/api-gateway.ts`** — versioned APIs, service identities, idempotency and signed
  webhooks (FR-01). This module exists because of one fact: **at-least-once delivery means
  every caller will eventually send the same request twice.** A till on flaky 4G retries a sale
  it already committed; a payment provider retries a webhook because our acknowledgement was
  lost; a partner's cron overlaps itself. None of those are bugs at the other end — they are
  the correct behaviour of a network. The bug is ours if the second copy has a second effect.
  - `admitRequest(…)` — a replay returns **the first answer**, not a fresh empty 200. Returning
    nothing is not idempotency: the caller cannot tell whether it worked, so it retries again,
    which is how a duplicate sale reaches a ledger. The stored digest is over a **key-sorted**
    body, so `{a,b}` and `{b,a}` are the same request.
    - **The same key with a different body is a `idempotency_conflict`, not a replay.** That is
      a caller bug, and silently returning the first answer would hide a genuinely lost
      transaction.
    - **A write with no `Idempotency-Key` is refused** (§31.1). Accepting one and hoping is
      what the shop pays for when its till resends a ₹4,000 sale.
    - Idempotency is scoped **per tenant**, and identities carry tenant, branch and scope
      claims — an empty branch claim means the whole tenant, not none.
  - `signWebhook(…)` / `verifyWebhook(…)` — **the timestamp is inside the signature.** A
    signature over the body alone is valid forever, so a captured "payment succeeded" can be
    posted back at will. Fields are joined with an escaped unit separator rather than
    concatenated, because concatenation makes the signature *ambiguous*: `deliveryId "ab" +
    event "c"` and `deliveryId "a" + event "bc"` would otherwise produce the same signature —
    a forgery anybody could construct without the key.
    - A **bad signature** is a security event. A **duplicate delivery id is not** — providers
      genuinely retry when our ack is lost, and calling every retry an attack trains people to
      ignore the alerts.
  - `deprecationNotices(…)` — who is still on a version that is going away, **named rather than
    counted**. A number gets shipped on a Friday; a list of names gets a phone call first.

- **`src/connector.ts`** — the connector SDK (FR-02): the shape the Stage 10 Tally connector
  proved, extracted so every future integration inherits it. What makes integrations rot is not
  any single failure but that failures become **invisible**: a retry loop that never gives up
  looks healthy while nothing moves; a dead-letter queue somebody clears every Monday looks
  empty; a mapping that drops an unrecognised field looks like a clean run.
  - `applyMapping(…)` — **an unmapped source field is an exception, not a dropped field.**
    Dropping it silently is how a tax code stops reaching the accounts package and nobody
    notices for a quarter: the run looks clean, the totals look plausible, and the difference
    turns up at the year end. A lookup miss is refused for the same reason — mapping an unknown
    ledger code to blank produces a journal that posts and is wrong.
  - `drainConnector(…)` — four outcomes, and the differences between them are the module:
    `duplicate` **counts as delivered** (after a timeout the destination usually has it and our
    ack was lost); `permanent` **dead-letters immediately** rather than burning nine retries and
    burying the message that mattered; `retryable` backs off, **bounded**; `throttled` **stays
    queued** — a provider's rate limit is their capacity problem, not a reason to lose our
    message. A message carries **its own connector version**, so one enqueued under v1 is
    delivered under v1 whatever is deployed by the time it drains.
  - `deadLetters(…)` / `requeueCorrected(…)` — **a dead letter is read, never deleted** (hard
    rule #6). There is no `purge`, `clear`, `remove` or `drop` in this package, and a test reads
    the module's own exports to prove it. A failure is resolved by a **new message with a new
    delivery key**; reusing the old key would be indistinguishable from a retry at the
    destination, which is exactly what the correction exists to escape. The original stays,
    marked `supersededBy`.
  - `queueHealth(…)` — **depth alone says nothing.** Twenty messages is fine; twenty that have
    been there since Tuesday is an outage nobody noticed. Measured by age.

- **`src/secrets.ts`** — managed secrets (FR-03). **No secret ever exists in this module.**
  Not a stylistic choice — the types carry a *vault reference* and there is no field, parameter
  or return value anywhere that could hold a value. A test asserts nothing named `reveal`,
  `getSecretValue` or `plaintextFor` exists. The reason is the shape of every credential leak
  that has happened: nobody commits a secret on purpose, they add a field "temporarily" or log
  a config object while debugging — and once a secret *can* sit in a variable it will eventually
  sit in a log line, and a log line is copied into a ticket, a screenshot, a chat.
  - `reviewSecrets(…)` — every finding is phrased **by what the secret protects**, the same
    discipline as an expired AMC in M26: *"secret 14 is 400 days old"* gets scrolled past;
    *"the live payment key has not been rotated in 400 days"* does not. The blocking finding is
    a **revoked secret a live adapter still points at** — that is not hygiene, it is an
    integration that will fail at the worst moment while everybody believes the rotation
    finished.
  - `rotateSecret(…)` / `revokeSecret(…)` — **rotation overlaps; revocation does not**, which
    is why they are two functions rather than one with a flag. A hard cut fails every edge
    device that has not synced. A compromise accepts that breakage — and **names what will stop
    working before it stops**, which is the difference between a controlled incident and a
    morning of people wondering why payments died.
  - `findUsageSignals(…)` — `actionTaken` is typed as the literal `false`. Revoking a credential
    automatically on a traffic spike is how a shop's payment integration dies mid-sale, and the
    spike is usually a promotion. `silent` matters as much as `spike`: an integration that
    stopped calling is one that broke, and **nobody reports the alert that never fires**.

- **`src/adapters.ts`** — the certified matrix (FR-04). The point of a matrix rather than a
  config file is that an uncertified combination is **refused** rather than merely
  undocumented. A cheap thermal printer bought on a Sunday half-works, receipts come out with
  the tax lines missing, and it takes three weeks to connect the complaint to the hardware.
  - `checkDevice(…)` — **the refusal names a working alternative**, because one that does not
    is a refusal somebody overrides on a Sunday when the shop needs a printer. The certified
    matrix only holds if following it is easier than going around it. Wrong firmware says
    *"update it rather than replace it"*.
  - `registerAdapter(…)` — two absolute refusals with no override anywhere. A payment adapter
    declaring it retains anything outside `PERMITTED_PAYMENT_RETENTION` **cannot be registered**
    (hard rule #3) — an **allowlist**, not a list of forbidden field names, so a provider that
    invents a new one next year is refused too. And a credential that is a literal rather than a
    `vault://` pointer is refused (hard rule #4): the repository secret-scan catches those in
    code; this catches the ones typed into a configuration screen, which the scanner never sees.
  - `adapterHealth(…)` / `integrationHealth(…)` — health is **when it last actually worked**,
    not whether it is configured. An adapter failing quietly for nine days is configured,
    enabled and green on any dashboard that reports configuration, and that is the normal way an
    integration dies: not with an outage but with a slow slide nobody measured.
    `posUnaffected` is typed as the literal `true` — **no integration failure may reach the
    till** (P-01, hard rule #1); a cloud adapter being down is a queue getting longer, not a
    shop that has stopped selling.

> Pure and deterministic: the clock, the digest and the transport are all injected; no I/O and
> no secret material at any point. Composes with `packages/platform` (partner authorisation,
> Stage 18), `packages/period-close` (the Tally connector this SDK generalises) and
> `packages/ops` (health, alerts). Tested in `tests/unit/integration-api-gateway.test.ts` (24),
> `integration-connector.test.ts` (24), `integration-secrets.test.ts` (20) and
> `integration-adapters.test.ts` (26), and proven end to end in
> `tests/integration/the-seams-hold.test.ts` (Stage 19 gate). Part of the repository layout in
> `CLAUDE.md`.
