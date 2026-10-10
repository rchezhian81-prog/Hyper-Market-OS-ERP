#!/usr/bin/env bash
# The real-identity-server proof suites, each on a freshly migrated database (OB-15 · ADR-0019 · docs/runbooks/identity-server.md).
#
# The four suites below SKIP when no identity server is configured — correct for a developer's machine, and exactly why a
# skipped run must never count as proof. This script runs them against a REAL Keycloak and refuses a quiet green: each
# suite must run every one of its tests, and pass, on a database migrated just for it (the person a suite signs in
# becomes the shop's first owner only where the shop has none yet, so a reused database fails, correctly).
#
# Needs (environment):
#   KEYCLOAK_PROOF_BASE                 e.g. http://127.0.0.1:8180 — Keycloak with infra/keycloak/realm-sre-store.json imported
#   KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE  a file holding the bootstrap administrator's password (generated, never committed)
#   KEYCLOAK_PROOF_TENANT               the tenant the realm was started for (SRE_TENANT_ID)
#   PROOF_PG_URL                        a PostgreSQL server URL with no database, whose user may create databases and roles
# Optional: PROOF_DB_PREFIX (default sre_idp), PROOF_OUT (default a fresh temporary directory).
set -euo pipefail

: "${KEYCLOAK_PROOF_BASE:?set KEYCLOAK_PROOF_BASE}"
: "${KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE:?set KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE}"
: "${KEYCLOAK_PROOF_TENANT:?set KEYCLOAK_PROOF_TENANT}"
: "${PROOF_PG_URL:?set PROOF_PG_URL}"
prefix="${PROOF_DB_PREFIX:-sre_idp}"
out="${PROOF_OUT:-$(mktemp -d)}"
pg="${PROOF_PG_URL%/}"

# suite name → the least number of tests it must run (the counts recorded in docs/runbooks/identity-server.md)
suites=(
  "keycloak-real:6"
  "keycloak-shop-realms:3"
  "keycloak-provisioning:4"
  "identity-front-door:1"
)

for entry in "${suites[@]}"; do
  suite="${entry%%:*}"
  min="${entry##*:}"
  db="${prefix}_${suite//-/_}"
  echo "== ${suite}: fresh database ${db}"
  psql "${pg}/postgres" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" -c "CREATE DATABASE ${db}"
  DATABASE_URL="${pg}/${db}" pnpm db:migrate > /dev/null
  KEYCLOAK_PROOF_DATABASE_URL="${pg}/${db}" pnpm exec vitest run "tests/integration/${suite}.test.ts" \
    --reporter=default --reporter=json --outputFile="${out}/${suite}.json"
  node scripts/assert-suite-ran.mjs "${out}/${suite}.json" --min-files 1 --min-tests "${min}"
done
echo "All identity-server suites ran against a real Keycloak and passed; nothing skipped."
