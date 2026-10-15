#!/usr/bin/env bash
# Round 32 · OB-116 — put head office's own seal secret (BOX_HISTORY_SEAL_KEY) into the settings file the release
# actually reads, correctly, without ever showing it. Run ON THE BOX by the administrator (with sudo when the settings
# file belongs to the deploy user). It:
#   1. reads /opt/sre/deploy.conf (or $SRE_DEPLOY_CONF) the same way infra/deploy/release.sh does, to find the file;
#   2. removes every existing BOX_HISTORY_SEAL_KEY line (plain, `export …`, empty, or a placeholder) — a NEW value is
#      made each time; nothing else in the file is touched;
#   3. makes sure the file ends with a newline, then appends one fresh value from `openssl rand` (never printed);
#   4. keeps the file's owner and permissions as they were;
#   5. checks the result by NAME only: exactly one line, a value of at least 32 characters, not the placeholder, not
#      the same as PACK_SIGNING_KEY / PII_KEY_ENCRYPTION_KEY / IDP_SIGNING_KEY.
# It prints names, counts and the file's path — never a value. Exit 0 = done; 78 = the settings file was not found;
# 1 = the check after writing failed (the file is left as written, and the message says why).
#
# A line glued to the end of another line (a value with `BOX_HISTORY_SEAL_KEY=` inside it) cannot be told apart safely
# from a real value, so it is NOT changed: the script names it and stops (exit 1) for a person to look.
set -euo pipefail

CONF="${SRE_DEPLOY_CONF:-/opt/sre/deploy.conf}"
# shellcheck disable=SC1090
if [ -f "$CONF" ]; then . "$CONF"; fi
: "${SRE_APP_DIR:=/opt/sre/app}"
: "${SRE_ENV_FILE:=.env.pilot}"
FILE="$SRE_APP_DIR/infra/compose/$SRE_ENV_FILE"
NAME=BOX_HISTORY_SEAL_KEY

say() { printf 'seal-key: %s\n' "$*"; }

if [ ! -f "$FILE" ]; then
  say "NOT FOUND — the release reads $FILE (from $CONF, or the defaults), and there is no such file. Nothing was changed."
  exit 78
fi
say "the release reads: $FILE"

# A mention of the name that is not at the start of a line (after an optional `export `) is a glued line.
if grep -E "$NAME" "$FILE" | grep -vqE "^[[:space:]]*(export[[:space:]]+)?$NAME="; then
  say "STOPPED — $NAME appears in the middle of another line (glued on without a newline). Open the file, put it on its own line or delete it, then run this again. Nothing was changed."
  exit 1
fi

owner="$(stat -c '%u:%g' "$FILE")"
mode="$(stat -c '%a' "$FILE")"
tmp="$(mktemp "$FILE.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
removed="$(grep -cE "^[[:space:]]*(export[[:space:]]+)?$NAME=" "$FILE" || true)"
grep -vE "^[[:space:]]*(export[[:space:]]+)?$NAME=" "$FILE" > "$tmp" || true
# Ends with a newline before the new line is appended.
if [ -s "$tmp" ] && [ "$(tail -c1 "$tmp" | od -An -c | tr -d ' ')" != '\n' ]; then printf '\n' >> "$tmp"; fi
printf '%s=%s\n' "$NAME" "$(openssl rand -base64 48 | tr -d '\n')" >> "$tmp"
chown "$owner" "$tmp" 2>/dev/null || true
chmod "$mode" "$tmp"
mv -f "$tmp" "$FILE"
trap - EXIT
say "removed $removed old $NAME line(s); wrote one new value (not shown); owner and permissions kept ($owner, $mode)."

# The check, by name only.
value_of() { grep -E "^$1=" "$FILE" | tail -n1 | cut -d= -f2- ; }
count="$(grep -cE "^$NAME=" "$FILE" || true)"
seal="$(value_of "$NAME")"
fail=""
[ "$count" = 1 ] || fail="there are $count $NAME lines, not 1"
[ -z "$fail" ] && [ "${#seal}" -ge 32 ] || fail="${fail:-the value is shorter than 32 characters}"
case "$seal" in *REPLACE_WITH*) fail="${fail:-the value is still the placeholder}";; esac
for other in PACK_SIGNING_KEY PII_KEY_ENCRYPTION_KEY IDP_SIGNING_KEY; do
  [ -n "$(value_of "$other")" ] && [ "$seal" = "$(value_of "$other")" ] && fail="${fail:-the value equals $other}"
done
unset seal
if [ -n "$fail" ]; then say "CHECK FAILED — $fail. Nothing secret was printed."; exit 1; fi
say "CHECK PASSED — exactly one $NAME line with a value of 32+ characters, distinct from the other keys. Tell the owner \"the seal key helper passed\"."
