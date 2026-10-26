#!/usr/bin/env bash
# infra/deploy/release.sh — put ONE merged commit of SRE Retail OS live on this box, or put the previous one back.
#
# Stage F slice 1 (§19/§20 "containers, IaC, CI/CD" · AID-08 "sign releases, stage rollout and prove rollback" ·
# hard rule #8 · P-08). The CI `release` job calls this over SSH after every merge to main whose checks are green
# (see .github/workflows/ci.yml and docs/runbooks/automatic-deployment.md). It can also be run by hand by the
# custodian:  infra/deploy/release.sh <commit-sha>
#
# What it does, in order — and what it refuses:
#   1. Refuses anything that is not a 40-character commit id, and any commit that is NOT on origin/main.
#      A branch, a tag, "latest", or a commit somebody pushed around the pull-request gate never deploys.
#   2. Fetches, remembers the commit that is live now (the rollback target), checks the new commit out, and
#      RE-RUNS ITSELF from that checkout — so the deploy logic used is the one shipped with the release, and
#      the key in authorized_keys can be pinned to this one script for ever (forced command).
#   3. Installs dependencies, builds the app shells, brings the compose stack up (`migrate` applies any new
#      schema first; it is idempotent), waits for the API to say READY, and runs the stand-up check.
#   4. If any of that fails: puts the previous commit back the same way, and exits 70 so the pipeline goes RED
#      while the shop is on the release that worked. If even that does not come back: exit 71 — a person now.
#   5. Appends one line per attempt to an append-only release log: when, which commit, which it replaced, the
#      result, who merged it and which pipeline run — the box's own record of what has been live.
#
# What it never does: print a secret (it reads no .env — it only hands the path to compose and the check),
# `docker compose down -v`, touch the database by hand, or deploy with another deploy still running.
#
# Settings: every value has a default matching docs/pilot/DEMO-PILOT-STANDUP-RUNBOOK.md and can be overridden
# in /opt/sre/deploy.conf (see deploy.conf.example — no secret belongs there either).
#
# Exit codes (BSD sysexits, so a pipeline can tell them apart):
#   0 deployed · 64 usage · 65 refused (not on main) · 69 refused (the pre-release backup failed, or the books could not be
#   read before the release) ·
#   70 rolled back to the previous release (it did not come up, failed its canary bake, or its books did not reconcile) ·
#   71 rollback failed too · 75 another deployment is running · 77 refused (this box checks release signatures and the
#   release is unsigned or its signature does not verify) · 78 the box is not set up for this (round 32: or its
#   settings file lacks a setting this release requires — refused before anything is rebuilt, the box untouched).
#
# WF-20 (ADR-0026): before anything changes, the box's pre-release backup runs (SRE_PREDEPLOY_BACKUP_CMD); after the
# release is up and GREEN, a canary box WATCHES it for SRE_BAKE_SECONDS (READY throughout, no growth in server errors)
# before calling it deployed. The pipeline deploys to the canary box first and to the full rollout only after that.
#
# QG-10 · WF-20 "smoke/RECONCILE" (FG-3): just before the release touches anything, the box SNAPSHOTS head office's books —
# the ledger (count, last sequence, a digest, per family), the outbox's dead letters and the sync backlog — with
# scripts/release-reconcile.mjs run inside the stack's own `migrate` container (it reads the database setting from that
# container's environment; this script never reads a secret). After the release is up, GREEN and watched, it snapshots
# again and COMPARES: an event lost or altered, a new dead letter or a grown backlog is a DIFFERENCE, and the release is
# rolled back (70) like any other failure. A snapshot that cannot be taken BEFORE refuses the release (69), untouched.
# Every release attempt that gets that far appends one QG-10 evidence line (health, smoke, reconciliation, monitoring,
# rollback — each verified or not) to SRE_QG10_LOG and prints it ("QG-10 record: …") for the pipeline's summary. The
# record is evidence for the owner's QG-10 decision, never a decision (QG-12).
#
# WF-20 · AID-08 "sign releases" (OB-288 P5): a box given the release-signing PUBLIC key (SRE_RELEASE_PUBKEY) deploys
# only a commit whose signature verifies — the 4th argument, the base64 Ed25519 signature `scripts/release-signing.mjs
# sign` made over "sre-release-v1 / commit=<sha> / tree=<tree id>". The box rebuilds those lines from its own fetch and
# checks them with openssl BEFORE the backup or anything else; unsigned or not verifying → 77, the box untouched. A box
# without the key says on every run that the signature was not checked (never silently).

