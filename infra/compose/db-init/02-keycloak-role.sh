#!/bin/sh
# Runs ONCE, when the database volume is first initialised. Creates the identity server's own login and its OWN schema
# (ADR-0019 §1: Keycloak keeps its tables in a schema of its own, never among the product's). The login owns only that
# schema: not a superuser, no access to the product's tables. Skipped — and said so — when no password was given, so a
# stack that does not run the identity server gets no extra role.
set -eu
if [ -z "${KEYCLOAK_DB_PASSWORD:-}" ]; then
  echo "identity server: KEYCLOAK_DB_PASSWORD is not set — no identity-server database login created."
  exit 0
fi
KC_ROLE="${KEYCLOAK_DB_USER:-sre_keycloak}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$KC_ROLE') THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', '$KC_ROLE', '$KEYCLOAK_DB_PASSWORD');
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO "$KC_ROLE";
CREATE SCHEMA IF NOT EXISTS keycloak AUTHORIZATION "$KC_ROLE";
REVOKE ALL ON SCHEMA public FROM "$KC_ROLE";
SQL
