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
