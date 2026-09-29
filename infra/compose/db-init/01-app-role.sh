#!/bin/sh
# Runs ONCE, when the database volume is first initialised (the postgres image's docker-entrypoint-initdb.d).
#
# Creates the APPLICATION role the API, the migration runner and the operator tools connect as: a plain login
# role — NOT a superuser, NOT BYPASSRLS — because PostgreSQL superusers step around row-level security entirely,
# and row-level security (db/migrations/0012) is what confines every statement to one tenant's rows (GAP-DATA-02).
# The image's POSTGRES_USER stays the superuser for administration only; the API refuses to start on it.
#
# The role reuses POSTGRES_PASSWORD (one secret, two roles) so a pilot deployment adds no new setting. Nothing
# here is written to the repository — the password arrives from the git-ignored .env (hard rule #4).
#
# An EXISTING database (initialised before this file existed) does not run this script; the runbook gives the
# same three statements to run once by hand (docs/runbooks/pilot-deployment.md).
set -eu
APP_ROLE="${APP_DB_USER:-sre_app}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', '$APP_ROLE', '$POSTGRES_PASSWORD');
  END IF;
END \$\$;
GRANT CONNECT, TEMPORARY ON DATABASE "$POSTGRES_DB" TO "$APP_ROLE";
-- The application role OWNS the schema objects (it runs the migrations), so FORCE ROW LEVEL SECURITY binds it too.
GRANT ALL ON SCHEMA public TO "$APP_ROLE";
SQL
