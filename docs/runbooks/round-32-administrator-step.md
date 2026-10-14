# Round 32 — one step for the IT administrator before release (OB-116, OB-118)

The owner has decided (OB-118) that round 32 is merged only after this step is done on the demo server.
Nothing here contains a secret value. Never paste the value into chat, email, a ticket or any document.

## On the demo server (as the deploy administrator)

1. Open the stack's settings file: `/opt/sre/app/infra/compose/.env.pilot`.
2. Add one line named `BOX_HISTORY_SEAL_KEY=` followed by a NEW random value made on the server itself:
   `openssl rand -base64 48`
   - It must NOT be the same value as `PACK_SIGNING_KEY` (head office refuses to start if they are equal).
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
