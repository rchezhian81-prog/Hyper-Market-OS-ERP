# Stage 18 gate evidence — two shops, one system

**Gate:** roadmap Stage 18 — multi-branch and innovation. Module M36 (all four FRs), plus the
R8 innovation wave: self-checkout and scan-and-go (D04), shelf/POS/app/ESL price integrity
(D06), and ESL/IoT readiness (D14).

**Executed:** 4 August 2026 against **PostgreSQL 16.13**. Automated as
`tests/integration/two-shops-one-system.test.ts` (20 assertions), run in CI against a real
PostgreSQL service container, and **verified repeatable** (run three times, green three times).

The claim on trial: **two shops run on one system, neither can see the other, and nothing the
vendor does can stop either of them trading.**

---

## The setup

SRE Hyper Market and Kumar Stores run on the **same deployment, the same binary and the same
database**. SRE is on the Growth plan and runs a concession counter; Kumar is on Standard and
does not. They see different brands, different features and different bills.

---

## Two shops, one system

### 1. Isolation (M36-FR-01)

| # | What happens | Control proven |
|---|---|---|
| 1 | Both shops close their trading day and bank it | **One append-only ledger, one stream name** (`daysummary/…`) — only the tenant column separates them, which is exactly the isolation under test |
| 2 | Each reads its own stream back | SRE gets ₹4,120.00, Kumar gets ₹965.00. Neither sees the other's row |
| 3 | A result set carrying one foreign row | **The whole result set is refused** and reported as a `criticalDefect`, not trimmed — the silently-trimmed version is the one nobody ever investigates (§35) |
| 4 | A query with no tenant context at all | **Refused.** *"An unscoped query is how every one of these incidents starts"* |
| 5 | Kumar asks for the concession module | **Not entitled** — *"that is a sales conversation"* |
| 6 | A tenant suspended for non-payment asks for B2B | **Suspended** — *"that is a billing conversation"*. Two different answers on purpose: a support engineer who cannot tell them apart wastes an afternoon on the wrong one |
| 7 | The Stage-5 entitlements engine, cross-checked | Concession on for SRE, off for Kumar, **no bleed** |

### 2. Nothing we do stops either shop trading (M36-FR-01, P-01)

| # | What happens | Control proven |
|---|---|---|
| 8 | Kumar opens two extra tills for Diwali week — 7 lanes on a 4-lane plan | **`mayContinueTrading` is typed as `true`.** Not a boolean that happens to be true — the type. No code path here, and no future edit to this file, can close a shop on a Saturday |
| 9 | The lane overage | Metered at its **peak: 7 tills, not 15.** Metering a peak as a sum would bill a shop thirty times for the same four tills. ₹9,000 of overage, ₹24,000 total |
| 10 | Transactions at 58,000 of a 60,000 limit | **Notified before the invoice was** |
| 11 | SRE's usage sitting in the same table | Never touches Kumar's invoice |
| 12 | SRE considers dropping from Growth to Standard | **Allowed** — trapping a struggling tenant on a plan they cannot pay for helps nobody |
| 13 | What the downgrade costs them | B2B, the customer app and the concession module go dark; two limits are already exceeded — and **"No data is deleted"** is stated on the face of it |

### 3. One deployment, two brands (M36-FR-02)

| # | What happens | Control proven |
|---|---|---|
| 14 | Both shops render their own product name, colours and template set | **From one binary.** No fork — the moment branding needs a fork, every fix applies N times and within eighteen months nobody knows which customer runs which version |
| 15 | Kumar's branding offered against SRE's tenant id | **Ignored**, and neutral defaults used. This is the failure that has a retailer invoicing under a competitor's mark |
| 16 | A brand-new tenant with nothing set | **Neutral**, never the last tenant rendered. The fallback is rebuilt fresh each call so there is no shared object to leak through |
| 17 | "Branch closing time" for each shop | *"Store closing time"* and *"Showroom closing time"* |
| 18 | A tenant renames "tax invoice" to "bill" | **Blocked** — *"a document that calls a tax invoice something else is not a tax invoice"* |
| 19 | The same rename slipping past validation into rendering | **Refused a second time.** Validation and rendering are separated by a database and a year |
| 20 | Brand colours at 1.6:1 contrast | **Blocked** — *"a cashier who cannot read the total at 8pm is a support call every day for a year"* |

