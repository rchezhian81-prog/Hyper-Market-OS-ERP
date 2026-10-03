# Administrator handover — connect and deploy the demo box (one sheet, 2 October 2026)

_Status 3 Oct 2026: NOT executed — the build session has no route to the box (no client, key or address; port 22 egress blocked); see `docs/STATUS.md` for the two ways forward. The sheet stands ready._

_For the person with administrator access to the demo VPS and to the GitHub repository settings. Everything on this sheet
is **PREPARED** by the build session and **EXECUTED** by you; the build session has no route to the box, no key and no
address, and no secret may pass through it. Follow the steps in order. Where a step says ⚠ STOP, stop and report._

**Where each step runs** is in its heading: **[BOX]** = a shell on the demo VPS as the administrator; **[YOUR PC]** = your own
computer; **[GITHUB]** = the repository's web settings; **[STORE PC]** = the shop computer (after deployment, separate runbook).

**Two rules for everything you send back:** (1) never a key, a password, a token or the contents of `.env.pilot`; (2) replace
the box's address with the word `<box>` before pasting. Every command below prints nothing secret unless you add to it.

**Prerequisites:** administrator SSH login to the box · `ssh` and `ssh-keygen` on your PC · a GitHub account with admin
rights on the repository · about 60 minutes · the demo hostname if you have one (a domain pointing at the box), or the
box's public IP otherwise.

---

## A. [BOX] Preserve the server work and the runtime configuration — before touching anything

```bash
P=/opt/sre/preserve-$(date +%F); sudo mkdir -p "$P" && sudo chmod 700 "$P"
sudo cp -a /opt/sre/app/infra/compose/.env.pilot "$P"/                       # the runtime secrets and settings, as they are
sudo cp -a /opt/sre/deploy.conf "$P"/ 2>/dev/null || true
for d in /etc/caddy /etc/nginx /etc/apache2 /etc/traefik; do [ -d "$d" ] && sudo cp -a "$d" "$P"/; done   # whatever front exists
cd /opt/sre/app && git rev-parse HEAD && git status --short | tee "$P"/git-status.txt && git diff | sudo tee "$P"/uncommitted.patch >/dev/null
git stash list | tee "$P"/stashes.txt; git branch -a | tee "$P"/branches.txt
git check-ignore -v infra/compose/.env.pilot                                   # MUST print a line: the env file is ignored by git
```

**Evidence to return:** the commit id printed by `git rev-parse HEAD` (expected `e72b4ae…`), the `git status --short` list,
the branch list, and the one line from `git check-ignore`. ⚠ STOP if `git check-ignore` prints nothing.

## B. [BOX] Push the stand-up work for review — secrets excluded

The box holds work the repository does not (the demo sign-in page, the data bridge, the fixed-UUID demo tenant, the hosted
results, ADR 0016). It is reviewed and merged by the build session **before** anything from `main` is re-seeded.

```bash
cd /opt/sre/app
git switch -c claude/pilot-hosted-standup 2>/dev/null || git switch claude/pilot-hosted-standup
git add -A -n | grep -Ei '\.env|\.pem$|\.key$|id_ed25519|id_rsa|secret|password|backups/|\.dump$' && echo "⚠ STOP — a secret-looking file is staged above" || echo "nothing secret-looking staged"
git add -A && git commit -m "hosted stand-up work from the demo box (28 Sep 2026)" || echo "nothing new to commit"
git push -u origin claude/pilot-hosted-standup
git log --oneline -5
```

**Evidence to return:** the five `git log` lines. ⚠ STOP if the grep printed a file. The build session then reviews the
branch against `main`, keeps the useful work, excludes anything with an address or a secret, and merges it by pull request.

