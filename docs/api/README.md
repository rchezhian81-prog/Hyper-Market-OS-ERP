# `docs/api/`

The API and event contract catalogue (API-01 to API-13 and the core business events).

- **`surface.md`** — **generated** from the running route table (M36-FR-04, P-06): every endpoint the
  kernel serves, by API domain, with its permission, optional feature and idempotency. Do not edit by hand;
  `tests/guardrails/the-api-surface-is-documented.test.ts` fails when it is behind — regenerate with
  `UPDATE_API_SURFACE=1 pnpm exec vitest run tests/guardrails/the-api-surface-is-documented.test.ts`. Served
  live at `GET /v1/platform/api-manifest`.
- **`catalogue.md`** — Stage 4 API & event catalogue: conventions (versioning,
  idempotency, auth, events), the API-01…API-13 domain map, core Store-Core flows, and
  the named §30.2 domain events. Detailed endpoint specs and schemas are produced per
  domain from Stage 5.

> This folder is part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
> Contracts (versioned schemas) live in `packages/contracts/`.
