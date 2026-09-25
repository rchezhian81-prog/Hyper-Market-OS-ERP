# Safe pilot environment (Phase 2)

_Release candidate `pilot-rc-1` (commit `c45b948`). Non-production, isolated pilot only._

The pilot must be **properly isolated** from any real/production data and from the dev stack, hardened, and
recoverable. This ties together the pilot compose overlay, the existing hardening, and the backup/restore
proof. Actual cloud provisioning (a managed host + spend) is **EX-01 / OA-5 — an owner/external gate**; the
one-machine stack below needs none of it and does not pre-empt the vendor choice (ADR-0002).

## How to bring the isolated pilot up

```
cd infra/compose
cp .env.pilot.example .env.pilot     # fill in generated secrets — never commit
docker compose -p sre-pilot \
  -f docker-compose.yml -f docker-compose.pilot.yml \
  --env-file .env.pilot up -d
```

## Isolation checklist (each item is how the requirement is met)

| Requirement | How | Evidence |
|---|---|---|
| Separate pilot **database** | `POSTGRES_DB=sre_pilot`, distinct user; project `sre-pilot` | `.env.pilot.example`, overlay |
| Separate **storage** | project name namespaces volumes → `sre-pilot_db-data`, `sre-pilot_edge-data` | overlay header |
| Separate **secrets** | `.env.pilot` (git-ignored `.env.*`); fresh keys | `ENV-VAR-INVENTORY.md` |
| **Pilot-only users** | genesis owner via `BOOTSTRAP_OWNER_*`; provision the rest | `roles.ts`, OA-6 |
| **Test / local IdP** | `IDP_*` point at the test IdP; production IdP deferred (OA-4) | KL-01 |
| Synthetic/approved **pilot data** | Phase 4 seed dataset, demo-marked | Phase 4 |
| **HTTPS** | terminate TLS in front of `web`/`api` (reverse proxy or nginx TLS block); never plain HTTP | operator step |
| **Secure cookies / sessions** | tokens are Bearer (no ambient cookie auth); any session cookie set `Secure` + `HttpOnly` + `SameSite` behind TLS | pipeline auth |
| **RBAC + tenant isolation** | default-deny at the router; every route declares a permission; per-tenant streams | `tests/integration/access-durability.test.ts`, `authorization-is-enforced` |
| **Audit logging** | request-level audit log + tamper-evident hash chain | `pnpm run verify:audit`, migration 0010 |
| **Monitoring + alerts** | `/livez` `/readyz`, `standup:check`, and the watch-list | `MONITORING-AND-ALERTS.md` |
| **Encrypted backups** | `db:backup` (+ storage-layer encryption / `BACKUP_ENCRYPTED`, `BACKUP_OFFSITE`) | `BACKUP-RESTORE-REHEARSAL.md` |
| **Tested restore** | `db:restore` reconciles control totals; **rehearsed** | `BACKUP-RESTORE-REHEARSAL.md` |
| **Resource / capacity limits** | `mem_limit` / `cpus` / `pids_limit` per service | `docker-compose.pilot.yml` |
| **Controlled administrator access** | containers `read_only`, `no-new-privileges`, tmpfs; DB bound to localhost; edge publishes no port | base compose |

## Do NOT connect (Phase 3) — use simulators / sandbox adapters

Production payment, GST/GSP, Tally, SMS, WhatsApp, banking, payroll providers stay **disconnected** in the
pilot. See `PILOT-FEATURE-MATRIX.md`.

## Verify the environment

- `pnpm run standup:check` → **GREEN** (no placeholder secrets; API up + reaches DB; screens served; sync state).
- `curl https://<pilot-host>/readyz` → `ready: true`.
- `pnpm run verify:audit` → audit chain intact.
- Backup/restore rehearsed → `BACKUP-RESTORE-REHEARSAL.md`.
