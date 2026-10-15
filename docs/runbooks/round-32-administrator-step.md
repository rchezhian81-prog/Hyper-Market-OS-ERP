# Round 32 — one step for the IT administrator before release (OB-116, OB-118)

The owner has decided (OB-118) that round 32 is merged only after this step is done on the demo server.
Nothing here contains a secret value. Never paste the value into chat, email, a ticket or any document.

## On the demo server (as the deploy administrator)

1. Open the stack's settings file: `/opt/sre/app/infra/compose/.env.pilot`.
2. Add one line named `BOX_HISTORY_SEAL_KEY=` with a NEW random value made on the server itself — written straight into
   the file, so the value is never shown on the screen or kept in the terminal's scrollback (round 33, verifier r32 note 2c).
   First make sure it is not there already (`grep -c '^BOX_HISTORY_SEAL_KEY=' /opt/sre/app/infra/compose/.env.pilot`
   prints `0`; if it prints `1`, stop — it is set), and that the file ends with a new line (`tail -c1 …/.env.pilot | od -c`
   shows `\n`; if not, run `echo >> /opt/sre/app/infra/compose/.env.pilot` first). Then:
   `printf 'BOX_HISTORY_SEAL_KEY=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> /opt/sre/app/infra/compose/.env.pilot`
   Do NOT run `openssl rand` on its own: that prints the value.
   - It must NOT be the same value as `PACK_SIGNING_KEY`, `PII_KEY_ENCRYPTION_KEY` or `IDP_SIGNING_KEY`, and must be at least
     32 characters (the command above makes 64). From round 33 the release's pre-check refuses each of these by NAME
     (exit 78) before anything is rebuilt — it never prints the value.
   - It is for head office only: never copy it to a store computer, a till or a phone.
3. Check it by NAME only (prints `1`, never the value):
   `grep -c '^BOX_HISTORY_SEAL_KEY=' /opt/sre/app/infra/compose/.env.pilot`
4. Tell the owner "the new head-office secret is set" — nothing else.

## What happens next

- The owner tells the build session; round 32 is merged and the automatic deploy runs.
- If the line were missing, the release is refused by name (exit 78) before anything is rebuilt, and the demo stays
  on its current version — nothing breaks.
- The first health-page read after the release rebuilds the saved store-computer history once (seconds to minutes;
  the page says "being prepared").

Full detail: `docs/runbooks/demo-deployment-handover.md` (settings table) and `docs/runbooks/automatic-deployment.md`
("Settings a release needs").
