#!/usr/bin/env bash
# The owner's RELAY server, set up in one command — OB-840 · ADR-0035 · docs/runbooks/remote-access-for-the-owner.md
#
#   sudo bash infra/remote-access/setup-relay.sh --domain <your domain> --email <your email> --tenant <shop tenant id>
#
# On a FRESH Ubuntu 22.04 or 24.04 server (2 GB). It:
#   1. refuses the DEMO server (hard rule #7: real and test data are kept apart) and anything that is not Ubuntu;
#   2. installs Docker from Ubuntu's own packages and turns the firewall on (ssh, http, https, the link port only);
#   3. makes this server's OWN secrets here (the sign-in database's and the first administrator's passwords) into
#      /opt/sre-relay/.env, readable by root only — they are never printed, never sent anywhere, never in git;
#   4. makes this server's ssh key for the link, builds the sign-in service from this checkout, starts everything;
#   5. prints the LINK CODE the owner types at the store computer.
# Running it again is safe: what is there is kept (secrets, keys, the sign-in database, the approved store computer).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RELAY_HOME="${RELAY_HOME:-/opt/sre-relay}"
SSH_PORT=2222
LISTEN_PORT=18095
ESBUILD_VERSION=0.28.1

say() { printf '%s\n' "$*"; }
refuse() { say "REFUSED — $*"; say "Nothing was changed."; exit 2; }

DOMAIN="" EMAIL="" TENANT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --tenant) TENANT="${2:-}"; shift 2 ;;
    *) refuse "not understood: $1. Use: sudo bash infra/remote-access/setup-relay.sh --domain <your domain> --email <your email> --tenant <shop tenant id>" ;;
  esac
done

