# `packages/a11y/`

Accessibility — **NFR-07** (WCAG 2.2 AA), **NFR-13** (interaction budget), §10, §27.1, and the
design system's own bars.

This package exists because of a pattern: the design system has said *"colour is never the only
signal"*, *"touch targets ≥ 44×44"* and *"contrast ≥ 4.5:1"* since Stage 3, and **nothing
enforced any of it.** That is the normal fate of a rule written in a document — it holds until
the first tight header on a 10-inch lane screen, and then it quietly stops holding for the one
man in twelve who cannot tell the green badge from the amber one.

- **`src/contrast.ts`** — the WCAG maths, once, for the whole product.

  It used to live privately inside `packages/platform/src/branding.ts`, which meant the
  tenant-branding screen and every other surface could disagree about whether a colour pair was
  readable. **They did disagree, and the shipped answer was wrong:** luminance was carried in
  hundredths, matching this codebase's integer discipline for money (§29.1). Luminance is not
  money — it is a physical ratio in 0…1, and two decimal places throws away most of the
  resolution exactly where contrast maths is most sensitive.

  ```
  white on #777777    computed 4.57:1  →  PASSED AA
                      actually  4.48:1  →  FAILS AA
  ```

  Mid-grey on white is one of the most common choices in any interface, so that was body text
  being published as accessible when it was not. Luminance is now computed at full precision and
  rounded once, at the end — and the ratio rounds **down**, because the number exists to be
  compared against a threshold and rounding up at the boundary is precisely how a failing colour
  ships with a green tick beside it.

  - An **unparseable colour fails.** Skipping it as "not applicable" is tempting and wrong: a
    colour the checker cannot read is one it cannot vouch for, and the surface renders something
    regardless.
  - `checkPalette` names the **worst pair**. A count of failures tells nobody which colour to
    change.

- **`src/signals.ts`** — the rules that were previously sentences.
  - `presentStatus` / `presentSyncBadge` return the tone, the label, the icon **and** the
    screen-reader announcement in one object. A surface that renders colour-only has to actively
    discard three fields — a deliberate act visible in a diff, rather than an omission nobody
    notices. There is deliberately **no `toneOf()` or `colourFor()` helper**, asserted by test:
    that helper is how a badge becomes a dot, because it makes the wrong thing the convenient
    thing.
  - The unsent count is **inside the label**. *"Offline"* alone invites the reasonable assumption
    that nothing is at stake; *"Offline — 42 sales waiting"* is the fact that gets somebody to
    look at the connection before the end of the day.
  - **Offline is `degraded`, not `error`.** The shop is meant to keep trading (P-01), and a red
    alarm on the normal offline state teaches cashiers to ignore the badge — and then they ignore
    the real one. `reconnecting` is kept distinct from `degraded` for the same reason: *"slow"*
    is a condition to work around, *"coming back"* is a reason to wait, and one word for two
    situations is a worse badge.
  - **Touch targets** report WCAG 2.5.8's 24px floor and the design system's 44px bar
    *separately*. They are different claims: one is the standard, the other is a cashier working
    fast at arm's length during a rush, where a mis-tap is a voided line and a queue.
  - **`checkInteractionBudget` (NFR-13)** names the steps rather than counting them. *"4 of 3"*
    starts an argument about what counts as an interaction; *"scan → confirm category → press
    Cash → confirm amount"* starts a conversation about which step to remove. The fourth tap is
    always added by a reasonable change six months later, by somebody who did not re-count.
  - **`checkFocusOrder`** reports every issue at once. A surface with four unreachable controls
    reported one at a time takes four rounds, and by the third nobody is reading.

The POS lane consumes this directly: `PosView.syncStatus()` returns the badge with its words
attached, alongside the raw `syncBadge()` that hands the view only a state and a number.

> Pure and deterministic: no I/O, no clock, no DOM, no dependency. Tested in
> `tests/unit/a11y-contrast.test.ts` (17) and `tests/unit/a11y-signals.test.ts` (28). Part of the
> repository layout in `CLAUDE.md`.
