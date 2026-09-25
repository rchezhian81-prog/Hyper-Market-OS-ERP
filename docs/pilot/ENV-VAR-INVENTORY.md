# Pilot environment-variable inventory (no secret values)

_Release candidate: `pilot-rc-1` (commit `c45b948`). Non-production pilot only._

**No secret value appears in this file, in the repository, in logs, or in any artifact.** Secrets live
only in the pilot host's `.env` (git-ignored: `.gitignore` lines `.env`, `.env.*`) or its secrets manager.
The template is `infra/compose/.env.example` (placeholders only). The API and edge **refuse to boot** on a
missing, placeholder, or too-short secret and name **every** problem at once — see
`services/kernel/src/config.ts` (`loadConfig`, `CLOUD_API_CONFIG`, `STORE_EDGE_CONFIG`). A short secret, a
copied `REPLACE_WITH_…` placeholder, or a wrong enum value all stop start-up loudly rather than running
insecure (SEC-04, hard rule #4).

Legend — **Secret?**: 🔒 held only in `.env`/secrets manager, never committed or echoed · **Req?**: required
to boot / optional. **Set for pilot**: the safe pilot value or "generate".

## Cloud API (`CLOUD_API_CONFIG`)

| Variable | Secret? | Req? | Min len | Allowed / default | Purpose | Set for pilot |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | 🔒 | required | 20 | — | Postgres connection string the API + migrations use | generate (pilot DB only) |
| `PACK_SIGNING_KEY` | 🔒 | required | 32 | — | signs catalogue packs every till trades on | `openssl rand -base64 48` |
| `IDP_SIGNING_KEY` | 🔒 | required | 32 | — | shared secret whose tokens the API believes (HS256) — **pilot uses the local/test IdP key**; a real production IdP is deferred (OA-4 / EX-03) | test-IdP key (pilot) |
| `IDP_ISSUER` | — | required | — | — | the `iss` claim a token must carry | pilot/test issuer URL |
| `IDP_AUDIENCE` | — | required | — | `sre-retail-os-api` | the `aud` claim a token must contain | as template |
| `PORT` | — | optional | — | default `8081` | API listen port | default |
| `NODE_ENV` | — | optional | — | `development`/`test`/**`production`** | runtime mode | `production` (hardened behaviour) even in pilot |
| `MIGRATION_TARGET_KIND` | — | optional | — | `rehearsal`/`staging`/`local`/`production` (default `rehearsal`) | which environment the migration service may load into — **`production` is how a trial load reaches live data (hard rule #7)** | `rehearsal` (pilot); NEVER `production` in pilot |
| `BOOTSTRAP_OWNER_TENANT_ID` | — | optional | — | — | the tenant seeded with a genesis owner at boot (OA-6) | pilot tenant id |
| `BOOTSTRAP_OWNER_USER_ID` | — | optional | — | — | the user who becomes that tenant's first owner (idempotent, never re-widened) | pilot owner's test-IdP subject |

## Store edge (`STORE_EDGE_CONFIG`)

| Variable | Secret? | Req? | Default | Purpose | Set for pilot |
|---|---|---|---|---|---|
| `EDGE_DATA_DIR` | — | required | — | where the edge keeps locally-committed work | pilot data dir |
| `EDGE_TENANT_ID` | — | required | — | which shop this edge belongs to | pilot tenant id |
| `PACK_SIGNING_KEY` | 🔒 | required | — | must match the API's, so the lane only accepts your packs | same as API |
| `EDGE_CAPACITY_BYTES` | — | optional | `10737418240` (10 GiB) | disk the edge may use offline | default |
| `EDGE_LANE_PORT` | — | optional | — | loopback port the till screen posts sales to | set on a till box |
| `EDGE_SCREEN_PORT` | — | optional | — | loopback port the screens are served from | set on a screen box |
| `EDGE_APPS_DIR` | — | optional | — | where `apps/` lives, to serve screens from disk | as installed |
| `EDGE_PACK_FILE` | — | optional | — | the last pack the cloud sent (never defaults — absent ≠ empty) | after first pack |
| `CLOUD_API_URL` | — | optional | — | **absent = sell-and-queue offline-first**; set to drain to the cloud | set once sync is wanted |
| `CLOUD_API_TOKEN` | 🔒 | optional | — | store token for cloud drain (minted for a provisioned store login) | mint at set-up |

## Compose infrastructure (`infra/compose/.env.example`)

`POSTGRES_DB` (`sre_retail_os`), `POSTGRES_USER` (`sre_app`), `POSTGRES_PASSWORD` 🔒 (generate URL-safe:
`openssl rand -hex 24`), `POSTGRES_PORT` (`5432`), `WEB_PORT` (`8080`), `API_PORT` (`8081`). `DATABASE_URL`
is composed from the four Postgres values and left blank in the template on purpose.

## Rules

- **Never** commit a `.env`; never paste a secret into an issue, PR, screenshot, log or this repo.
- Rotate `PACK_SIGNING_KEY` / `IDP_SIGNING_KEY` / DB password if a pilot machine is retired.
- The pilot uses the **test/local IdP** and **`MIGRATION_TARGET_KIND=rehearsal`**; both must change (with a
  real IdP and a deliberate cutover) only at production go-live, which is an owner GO gate.