### 4. A shop can leave (M36-FR-03)

| # | What happens | Control proven |
|---|---|---|
| 21 | An export missing the finance domain | **Fails.** *"Half a dataset handed over as 'your data' is worse than a refusal — the customer finds out months later"* |
| 22 | A domain that legitimately has no rows | **Present and zero.** Absence and emptiness are different facts, and only one is reassuring |
| 23 | Another tenant's file in the bundle | **The whole export is refused**, not shipped with a note |
| 24 | Closure requested before the export was taken | **Refused** — the last easy moment to get their data, and three weeks later it is a conversation nobody wants |
| 25 | Closure with nobody's name against it | **Refused.** Closing ends a business relationship (§28) |
| 26 | Closure, properly | Access revoked; **sales and tax records retained until 2034-03-31 under the Income Tax Act 1961**, and **audit evidence retained indefinitely** (hard rule #6) |
| 27 | An additive API change | **Safe to deploy** |
| 28 | A removal announced yesterday | **Still breaking.** *"The announcement is not the mitigation, the elapsed time is"* |
| 29 | The same removal after a 14-month window | **Still refused — SRE is still calling it**, named rather than counted. *"3 tenants affected"* gets deployed on a Friday |
| 30 | Making an optional field required | **Breaking.** It looks additive on a diff and is the change that most often takes a partner integration down |

### 5. A partner builds on the sandbox (M36-FR-04)

| # | What happens | Control proven |
|---|---|---|
| 31 | A partner builds against the sandbox on `API-06 orders v3` | Works |
| 32 | The same call, same version, against a real shop | **Works unchanged — no SRE code change in between.** That is the acceptance criterion, met literally |
| 33 | A sandbox key presented against production | **Refused and recorded as a security event**, whether it was a mistake or not (hard rule #7) |
| 34 | Production data offered as a sandbox seed | **The whole seed is refused** — *"realistic data is generated, never copied, whatever the reason given"* |
| 35 | The partner reaches for Kumar, who never engaged them | **Refused, security event.** *"An implementation partner for one retailer does not hold a key to every retailer"* |
| 36 | A call with no API version | **Refused, not defaulted to latest** — *"defaulting is what breaks a partner integration on the morning we ship"* |
| 37 | A retired version | Refused, with the retirement date |
| 38 | A connector certified against v2 while v3 is current | **`stale_version` — "old with a badge".** It keeps running, because pulling a working integration out of a live shop over paperwork is worse than the risk |
| 39 | A connector never certified at all | **Cannot reach production.** *"Somebody else's untested software holding our customers' data"* |

### 6. The innovation wave on the shop floor (D04, D06, D14)

| # | What happens | Control proven |
|---|---|---|
| 40 | An ordinary two-item basket at self-checkout | **Pays and leaves.** No intervention |
| 41 | A bag left on the scale — 900g against 400g expected | The customer sees *"please wait — a colleague will be with you"*; the attendant sees *"usually a bag or a hand on the platform — **check, do not accuse**"* |
| 42 | Beer scanned | **Always a human.** *"The lane cannot clear this and never will"* |
| 43 | Five loose-produce lines — the banana trick | **Scored and watched, and the customer is NOT held up.** The attendant is told to *"glance at the produce, and say nothing about it"* |
| 44 | *(why both ways round)* | A lane that halts on everything sits empty; a lane that watches nothing is a shrinkage hole. Patterns are the office's business, not the lane's |
| 45 | A trusted scan-and-go trip | Walks out |
| 46 | An age-restricted item in a scan-and-go basket | **Ends the trip at a staffed till, full stop** |
| 47 | Two audits that found something missing | **Trust withdrawn, and the customer is told plainly** — *"a scheme that fails people mysteriously loses them for good"* |
| 48 | A price kiosk on a 33-hour-old list | **Stops quoting.** *"Check the price at the counter"* — a kiosk quoting yesterday's promotion is worse than no kiosk |
| 49 | A shelf label ₹4 **below** the till, on 2 units sold | **Top of the list, regardless of value** — the displayed price is what the customer was offered (Legal Metrology) |
| 50 | A shelf label ₹50 **above** the till, on 100 units — ₹5,000 | **Second list.** Real money, no legal exposure |
| 51 | An electronic label silent for nine days | **`esl_unreachable`, naming `esl-118` at shelf `C-01-2`** — *"it is showing whatever it was last told, and it will keep showing it"* |
| 52 | A product on sale with no shelf label at all | Flagged |
| 53 | A price rise pushed to two labels, one confirms | **The till is held.** Fire-and-forget would *create* the overcharge risk the audit exists to catch |
| 54 | Both labels confirm | The till may change |

### 7. And it is all banked

| # | What happens | Control proven |
|---|---|---|
| 55 | Both tenants' platform events written | One ledger, read back per tenant |
| 56 | `DELETE` and `UPDATE`, on each tenant's rows | **The database itself refuses** (migration 0004) |
| 57 | After a tenant is closed | The ledger is **still there**. Closure revokes access; it does not, and cannot, delete evidence |

---

## The four things this stage refuses to let happen

**One shop seeing another.** Every layer already scopes by tenant — the database column, the
session, the portals. This stage adds the assertion that fires when all of those fail, and it
refuses the **whole result set** rather than trimming it, because a query that silently returns
fewer rows than expected is a bug nobody investigates until a customer finds it.

**A vendor closing a shop.** A metered limit is a commercial fact. Enforcing it at the lane
turns it into "upgrade or stop trading", taken automatically at the worst possible moment by
code with no idea what is happening in the shop. `mayContinueTrading` is typed as `true` so
that no future edit can change this by accident.

**Branding through a fork.** One codebase, one deployment, many brands — and an unset brand
falls back to neutral rather than to whoever was rendered last. The words the law names cannot
be renamed at all, and that is checked twice.

**A customer trapped.** An export is complete or it is not an export, checked against the
platform's own domain list so the exporter cannot fall behind the product. Closure respects
statutory retention rather than honouring a delete request that would become our problem. And
audit evidence survives all of it.

## Repeatability

Run-scoped prefix (`RUN = t<base36 timestamp>`) through every event, export, credential and
basket id, with reads filtered by it — the suite runs any number of times against the same
append-only database and asserts only on its own events.

## Verdict

**Stage 18 gate: PASSED.** Two shops trade on one system without seeing each other, a shop
that outgrows its plan is invoiced rather than stopped, two brands render from one binary, a
shop that wants to leave gets everything and the law still gets what it needs, a partner's
sandbox work runs unchanged against a real shop, and the shop floor gets self-checkout that
helps rather than accuses and shelf labels that must agree with the till before it charges.

## What the owner should check in the store

1. **Ask to see the system running for a second, imaginary shop.** It should look like a
   different product — different name, different colours, different modules — from the same
   installation. If anyone says a second customer needs "a copy of the code", that is the
   answer this whole stage exists to prevent.
2. **Ask what happens if you outgrow your plan during Diwali week.** The correct answer is *"you
   get an invoice"*. If the answer is *"the tills stop"*, do not sign.
3. **Ask for your data as if you were leaving tomorrow.** You should get everything, in files
   another system can read, with a checksum on each one — not a set of PDFs.
4. **Stand at a self-checkout and put your bag on the scale.** The screen should say a colleague
   is coming. It must not say anything about an unexpected item, a check, or a problem — the
   lane is in public.
5. **Try to buy beer at the self-checkout.** It must always fetch a person. There is no setting
   that changes this.
6. **Walk the aisle with a scanner and compare three shelf labels with the till price.** Any
   label showing *less* than the till charges is the one to fix today — you must honour the
   shelf price, so it is a legal matter, not a margin one.