set -euo pipefail

say() { printf 'release: %s\n' "$*"; }
usage() {
  echo "usage: release.sh <40-hex commit sha> [actor] [run-id] [signature]" >&2
  echo "   or, as an SSH forced command:  release <sha> [actor] [run-id] [signature]" >&2
  exit 64
}

# ── Settings ────────────────────────────────────────────────────────────────────────────────────────────
CONF="${SRE_DEPLOY_CONF:-/opt/sre/deploy.conf}"
# shellcheck disable=SC1090
if [ -f "$CONF" ]; then . "$CONF"; fi
: "${SRE_APP_DIR:=/opt/sre/app}"
: "${SRE_RELEASE_BRANCH:=main}"
: "${SRE_COMPOSE_PROJECT:=sre-pilot}"
: "${SRE_COMPOSE_FILES:=docker-compose.yml docker-compose.pilot.yml}"
: "${SRE_ENV_FILE:=.env.pilot}"
: "${SRE_BUILD_SHELLS:=pos owner-app web-erp picker-app delivery-app customer-app warehouse-app}"
: "${SRE_BUILD_ENV:=}"
: "${SRE_BUILD_TOOLS:=demo-login}"
: "${SRE_RECREATE_SERVICES:=edge-relay}"
: "${SRE_API_URL:=http://127.0.0.1:8081}"
: "${SRE_FRONT_URL:=https://127.0.0.1}"
: "${SRE_WEB_URL:=http://127.0.0.1:8080}"
: "${SRE_READY_TIMEOUT:=180}"
: "${SRE_READY_POLL:=2}"
: "${SRE_RELEASE_LOG:=/opt/sre/releases.log}"
: "${SRE_DEPLOY_LOCK:=/opt/sre/deploy.lock}"
# WF-20 (ADR-0026): the backup taken BEFORE a release touches anything, and the canary bake after it comes up.
#   SRE_PREDEPLOY_BACKUP_CMD — a command that takes a backup and exits 0 only when it succeeded; empty = none here
#                              (said on every run). A failed backup refuses the release (69) with nothing touched.
#   SRE_BAKE_SECONDS         — how long to WATCH the new release before calling it deployed (the canary box: e.g.
#                              600). 0 = no bake. During the bake the API must stay READY and its server errors
#                              (5xx on /metricz) must not grow by more than SRE_BAKE_MAX_5XX — or it is rolled back.
: "${SRE_PREDEPLOY_BACKUP_CMD:=}"
: "${SRE_BAKE_SECONDS:=0}"
: "${SRE_BAKE_POLL:=15}"
: "${SRE_BAKE_MAX_5XX:=0}"
# WF-20 · AID-08: the path of the release-signing PUBLIC key (PEM). Empty = signatures are not checked here (said).
: "${SRE_RELEASE_PUBKEY:=}"
# QG-10 · WF-20 post-deploy reconcile (FG-3).
#   SRE_RECONCILE                      on (the default) | off — off is said on every run and the QG-10 record says "not run".
#   SRE_RECONCILE_CMD                  the command that prints a snapshot (extra arguments are appended); empty = the stack's
#                                      own migrate container running this release's scripts/release-reconcile.mjs.
#   SRE_RECONCILE_MAX_BACKLOG_GROWTH   how far the sync backlog may grow across the release (default 0).
#   SRE_QG10_LOG                       the append-only file of per-release QG-10 evidence lines.
: "${SRE_RECONCILE:=on}"
: "${SRE_RECONCILE_CMD:=}"
: "${SRE_RECONCILE_MAX_BACKLOG_GROWTH:=0}"
: "${SRE_QG10_LOG:=/opt/sre/qg10-evidence.jsonl}"

