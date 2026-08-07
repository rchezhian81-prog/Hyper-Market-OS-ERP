# `packages/self-checkout/`

Self-checkout, scan-and-go, the price kiosk and price integrity — the **R8 innovation wave**
(D04, D06, D14 / M12 / M15 / M05 / P-01 / P-02 / hard rule #1).

- **`src/self-checkout.ts`** — the one place in a shop where **the customer operates the
  till**. Two failure modes pull in opposite directions, and every decision here sits between
  them.

  Too suspicious and it is unusable: a machine that halts on every unexpected weight, summons
  an attendant four times, accuses somebody of theft over a reusable bag. That lane sits empty
  while the staffed one has a queue, and the shop has bought furniture.

  Too trusting and it is a shrinkage hole: scanning an expensive item as a cheap loose one is
  the commonest self-checkout loss in the world, and it is invisible unless somebody watches
  the *pattern* rather than the incident.

  So: **intervene rarely, watch always, and never accuse anybody at the lane.**
  - `assessSelfCheckout(…)` — every intervention carries **two messages**: a neutral one for
    the customer (*"a colleague will be with you"*) and a specific one for the attendant
    (*"scale read 900g against 400g — usually a bag or a hand on the platform; check, do not
    accuse"*). The lane is in public, and a machine that publicly implies theft costs more in
    goodwill than the item was worth.
    - **Patterns are scored across the basket and never shown at the lane.** One mis-weigh is a
      mis-weigh; four loose-produce substitutions in one basket is a pattern. `riskBps` is for
      the loss-prevention review; the lane's job is to sell somebody their shopping.
    - **Age verification is always a human.** No self-checkout anywhere clears an age-restricted
      line on its own, whatever a camera claims.
    - A random audit says what it is: *"nothing is wrong with this basket; check a few items
      and thank them."*
  - `decideScanAndGo(…)` — **earned trust with an honest sampling rate.** A scheme that audits
    everybody is a queue with extra steps; one that never audits is a free-for-all within a
    month. Trust is withdrawn on a **found discrepancy**, not a suspicion, and the customer is
    told plainly rather than mysteriously failing checks. An age-restricted item ends the trip
    at a staffed till, full stop.
  - `quotePrice(…)` — the kiosk is **read-only, offline-capable, and always says how fresh it
    is**. A kiosk quoting yesterday's promotion is worse than no kiosk: the customer takes the
    number to the till as a promise, and the cashier either honours a price the shop is not
    charging or has an argument in front of a queue. Past the staleness window it says *"check
    at the counter"* rather than quoting a number it does not trust.

- **`src/price-integrity.ts`** — one commerce truth (P-02) is a principle until somebody
  checks. A hypermarket displays the same price in four places — shelf edge, till, app, and
  (where fitted) an electronic label — and they drift apart constantly.

  The consequences are **not symmetric**, and that asymmetry drives the whole module.
  - `auditPriceIntegrity(…)` — **the till is the reference**, not because it is more likely to
    be right but because it is what the customer is charged; every other surface is a claim
    about it.
    - **The shelf showing LESS than the till charges is a legal problem**, not a margin one:
      under the Legal Metrology (Packaged Commodities) Rules the displayed price is what the
      customer was offered. Reported as `overcharge_risk` **at the top of the list regardless
      of value** — a ₹4 label error still gets a shop a notice, and a ₹5,000 margin leak does
      not.
    - **The shelf showing MORE is a margin leak**: real money, no legal exposure, ranked by
      value because that is how you decide what to fix first.
    - **A surface that has not confirmed is treated as unconfirmed, not as agreeing.** An ESL
      whose last contact was nine days ago is showing whatever it was last told, and it will
      keep showing it. The device id and shelf address are named so somebody can walk to it.
  - `pushEslPrice(…)` — a price change **waits for every label to echo it back**. The dangerous
    version is fire-and-forget: the till changes, the push is marked done, and a label that
    never received it now shows the old price while the till charges the new one — which is
    precisely the `overcharge_risk` above, **created by the system meant to prevent it**. A
    flat battery is reported separately, because a label that confirmed is showing the right
    price today and needs replacing before it goes dark mid-promotion.

> Pure and deterministic: the clock is injected, no I/O. Composes with `packages/price-guard`
> (M05 floors and ceilings), `packages/loss-prevention` (M15 patterns) and
> `packages/compliance` (M34 Legal Metrology obligations). Tested in
> `tests/unit/self-checkout.test.ts` (28) and proven end to end in
> `tests/integration/two-shops-one-system.test.ts` (Stage 18 gate). Part of the repository
> layout in `CLAUDE.md`.
