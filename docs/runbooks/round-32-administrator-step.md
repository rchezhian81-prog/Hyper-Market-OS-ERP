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

## If the release is still refused (exit 78) — check with the NEW checker

The box's own `scripts/standup-check.mjs` is the previous release's copy until a release succeeds, and that copy does
not know `BOX_HISTORY_SEAL_KEY` — so running it proves nothing. Check with the new one, without changing the box:

1. Which settings file does the release read? (names only)
   `grep -E '^(SRE_APP_DIR|SRE_ENV_FILE)=' /opt/sre/deploy.conf`
   (no line = the defaults `/opt/sre/app` and `.env.pilot`). The file is `<SRE_APP_DIR>/infra/compose/<SRE_ENV_FILE>`.
2. Get the new checker into a temporary file (this changes nothing the box runs):
   `git -C /opt/sre/app fetch -q origin main && git -C /opt/sre/app show origin/main:scripts/standup-check.mjs > /tmp/standup-check-new.mjs`
3. Run it against that settings file (it prints setting NAMES only, never a value):
   `STANDUP_ENV_FILE=<the file from step 1> node /tmp/standup-check-new.mjs --settings-only`
   It must report Settings as OK. If it names `BOX_HISTORY_SEAL_KEY`, read the reason it gives (missing, placeholder
   left in, or the same as `PACK_SIGNING_KEY`) and fix that line in THAT file, with the no-echo command above.
4. Delete the temporary file: `rm /tmp/standup-check-new.mjs`. Tell the owner "the new checker passes".
