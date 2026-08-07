# Cross-cutting hardening — performance shape and accessibility

**Covers:** §32 (quantitative targets), **NFR-02** (POS p95, no network on the local sale path),
**NFR-03** (durability, sync once), **NFR-07** (WCAG 2.2 AA), **NFR-13** (interaction budget),
**QG-05**. Principles **P-01**, **P-08**; **hard rules #1, #6**.

**Executed:** 5 August 2026. `tests/performance/` (19 assertions) and `packages/a11y/`
(45 assertions), all green, and the performance suite **verified stable across three runs** —
a flaky performance test gets its threshold raised until it is measuring nothing.

---

## Part 1 — performance: shape, not speed

### The honest boundary, stated first

§32 gives its POS targets **"on certified pilot hardware"**. That hardware is EX-09 and does not
exist. So **no test in this repository can certify *"scan-to-line p95 ≤ 300 ms"***, and a green
tick against 300 ms measured on a CI container would be worse than no measurement at all — it is
exactly the evidence somebody quotes at the pilot when the lane turns out to be slow.

`againstBudget(...)` therefore returns **`certifiesTheTarget` typed as the literal `false`**, for
the same reason `shopKeepsTrading` is typed `true` elsewhere: it is the claim somebody will
otherwise make on the test's behalf in eighteen months. `certifiedHardwareGate()` records the six
items that genuinely need the store, in the same spirit as the AI package's
`liveProviderGate()` — the boundary between settled and pending has to be written down, or it
gets blurred by whoever needs it blurred.

### What *is* settleable, and why it is the part that matters

A scan path that is **O(n) in catalogue size** blows the budget on real hardware however fast the
machine is. That regression is hardware-independent, it is the one that actually reaches
production — somebody replaces a `Map.get` with an `Array.find` during a refactor — and every
existing test still passes on a 240-product fixture.

Measured on this class of machine, at 100× the data:

| Implementation | 500 products | 50,000 products | Growth |
|---|---|---|---|
| `Map.get` (what ships) | 0.000373 ms | 0.000705 ms | **1.9×** |
| `Array.find` (a deliberate regression) | 0.088 ms | 12.0 ms | **136×** |

The gap is two orders of magnitude, which is why a **ratio** is assertable on unknown hardware
when an absolute figure is not. The verdict bands are derived from that measurement rather than
chosen for convenience, and the reasoning sits in the code beside them.

| # | What is proven | Why it is the failure that matters |
|---|---|---|
| 1 | Scan cost is **flat** across 100× catalogue growth | The regression a fast machine hides completely |
| 2 | **The harness FIRES on a deliberate linear scan** | Without it, `measureComplexity` could return `flat` unconditionally and every other test here would still pass |
| 3 | A **miss** costs the same as a hit | A mis-scan that walks the catalogue freezes a queue on a Saturday |
| 4 | Cache build is linear, not quadratic | It happens once at lane start; quadratic turns two seconds into three minutes |
| 5 | A 200-line basket is linear in **its own lines** | Re-summing every line on every add is invisible on a 5-item test basket and painful on a trolley shop |
| 6 | Commit runs with `fetch`, `XMLHttpRequest` and `WebSocket` **removed from the runtime** | Hard rule #1, enforced by absence rather than by a mock that records calls |
| 7 | Commit cost is **independent of how much the lane has already sold** | The classic append-only mistake: fine at 9am, unusable at 7pm, and only visible on the busiest evening |
| 8 | Outbox enqueue and dedupe are **flat at 100× queue depth** | A queue that degrades with its own depth fails on day three of an outage, with nobody watching |
| 9 | 72 hours of this shop's trading held without degradation | P-01's offline minimum, as arithmetic |
| 10 | A 24-hour backlog drains **in order, exactly once**, in 24 rounds not 2,400 | A drain that reorders puts a 7am sale behind a 7pm one and makes the day briefly unreconstructable |
| 11 | A dead-lettered item stays **counted** | Hard rule #6 and P-08: a backlog that shrinks because items failed is worse than one that does not shrink, because the badge goes green while the sales are still not in the cloud |

### A defect the tripwire caught — in the measurement

The first version of the deliberate-linear-scan control **reported `flat`**, which would have
meant every complexity assertion in the folder was worthless.

The cause was in the test, not the code: lookups used `i % n`, so with 300 iterations against
50,000 products it only ever asked for the first 300 — and a linear scan found its match at
roughly the same *absolute* position whatever the catalogue size, and never got slower. Fixed
with a prime stride so the working set stays proportional to the data, which is also the honest
cache behaviour for the `Map`.

**This is the entire argument for the tripwire.** A performance assertion nobody has seen fail is
an assertion nobody should trust.

---

## Part 2 — accessibility: a shipped defect, and three sentences made enforceable

### The defect

