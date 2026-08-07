# `packages/quality/`

Cold-chain evidence, quality sampling and release — **M10-FR-02** (with D05-FR-04 and the
FSSAI obligations tracked in `packages/compliance`).

Cold chain is the one control where the damage is invisible. Frozen goods that sat at 9 °C
for three hours look exactly like frozen goods that did not; nobody can tell by looking, the
customer certainly cannot, and the consequence lands on whoever ate it. So the **evidence**
decides, not an opinion at the counter.

- **`src/cold-chain.ts`**
  - `assessColdChain({ batchId, productId, rule, readings })` — judges an excursion on
    **duration as well as peak**. A freezer door open for ninety seconds is not a breach;
    the same reading for four hours is. Judging on peak alone either condemns good stock or
    clears bad stock, depending on which threshold you happen to pick. Returns
    `within_range` / `brief_excursion` / `breach`, the peak, the minutes out of range, and
    the **readings that justify the verdict** — retained for an inspection, because "we
    checked it" is not evidence; the reading, the time and the person are (M34-FR-03).
    - **A missing reading is a failed reading.** A cold-chain batch with no temperature
      recorded is a cold-chain batch nobody checked, and assuming it was fine is exactly
      the assumption that makes people ill. No readings → `breach`, quarantined.
    - A breach sets `quarantine: true` **automatically** — it is not a warning for someone
      to consider while unloading a van in the rain.
    - Temperatures are integers in **tenths of a degree** (83 = 8.3 °C) — the same
      discipline as money (§29.1), for the same reason: 8.3 is not representable in binary
      floating point and a rounding error at the threshold decides whether stock is
      condemned.
  - `releaseFromQualityHold({ hold, samples, coldChain, expiresOn, releasedBy, at })` — a
    held batch is **not sellable until released by a named person**. Release is refused for
    a **failed** sample, an **outstanding** sample (releasing now would be a guess), an
    open **cold-chain breach**, an **expired** batch (which can never be released), or an
    **unnamed releaser**. Each refusal names itself (`ReleaseRefusal`) so the reason reaches
    the operator rather than a log.
  - `raiseColdChainIncident(assessment, at, controlId)` — turns a breach into an incident
    **linked to the control it defeated**, so it reaches the compliance register
    (`packages/compliance`, M34-FR-04) rather than a conversation. The evidence travels with
    it and is never deleted (hard rule #6).

> Pure and deterministic: the timestamp is injected, there is no clock and no I/O. Feeds
> `packages/stock` (a quarantined batch is `NEVER_SELLABLE`) and `packages/warehouse` (which
> refuses to put quarantined stock into a pickable bin or onto a transfer). Tested in
> `tests/unit/quality-cold-chain.test.ts` (14) and proven end to end in
> `tests/integration/physical-to-system.test.ts` (Stage 8 gate). Part of the repository
> layout in `CLAUDE.md`.
