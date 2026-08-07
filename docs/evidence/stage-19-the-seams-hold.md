# Stage 19 gate evidence — the seams hold

**Gate:** roadmap Stage 19 — operate and improve. Module M32 (all four FRs), with the M33 and
M35 operational surfaces they feed.

**Executed:** 4 August 2026 against **PostgreSQL 16.13**. Automated as
`tests/integration/the-seams-hold.test.ts` (15 assertions), run in CI against a real PostgreSQL
service container, and **verified repeatable** (run three times, green three times).

The claim on trial: **the seams hold, and the till never notices.**

---

## One evening of integration traffic

### 1. A till on flaky 4G resends a sale it already committed (M32-FR-01)

| # | What happens | Control proven |
|---|---|---|
| 1 | Lane 3 commits a ₹4,120 sale locally at 18:42 and syncs it | Accepted, banked once |
| 2 | The connection drops; the till sends it again | **The FIRST answer is returned** — same receipt number, no second effect |
| 3 | It sends it a third time, with the JSON fields in a different order | Still a replay. The digest is over a **key-sorted** body, so `{a,b}` and `{b,a}` are the same request |
| 4 | *(why the first answer matters)* | A fresh empty 200 leaves the till unable to tell whether it worked, so it retries again. **That is how a duplicate sale reaches a ledger** |
| 5 | The ledger, checked in PostgreSQL | **One sale. Not three** |
| 6 | The same key reused for a genuinely different ₹990 sale | **Conflict, not a replay** — silently returning the first answer would hide a lost transaction |
| 7 | A write with no idempotency key at all | **Refused.** *"Accepting one and hoping is how a till that resent a sale puts it in the ledger twice"* |
| 8 | An old lane build calling a retired version | **Refused cleanly**, naming where to go: *"move to v1 or v2"* — a vague 400 is what has somebody guessing at midnight |
| 9 | Two callers still on the deprecated version | **Named, not counted.** *"Telephone them, do not count them"* |

### 2. The payment provider replays a webhook (M32-FR-01)

| # | What happens | Control proven |
|---|---|---|
| 10 | A signed `payment.succeeded` arrives 30 seconds after the sale | Accepted |
| 11 | Our acknowledgement is lost, so the provider sends it again | **Replay, and NOT a security event** — providers genuinely retry, and calling every retry an attack trains people to ignore the alerts |
| 12 | Somebody captures that delivery and posts it back six hours later | **Refused as `too_old`, and it IS a security event.** The timestamp is inside the signature, so a valid signature replayed later is still catchable |
| 13 | The amount edited from ₹4,120 to ₹41,200 in flight | **Bad signature, security event** |
| 14 | *(the design point)* | Fields are joined with a separator rather than concatenated: otherwise `deliveryId "ab" + event "c"` and `deliveryId "a" + event "bc"` sign identically — a forgery anybody could construct without the key |

### 3. Tally rejects a journal (M32-FR-02)

| # | What happens | Control proven |
|---|---|---|
| 15 | A clean sales journal maps to Tally's field names | `LEDGERNAME` = "Sales Account" |
| 16 | A cess line nobody wrote a mapping rule for | **Refused, not dropped.** *"Silently dropping them is how a tax code stops reaching the accounts package for a quarter"* |
| 17 | A ledger code the lookup has never seen | **Refused** — *"mapping an unknown code to blank produces a record that posts and is wrong"* |
| 18 | Tally rejects the journal: ledger does not exist | **Dead-lettered on attempt 1, not 5.** Nine retries with backoff burns forty minutes and buries the message that mattered |
| 19 | A dropped connection on a different journal | **Backs off 2 seconds**, bounded |
| 20 | Tally replies "voucher already exists" | **Counts as delivered.** It has the message; our ack was lost |
| 21 | Tally rate-limits us | **Stays queued.** *"A provider's capacity problem is not a reason to lose our message"* |
| 22 | The dead letter sits overnight | The queue reports `needsAttention` — *"read, never deleted (#6)"* |
| 23 | Finance corrects it, reusing the original key | **Refused** — at Tally it would be indistinguishable from a retry, which is what we are escaping |
| 24 | Finance corrects it with a NEW key | Queued. **The original failure still stands**, marked `supersededBy`, with its error text intact |
| 25 | A queue with one message sitting since 15:00 | **Flagged by AGE.** *"Depth alone says nothing; a queue that is neither growing nor moving is an outage nobody noticed"* |

### 4. A key is rotated, and another is leaked (M32-FR-03)

| # | What happens | Control proven |
|---|---|---|
| 26 | The payment key has not been rotated in 216 days | Reported as *"the key protecting **card payments at every till** has not been rotated"* — not *"secret 14 is 216 days old"* |
| 27 | A rotation with no overlap | **Refused.** It would fail every edge device that has not synced — *"if this is a compromise, revoke it and accept the breakage deliberately"* |
| 28 | A rotation with 7 days' grace | v5 active, v4 **superseded not revoked**, valid until 2026-08-12 |
| 29 | A webhook signing key is pasted into a support ticket | **Revoked immediately**, and the two adapters that **STOP WORKING NOW** are named before it happens |
| 30 | A week later, one adapter was never repointed | **Blocking finding.** *"It will fail at the worst moment while everybody believes the rotation was finished"* |
| 31 | A partner's traffic goes from 200 calls to 9,000 | Surfaced, `actionTaken: false` — *"revoking on a spike kills a payment integration mid-sale"*, and the spike is usually a promotion |
| 32 | 90 of 400 lane calls start failing | Error surge surfaced |
| 33 | The shelf-label feed stops calling entirely | **`silent`** — *"an integration that went quiet is an integration that broke, and nobody reports the alert that never fires"* |

