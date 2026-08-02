# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 2 August 2026

---

## Current stage
**Stage 3 — UX & design system (screen inventory complete).** Store-Core Stage 2 is
complete (22 modules, 88 requirements traced). The interfaces are designed before they
are built (roadmap §27, QG-02). No application code yet — coding stays on HOLD until the
owner closes D3/D4/D5/D8 (§38). Running autonomously per owner instruction
("continue always"), producing all design/specification work up to that coding line.

- **Stage 3 done:** design system, usability test script, and screen specs for **all 14
  §27 role surfaces** — cashier POS, owner command centre, store/manager,
  purchase/receiving, inventory/warehouse handheld, product/merchandising, finance,
  customer app/web, picker/packer, delivery, CRM/service, admin/security, migration,
  and AI control (in `docs/design/screens/`). (The two surfaces the previous "next" note
  had omitted — product/merchandising and finance — are included, per §8 of the design
  system; nothing dropped.)
- **Stage 3 next:** QG-02 human usability testing with real staff
  (`usability-test-script.md`) when the store is available. Then **Stage 4 —
  architecture**.

Store-Core scope (roadmap §21 Stage 2): **M01–M15, M23, M29, M30, M32–M35 — all done.**
Each module doc marks store-fact-dependent fields `⟳ AVR-##` (confirmed in Stage 1),
so nothing is guessed.

Not yet expanded (post-Store-Core, later releases R4–R8): M16–M22, M24–M28, M31,
M36, and the cross-cutting sets SEC/PRV/NFR/AI-NFR/MG — expanded when their
release/stage is reached.

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
Stage 3 screen inventory is complete (all 14 §27 surfaces + design system + usability
script). Options for the next step:
1. **Stage 4 — Architecture** — data model (§29), API catalogue (§30), offline-sync
   design (§31), threat/privacy model (§35), migration design (§34). This is the roadmap
   sequence after Stage 3; **or**
2. **QG-02 usability test** — run `docs/design/usability-test-script.md` with real staff
   in the store (needs store access), recording every hesitation; **or**
3. **Expand the remaining modules** (M16–M22, M24–M28, M31, M36) and the cross-cutting
   sets (SEC/PRV/NFR/AI-NFR/MG) to full row-level traceability.
(Stage 1 discovery + owner fields D3/D4/D5/D8 remain the gating inputs for the M0/M1
gates and block the start of coding.)

In parallel (owner/store): fill D3/D4/D5/D8; gather the 20 AVR facts
(`docs/discovery/avr-closure.md`); measure the six baselines
(`docs/discovery/baseline.md`); send the ERP-vendor letter
(`docs/discovery/legacy-data-access.md`).
