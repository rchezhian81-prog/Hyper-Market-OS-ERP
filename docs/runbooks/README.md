# `docs/runbooks/`

Step-by-step instructions a non-programmer can follow, especially at 9pm when something breaks.

> This folder is part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
> It is intentionally empty for now — no application code is written during setup.

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
