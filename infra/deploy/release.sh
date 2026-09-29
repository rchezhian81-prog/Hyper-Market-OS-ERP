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
#   0 deployed · 64 usage · 65 refused (not on main) · 70 rolled back to the previous release ·
#   71 rollback failed too · 75 another deployment is running · 78 the box is not set up for this.

set -euo pipefail

say() { printf 'release: %s\n' "$*"; }
usage() {
  echo "usage: release.sh <40-hex commit sha> [actor] [run-id]" >&2
  echo "   or, as an SSH forced command:  release <sha> [actor] [run-id]" >&2
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
: "${SRE_API_URL:=http://127.0.0.1:8081}"
: "${SRE_READY_TIMEOUT:=180}"
: "${SRE_READY_POLL:=2}"
: "${SRE_RELEASE_LOG:=/opt/sre/releases.log}"
: "${SRE_DEPLOY_LOCK:=/opt/sre/deploy.lock}"

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
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || usage
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
  if [ "$PREVIOUS" = "$SHA" ]; then say "this box is already at $SHA — re-applying it (harmless, idempotent)."; fi
  say "live now: $PREVIOUS — checking out $SHA"
  git checkout --quiet --detach "$SHA"
  exec bash "$SRE_APP_DIR/infra/deploy/release.sh" --phase2 "$SHA" "$ACTOR" "$RUN" "$PREVIOUS"
fi

# ── Phase 2: build, bring up, verify — or put the previous release back ─────────────────────────────────
PREVIOUS="${4:-}"
[[ "$PREVIOUS" =~ ^[0-9a-f]{40}$ ]] || usage
cd "$SRE_APP_DIR"

bring_up() {
  say "installing dependencies…"
  pnpm install --frozen-lockfile || return 1
  for app in $SRE_BUILD_SHELLS; do
    say "building the $app shell…"
    # shellcheck disable=SC2086
    env $SRE_BUILD_ENV node scripts/build-app.mjs "$app" || return 1
  done
  say "bringing the stack up (migrations run first, idempotently)…"
  compose up -d --build || return 1
}

wait_ready() {
  local deadline=$(( $(date +%s) + SRE_READY_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "$SRE_API_URL/readyz" >/dev/null 2>&1; then return 0; fi
    sleep "$SRE_READY_POLL"
  done
  return 1
}

verify() {
  say "waiting up to ${SRE_READY_TIMEOUT}s for the API to be READY…"
  wait_ready || { say "the API did not become ready in time."; return 1; }
  say "running the stand-up check…"
  STANDUP_ENV_FILE="$SRE_APP_DIR/infra/compose/$SRE_ENV_FILE" node scripts/standup-check.mjs || return 1
}

if bring_up && verify; then
  record deployed
  say "DEPLOYED $SHA (replaced $PREVIOUS) — merged by $ACTOR, pipeline run $RUN. The stack is up and the stand-up check is GREEN."
  exit 0
fi

say "NOT HEALTHY — the new release did not come up. Last lines from the api and migrate containers:"
compose logs --no-color --tail=60 api migrate 2>/dev/null || true
say "rolling back to $PREVIOUS…"
git checkout --quiet --detach "$PREVIOUS"
if bring_up && verify; then
  record rolled_back
  echo "ROLLED BACK — $SHA did not come up healthy; the box is back on $PREVIOUS and GREEN. Nothing was lost: the ledger is append-only and migrations are additive. Fix forward and merge again." >&2
  exit 70
fi
record rollback_failed
echo "ROLLBACK FAILED — neither $SHA nor the previous $PREVIOUS came up healthy. A person is needed on the box now: docs/runbooks/automatic-deployment.md, section 'When it goes red'." >&2
exit 71