## C. [BOX] Inspect ports 80/443 and the existing front — choose configuration A or B

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
systemctl list-units --type=service --state=running | grep -Ei 'caddy|nginx|apache|httpd|traefik|haproxy' || echo "no front service running"
docker ps --format '{{.Names}}  {{.Ports}}'
sudo ufw status numbered
```

Read the output and pick **one**:

| If… | Then it is configuration… |
|---|---|
| Nothing else uses 80/443, **or** the only thing there is the front the 28 Sep stand-up installed by hand for this demo (a host Caddy/nginx forwarding to the demo's own API/edge) | **A — the stack's own proxy takes 443/80.** In step F you stop and disable that hand-installed front. The demo is then exactly what the repository's compose file describes. |
| **Another application** on this VPS is served through the existing front on 80/443 | **B — the existing front stays and forwards one hostname to the demo.** The stack's proxy binds loopback ports only; nothing else on the box is interrupted. |

**Evidence to return:** the `ss` output (addresses replaced by `<box>`), the service list line, the `docker ps` lines, and the
letter you chose.

## D. [BOX] Back up the database — with the CURRENT administrator connection, before anything changes

```bash
cd /opt/sre/app && sudo mkdir -p /opt/sre/backups && sudo chown "$USER" /opt/sre/backups
DATABASE_URL="$(sudo grep -E '^DATABASE_URL=' infra/compose/.env.pilot | cut -d= -f2-)" pnpm run db:backup -- --out /opt/sre/backups
ls -la /opt/sre/backups | tail -3
```

(`docs/runbooks/backup-and-recovery.md` is the authority; the tool writes the dump with the control totals beside it.) Keep a
copy off the machine as that runbook says. **Evidence to return:** the `ls` lines (file names and sizes only).

## E. [BOX] Create the application database role on the EXISTING database

Since migration 0012 the API refuses to run as the database superuser (row-level security). A fresh install creates the role
itself; your database was created before that, so once, by hand. Read `POSTGRES_USER` and `POSTGRES_DB` from `.env.pilot`
(names, not secrets) and use the **same password as `POSTGRES_PASSWORD`**, typed into the terminal only:

```bash
cd /opt/sre/app/infra/compose
C="docker compose -p sre-pilot -f docker-compose.yml -f docker-compose.pilot.yml --env-file .env.pilot"
read -rs -p "POSTGRES_PASSWORD from .env.pilot: " PW; echo                      # typed blind — never on the command line, never in history
$C exec db psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "CREATE ROLE sre_pilot_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '$PW';"
unset PW
$C exec db psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "GRANT CONNECT, TEMPORARY ON DATABASE <POSTGRES_DB> TO sre_pilot_app; GRANT ALL ON SCHEMA public TO sre_pilot_app;"
$C exec db psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "REASSIGN OWNED BY <POSTGRES_USER> TO sre_pilot_app;"
$C exec db psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "\du sre_pilot_app"
```

**Evidence to return:** the `\du` table (one row, `Cannot login` absent, no `Superuser`, no `Bypass RLS`).

## F. [BOX] Settings — `.env.pilot` gains what the new release needs

Edit `infra/compose/.env.pilot` (the template at `main`, `infra/compose/.env.pilot.example`, shows each line with a comment):

| Line | Set it to | Both A and B? |
|---|---|---|
| `APP_DB_USER=` | `sre_pilot_app` (the role from step E) | both |
| `DATABASE_URL=` | the same URL with the **user part changed** from `<POSTGRES_USER>` to `sre_pilot_app` (same password, same host, same database) | both |
| `SRE_PUBLIC_HOST=` | **A with a domain:** `demo.yourdomain` · **A without a domain:** `localhost, 127.0.0.1, <the box's public IP>` · **B:** `demo.yourdomain` (the name the existing front will forward) | both |
| `SRE_TLS=` | **A with a domain:** the email address for certificate notices · **A without / B:** `internal` | both |
| `SRE_DEFAULT_SNI=` | `localhost` (leave the default) | both |
| `SRE_AUTH_ROUTE=` / `SRE_AUTH_UPSTREAM=` | leave the defaults (`auth-not-deployed`, `auth:8082`) | both |
| `HTTPS_PORT=` / `HTTP_PORT=` | **A:** `443` / `80` · **B:** `127.0.0.1:8443` / `127.0.0.1:8088` (loopback only — nothing new reaches the internet) | — |
| `EDGE_TENANT_ID=` | **leave it** — the demo tenant's fixed UUID the stand-up set; the store token and the smoke test read it | both |

Then the front, by configuration:

- **A:** `sudo systemctl disable --now <the hand-installed front service>` (from step C) and `sudo ufw allow 80/tcp` (the
  stand-up opened only 443; port 80 carries the http→https redirect and the simplest certificate issuance).
