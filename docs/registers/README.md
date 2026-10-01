# `docs/registers/` — Governance registers (roadmap Stage 0)

The six registers that keep the programme controllable. Each has stable ID
prefixes, an owner, a status and a date, so nothing is tracked in someone's head.

| File | Holds | ID prefix |
| --- | --- | --- |
| [`decisions.md`](./decisions.md) | Owner & developer decisions (OD/D/AID), incl. the open blocking fields | `OD-`, `D`, `AID-` |
| [`risks.md`](./risks.md) | Risks with severity and mitigation (seeded from the Annexure G findings) | `R-` |
| [`compliance.md`](./compliance.md) | Legal/regulatory obligations, validator roles and fixed dates | `C-` |
| [`issues.md`](./issues.md) | Problems found during build/operation | `I-` |
| [`changes.md`](./changes.md) | Deliberate scope/plan changes (how OD-02 is honoured) | `CH-` |
| [`requirements.md`](./requirements.md) | Governance status of requirements (detail in `../requirements/`) | roadmap IDs |
| [`sp10-staff-uat.md`](./sp10-staff-uat.md) | SP-10: every staff / physical-device practice session, with the software version it ran on; the only thing that can mark SP-10 done | `UAT-S-` |

> **State.** Built during Setup 4 / Stage 0 from Annexure G and Annexure H. Rows
> marked _pending roadmap_ are completed from `docs/roadmap/roadmap-v2.0.docx`
> when it is added. The Stage 0 gate still needs the **D4 second-custodian name**
> (see `decisions.md`) before it can be signed.
