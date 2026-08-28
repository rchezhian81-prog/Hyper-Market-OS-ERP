# `docs/runbooks/`

Step-by-step instructions a non-programmer can follow, especially at 9pm when something breaks.

> This folder is part of the SRE Retail OS repository layout defined in `CLAUDE.md`.

## The stand-up package — everything to bring the pilot up, in order

If you are standing the system up for the **one-lane pilot**, follow these in sequence. Each one
hands off to the next; you do not need to know which of the other runbooks exists.

1. **`pilot-deployment.md`** — bring the whole system up on one machine with one command
   (`docker compose up`): database, schema, cloud API, the store box, and the till/owner screens.
   Vendor-neutral — it does not commit you to a cloud provider.
2. **`pnpm run standup:check`** — the readiness gate. One command that answers GREEN / RED, in
   plain English, for each piece: settings filled in, API running and ready, till screen served,
   sync setting. Read-only — it looks, never changes. Run it until it is GREEN.
3. **`pilot-setup-workbook.md`** (+ `.xlsx`) — the fill-in form: every setting turned into a
   plain-English question with its default and a blank to complete (the owner configuration).
4. **`store-go-live-checklist.md`** — the walk-through of the things a **person in the store** must
   witness or approve (UAT-01…58): the offline-trading drills, the money checks, the safety drills.
5. **`pilot-run-sheet.md`** — the same drills laid out **day by day**, a booked plan you put your
   own dates on. Pairs with the one-lane pilot plan.
6. **`backup-and-recovery.md`** — the safety net: take a backup before anything you care about, and
   prove a restore actually works (not assumed).

`cutover-weekend.md` and `environments-and-secrets.md` come later, at full go-live — not for the
pilot. The master source of truth for the human sign-offs is `../registers/uat-calendar.md`.

## The other runbooks

- **`security-incident.md`** — SEC-10 / PRV-09 / C-05. What to do when something has gone
  wrong, written for 9pm. The rule it exists for: **the six-hour CERT-In clock starts when you
  NOTICE, not when you understand** — an incomplete report at hour two is correct procedure, a
  complete one at hour nine is a breach of the rules about breaches. Contain without destroying
  the evidence (unplug the network, never the power); ransomware comes before containment
  because the damage is still spreading; evidence is retained permanently (hard rule #6).

- **`legacy-self-extraction.md`** — MG-01/02/06. **We do not wait for the incumbent vendor**
  (owner decision OB-06, 7 Aug 2026). A vendor asked to export a customer's data is being asked
  to help that customer leave, and a plan whose first step is *"wait for them"* hands the
  schedule to somebody whose interests run the other way. Four routes, best first; our own data,
  our own machine, the access we already have, and their software untouched.

  The part that matters is **verification**. With no vendor file, nothing checks the incumbent
  except the incumbent — and a stock total read off one report and agreed against another from
  the same product reconciles perfectly while proving nothing. So every figure is proved against
  evidence from *outside* it: the bank, the filed returns, the supplier's own statement, and a
  physical count. **A vendor export is one system's account of itself; a bank statement is an
  adversary's.**