- **B:** add ONE site to the existing front and reload it. It terminates TLS with its own certificate for the demo hostname
  and forwards to the stack's proxy on loopback, keeping the `Host` header (the stack's proxy answers only for
  `SRE_PUBLIC_HOST`). The stack's own certificate for that name is self-made, so the front skips verification on that
  loopback hop only.

  Caddy (`/etc/caddy/Caddyfile`):
  ```
  demo.yourdomain {
  	reverse_proxy https://127.0.0.1:8443 {
  		header_up Host {host}
  		transport http {
  			tls_insecure_skip_verify
  		}
  	}
  }
  ```
  nginx (a new `server` block):
  ```
  server {
    listen 443 ssl; server_name demo.yourdomain;
    # your existing ssl_certificate / ssl_certificate_key lines for this name
    location / { proxy_pass https://127.0.0.1:8443; proxy_ssl_verify off; proxy_ssl_server_name on; proxy_ssl_name demo.yourdomain; proxy_set_header Host $host; }
  }
  ```
  **Recorded limitation of B:** the stack's proxy overwrites the client address with the front's (loopback), so the API's
  per-IP rate limit and sign-in lockout are shared by every visitor of the demo. Acceptable for a synthetic demo; not for
  real customers.

**Evidence to return:** the letter (A or B); for A the `ufw status` line for 80; for B the one site block as added
(hostname only). Never the env file.

## G. [BOX] Bring the checkout to `main`

The running containers keep serving the old release until the pipeline deploys; this only moves the files.

```bash
cd /opt/sre/app && git switch main && git fetch origin main && git pull --ff-only && git rev-parse HEAD && git status --short | wc -l
```

**Evidence to return:** the commit id (it must be `0bf098a…` or newer) and the count (`0`). ⚠ STOP if `pull --ff-only` refuses:
step B was not completed.

## H. [BOX] + [YOUR PC] Restricted deployment access — the `deploy` user, the key that can only run the release script

Follow `docs/runbooks/automatic-deployment.md`, "One-time set-up", steps 1–6, exactly. In short:

1. **[BOX]** `sudo adduser --disabled-password --gecos "" deploy && sudo usermod -aG docker deploy && sudo chown -R deploy:deploy /opt/sre`
2. **[BOX]** `sudo -u deploy git -C /opt/sre/app fetch origin main` must succeed (the same read-only deploy key or token the stand-up used).
3. **[BOX]** `sudo -u deploy cp /opt/sre/app/infra/deploy/deploy.conf.example /opt/sre/deploy.conf` — keep `SRE_BUILD_ENV="PILOT_DEMO_BANNER=1"`; change nothing else unless your paths differ.
4. **[YOUR PC]** `ssh-keygen -t ed25519 -N "" -C sre-retail-os-pipeline -f sre-pipeline-key` — two files; the private one goes into GitHub in step I and is then deleted.
5. **[YOUR PC]** `ssh-keyscan -t ed25519 -p 22 <the box's address>` — keep the one output line that starts with the address.
6. **[BOX]** put the public key as the ONE forced-command line from `infra/deploy/authorized_keys.example` into
   `/home/deploy/.ssh/authorized_keys` (folder 700, file 600, owned by `deploy`), replacing `REPLACE_WITH_THE_PUBLIC_KEY`
   with the key part of `sre-pipeline-key.pub`.

**Evidence to return:** `sudo -u deploy cat /home/deploy/.ssh/authorized_keys | cut -c1-60` (the forced command prefix only)
and `ls -la /opt/sre/deploy.conf`.

## I. [GITHUB] The `demo` environment and its five secrets

Repository → **Settings → Environments → New environment** → name it exactly `demo` → **Add environment secret**, five times:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the box's address (host name or IP) |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_PORT` | `22` (or your SSH port) |
| `DEPLOY_SSH_KEY` | the **entire contents** of the private key file `sre-pipeline-key` |
| `DEPLOY_HOST_KEY` | the one line `ssh-keyscan` printed in step H.5 |

Then **[YOUR PC]** `rm sre-pipeline-key sre-pipeline-key.pub`. The private key now exists only in GitHub's secret store.

**Evidence to return:** a screenshot or the list of the five secret **names** on the environment page (values are hidden there).

## J. [GITHUB] Deploy the latest eligible `main` commit

Repository → **Actions → CI → the newest run on `main`** → **Re-run all jobs**. (Or merge the next pull request.) The commit it
deploys is that run's `main` head — it must be `0bf098a` or newer (the first commit that holds `pnpm run demo:smoke`).

Wait for the job **Deploy the merged release to the demo box (rolls back if it does not come up)**. Green = the box is on that
commit and the stand-up check is GREEN. Red = read the job log; the table "When it goes red" in `automatic-deployment.md`
says what each line means. The three likeliest first-release failures and their causes: `port is already allocated` (step F's
front still holds 80/443), `refuses to start on a superuser` (step E/F: the role or the URL), a TLS handshake failure (step F:
`SRE_PUBLIC_HOST` does not name the address you are using).

**Evidence to return:** the run number, the commit id in the job summary line "Deployed … to the demo box", and the job's
colour. ⚠ A green run whose deploy step says "No demo box is configured" means step I is incomplete — that is NOT a deployment.