[ "$(id -u)" = "0" ] || refuse "run it with sudo (it installs programs and opens the firewall)."
grep -qi '^ID=ubuntu' /etc/os-release 2>/dev/null || refuse "this is for a fresh Ubuntu 22.04 or 24.04 server."
# Hard rule #7: never the demo server. The demo keeps its release in /opt/sre (infra/deploy/release.sh).
if [ -e /opt/sre/deploy.conf ] || [ -d /opt/sre/app ]; then
  refuse "this is the DEMO server (it has /opt/sre). Real and test data are kept apart: rent a NEW server for remote access."
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/*$##')"
printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' || refuse "--domain must be your domain name only, for example office.example.in."
printf '%s' "$EMAIL" | grep -Eq '^[^@ ]+@[^@ ]+\.[^@ ]+$' || refuse "--email must be your email address (the certificate service writes to it before a certificate runs out)."
printf '%s' "$TENANT" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$' || refuse "--tenant must be the shop's tenant id, as the store computer's About page shows it."

say "1/6  Checking that ${DOMAIN} points at this server…"
MY_IP="$(curl -4 -fsS --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [ -z "$DNS_IP" ]; then
  refuse "${DOMAIN} does not point anywhere yet. Add its A record (guide step 3), wait 10 minutes, and run this again."
fi
if [ -n "$MY_IP" ] && [ "$DNS_IP" != "$MY_IP" ]; then
  refuse "${DOMAIN} points at ${DNS_IP}, but this server is ${MY_IP}. Fix the A record (guide step 3), wait 10 minutes, and run this again."
fi

say "2/6  Installing Docker (Ubuntu's own packages) and turning the firewall on…"
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 openssl curl ufw >/dev/null
fi
systemctl enable --now docker >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw --force enable >/dev/null

say "3/6  This server's own secrets (made here, kept here, never shown)…"
install -d -m 0755 "$RELAY_HOME" "$RELAY_HOME/www" "$RELAY_HOME/sign-in" "$RELAY_HOME/ssh"
install -d -m 0755 -o 1000 -g 1000 "$RELAY_HOME/data" "$RELAY_HOME/data/pending"
install -d -m 0755 "$RELAY_HOME/ssh/authorized"
ENV_FILE="$RELAY_HOME/.env"
umask 077
if [ ! -f "$ENV_FILE" ]; then
  {
    printf 'RELAY_DOMAIN=%s\n' "$DOMAIN"
    printf 'RELAY_TLS_EMAIL=%s\n' "$EMAIL"
    printf 'RELAY_TENANT_ID=%s\n' "$TENANT"
    printf 'RELAY_HOME=%s\n' "$RELAY_HOME"
    printf 'RELAY_SSH_PORT=%s\n' "$SSH_PORT"
    printf 'KEYCLOAK_ADMIN_USER=kcadmin\n'
    printf 'RELAY_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'KEYCLOAK_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  } > "$ENV_FILE"
else
  grep -q "^RELAY_DOMAIN=${DOMAIN}$" "$ENV_FILE" || refuse "this server was set up for another domain ($(grep '^RELAY_DOMAIN=' "$ENV_FILE" | cut -d= -f2)). Rent a new server, or ask for help."
  grep -q "^RELAY_TENANT_ID=${TENANT}$" "$ENV_FILE" || refuse "this server was set up for another shop. Rent a new server, or ask for help."
fi
chmod 600 "$ENV_FILE"
umask 022
[ -f "$RELAY_HOME/ssh/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -C sre-relay -f "$RELAY_HOME/ssh/ssh_host_ed25519_key"
chmod 600 "$RELAY_HOME/ssh/ssh_host_ed25519_key"
# The tunnel runs as sre-link (uid 10022), never root (QG-03): its host key must be readable by that user alone.
chown 10022 "$RELAY_HOME/ssh/ssh_host_ed25519_key"
touch "$RELAY_HOME/ssh/authorized/sre-link"
chmod 644 "$RELAY_HOME/ssh/authorized/sre-link"

say "4/6  Building the sign-in service from this checkout…"
docker run --rm -v "$REPO:/src:ro" -v "$RELAY_HOME/sign-in:/out" -w /tmp node:22-alpine sh -c \
  "npm install --no-save --no-audit --no-fund esbuild@${ESBUILD_VERSION} >/dev/null 2>&1 && ./node_modules/.bin/esbuild /src/services/identity/src/sign-in-main.ts --bundle --platform=node --format=esm --target=node22 --log-level=warning --outfile=/out/sign-in.mjs"
[ -s "$RELAY_HOME/sign-in/sign-in.mjs" ] || { say "NOT DONE — the sign-in service could not be built. Send a photo of this screen."; exit 1; }

# The public facts the store computer pins (no secret): this server's link key, the sign-in address, the shop.
HOST_KEY="$(cut -d' ' -f1,2 "$RELAY_HOME/ssh/ssh_host_ed25519_key.pub")"
cat > "$RELAY_HOME/www/pins.json" <<PINS
{"kind":"sre-remote-link-pins-v1","tenantId":"${TENANT}","issuer":"https://${DOMAIN}/auth/realms/sre-store","audience":"sre-retail-os-api","sshPort":${SSH_PORT},"user":"sre-link","listenPort":${LISTEN_PORT},"hostKeys":["${HOST_KEY}"]}
PINS
chmod 644 "$RELAY_HOME/www/pins.json"

say "5/6  Starting the relay (the first start takes a few minutes)…"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml" --env-file "$ENV_FILE")
"${COMPOSE[@]}" up -d --build --remove-orphans >/dev/null
for _ in $(seq 1 90); do
  if "${COMPOSE[@]}" exec -T link-desk wget -qO "/data/jwks.json" http://idp:8080/auth/realms/sre-store/protocol/openid-connect/certs 2>/dev/null; then break; fi
  sleep 5
done
[ -s "$RELAY_HOME/data/jwks.json" ] || { say "NOT DONE — the sign-in server did not start in 7 minutes. Run this again; if it says this again, send a photo of: sudo sre-relay status"; exit 1; }
ln -sf "$HERE/sre-relay" /usr/local/sbin/sre-relay
chmod 755 "$HERE/sre-relay"

say "6/6  Done."
CODE="$("${COMPOSE[@]}" exec -T link-desk node /repo/infra/remote-access/link-desk.mjs code /srv/remote-link/pins.json /data/jwks.json)"
say ""
say "  LINK CODE:  ${CODE}"
say ""
say "  Next (guide step 5): make your own sign-in on this server:"
say "      sudo sre-relay add-owner --person <your id in the shop system> --login <a sign-in name of your choice>"
say "  Then, at the store computer, type the link code there (guide step 7)."