The design system has required **contrast ≥ 4.5:1** since Stage 3. The maths lived privately
inside `packages/platform/src/branding.ts`, and it carried relative luminance **in hundredths** —
matching this codebase's integer discipline for money (§29.1).

Luminance is not money. It is a physical ratio in 0…1, and two decimal places throws away most of
the resolution exactly where contrast maths is most sensitive.

| Pair | Computed | Actual | Effect |
|---|---|---|---|
| white on `#777777` | 4.57:1 | **4.48:1** | **Published as accessible. It is not.** |
| white on `#111111` | 17.50:1 | 18.88:1 | 7% understated |
| white on `#0A0A0A` | 21.00:1 | 19.80:1 | Above the theoretical maximum for the pair |

Mid-grey on white is one of the most common choices in any interface — this was body text passing
a check it should have failed.

**Fixed** in `packages/a11y/src/contrast.ts`: full-precision luminance, rounded once at the end,
and the ratio rounds **down**, because the number exists to be compared against a threshold and
rounding up at the boundary is precisely how a failing colour ships with a green tick. The fix
**discriminates** rather than lowering everything — `#767676`, one step lighter, still correctly
passes at 4.54:1. `branding.ts` now delegates, so there is one answer to *"can a cashier read
this"* instead of two.

Also caught: white on a mid amber (`#B0740A`) is **3.92:1** and fails. Amber reads as a warning
colour, so white text goes on it without anybody checking — and the badge that tells a cashier
the till is offline becomes the one nobody can read.

### Three sentences that were enforced by nothing

| Design-system rule | Now enforced by |
|---|---|
| *"Colour is never the only signal (icon + text too)"* | `presentStatus` **throws** without a label or an icon; every presentation returns tone, label, icon and screen-reader announcement together. Rendering colour-only requires actively discarding three fields — visible in a diff. **No `toneOf()` or `colourFor()` helper exists**, asserted by test: that helper is how a badge becomes a dot |
| *"Touch targets ≥ 44×44"* | `checkTouchTarget` reports the WCAG 2.5.8 24px floor and the design system's 44px bar **separately** — different claims, and the 44 is about a cashier working fast at arm's length, not about the standard |
| *"≤3 interactions"* (NFR-13) | `checkInteractionBudget` **names the steps rather than counting them.** *"4 of 3"* starts an argument about what counts as an interaction; *"scan → confirm category → press Cash → confirm amount"* starts a conversation about which step to remove |

Two further decisions worth recording, because both are easy to get backwards:

- **Offline is `degraded`, not `error`.** The shop is meant to keep trading (P-01). A red alarm on
  the normal offline state teaches cashiers that offline is a fault, which is how they learn to
  ignore the badge — and then they ignore the real one.
- **The unsent count is inside the label.** *"Offline"* alone invites the reasonable assumption
  that nothing is at stake. *"Offline — 42 sales waiting"* is the fact that gets somebody to look
  at the connection before the end of the day.

The POS lane consumes this directly: `PosView.syncStatus()` returns the badge with its words
attached, and all four `CONNECTION_STATES` are covered — `reconnecting` deliberately kept
distinct from `degraded`, because *"slow"* and *"coming back"* are different situations and one
word for both is a worse badge.

---

## What still needs the store (EX-09)

`certifiedHardwareGate()`, six items, none of them anything the harness already settles:

1. Scan-to-line p95 on the certified till — the CI-to-till ratio is exactly what is unknown.
2. Total/tender p95 with a real card terminal attached — the serial round trip is ours and cannot
   be simulated honestly.
3. Catalogue search at **audited scale** — the real SKU count is a Stage-1 store fact (AVR-04).
4. Backlog drain over the store's **real uplink** — the arithmetic is ours, the broadband is not.
5. Store-edge RTO on the real edge box — dominated by disk and real dataset size.
6. 72-hour offline endurance with a full day queued — the queue arithmetic is proven, the
   endurance is not.

Accessibility items needing real people rather than hardware — **QG-02 usability testing with
store staff** — remain scheduled in `docs/registers/uat-calendar.md`.

## What the owner should check in the store

1. **Stand at the lane and look at the badge from two metres.** You should be able to read words,
   not interpret a colour. If it is a coloured dot, it has been rendered wrong.
2. **Ask what the badge says when the internet is out.** The right answer is *"Offline — 42 sales
   waiting"*, in amber, not red. Red would say the till is broken, and it is not.
3. **Count the taps to sell one item for cash.** Three. If it is four, ask which one was added
   and why.
4. **Try the till with the screen at its dimmest, under the shop lights at 8pm.** That is the
   condition the contrast rules exist for, and it is the one nobody tests in an office.
5. **Ask what the scan speed is on the real till.** The honest answer today is *"we have proven
   it does not get slower as the catalogue grows; the actual figure needs the till."* Anyone who
   quotes you a millisecond number now is quoting a test container.
