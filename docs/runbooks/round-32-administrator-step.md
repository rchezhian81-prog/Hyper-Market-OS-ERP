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

## Still refused although the new checker passes — check it AS THE DEPLOY USER

The release runs as the deploy user (the one the pipeline's SSH key logs in as, normally `deploy`), not as you. If the
settings file was edited as root (for example with `sudo sed -i` or a `sudo` editor), it can now be owned by root and
unreadable to the deploy user — then the release sees "no settings file" and refuses (exit 78), while your own check passes.

1. Who owns the file, and can the deploy user read it? (names and permissions only)
   `ls -l <SRE_APP_DIR>/infra/compose/<SRE_ENV_FILE>`
   It should be owned by the deploy user (as it was before), readable by it, and by nobody else (`-rw-------`).
2. Run the new checker as the deploy user:
   `sudo -u deploy env STANDUP_ENV_FILE=<the file> node /tmp/standup-check-new.mjs --settings-only`
3. If it fails as the deploy user only, give the file back to the deploy user, keeping it private:
   `sudo chown deploy:deploy <the file> && sudo chmod 600 <the file>`
4. The pipeline run also states the reason in words, in the step "Deploy this exact commit over SSH" (setting names
   only): the owner or administrator can open it on GitHub → Actions → the latest "CI" run on main → that step.

## The one-command helper (use this if the release is still refused)

`infra/deploy/set-box-history-seal-key.sh` does the whole step correctly and never shows the value: it reads
`/opt/sre/deploy.conf` exactly as the release does to find the settings file, removes any old/empty/placeholder/`export`
`BOX_HISTORY_SEAL_KEY` line, makes sure the file ends with a newline, appends one fresh value from `openssl rand`, keeps
the file's owner and permissions, and checks the result by name only (one line, 32+ characters, not equal to the other
keys). It stops without changing anything if the name is glued inside another line.

On the box (the helper is not on the box's checkout until a release succeeds, so take it from main without changing
anything the box runs):

    git -C /opt/sre/app fetch -q origin main
    git -C /opt/sre/app show origin/main:infra/deploy/set-box-history-seal-key.sh > /tmp/set-seal-key.sh
    sudo bash /tmp/set-seal-key.sh
    rm /tmp/set-seal-key.sh

It must end with `CHECK PASSED`. Then tell the owner "the seal key helper passed".
