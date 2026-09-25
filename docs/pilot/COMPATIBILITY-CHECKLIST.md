# Pilot compatibility checklist

_Release candidate `pilot-rc-1` (commit `c45b948`). Non-production pilot only._

| Layer | Requirement | This release | Notes |
|---|---|---|---|
| Runtime | Node.js **≥ 22** | built & tested on Node 22.22 | `package.json` `engines.node >=22`; ESM (`"type":"module"`) |
| Package manager | pnpm **10.33** | `packageManager: pnpm@10.33.0` | CI installs `--frozen-lockfile` |
| Language target | ES2022 / ESNext modules | `tsconfig` `target ES2022`, `moduleResolution Bundler` | strict typecheck (`tsc --noEmit`) clean |
| Database | **PostgreSQL 16** | `postgres:16-alpine` in `infra/compose`; suite green on real PG16 | managed PG16 replaces the `db` service in the cloud tier (ADR-0002) |
| Containers | Docker Engine / Docker Desktop | `infra/compose/docker-compose.yml`, `infra/docker/{api,edge}.Dockerfile` | one-machine standup, vendor-neutral |
| Reverse proxy / TLS | HTTPS termination | `infra/compose/nginx.conf` | pilot must terminate **HTTPS** (Phase 2) |
| POS / screens | Desktop + PWA shell; sub-second scan; keyboard-driven scanner | served offline-first from the edge | hard rule #1 — no cloud round-trip on a sale |
| Mobile | Low-spec Android (picker, delivery, customer apps) | cross-platform served PWAs | roadmap §19 |
| Browser (operators) | Modern evergreen browser | screens are served static HTML/JS thin clients | both light & dark themes |
| Browser E2E | Chromium | `/opt/pw-browsers/chromium`; e2e self-skips if absent | 130 browser E2E tests |
| Offline | Store trades with no internet/cloud | edge sells-and-queues; unsent counter; idempotent drain | P-01, hard rule #1 |

## Pre-deploy compatibility gates

- [ ] Pilot host has Node ≥ 22 **or** runs the containers (no host Node needed for the container path).
- [ ] Docker Engine/Desktop present and running.
- [ ] PostgreSQL 16 reachable (managed or the compose `db` service).
- [ ] HTTPS certificate available for the pilot hostname.
- [ ] Chromium present on the CI/e2e runner (not needed on the store floor).
- [ ] `pnpm install --frozen-lockfile` succeeds (lockfile matches).
