# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 2 August 2026

---

## Current stage
**Stage 2 — detailed requirements (in progress).** Expanding each Store-Core
module's roadmap FR lines into the Appendix B requirement-record format, module by
module. No application code yet. The **M0 (Formal GO) gate** remains held only by
the four owner fields D3/D4/D5/D8.

Store-Core modules to expand (roadmap §21 Stage 2 scope): M01–M15, M23, M29, M30,
M32–M35.
- **Done:** M01–M11 (11 of 21).
- **Next:** M12–M15 (POS/returns/cash), then M23, M29, M30, M32–M35.

Each module doc marks store-fact-dependent fields `⟳ AVR-##` (confirmed in Stage 1),
so nothing is guessed. Individual FR rows are added to `docs/traceability.md` as
each module is expanded.

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

## Next session should start with
1. **Continue Stage 2 with M12** (POS sales), then M13–M15, and
   M23/M29/M30/M32–M35. Same method: expand every `M##-FR-##` into the Appendix B
   record in `docs/requirements/<module>.md`, add its rows to
   `docs/traceability.md`, and give a plain-English summary after each batch.
2. In parallel: owner fills D3/D4/D5/D8; Stage 1 store facts (AVR) are gathered and
   the six baseline numbers measured (`docs/discovery/baseline.md`).
