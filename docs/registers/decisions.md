# Decisions register

Every significant decision, its status and who owns it. IDs are stable.
`OD-##` = owner decisions · `D#` = developer/owner decision fields · `AID-##` =
AI-assisted development governance decisions.

> **Sourcing.** Entries are populated from the Annexure G audit and the Annexure H
> build pack (which is itself built from the roadmap). The authoritative text
> lives in roadmap §25; entries marked _pending roadmap_ must be completed verbatim
> when `docs/roadmap/roadmap-v2.0.docx` is added. Nothing here is invented.

Status legend: **Accepted** · **Open — blocking** (holds coding / a gate) ·
**Open** · **Pending roadmap**.

## Owner decisions (OD)

| ID | Decision | Status | Owner | Date | Source / notes |
| --- | --- | --- | --- | --- | --- |
| OD-01 | _pending roadmap §25_ | Pending roadmap | Owner | — | Record verbatim from roadmap. |
| OD-02 | Scope ratchet — nothing in scope is silently dropped; "not included is unacceptable". Deferral is explicit, in writing, with a named target release. | Accepted | Owner | 2 Aug 2026 | Annexure G (§15, §24). |
| OD-03 | _pending roadmap §25_ | Pending roadmap | Owner | — | |
| OD-04 | Build the SRE standalone POS as an independent product. Stated as final. | Accepted | Owner | 2 Aug 2026 | Annexure G. Makes the POS the critical path to 1 Apr 2027. |
| OD-05 | Migrate all **usable** history. | Accepted | Owner | 2 Aug 2026 | Annexure G (§34). "Usable" to be defined in Stage 11 — see R-08. |
| OD-06 | _pending roadmap §25_ | Pending roadmap | Owner | — | |
| OD-07 | _pending roadmap §25_ | Pending roadmap | Owner | — | |
| OD-08 | _pending roadmap §25_ | Pending roadmap | Owner | — | |
| OD-09 | Source-code ownership — the owner owns the product outright. | Accepted | Owner | 2 Aug 2026 | Annexure G (strong). Backed by AID-10 quarterly rebuild. |
| OD-10 | _pending roadmap §25_ | Pending roadmap | Owner | — | |

## Developer / owner decision fields (D)

| ID | Field | Value | Status | Owner | Date | Source / notes |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | Budget | ₹5–10 lakh planning envelope | Accepted | Owner | 2 Aug 2026 | Not permission to weaken scope, security, migration, testing, docs or ownership. |
| D2 | Owner capacity | 30 hours / week | Accepted | Owner | 2 Aug 2026 | Annexure G. |
| D3 | Running-cost ceiling | _blank_ | **Open — blocking** | Owner | — | Blocks production. Include AI monthly cost (Stage 17). |
| D4 | Second technical custodian (name) | _blank_ | **Open — blocking** | Owner | — | Annexure H: the one field it will not start without. Fill first. Ties to R-13 / AID-10. |
| D5 | GO date | _blank_ | **Open — blocking** | Owner | — | Blocks coding. |
| D6 | _pending roadmap §25_ | — | Pending roadmap | Owner | — | |
| D7 | _pending roadmap §25_ | — | Pending roadmap | Owner | — | |
| D8 | Completion date | _blank_ | **Open — blocking** | Owner | — | M5 (1 Apr 2027) is currently the only dated milestone. See R-01, R-02. |

## AI-assisted development governance (AID) — as referenced by the audit

| ID | Decision | Status | Owner | Source / notes |
| --- | --- | --- | --- | --- |
| AID-01 | Source-code ownership / control discipline. | Accepted | Owner | Annexure G. |
| AID-07 | Review architecture, data model, auth, payments, sync and migrations **manually** (SHALL); do **not** rely on automated tests as the only assurance (SHALL NOT). | Accepted | Owner | Annexure G — "sharper than the advice given, and correct." |
| AID-09 | Source-code ownership acknowledgement (developer). | Accepted | Owner | Annexure G (§24). |
| AID-10 | Quarterly rebuild-and-deploy by the second custodian, without the original builder. | Accepted | Owner | Annexure G / Annexure H Stage 19. Depends on D4. |
| AID-04, AID-06 | No production personal data in development or testing. | Accepted | Owner | Annexure G (see R-09 test-data strategy). |
| _others_ | _pending roadmap §23/§24_ | Pending roadmap | — | Record when roadmap added. |
