# Demo-pilot stand-up runbook (MilesWeb VM3, Mumbai) — run ON the server

_Non-production, synthetic data only. Order **#7709463384** — MilesWeb Managed VPS **VM3** (2 vCPU / 4 GB /
80 GB NVMe), **Mumbai (India)**, **Ubuntu 22.04 LTS**, no control panel. This runbook is followed **on the
server** (the owner chose to install Claude Code on the box and let a session there do the deployment). It is
written so a **Claude Code session on the server** — or a human developer — can execute it end to end._

**Non-negotiables for this stand-up (do not deviate):**
- **Synthetic/demo data only.** No real product/price data (that is Option 2, **unapproved**).
- **No live providers.** Payment, GST/e-invoice, Tally, SMS/WhatsApp, payroll bank-file, production AI — all
  stay **off** (sandbox/simulator only). `MIGRATION_TARGET_KIND=rehearsal`.
- **Keep DISABLED** (open GAP-SEC-06 follow-ups): payroll approve/lock/**bank-file release** and
  **bulk/sensitive-category product publish**, until API-tier step-up is implemented + tested for them.
- **Report the hosted deployment + human UAT separately** from the temporary-machine results already recorded.
- Store-floor operation is a **separate owner GO** — not part of this stand-up.

---

## 0. Before you start
- The MilesWeb welcome email gives the **server IP** and **root** login. Have it open.
- Decide a **demo hostname** if you have a spare domain/subdomain (e.g. `demo.sre-example.in`) and point its
  DNS **A record** at the server IP — this lets us get a free HTTPS certificate automatically. If you have no
  domain, we fall back to a self-signed certificate (browser shows a one-time warning; fine for a demo).
- Have **read access to the GitHub repo** ready (a read-only deploy token or SSH deploy key).

## 1. First login + harden the server
```bash
ssh root@YOUR_SERVER_IP                     # from the MilesWeb email
adduser sre && usermod -aG sudo sre         # a non-root working user
rsync --archive --chown=sre:sre ~/.ssh /home/sre   # copy your SSH key in
# Firewall: allow SSH + HTTPS only
apt update && apt install -y ufw
ufw allow OpenSSH && ufw allow 443/tcp && ufw --force enable
# Disable password logins (key-only) — edit /etc/ssh/sshd_config: PasswordAuthentication no
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart ssh
```

## 2. Install the toolchain (Node 22, pnpm, Docker, Claude Code)
```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm install -g pnpm@10 @anthropic-ai/claude-code   # Claude Code CLI (verify current install at https://code.claude.com/docs)
# Docker + compose plugin
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker sre
# log out/in so the docker group applies, then check:
docker --version && docker compose version && node --version && pnpm --version
```
Then start Claude Code in the repo (next step) and sign in when prompted.

## 3. Get the code
```bash
sudo mkdir -p /opt/sre && sudo chown sre:sre /opt/sre && cd /opt/sre
git clone <REPO_URL> app && cd app
# Deploy the DEFAULT branch (main). It includes the GAP-SEC-06 step-up fix, the DEMO banner and
# the pilot seed tooling — all added AFTER the `pilot-rc-1` tag. Do NOT check out pilot-rc-1: that
# tag is the pre-fix baseline and is missing the security fix and the demo tooling. Record the SHA:
git rev-parse HEAD
pnpm install --frozen-lockfile
```

## 4. Configure the pilot environment (secrets generated ON the box — never committed)
```bash
cd infra/compose
cp .env.pilot.example .env.pilot
# Generate fresh secrets and fill them into .env.pilot (do NOT paste these anywhere else):
openssl rand -hex 24     # -> POSTGRES_PASSWORD
openssl rand -base64 48  # -> PACK_SIGNING_KEY
openssl rand -base64 48  # -> IDP_SIGNING_KEY   (the pilot/test IdP signing key)
# Set in .env.pilot: POSTGRES_PASSWORD, DATABASE_URL (compose the postgres URL from the parts),
#   PACK_SIGNING_KEY, IDP_SIGNING_KEY, IDP_ISSUER (your pilot test-IdP URL), IDP_AUDIENCE=sre-retail-os-api,
#   EDGE_TENANT_ID=pilot-demo, and BOOTSTRAP_OWNER_* for the genesis owner (OA-6).
# Confirm the safe posture is pinned (already in the template): NODE_ENV=production, MIGRATION_TARGET_KIND=rehearsal.
```

## 5. HTTPS in front (TLS terminated before web/api)
- **If you set a domain (recommended):** run a small **Caddy** reverse proxy — it fetches a free Let's Encrypt
  certificate automatically and proxies `443 → web (8080)` and the API path `→ api (8081)`. (Caddyfile:
  `demo.yourdomain { reverse_proxy /v1/* localhost:8081; reverse_proxy localhost:8080 }`.)
- **If IP-only:** generate a self-signed certificate and terminate TLS with the repo's nginx TLS block
  (`infra/compose`) — the browser shows a one-time warning, acceptable for a synthetic demo.
- The DB stays bound to localhost; only 443 is exposed (UFW from step 1).

## 6. Bring the stack up + validate
```bash
cd infra/compose
docker compose -p sre-pilot -f docker-compose.yml -f docker-compose.pilot.yml --env-file .env.pilot up -d
# Migrations on the fresh pilot DB:
DATABASE_URL="<the pilot DB URL>" pnpm run db:migrate
# Readiness — must print GREEN (settings filled, API live+ready, till screen served):
STANDUP_ENV_FILE=infra/compose/.env.pilot pnpm run standup:check
```

## 7. Build the shells WITH the DEMO banner
```bash
# Bake the "DEMO / PILOT — NOT PRODUCTION" banner into the served bundles:
PILOT_DEMO_BANNER=1 pnpm run build:erp
PILOT_DEMO_BANNER=1 pnpm run build:pos
# (repeat for owner/picker/delivery/customer/warehouse shells as the demo needs)
```

## 8. Seed the synthetic demo data (through the REAL routes, via the test IdP)
The reproducible dataset + appliers are in `db/seed/pilot/` (`apply.ts` drives `applyPilotFoundation →
Catalogue → TradingPartners → Transactions`). For a **live** server, drive them through an **HTTP SeedClient**
that (a) mints bearer tokens with the test IdP signing key (pattern in `tests/support/local-idp.ts` — fresh
`auth_time` + `amr:['pwd','mfa']` so step-up routes pass) and (b) POSTs to the live API base URL. **Place any
new runner OUTSIDE `services/`, `apps/`, `edge/`** (e.g. under `db/seed/` or `scripts/`) so the
`no-test-idp-in-production` guardrail stays satisfied; then run `pnpm run check` to confirm the guardrail is
still green. Everything is scoped to tenant `pilot-demo` (`syntheticDataOnly:true`), so it cannot mix with
real data.

## 9. Host-specific verification (the ⛔-live checks — capture the output)
Run these **on the box** and record results (this is what was pending a real host):
1. **Authenticated browser workflows** — log in via the demo URL as each pilot role; walk the flows in
   `DEMO-PILOT-UAT-WALKTHROUGH.md`.
2. **RBAC + tenant isolation** — a role is refused an out-of-scope action (403); a foreign tenant sees nothing.
3. **Service restart + data persistence** — `docker compose ... restart`; confirm data survives and
   `standup:check` is GREEN again.
4. **Offline / reconnection + concurrent tills** — exercise the POS offline path + two tills.
5. **Monitoring + test-alert delivery** — trigger a test alert and confirm it reaches the named incident owner.
6. **Encrypted backup + restore into a separate clean DB** — `pnpm run db:backup`; restore into a fresh DB and
   confirm control totals reconcile; confirm overwrite is refused without `--force`.
7. **Deployment rollback** — redeploy the previous build + restore, with DB-compat check.

## 10. Hand over + report
- Provide the **demo URL** + secure access, and the **staff UAT walkthrough** (`DEMO-PILOT-UAT-WALKTHROUGH.md`).
- **Report the hosted deployment + human UAT SEPARATELY** from the temporary-machine tests (owner instruction):
  a new section/doc titled "Hosted demo — actual results" with the host, release SHA/tag, the §9 evidence, any
  defects (defect policy in `PILOT-GATES.md`), and what human UAT still remains.

## Appendix — first prompt for the on-server Claude Code session
> You are on the pilot demo server (MilesWeb VM3, Mumbai, Ubuntu 22.04), non-production, **synthetic data
> only**. Follow `docs/pilot/DEMO-PILOT-STANDUP-RUNBOOK.md` exactly. Stand up the isolated demo: harden the
> box, install Docker, deploy the repo's **default branch (main)** — which includes the GAP-SEC-06 fix, the
> DEMO banner and the seed tooling added after the `pilot-rc-1` tag (do NOT use pilot-rc-1) — generate secrets
> on the box, put HTTPS in front,
> bring up the `sre-pilot` compose stack, run migrations, build the shells with `PILOT_DEMO_BANNER=1`, seed the
> `pilot-demo` synthetic dataset through the real routes via the test IdP, then run the §9 host-specific checks
> and capture evidence. **Do NOT** import real product/price data (Option 2 is unapproved), connect any live
> provider, or enable payroll bank-file release / bulk product publish. Report the hosted results **separately**
> from the temporary-machine results already in the repo. If any secret or credential is needed, generate it on
> the box; never print it into the repo, logs or chat. Stop and ask the owner before any destructive or
> irreversible action.
