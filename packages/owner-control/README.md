# `packages/owner-control/`

The owner's control surface — **M29-FR-02** (comparisons and drill-through),
**M29-FR-03** (thresholds, alerts, approval inbox) and **M29-FR-04** (scheduled reports
and the daily brief), with D10/D13.

The owner carries a phone, not a dashboard, and is not a programmer. Everything here is
written for someone reading it in a car park.

## `src/drill-through.ts` — show me (M29-FR-02)

The owner sees *"margin down 4% in Fresh"* and asks the only question worth asking. A
drill-through that looks right and is wrong is worse than none at all, because the owner
**acts** on it.

- **The drill reaches the immutable source** (NFR-15) — the actual events, not rows from a
  summary table that might have been rebuilt differently.
- **The drill must reconcile to the KPI.** If the transactions do not add up to the number
  that was clicked, `drillThrough` says so **loudly** (`discrepancy`) instead of showing a
  plausible list. A list that nearly explains a number is how an owner spends a fortnight
  chasing a reporting bug.
- **Scope is enforced, and the number changes with it.** A branch manager sees their branch
  and a **recomputed** total, plus a line saying what was withheld and why. Showing a
  company total over a filtered list is how someone concludes their branch is losing money
  another branch actually made.
- **`compareBy`** ranks across branch/category/vendor/staff with exact basis-point shares
  (BigInt, never a float), and groups values with no dimension as **`unattributed`** rather
  than dropping them — quietly discarding makes the rows sum to less than the total, and
  whoever notices assumes the missing money went somewhere specific.
- Every drill is logged (`auditDrill`): drilling reaches individual transactions and,
  through them, individual people's work.

## `src/alerts-inbox.ts` — the five that matter (M29-FR-03)

The failure mode is not too little information; it is **too much**. An owner who gets
forty alerts a day stops reading alerts, and the one that mattered arrives into a habit of
ignoring them.

- **Alerts are grouped, not streamed.** Six voided bills on one lane is *one* alert with a
  count and a value, keeping every transaction id for the drill-through. The roadmap names
  the five kinds (Annexure H): large discount, voided bill, price override, after-hours
  login, cash short.
- **Every threshold is the owner's.** A ₹500 discount is routine in one shop and a scandal
  in another; neither belongs in our code. A kind with no threshold set raises nothing.
- **Ordering puts unvalued alerts above valued ones of the same severity.** That looks
  backwards until you see what it prevents: *"someone signed in at 2:15am"* carries ₹0 and
  is the most important line on the list. A pure value sort buries it under every void and
  discount — which is to say nowhere — and the unpriceable ones (access, hours, identity)
  are precisely the alerts nobody else is watching for.
- **`buildInbox`** flags an approval **the world has overtaken** (`superseded`, §31.1):
  approving a price change that was already replaced would silently undo the newer one.
  Every non-actionable item **says why** — your own request, above your authority, outside
  your scope — instead of presenting a button that will fail. Nothing here commits;
  decisions route to `packages/approvals` (hard rule #5).

## `src/scheduled-brief.ts` — it sends itself (M29-FR-04)

The roadmap's acceptance is concrete and it is the right test: *"the daily brief arrives on
the phone at the set time for three days running without anyone sending it"* and *"if AI is
off, the numbers still arrive."* The second half is the one systems get wrong, so the
architecture is inverted from how these are usually built:

> **The numbers ARE the brief. The narrative is a decoration on top.**

- `buildScheduledBrief` composes the deterministic figures first and **always returns a
  complete, sendable brief**. The narrative is applied only if it exists, is **confident**,
  is in the **reader's language**, and **carries evidence** (AI-NFR-04). Otherwise the brief
  goes out unchanged with a line saying the written summary was not available. AI never
  touches a number — it may only arrange words around them.
- **Three things needing attention**, worst first. An owner reads three things, not thirty.
- **Freshness is never hidden** — beyond the tenant's window the brief leads with *"THESE
  NUMBERS ARE NOT LIVE"* and the age in minutes (P-08).
- **Tamil or English** throughout (NFR-08), including the stale warning and the
  no-narrative line; an untranslated narrative falls back to the figures rather than to
  English the reader may not have.
- **`briefsDue`** is idempotent (a scheduler that fires twice sends once) and **carries a
  missed day** rather than skipping it — a brief that silently does not arrive is
  indistinguishable from a quiet day, which is exactly the morning you needed it.

> Pure and deterministic — the clock is injected and nothing is sent from here; this builds
> what a transport delivers. Tested in `tests/unit/owner-drill-through.test.ts` (10),
> `tests/unit/owner-alerts-inbox.test.ts` (17) and
> `tests/unit/owner-scheduled-brief.test.ts` (15), and proven end to end in
> `tests/integration/books-reconcile.test.ts` (Stage 10 gate). Part of the repository
> layout in `CLAUDE.md`.
