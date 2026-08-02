# `docs/security/`

Threat model and privacy map.

- **`threat-privacy-model.md`** — Stage 4 secure-by-design model (§35): trust boundaries,
  data classification, STRIDE threats and responses, identity/access (§28), encryption &
  key management, privacy (PRV), AI security (AI-NFR), environment isolation, and QG-06
  verification.

> This folder is part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
> The hard rules are enforced in CI by the tripwires in `tests/guardrails/`; SEC/PRV
> requirements are traced row-by-row during their build stages.
