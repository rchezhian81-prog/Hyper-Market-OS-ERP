# Administrator handover — connect and deploy the demo box (one sheet, 2 October 2026)

_Status 3 Oct 2026, evening: **EXECUTED by the administrator (the owner), steps A–L.** Deployed `2f9714c` by pipeline run 37125939387 (the first attempt, run 37120682570, died on an unattended pnpm prompt — fixed in #679 and the fix deployed itself); K verified (release log, commit, readyz, 13 migrations / 2 applied, public 200 · 401 · 302 · 200); smoke **16/16**; the sign-in page live at `/login/`. Evidence: `docs/evidence/demo-deployment-2026-10-03.md`. Snags met on the way and now written into the steps below: E (the application login was the bootstrap superuser), F (an empty address left the proxy restarting while the stand-up check stayed GREEN — the release script now checks the front), K (a headers-only request gets 405), L (the compose name `db` from the box — the smoke now translates it). Owner **Option 3 (OB-11)** was taken: `main` deployed with the sign-in gate already merged, so there was no gap in the staff screens. Earlier that day: NOT executed — the build session has no route to the box (no client, key or address; port 22 egress blocked); see `docs/STATUS.md`. The sheet stands ready._

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
| Nothing else uses 80/443, **or** the only thing there is the front the 28 Sep stand-up installed for this demo — a host Caddy/nginx forwarding to the demo's own API/edge, **or the demo stack's own `web` container holding 443 (`sre-pilot-web-1`, shown by `docker ps` as `0.0.0.0:443->443/tcp`; this is what the box showed on 3 Oct 2026)** | **A — the stack's own proxy takes 443/80.** In step F you stop and disable that hand-installed front. The demo is then exactly what the repository's compose file describes. |
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

⚠ **First check whether `POSTGRES_USER` is itself `sre_pilot_app`** (`grep -oE '^POSTGRES_USER=.*' .env.pilot`). If it is, the
box's database was born with that single login and PostgreSQL will not take SUPERUSER away from its bootstrap user
(`The bootstrap user must have the SUPERUSER attribute`, met on 3 Oct 2026). Then keep `sre_pilot_app` as the
administrator and create the limited application login **`sre_app`** instead — the name a fresh install creates — and hand the
tables over to it, tables first (a counter linked to a table moves with its table and cannot be handed over on its own):

```bash
cd /opt/sre/app/infra/compose
D=$(grep -E '^POSTGRES_DB=' .env.pilot | cut -d= -f2-); PW=$(grep -E '^POSTGRES_PASSWORD=' .env.pilot | cut -d= -f2-)
C="docker compose -p sre-pilot -f docker-compose.yml -f docker-compose.pilot.yml --env-file .env.pilot"
$C exec db psql -U sre_pilot_app -d "$D" -c "CREATE ROLE sre_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '$PW';"; unset PW
cat > /tmp/handover-e.sql <<'SQL'
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO sre_app;
GRANT ALL ON SCHEMA public TO sre_app;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relkind, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner
           WHERE n.nspname = 'public' AND o.rolname = 'sre_pilot_app' AND c.relkind IN ('r','p','v','m') LOOP
    IF r.relkind = 'v' THEN EXECUTE format('ALTER VIEW public.%I OWNER TO sre_app', r.relname);
    ELSIF r.relkind = 'm' THEN EXECUTE format('ALTER MATERIALIZED VIEW public.%I OWNER TO sre_app', r.relname);
    ELSE EXECUTE format('ALTER TABLE public.%I OWNER TO sre_app', r.relname); END IF;
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner
           WHERE n.nspname = 'public' AND o.rolname = 'sre_pilot_app' AND c.relkind = 'S' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO sre_app', r.relname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
           WHERE n.nspname = 'public' AND o.rolname = 'sre_pilot_app' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO sre_app', r.sig);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_roles o ON o.oid = t.typowner
           WHERE n.nspname = 'public' AND o.rolname = 'sre_pilot_app' AND t.typtype IN ('e','d') LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO sre_app', r.typname);
  END LOOP;
END $$;
SQL
$C exec -T db psql -U sre_pilot_app -d "$D" -v ON_ERROR_STOP=1 -v db="$D" < /tmp/handover-e.sql; rm /tmp/handover-e.sql
sed -i 's/^APP_DB_USER=.*/APP_DB_USER=sre_app/; s#://sre_pilot_app:#://sre_app:#; s#://sre_pilot_app@#://sre_app@#' .env.pilot
$C exec db psql -U sre_pilot_app -d "$D" -c "\du" -c "\dt"
```

Evidence then: `sre_app` with an empty Attributes column, every table's Owner `sre_app`, and `POSTGRES_USER` unchanged. In step F
set `APP_DB_USER=sre_app` (the line above already did) and leave `POSTGRES_USER` as it is. **Otherwise**, the standard case:

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
| `SRE_PUBLIC_HOST=` | ⚠ never an empty entry — `localhost, 127.0.0.1, ` with nothing after the last comma leaves the proxy restarting forever while the stand-up check stays GREEN (3 Oct 2026; the release script now checks the front and says NOT HEALTHY). Check with `grep -oE '^SRE_PUBLIC_HOST=.*' .env.pilot`. · **A with a domain:** `demo.yourdomain` · **A without a domain:** `localhost, 127.0.0.1, <the box's public IP>` · **B:** `demo.yourdomain` (the name the existing front will forward) | both |
| `SRE_TLS=` | **A with a domain:** the email address for certificate notices · **A without / B:** `internal` | both |
| `SRE_DEFAULT_SNI=` | `localhost` (leave the default) | both |
| `SRE_AUTH_ROUTE=` / `SRE_AUTH_UPSTREAM=` | leave the defaults (`auth-not-deployed`, `auth:8082`) | both |
| `HTTPS_PORT=` / `HTTP_PORT=` | **A:** `443` / `80` · **B:** `127.0.0.1:8443` / `127.0.0.1:8088` (loopback only — nothing new reaches the internet) | — |
| `EDGE_TENANT_ID=` | **leave it** — the demo tenant's fixed UUID the stand-up set; the store token and the smoke test read it | both |

Then the front, by configuration:

- **A:** `sudo systemctl disable --now <the hand-installed front service>` (from step C; **skip this line when step C showed no host front service** — the 28 Sep front is the stack's own `web` container, which the first release replaces by itself) and `sudo ufw allow 80/tcp` (the
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

⚠ **Not harmless on a box whose running front serves the shells straight from this checkout** — the 28 Sep stand-up does (`web`
bind-mounts `apps/*/web` and `nginx.pilot.conf`): the moment the folder is on `main`, the live demo serves `main`'s files. So do G in
the **same sitting as J, right before it**. And first, while the checkout still describes them, remove the two demo-only containers
(the relay shares the edge's network namespace; left behind, the release may fail to recreate the edge):

```bash
cd /opt/sre/app/infra/compose && docker compose -p sre-pilot -f docker-compose.yml -f docker-compose.pilot.yml --env-file .env.pilot rm -sf edge-relay demo-login
```

Then:

```bash
cd /opt/sre/app && git switch main && git fetch origin main && git pull --ff-only && git rev-parse HEAD && git status --short | wc -l
```

**Evidence to return:** the commit id (it must be `0bf098a…` or newer) and the count (`0`). ⚠ STOP if `pull --ff-only` refuses:
step B was not completed.

## H. [BOX] + [YOUR PC] Restricted deployment access — the `deploy` user, the key that can only run the release script

Follow `docs/runbooks/automatic-deployment.md`, "One-time set-up", steps 1–6, exactly. In short:

1. **[BOX]** `sudo adduser --disabled-password --gecos "" deploy && sudo usermod -aG docker deploy && sudo chown -R deploy:deploy /opt/sre`
2. **[BOX]** `sudo -u deploy git -C /opt/sre/app fetch origin main` must succeed (the same read-only deploy key or token the stand-up used).
3. **[BOX]** `sudo -u deploy cp /opt/sre/app/infra/deploy/deploy.conf.example /opt/sre/deploy.conf` — keep `SRE_BUILD_ENV` and `SRE_BUILD_TOOLS` as the example has them (the demo banner, the demo till's lane path, the demo sign-in bundle); change nothing else unless your paths differ.
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

**What the first deployment of `main` changes on the demo address (owner Option 3, OB-11, 3 Oct 2026):** the staff screens, the demo
sign-in and `/store/…` answer **404 by name** until the sign-in-gate release — the merge of the box's stand-up branch behind the
public proxy (ADR-0018 amendment) — deploys itself through this same pipeline; the customer app, the API, the database, the
store-edge sync and the demo logins on the box's disk are unaffected. After that release the staff screens are at
`https://<demo>/login/` (sign in, then the till, owner, ERP, picker, driver, warehouse and supplier screens, and the demo store box
at `/store/…`).

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
curl -sk -o /dev/null -w '%{http_code}\n' "$H/customer/"                        # 200 — the customer app (a headers-only request, -I, gets 405 from the edge's screen server; not a fault)
curl -sk "$H/v1/livez"; echo                                                    # the API through the proxy
curl -sk -o /dev/null -w '%{http_code}\n' "$H/v1/floor/indents"                 # 401 — the API refuses an unauthenticated call by name
curl -sk -o /dev/null -w '%{http_code}\n' "$H/auth/anything"                    # 503 — customer sign-in is "not deployed", by name (KL-15)
curl -sk -o /dev/null -w '%{http_code}\n' "$H/pos/"                             # 404 before the sign-in-gate release; 302 (to /login/) after it — behind the demo sign-in either way
curl -sk -o /dev/null -w '%{http_code}\n' "$H/login/"                           # 404 before the sign-in-gate release; 200 after it — the demo sign-in page
```

Open `$H/customer/` in a browser: the **DEMO / PILOT — NOT PRODUCTION** banner must be visible.

After the DF-1 release (3 Oct 2026, OB-12): sign in at `$H/login/` and you land on the **demo home**, which lists the pages that work on
this demo and names the store-computer-fed shells as such. Do not judge the demo by `/erp/` — the Store manager shell shows
"Not known" until a store computer (or, on the demo, the DF-2 pack) feeds it.

**Known after the sign-in-gate release (H-14, `docs/STATUS.md` 3 Oct 2026):** the demo till at `$H/store/pos/` will list the five
seeded products under "Products nobody can sell" with `unknown unit of measure "each"` / `"litre"` until a person corrects their units
to the engine's codes (`ea`, `L`) — the seed is corrected in the repository; the box's data was seeded before. Not a deployment fault.

**Evidence to return:** every line's output, with the address replaced by `<box>`. The sign-in posture is the pair 401/503:
the API accepts only a token (the smoke in step L proves hundreds of accepted, authenticated calls) and customer sign-in
is deliberately not deployed.

## L. [BOX] Prove the deployed workflow — the smoke

```bash
cd /opt/sre/app && sudo -u deploy pnpm run demo:smoke -- --env-file infra/compose/.env.pilot --report /opt/sre/smoke-$(date +%F).json; echo "EXIT=$?"
cat /opt/sre/smoke-$(date +%F).json
```

Run it as `deploy`, so the bundles it builds in the checkout stay the deploy user's. The settings file names the database `db`
(its name inside the containers); since 3 Oct 2026 the smoke translates that to the box's own loopback itself and says so. On an
older checkout, run it against a temporary copy: `sudo -u deploy sh -c "umask 077; sed 's/@db:/@127.0.0.1:/' infra/compose/.env.pilot > /opt/sre/.env.smoke"`,
pass `--env-file /opt/sre/.env.smoke`, then `sudo -u deploy rm -f /opt/sre/.env.smoke`.

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

**Received 3 Oct 2026, A–L** — summarised in `docs/evidence/demo-deployment-2026-10-03.md`; deployed `2f9714c`.

On receipt the build session: reviews and merges the stand-up branch (B), records the deployed commit as the software
version in `docs/registers/sp10-staff-uat.md`, files the smoke report under `docs/evidence/`, updates
`docs/runbooks/demo-practice-environment.md` §0 from PREPARED to EXECUTED where the evidence shows it, and hands the owner
the access instructions (§6 of that runbook) for the practice sessions.