### 5. Hardware and providers at the door (M32-FR-04)

| # | What happens | Control proven |
|---|---|---|
| 34 | Somebody buys an uncertified scanner on a Sunday | **Blocked, and the refusal names Honeywell and Zebra.** A refusal with no alternative is one somebody overrides |
| 35 | A certified Zebra on old firmware | *"Update it rather than replace it"* |
| 36 | The certified scanner | *"Runs at the store edge, no cloud in the path of a scan"* |
| 37 | A payment adapter declaring it keeps the full card digits | **Refused outright, with no override anywhere** (hard rule #3) |
| 38 | *(why an allowlist)* | A blocklist only refuses field names somebody thought to write down. `PERMITTED_PAYMENT_RETENTION` refuses whatever a provider invents next year too |
| 39 | A payment provider not recorded as RBI-authorised | **Refused** — *"tokenisation from an unauthorised gateway is somebody else's promise about the customer's card"* |
| 40 | A live API key typed into a configuration screen | **Refused** (hard rule #4). The repository scanner never sees a settings page |

### 6. And the till never notices (P-01, hard rule #1)

| # | What happens | Control proven |
|---|---|---|
| 41 | Tally last worked five hours ago; the ESL feed has never reported at all | Both **`silent`** — *"'configured' is not health"* |
| 42 | The cloud database is unreachable, 41 items queued, 1 dead-lettered | `checkHealth` says **not ok** |
| 43 | The store edge is writable | **`canTrade: true`** |
| 44 | The integration report | **`posUnaffected` is typed as the literal `true`** — *"the till is unaffected either way"* |
| 45 | The owner's status centre | Same computation, not a cheerful status of its own. Names the problem, never says "stop selling" |

### 7. Banked, idempotently, and undeletable

| # | What happens | Control proven |
|---|---|---|
| 46 | Six integration events written to PostgreSQL | Replay served, webhook rejected, connector dead-lettered, correction queued, secret revoked, device refused |
| 47 | The first event re-sent | **Six rows, not seven** — the ledger applies the same rule the API does |
| 48 | `DELETE` and `UPDATE` on the ledger | **The database itself refuses** (migration 0004) |

---

## The four things this stage refuses to let happen

**A duplicate effect from a duplicate request.** At-least-once delivery is not a defect to be
worked around; it is the guarantee. So a replay returns the first answer, an unkeyed write is
refused, and a reused key with different content is a conflict rather than a quiet lie.

**A failure that becomes invisible.** An unbounded retry loop, a dead-letter queue somebody
clears on a Monday, a mapping that drops what it does not recognise, an adapter that has not
worked in nine days but is still "configured" — every one of these looks healthy. Each is
measured by the thing that actually matters: whether anything moved, and when it last worked.

**A secret in a variable.** Not a policy but a shape: the types cannot hold one. Rotation
overlaps so it is safe to do routinely; revocation does not, and names its casualties in
advance.

**An integration failure reaching a customer.** Every seam here queues, refuses or reports.
None of them can stop a sale, and `posUnaffected: true` makes that a property of the code
rather than an intention in a document.

## Two defects the guardrails caught while building this

Both were caught by tripwires written in earlier stages, and both were real:

- **A raw `0x1F` byte** got into `api-gateway.ts`, which would have rendered the file's diff as
  *"Binary files differ"* in a pull request — a hole through hard rule #8. The Stage 8
  `plain-text-source` guardrail caught it, and fixing it exposed a **second, worse** problem:
  the webhook signature was concatenating its fields, which makes it **ambiguous** and forgeable
  without the key. Both fixed; the separator is now an escape with the reason written beside it.
- **The card-data guardrail** fired on a type that listed forbidden card fields by name. The
  fix was better than the original: a **default-deny allowlist** of what a payment adapter may
  keep, which refuses field names nobody has thought of yet.

## Repeatability

Run-scoped prefix (`RUN = u<base36 timestamp>`) through every sale, delivery, message, secret
and event id, with reads filtered by it — the suite runs any number of times against the same
append-only database and asserts only on its own events.

## Verdict

**Stage 19 gate: PASSED.** A resent sale banks once, a captured webhook cannot be replayed, a
rejected journal dead-letters visibly and is corrected without ever being deleted, a leaked key
is revoked with its casualties named, an uncertified scanner is turned away with an alternative,
a payment adapter cannot keep a card number — and through all of it the till keeps selling.

## What the owner should check in the store

1. **Unplug the internet during a sale, finish it, and plug it back in.** One sale must appear
   in the system, not two. This is the single most important check in this stage.
2. **Ask what happens when Tally rejects something.** The right answer is *"it goes in a list
   somebody works through"*, never *"it retries until it works"* and never *"we clear the list
   on Mondays"*.
3. **Ask to see the rejected-items list.** There must be no button that empties it. Fixing one
   means sending a corrected copy; the original failure stays on file.
4. **Ask where the payment key is kept.** The answer must be a vault, not a settings screen and
   not a file. Ask when it was last changed.
5. **Try to connect a scanner nobody has approved.** It must be refused *and* tell you which
   ones to buy.
6. **Ask whether the shop can sell when the cloud is down.** It must be yes, every time. If any
   integration can stop a till, that is the answer this stage exists to make impossible.