## K. [BOX] Verify what is actually running

```bash
tail -3 /opt/sre/releases.log                                                   # last line: result=deployed sha=<the commit> previous=<the old one>
git -C /opt/sre/app rev-parse HEAD                                              # the same commit
curl -s http://127.0.0.1:8081/readyz; echo                                      # {"ready":true,…}
cd /opt/sre/app/infra/compose && C="docker compose -p sre-pilot -f docker-compose.yml -f docker-compose.pilot.yml --env-file .env.pilot"
$C ps
$C logs migrate 2>/dev/null | tail -5                                           # 13 migrations applied once; "0" on a re-run
cd /opt/sre/app && STANDUP_ENV_FILE=infra/compose/.env.pilot pnpm run standup:check   # GREEN on every piece
H=https://<the demo hostname or the box's IP>                                   # configuration A: the box; B: the name the front serves
curl -skI "$H/customer/" | head -1                                              # HTTP/2 200 — the customer app, DEMO banner inside
curl -sk "$H/v1/livez"; echo                                                    # the API through the proxy
curl -sk -o /dev/null -w '%{http_code}\n' "$H/v1/floor/indents"                 # 401 — the API refuses an unauthenticated call by name
curl -sk -o /dev/null -w '%{http_code}\n' "$H/auth/anything"                    # 503 — customer sign-in is "not deployed", by name (KL-15)
curl -sk -o /dev/null -w '%{http_code}\n' "$H/pos/"                             # 404 — staff screens are NOT on the public origin
```

Open `$H/customer/` in a browser: the **DEMO / PILOT — NOT PRODUCTION** banner must be visible.

**Evidence to return:** every line's output, with the address replaced by `<box>`. The sign-in posture is the pair 401/503:
the API accepts only a token (the smoke in step L proves hundreds of accepted, authenticated calls) and customer sign-in
is deliberately not deployed.

## L. [BOX] Prove the deployed workflow — the smoke

```bash
cd /opt/sre/app && pnpm run demo:smoke -- --env-file infra/compose/.env.pilot --report /opt/sre/smoke-$(date +%F).json; echo "EXIT=$?"
cat /opt/sre/smoke-$(date +%F).json
```

It creates a fresh synthetic tenant and runs sixteen steps through the real routes against the API this box is serving, with a
real store box started inside the command: supplier → order → delivery with quarantine → QC → indent / approval / issue /
independent receipt → the till sells one by barcode → **the shelf falls by exactly one** → an eligible resale return
**puts it back** → float, pickup, blind close → cash office balanced → invoice, debit note, payables and day book balanced
→ dashboard → the same sale re-sent banks once. `EXIT=0` only when all sixteen pass. The report holds no secret.

**Evidence to return:** `EXIT=…` and the whole report file. The two steps that answer the owner's question read "…shelf 9…"
(the sale took one) and "…shelf 10…" (the return restored it) in their detail.

## M. Afterwards

- **[STORE PC]** and the phones: `docs/runbooks/demo-practice-environment.md` §4, at the SAME commit the release log names.
- The demo address goes to the owner **directly from you**, never into the repository or a chat with the build session.
- Rollback, if ever needed (custodian, on the box): `sudo -u deploy /opt/sre/app/infra/deploy/release.sh <previous sha>`.

## Evidence checklist — what the build session needs back (no address, key or secret)

| Step | Evidence |
|---|---|
| A | `rev-parse` id · `git status --short` · branch list · the `check-ignore` line |
| B | five `git log --oneline` lines; confirmation nothing secret-looking was staged |
| C | `ss` / service / `docker ps` output (addresses as `<box>`) · the letter A or B |
| D | the backup file names and sizes |
| E | the `\du` row |
| F | the letter; A: the ufw line for 80; B: the site block (hostname only) |
| G | the `main` commit id · `0` |
| H | the forced-command prefix · `ls -la /opt/sre/deploy.conf` |
| I | the five secret names on the `demo` environment page |
| J | run number · "Deployed <sha> to the demo box" · green |
| K | every verification line |
| L | `EXIT=0` · the smoke report JSON |

On receipt the build session: reviews and merges the stand-up branch (B), records the deployed commit as the software
version in `docs/registers/sp10-staff-uat.md`, files the smoke report under `docs/evidence/`, updates
`docs/runbooks/demo-practice-environment.md` §0 from PREPARED to EXECUTED where the evidence shows it, and hands the owner
the access instructions (§6 of that runbook) for the practice sessions.
