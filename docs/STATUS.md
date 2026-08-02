# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 2 August 2026

---

## Current stage
**Stage 0/1 groundwork complete; roadmap now in the repository.** No application
code yet, by design. The **M0 (Formal GO) gate** is held only by the four owner
fields D3/D4/D5/D8 — everything that can be prepared without them is done.

## Last completed
- **Setup 1/3/4** — repository, `CLAUDE.md`, safety net (tests, guardrails, secret
  scan, CI), and baseline ADR. (Merged to `main` via PR #1.)
- **Roadmap added** — `docs/roadmap/roadmap-v2.0.docx` (Final Master Roadmap v2.0,
  39 sections) is now the single source of truth in the repository.
- **Setup 2 — Requirement index complete.** `docs/requirements/index.md` now maps,
  from the roadmap: M01–M36 (title/priority/purpose), D01–D14 (FR lines),
  WF-01–WF-20, QG-01–QG-12, A01–A10 (authority), MG-01–MG-12, the §31 offline
  matrix, §32 targets, R0–R8, stages 0–19, milestones M0–M8, API-01–13, and the
  SEC/PRV/NFR/AI-NFR/AID/AVR requirement sets.
- **Stage 0 registers completed from the roadmap** — `decisions.md` (OD-01–10,
  D1–D8, AID-01–10 verbatim), `risks.md`, `compliance.md`. `open-questions.md`
  refreshed; `docs/discovery/avr-closure.md` populated with all 20 AVR items;
  `to-be-processes.md` lists WF-01–20; `docs/traceability.md` seeded with the §37
  family-level baseline.

## In progress
- Nothing active. Clean stopping point.

## Blocked / needs owner input (recorded, not stalling further prep)
- **D3, D4, D5, D8** — the four owner-closure fields that hold the M0 gate. The
  roadmap itself still shows D4 (second custodian) as "NAME REQUIRED". Fill D4
  first. Tracked in `docs/registers/decisions.md`.
- **The 20 AVR facts (Stage 1)** — store-specific facts (volumes, departments,
  legacy export rights, etc.) in `docs/discovery/avr-closure.md`, each needing a
  named person. These are gathered in the store during Stage 1.

## Next session should start with (Stage 2, per roadmap §21)
1. **Stage 2 — detailed requirements**, module by module, for the Store Core scope
   (M01–M15, M23, M29, M30, M32–M35). For each module expand every `M##-FR-##` into
   the Appendix B requirement record (testable "system shall", actors, flows,
   rules, permissions, offline behaviour, audit, acceptance) in
   `docs/requirements/<module>.md`, and expand `docs/traceability.md` to one row
   per requirement. Stop after each module for a plain-English owner summary
   (roadmap says: do not do all modules in one response).
2. In parallel: owner fills D3/D4/D5/D8; Stage 1 store facts (AVR) are gathered and
   the six baseline numbers measured (`docs/discovery/baseline.md`).
