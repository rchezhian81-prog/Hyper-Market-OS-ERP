# Pilot deployment checklist

_Release candidate `pilot-rc-1` (commit `c45b948`). Non-production, isolated pilot environment only._

Detailed steps live in `docs/runbooks/pilot-deployment.md` (one-machine standup) and
`docs/runbooks/environments-and-secrets.md`. This is the gated checklist that wraps them. **Do not deploy to
production.** Each ☐ must be ticked with evidence before the store-floor pilot starts (owner GO — Phase 7/8).

## A. Pre-deploy (release baseline)

- [x] Working tree clean; branch synced with `main`; **no open/conflicting PRs**.
- [x] Release SHA fixed: `c45b948bfb42a6d77ee2ba7b5b7b7cbb86ecaeba`; RC tag `pilot-rc-1`.
- [x] Full gate green (`pnpm run check`): typecheck, lint, secret-scan, unit/integration, perf, e2e.
- [x] Dependency scan `pnpm audit --audit-level=high` → pass; SBOM (`docs/evidence/sbom.json`) no drift.
- [x] Real-PostgreSQL DB/migration suite green; 11/11 migrations apply.
- [x] Rollback target recorded (legacy system in parallel; backup/restore rehearsed in Phase 7).

## B. Provision the isolated pilot environment (Phase 2)

- [ ] **Separate** pilot Postgres 16 (own instance/DB), storage, and secrets — not shared with any real/prod data.
- [ ] Pilot `.env` created from `infra/compose/.env.example`; every `REPLACE_WITH_…` replaced; **no secret committed**.
- [ ] `PACK_SIGNING_KEY`, `IDP_SIGNING_KEY`, DB password generated fresh for the pilot.
- [ ] `MIGRATION_TARGET_KIND=rehearsal`; `NODE_ENV=production`; local/**test IdP** configured.
- [ ] **HTTPS** terminating (nginx/`infra/compose/nginx.conf`); secure + httpOnly session cookies.
- [ ] Pilot-only users provisioned (genesis owner via `BOOTSTRAP_OWNER_*`); RBAC + tenant isolation confirmed.
- [ ] Monitoring + alerts wired; `/livez` and `/readyz` probed; `pnpm run standup:check` → GREEN.
- [ ] Encrypted backup scheduled (`pnpm run db:backup`); **restore rehearsed** into a clean env (`db:restore`).
- [ ] Resource/capacity limits set on containers; administrator access controlled + logged.

## C. Data (Phase 4)

- [ ] Synthetic/approved pilot dataset loaded (org, branch, users, products, tax/HSN, stock, tills, tenders,
      sample orders, delivery zones, concession sources, **demo-marked** payroll, sandbox GST records).
- [ ] Demo data never mixed with real financial/statutory/payroll/customer exports.

## D. Feature safety (Phase 3)

- [ ] Confirm the `PILOT-FEATURE-MATRIX` DISABLED set is off: no live GST filing, e-invoice, payroll,
      bank-file, autonomous actions, delete-my-data production execution, production messaging/payment,
      irreversible migration.
- [ ] Kill switches reachable (AI gateway, connector delivery); maker-checker on sensitive actions verified.

## E. Deploy

- [ ] `docker compose up -d`; `migrate` exits 0; `db`, `api`, `web` healthy.
- [ ] Smoke: `/readyz` = ready; a scripted authenticated request through the real pipeline succeeds.
- [ ] Offline promise demonstrated (pull the cable mid-sale; unsent counter rises; nothing lost).

## F. Gate to start floor pilot (Phase 7)

- [ ] All Phase 7 blocking gates pass; **owner UAT approval** recorded; **owner GO** given.

> Do not activate the pilot automatically. Present the completed readiness package and request OWNER GO.
