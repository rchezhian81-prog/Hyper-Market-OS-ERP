# `packages/facilities/`

Assets, equipment monitoring, safety schedules and incidents — **M26-FR-01…04** (D14, §35,
P-03, hard rule #6). A per-tenant **optional** feature (ADR-0003).

A hypermarket is a building full of machines that lose money quietly. The chiller running two
degrees warm does not stop; it shortens the life of everything inside it and the shop finds
out at the shrinkage count.

- **`src/assets.ts`** — what the shop owns and whether anyone is looking after it.
  - `assessAssets({ branchId, assets, services, asAt })` — **criticality is a property of the
    asset, not of the alert.** Critical assets come back in their own list, not merely sorted
    higher: a list where the cold room and the shelf trolley sit at the same weight is a list
    where the cold room gets missed.
    - An expired AMC is reported **against what it protects**. *"AMC-14 expired"* tells the
      owner nothing; *"the cold room has no maintenance contract and ₹80,000 of stock sits in
      it"* is the sentence that gets it renewed.
    - A **breakdown call is not preventive maintenance** — counting it as one is how an asset
      goes two years without a service and shows as fine. `never_serviced` is its own alert.
    - Warranty is flagged while it is still live, because anything wrong should be raised now
      rather than paid for next month.
  - `summariseDowntime({ assets, events, asAt })` — measured **from when it broke, not from
    when it was reported**. An hour of downtime reported four hours late is a five-hour
    exposure; `unreportedMinutes` is a number of its own rather than folded into the total,
    because for a chiller that gap is the difference between stock that is fine and stock that
    must be destroyed.
  - `reportEnergy({ branchId, readings, from, to })` — states **how much of the figure was
    guessed**. An energy number that silently blends meter readings with estimates will be
    quoted in a decision about buying a chiller; if a third of it is estimated the owner should
    be told before, not after. No readings is *"an absence of data, not an absence of
    consumption"*.

- **`src/monitoring.ts`** — the **equipment**, where M10 assesses the **batch**.
  - `assessEquipment({ assetId, range, readings, contents, asAt })` — a batch assessment says
    this crate of chicken is compromised; an equipment assessment says the cold room has been
    drifting for six hours and **everything in it** is compromised, including the batches
    nobody probed. The store's habit is to probe a few batches; the room is what actually
    fails. A breach names the exposed batches and their value, and sets `holdStock` for M10.
    - **A sensor that has gone quiet is a fault, not a pass.** The dangerous failure is not a
      high reading, it is no reading — the probe that fell out of the room three weeks ago and
      has read as "no alerts" ever since. `no_data` and `stale` both hold the stock.
    - **IoT is readiness, not a dependency** (D14). Readings from a probe, a hand-written log
      sheet or a sensor feed are assessed identically, and the `source` is recorded so nobody
      mistakes a hand-written 4 °C for a metered one.
  - `assessPower({ branchId, events, criticalAssets, asAt })` — assessed **by what it
    protects**. *"DG failed to start"* is an equipment note; *"the cold room has had no power
    for 47 minutes"* is the sentence that gets somebody into the store. Unprotected minutes run
    from the mains failure, not from when the generator was tried — the stock does not care
    which piece of equipment let it down.

- **`src/schedules.ts`** — cleaning, pest, fire, safety, and what happens when they are missed.
  - `assessCompletion({ schedule, task })` — **completion without evidence is not completion**
    where evidence was required. A tick against "fire extinguishers checked" is worth nothing
    at an inspection and a dated photograph is worth everything, so the tick is **refused**
    rather than accepted with a note — an accepted-with-a-note task shows green, and green is
    what everybody reads. Self-verification of a safety check is *"a signature against
    nothing"* (§28).
  - `findOverdue({ schedules, tasks, asAt })` — **a missed compliance task escalates by
    itself**, to a named person. A task that quietly rolls into tomorrow's list forever is the
    failure mode, and it is invisible precisely because nothing ever goes red. Cleaning is
    deliberately **not** compliance-linked: burying the fire check among forty
    mop-the-aisle alerts is the same failure by another route.
  - `closeIncident({ incident, closedBy, actionTaken, authorityNotifiedOn?, at })` — **an
    incident closed with no corrective action is an incident that will happen again**, recorded
    as handled. A serious incident needs evidence and a second person; a **reportable** one
    cannot be closed until the statutory notification is on file, because closing it internally
    is exactly what makes everybody stop thinking about it.
  - `buildComplianceEvidence(…)` — the pack an inspector would ask for, which **says plainly
    whether it would survive**. Same principle as the finance evidence pack (M23-FR-04): a pack
    that presents a 60%-complete record as "the evidence" is worse than no pack, because
    somebody will hand it over believing it is complete. Gaps are listed by name.

> Pure and deterministic: the clock is injected, no I/O. Cold-chain findings feed the M10
> quality holds in `packages/quality`. Tested in `tests/unit/facilities.test.ts` (39) and
> proven end to end in `tests/integration/beyond-the-till.test.ts` (Stage 16 gate). Part of
> the repository layout in `CLAUDE.md`.