COMPOSE_FILE_ARGS=()
for f in $SRE_COMPOSE_FILES; do COMPOSE_FILE_ARGS+=(-f "$f"); done
compose() { (cd "$SRE_APP_DIR/infra/compose" && docker compose -p "$SRE_COMPOSE_PROJECT" "${COMPOSE_FILE_ARGS[@]}" --env-file "$SRE_ENV_FILE" "$@"); }

# ── Arguments (a forced command hands them over in SSH_ORIGINAL_COMMAND) ────────────────────────────────
PHASE=1
if [ "${1:-}" = "--phase2" ]; then PHASE=2; shift; fi
if [ $# -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  read -r -a WORDS <<< "$SSH_ORIGINAL_COMMAND"
  [ "${WORDS[0]:-}" = "release" ] || usage
  set -- "${WORDS[@]:1}"
fi
SHA="${1:-}"; ACTOR="${2:-unknown}"; RUN="${3:-manual}"
SIGNATURE=""; if [ "$PHASE" = 1 ]; then SIGNATURE="${4:-}"; fi
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || usage
if [ -n "$SIGNATURE" ] && ! [[ "$SIGNATURE" =~ ^[A-Za-z0-9+/]{86}==$ ]]; then SIGNATURE="unreadable"; fi
[[ "$ACTOR" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || ACTOR=unknown
[[ "$RUN" =~ ^[A-Za-z0-9._:/-]{1,80}$ ]] || RUN=manual

record() {
  mkdir -p "$(dirname "$SRE_RELEASE_LOG")"
  printf '%s result=%s sha=%s previous=%s by=%s run=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$SHA" "${PREVIOUS:-none}" "$ACTOR" "$RUN" >> "$SRE_RELEASE_LOG"
}

# ── Phase 1: refuse, fetch, remember, check out, re-run from the new checkout ───────────────────────────
if [ "$PHASE" = 1 ]; then
  if [ ! -d "$SRE_APP_DIR/.git" ]; then
    echo "NOT SET UP — $SRE_APP_DIR is not a git checkout of the application. Follow docs/runbooks/automatic-deployment.md first." >&2
    exit 78
  fi
  # One deployment at a time. The lock is held on fd 9 and survives the exec below.
  if command -v flock >/dev/null 2>&1; then
    mkdir -p "$(dirname "$SRE_DEPLOY_LOCK")"
    exec 9>"$SRE_DEPLOY_LOCK"
    if ! flock -n 9; then
      echo "REFUSED — another deployment is running on this box. Wait for it to finish, then try again." >&2
      exit 75
    fi
  fi
  cd "$SRE_APP_DIR"
  PREVIOUS="$(git rev-parse HEAD)"
  say "fetching origin/$SRE_RELEASE_BRANCH…"
  git fetch --quiet origin "$SRE_RELEASE_BRANCH"
  if ! git merge-base --is-ancestor "$SHA" "origin/$SRE_RELEASE_BRANCH" 2>/dev/null; then
    echo "REFUSED — commit $SHA is not on origin/$SRE_RELEASE_BRANCH. Only a merged, CI-green commit deploys (hard rule #8, AID-08). Nothing was changed; the box is still on $PREVIOUS." >&2
    exit 65
  fi
  # WF-20 · AID-08: on a box that checks signatures, only a release whose signature verifies goes any further.
  if [ -n "$SRE_RELEASE_PUBKEY" ]; then
    if [ ! -r "$SRE_RELEASE_PUBKEY" ]; then
      record signature_key_missing
      echo "NOT SET UP — this box is told to check release signatures (SRE_RELEASE_PUBKEY=$SRE_RELEASE_PUBKEY) but cannot read that public key. Nothing was changed; the box is still on $PREVIOUS." >&2
      exit 78
    fi
    if [ -z "$SIGNATURE" ]; then
      record unsigned_refused
      echo "REFUSED — $SHA arrived unsigned, and this box deploys only signed releases (WF-20, AID-08). Nothing was changed; the box is still on $PREVIOUS." >&2
      exit 77
    fi
    SIG_DIR="$(mktemp -d)"
    TREE="$(git rev-parse "$SHA^{tree}")"
    printf 'sre-release-v1\ncommit=%s\ntree=%s\n' "$SHA" "$TREE" > "$SIG_DIR/manifest"
    if [ "$SIGNATURE" = "unreadable" ] || ! printf '%s' "$SIGNATURE" | base64 -d > "$SIG_DIR/signature" 2>/dev/null \
       || ! openssl pkeyutl -verify -pubin -inkey "$SRE_RELEASE_PUBKEY" -rawin -in "$SIG_DIR/manifest" -sigfile "$SIG_DIR/signature" >/dev/null 2>&1; then
      rm -rf "$SIG_DIR"
      record signature_refused
      echo "REFUSED — the release signature does not verify for $SHA (tree $TREE) against this box's release key. It was not signed by the release-signing key, or it was changed. Nothing was changed; the box is still on $PREVIOUS." >&2
      exit 77
    fi
    rm -rf "$SIG_DIR"
    say "release signature verified for $SHA (tree $TREE)."
  else
    # OB-342: until the box is given the custodian's public key it deploys either way and says so — and says whether the
    # release arrived signed, so the custodian can see the signing works before the box starts enforcing it.
    if [ "$SIGNATURE" = "unreadable" ]; then ARRIVED="arrived with an unreadable signature"; elif [ -n "$SIGNATURE" ]; then ARRIVED="arrived signed"; else ARRIVED="arrived NOT SIGNED"; fi
    say "release signature NOT CHECKED on this box (SRE_RELEASE_PUBKEY is not set; the release $ARRIVED) — see docs/runbooks/automatic-deployment.md."
  fi
  # WF-20: back up BEFORE anything changes. A backup that fails stops the release here, with the box untouched.
  if [ -n "$SRE_PREDEPLOY_BACKUP_CMD" ]; then
    say "taking the pre-release backup…"
    if ! bash -c "$SRE_PREDEPLOY_BACKUP_CMD"; then
      record backup_failed
      echo "REFUSED — the pre-release backup did not succeed, so $SHA was not deployed. Nothing was changed; the box is still on $PREVIOUS. Fix the backup (docs/runbooks/backup-and-recovery.md), then deploy again." >&2
      exit 69
    fi
    say "pre-release backup taken."
  else
    say "no pre-release backup is configured on this box (SRE_PREDEPLOY_BACKUP_CMD) — the scheduled backup is the latest copy."
  fi
  if [ "$PREVIOUS" = "$SHA" ]; then say "this box is already at $SHA — re-applying it (harmless, idempotent)."; fi
  say "live now: $PREVIOUS — checking out $SHA"
  git checkout --quiet --detach "$SHA"
  exec bash "$SRE_APP_DIR/infra/deploy/release.sh" --phase2 "$SHA" "$ACTOR" "$RUN" "$PREVIOUS"
fi

# ── Phase 2: build, bring up, verify — or put the previous release back ─────────────────────────────────
PREVIOUS="${4:-}"
[[ "$PREVIOUS" =~ ^[0-9a-f]{40}$ ]] || usage
cd "$SRE_APP_DIR"

# Unattended by definition (an SSH forced command, no terminal). pnpm asks before it clears a modules directory laid
# down by another version or user and, with no TTY to answer, ABORTS — the first release on a box set up by hand died
# there. CI=true tells it to proceed without a prompt; it also quietens the shell builds' progress output.
export CI=true

# How many `api` containers this stack runs — refused when it is more than one, or when compose cannot say (a failed
# `compose ps` is never read as "none running").
api_count_ok() {
  local listed apis
  if ! listed=$(compose ps -q api); then
    say "REFUSED — could not count the API containers in this stack (docker compose ps failed), so it cannot be shown that only ONE API version runs. Nothing more was changed; check docker on this box."
    return 1
  fi
  apis=$(printf '%s\n' "$listed" | grep -c . || true)
  if [ "${apis:-0}" -gt 1 ]; then
    say "REFUSED — $apis API containers are running in this stack; head office must run exactly ONE API at a time (never two versions side by side). Scale it back to one: docker compose up -d --scale api=1."
    return 1
  fi
  return 0
}

bring_up() {
  say "installing dependencies…"
  pnpm install --frozen-lockfile || return 1
  for app in $SRE_BUILD_SHELLS; do
    say "building the $app shell…"
    # shellcheck disable=SC2086
    env $SRE_BUILD_ENV node scripts/build-app.mjs "$app" || return 1
  done
  # Tool bundles the compose overlay runs from the checkout (the DEMO-ONLY sign-in, pilot overlay only). Built on
  # every release so the running bundle is the release's; harmless on a stack that never starts the service.
  for tool in $SRE_BUILD_TOOLS; do
    say "building the $tool bundle…"
    node scripts/build-service.mjs "$tool" || return 1
  done
  # Verifier r21 (rolling deploy): ONE API version at a time. The per-item setting guard (and every other write guard) is
  # keyed by the code that writes it; two API versions running side by side would not meet on one guard. `compose up`
  # replaces the single `api` container stop-first — the old one is stopped before the new one starts — so versions never
  # overlap. If this stack ever runs more than one `api` container (scaled by hand, `deploy.replicas`), it is refused and
  # the release is put back: docs/runbooks/automatic-deployment.md, "One API version at a time".
  # Verifier r22 (low): counted BEFORE `compose up` as well — a stack already running two is refused before anything is
  # rebuilt, so the new version never starts beside them (compose recreates scaled containers one at a time, so after `up`
  # the overlap would already have happened). The only overlap window left is a stack scaled up by `up` itself (replicas
  # set in the compose file), caught by the count after it. And a count that cannot be read is a refusal, never "0".
  api_count_ok || return 1
  say "bringing the stack up (migrations run first, idempotently)…"
  compose up -d --build || return 1
  api_count_ok || return 1
  # A service that SHARES another container's network namespace (the demo relay: `network_mode: service:edge`) is
  # not recreated by compose when that container is — it stays attached to the old, dead network. On 4 Oct 2026
  # the relay answered 502 for every demo store box screen after a release had rebuilt the edge. Recreate such
  # services on every release; a stack without the service (a store) says so and carries on.
  for svc in $SRE_RECREATE_SERVICES; do
    say "recreating the $svc service so it follows the container whose network it shares…"
    compose up -d --force-recreate --no-deps "$svc" >/dev/null 2>&1 || say "  (no $svc service in this stack — nothing to recreate)"
  done
  # A tool bundle runs from a folder MOUNTED into its container (the demo sign-in: ../pilot/demo-login/dist → /app).
  # Rebuilding the file changes nothing compose can see, so `up` leaves the container running the old code — the
  # demo home shipped on 3 Oct 2026 did not appear until the container was restarted by hand. Restart each tool's
  # service after `up`; a stack without that service (a store) just says so and carries on.
  for tool in $SRE_BUILD_TOOLS; do
    say "restarting the $tool service so it runs this release's bundle…"
    compose restart "$tool" >/dev/null 2>&1 || say "  (no $tool service in this stack — nothing to restart)"
  done
}

# The demo front answers the till probe only through the demo sign-in's gate, so for a second or two after that
# restart it says 500 — and the stand-up check, a one-shot, went RED on a healthy box (3 Oct 2026, run 37134559059,
# "rollback failed" with nothing broken). Give the front up to 45 s to answer again before judging anything.
web_settled() {
  [ -z "$SRE_WEB_URL" ] && return 0
  local deadline=$(( $(date +%s) + 45 )) code
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code=$(curl -sS -L -o /dev/null --max-time 5 -w '%{http_code}' "$SRE_WEB_URL/pos/" 2>/dev/null || echo 000)
    case "$code" in 2*|3*|401|403) return 0;; esac
    sleep "$SRE_READY_POLL"
  done
  return 1
}

wait_ready() {
  local deadline=$(( $(date +%s) + SRE_READY_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "$SRE_API_URL/readyz" >/dev/null 2>&1; then return 0; fi
    sleep "$SRE_READY_POLL"
  done
  return 1
}

# The public front (the proxy, ADR-0018), which the stand-up check does not see — it looks at loopback ports only. On
# 3 Oct 2026 a release went GREEN while the proxy restarted forever on an empty name in SRE_PUBLIC_HOST, and nobody could
# reach the demo address. The front makes its own certificate on a demo, hence -k. Empty SRE_FRONT_URL skips the check.
front_answers() {
  [ -z "$SRE_FRONT_URL" ] && return 0
  local deadline=$(( $(date +%s) + 45 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsk --max-time 10 "$SRE_FRONT_URL/readyz" >/dev/null 2>&1; then return 0; fi
    sleep "$SRE_READY_POLL"
  done
  return 1
}

# QG-10: note how this attempt's stages went (the first attempt only — a rollback re-uses verify()).
mark() { if [ "${STAGE:-release}" = release ]; then printf -v "$1" '%s' "$2"; fi; }

verify() {
  say "waiting up to ${SRE_READY_TIMEOUT}s for the API to be READY…"
  wait_ready || { say "the API did not become ready in time."; mark Q_HEALTH failed; return 1; }
  mark Q_HEALTH verified
  say "waiting for the web front to answer again after the tool restarts…"
  web_settled || say "  (the web front did not answer within 45 s — the stand-up check will say so)"
  say "running the stand-up check…"
  STANDUP_ENV_FILE="$SRE_APP_DIR/infra/compose/$SRE_ENV_FILE" node scripts/standup-check.mjs || { mark Q_SMOKE failed; return 1; }
  say "checking the public front at ${SRE_FRONT_URL:-"(skipped)"}…"
  front_answers || { say "the public front did not answer at $SRE_FRONT_URL/readyz while the API behind it is fine — the proxy is down or refused its configuration (an empty name in SRE_PUBLIC_HOST?). See 'When it goes red'."; mark Q_SMOKE failed; return 1; }
  mark Q_SMOKE verified
}

# The API's server-error count so far (5xx on /metricz), or "unknown" when it cannot be read.
server_errors() {
  curl -fsS --max-time 5 "$SRE_API_URL/metricz" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d;}).on("end",()=>{try{const m=JSON.parse(s);const n=Number((m.byStatusClass||{})["5xx"]||0);console.log(Number.isFinite(n)?n:"unknown");}catch{console.log("unknown");}});' \
    || echo unknown
}

# WF-20 canary stage (ADR-0026): WATCH the release for SRE_BAKE_SECONDS before calling it deployed. It must stay READY and
# its server errors must not grow past SRE_BAKE_MAX_5XX; an unreadable error count is a failure, never a pass (P-08).
BAKE_FAILED=0
bake() {
  [ "${SRE_BAKE_SECONDS:-0}" -gt 0 ] 2>/dev/null || return 0
  local base now deadline
  base="$(server_errors)"
  if [ "$base" = "unknown" ]; then say "canary bake: the API's error count cannot be read at $SRE_API_URL/metricz."; BAKE_FAILED=1; Q_MONITOR=failed; return 1; fi
  say "canary bake: watching $SHA for ${SRE_BAKE_SECONDS}s (server errors now $base, at most +$SRE_BAKE_MAX_5XX allowed)…"
  deadline=$(( $(date +%s) + SRE_BAKE_SECONDS ))
  while :; do
    if ! curl -fsS --max-time 5 "$SRE_API_URL/readyz" >/dev/null 2>&1; then
      say "canary bake: the API stopped being READY."; BAKE_FAILED=1; Q_MONITOR=failed; return 1
    fi
    now="$(server_errors)"
    if [ "$now" = "unknown" ] || [ $(( now - base )) -gt "$SRE_BAKE_MAX_5XX" ]; then
      say "canary bake: server errors went from $base to $now (allowed +$SRE_BAKE_MAX_5XX)."; BAKE_FAILED=1; Q_MONITOR=failed; return 1
    fi
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep "$SRE_BAKE_POLL"
  done
  say "canary bake: $SHA stayed READY for ${SRE_BAKE_SECONDS}s with server errors at $now."
  Q_MONITOR=verified
}

# ── QG-10 · WF-20: the reconcile around the release, and the per-release QG-10 record ──────────────────────────────────
# The stages QG-10 names, as this attempt went (kept for the first attempt only — a rollback re-uses verify()).
STAGE=release
Q_HEALTH=not_run; Q_SMOKE=not_run; Q_RECONCILE=not_run; Q_MONITOR=not_run; Q_ROLLBACK=ready
RECON_DIR="$(mktemp -d)"
trap 'rm -rf "$RECON_DIR"' EXIT
RECONCILE_FAILED=0
# THIS release's reconcile tool, kept aside: after a rollback the checkout is the previous release, which may not have it.
mkdir -p "$RECON_DIR/tool/lib"
cp scripts/release-reconcile.mjs "$RECON_DIR/tool/" && cp scripts/lib/release-reconcile.mjs "$RECON_DIR/tool/lib/" \
  || { say "the reconcile tool is missing from $SHA (scripts/release-reconcile.mjs)."; }
reconcile_tool() { node "$RECON_DIR/tool/release-reconcile.mjs" "$@"; }

# Print one snapshot of head office's books on stdout (extra arguments go to `snapshot`, e.g. --upto <seq>).
reconcile_snapshot() {
  if [ -n "$SRE_RECONCILE_CMD" ]; then
    bash -c "$SRE_RECONCILE_CMD $*"
  else
    # The migrate service is the stack's own one-shot container with the database setting; this release's script is
    # mounted read-only over its scripts folder, so the snapshot logic is the release's even before its image is built.
    compose run --rm --no-deps -T -v "$SRE_APP_DIR/scripts:/app/scripts:ro" migrate node scripts/release-reconcile.mjs snapshot "$@"
  fi
}

# After the release is up: re-read the books and compare with the snapshot taken before it.
reconcile_after() {
  [ "$SRE_RECONCILE" = "off" ] && return 0
  local upto
  upto="$(reconcile_tool max-seq "$RECON_DIR/before.json")" || { say "reconcile: the before-release snapshot cannot be read back."; Q_RECONCILE=failed; RECONCILE_FAILED=1; return 1; }
  say "reconcile: re-reading the books (the ledger up to sequence $upto, the outbox, the sync backlog)…"
  reconcile_snapshot --upto "$upto" > "$RECON_DIR/after.json" 2>/dev/null || true
  if reconcile_tool compare "$RECON_DIR/before.json" "$RECON_DIR/after.json" \
       --max-backlog-growth "$SRE_RECONCILE_MAX_BACKLOG_GROWTH" --json "$RECON_DIR/result.json" | sed 's/^/release: reconcile: /'; then
    Q_RECONCILE=verified
    return 0
  fi
  Q_RECONCILE=failed; RECONCILE_FAILED=1
  return 1
}

# Append and print this attempt's QG-10 evidence line. A record that cannot be written is said, loudly (P-08).
qg10_record() {
  local outcome="$1" line
  if line="$(reconcile_tool qg10 --sha "$SHA" --previous "$PREVIOUS" --by "$ACTOR" --run "$RUN" \
        --box "$(hostname 2>/dev/null || echo box)" --outcome "$outcome" --health "$Q_HEALTH" --smoke "$Q_SMOKE" \
        --reconciliation "$Q_RECONCILE" --monitoring "$Q_MONITOR" --rollback "$Q_ROLLBACK" \
        $( [ -f "$RECON_DIR/result.json" ] && printf -- '--differences %s' "$RECON_DIR/result.json" ))" \
     && mkdir -p "$(dirname "$SRE_QG10_LOG")" && printf '%s\n' "$line" >> "$SRE_QG10_LOG"; then
    say "QG-10 record: $line"
  else
    say "QG-10 record NOT WRITTEN — the evidence line for $SHA could not be made or appended to $SRE_QG10_LOG. Tell the custodian."
  fi
}

# Round 32 · OB-116: a release whose settings file lacks a setting THIS release requires (from round 32, BOX_HISTORY_SEAL_KEY,
# head office's own seal secret) is refused here, by name, before anything is rebuilt or restarted — never found out by an API
# that will not come up. The check prints setting NAMES only, never a value. The box stays on the previous release, untouched.
say "checking the settings file has every setting this release needs…"
if ! STANDUP_ENV_FILE="$SRE_APP_DIR/infra/compose/$SRE_ENV_FILE" node scripts/standup-check.mjs --settings-only; then
  git checkout --quiet --detach "$PREVIOUS"
  record settings_missing
  echo "REFUSED — the settings file ($SRE_ENV_FILE) is missing a setting $SHA needs (named above), so it was not deployed. Nothing was rebuilt or restarted; the box is still on $PREVIOUS. Add the setting on this box (docs/runbooks/automatic-deployment.md, \"Settings a release needs\"), then deploy again." >&2
  exit 78
fi

# QG-10 · WF-20: the books BEFORE the release touches anything. Cannot be read → refused (69), nothing rebuilt.
if [ "$SRE_RECONCILE" = "off" ]; then
  say "the post-deploy reconcile is SWITCHED OFF on this box (SRE_RECONCILE=off) — the QG-10 record will say reconciliation was not run."
else
  say "reconcile: taking the before-release snapshot of the books (the ledger, the outbox, the sync backlog)…"
  reconcile_snapshot > "$RECON_DIR/before.json" 2>/dev/null || true
  if ! reconcile_tool max-seq "$RECON_DIR/before.json" >/dev/null 2>&1; then
    Q_RECONCILE=failed; qg10_record refused_books_unreadable
    git checkout --quiet --detach "$PREVIOUS"
    record reconcile_snapshot_failed
    echo "REFUSED — the books could not be read before the release (the reconcile snapshot failed), so $SHA was not deployed: after it, nobody could show the ledger, the outbox and the sync backlog still agree (QG-10). Nothing was rebuilt or restarted; the box is still on $PREVIOUS. Check the database container, then deploy again." >&2
    exit 69
  fi
  say "reconcile: before-release snapshot taken (ledger up to sequence $(reconcile_tool max-seq "$RECON_DIR/before.json"))."
fi

if bring_up && verify && bake && reconcile_after; then
  [ "$SRE_BAKE_SECONDS" -gt 0 ] 2>/dev/null || Q_MONITOR=not_run_on_this_box
  [ "$SRE_RECONCILE" = "off" ] && Q_RECONCILE=not_run
  record deployed
  qg10_record deployed
  say "DEPLOYED $SHA (replaced $PREVIOUS) — merged by $ACTOR, pipeline run $RUN. The stack is up and the stand-up check is GREEN."
  exit 0
fi

if [ "$RECONCILE_FAILED" = 1 ]; then
  say "THE BOOKS DO NOT RECONCILE — $SHA came up healthy, but the ledger, the outbox or the sync backlog differ from before the release (above). Last lines from the api container:"
elif [ "$BAKE_FAILED" = 1 ]; then
  say "NOT HEALTHY UNDER WATCH — $SHA came up but failed its canary bake. Last lines from the api container:"
else
  say "NOT HEALTHY — the new release did not come up. Last lines from the api and migrate containers:"
fi
compose logs --no-color --tail=60 api migrate 2>/dev/null || true
say "rolling back to $PREVIOUS…"
STAGE=rollback
git checkout --quiet --detach "$PREVIOUS"
if bring_up && verify; then
  Q_ROLLBACK=exercised_ok
  if [ "$RECONCILE_FAILED" = 1 ]; then
    record rolled_back_on_reconcile
    qg10_record rolled_back_on_reconcile
    echo "ROLLED BACK — $SHA came up but its books did not reconcile with the snapshot taken before it (the differences are above); the box is back on $PREVIOUS and GREEN, and the full rollout will not run. Open an incident (POST /v1/platform/incidents/:id) with this release's commit — nothing on the ledger is deleted or overwritten to fix it (hard rule #2)." >&2
    exit 70
  fi
  if [ "$BAKE_FAILED" = 1 ]; then
    record rolled_back_in_canary_bake
    qg10_record rolled_back_in_canary_bake
    echo "ROLLED BACK — $SHA came up but failed its canary bake; the box is back on $PREVIOUS and GREEN, and the full rollout will not run. Open an incident (POST /v1/platform/incidents/:id) with this release's commit. Nothing was lost: the ledger is append-only and migrations are additive." >&2
    exit 70
  fi
  record rolled_back
  qg10_record rolled_back
  echo "ROLLED BACK — $SHA did not come up healthy; the box is back on $PREVIOUS and GREEN. Nothing was lost: the ledger is append-only and migrations are additive. Fix forward and merge again." >&2
  exit 70
fi
Q_ROLLBACK=exercised_failed
record rollback_failed
qg10_record rollback_failed
echo "ROLLBACK FAILED — neither $SHA nor the previous $PREVIOUS came up healthy. A person is needed on the box now: docs/runbooks/automatic-deployment.md, section 'When it goes red'." >&2
exit 71
