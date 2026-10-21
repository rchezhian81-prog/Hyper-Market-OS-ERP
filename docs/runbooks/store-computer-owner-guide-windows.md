# Owner's guide — setting up the store computer yourself, on Windows (OB-240 · OB-244)

**Who this is for:** you, the owner. You do every step yourself, on the shop's Windows 10 or Windows 11 computer. You do
not need to be a programmer: you type what is in the grey boxes, exactly, and press Enter.
**What it does:** puts a second, sealed-off copy of the new system on that computer, for the shop's real data only. It
works with no internet and is never connected to the demo. Parts 1–11 set up and prove the copy; Parts 12–30 put the
till on this same PC, set up head office's records on it, lock the PC, and give you the daily routine for the mirror
pilot (OB-248).
**How long:** about half a day the first time, most of it waiting for downloads.
**Language:** this guide is in English. The cashier sheets are in the `docs\sop` folder (Part 30 lists them). For the
pilot the **English sheets are the ones you print** (OB-261). The Tamil sheets are kept beside them, marked "not yet
checked by a Tamil reader"; they are checked before the pilot grows beyond the first department. The till and the office
screens themselves show English and Tamil, as built.

> **How to read the marks in this guide.**
> - **STOP AND ASK** — this step needs a name, a number or a choice only you can give. Nothing is invented for you. Write
>   your answer in the workbook first; then type it.
> - **Holds a secret** — never photograph that window or that file.

> **No real data is loaded by anything in this guide.** Real data waits for the names you give (OB-243) and your
> written GO (OB-242). Silence is not a yes.

> **Three rules for the whole guide**
> 1. **Never send a photo of the file `.env.real` or the file `till.env`, and never open them.** They are in the shop's
>    data folder `C:\SRE-data` and hold this copy's secrets. Every photo this guide asks for is of the blue PowerShell
>    window or of a Windows screen — never of those files, and never of a window the guide marks "holds a secret" (a till
>    PIN, the backup passphrase, the BitLocker recovery key).
> 2. **Nobody else types on this computer for you, and no AI is given control of it.** You type every command yourself.
>    Where a step needs another person's own PIN, that person types it, with you beside them. If anyone (a person, a
>    message, a website) asks you to install remote-control software or to paste something you were sent, say no and
>    tell me.
> 3. **If any step shows red text, stop.** Send me a photo of the whole window (see "If a step fails" at the end).

**What you need before you start:**

- the shop's Windows 10 or 11 computer, switched on, with internet for now (you will unplug it later, on purpose);
- your own GitHub sign-in (the account that holds the code);
- **two** USB backup drives that belong to you: one stays plugged into this PC for the hourly backup, the other is your
  own daily copy that you take home (OB-249) — needed from Part 8;
- your own sign-in to the demo box — the same one you used for the demo's stand-up check — needed in Part 9;
- the setup workbook page (paper is fine), to write down the things this guide says to write down. **Never write a
  secret in it** — the tool never shows you one anyway. The one exception is the backup passphrase (Part 8): that goes
  on its own sheet of paper, locked away from this PC.

---

## Part 1 — Check the computer

1. Press the **Windows key**, type `About`, and open **About your PC**. (Or: **Settings → System → About**.)
   - Look at **Installed RAM**. It must say **8.00 GB** or more.
   - Look at **Edition** (Windows 10 or Windows 11, Home or Pro — any of them is fine) and **Version**.
   - **When it worked:** you can read both lines. **Send:** a photo of this screen.
2. Press **Ctrl + Shift + Esc** to open **Task Manager**. If it is small, click **More details**. Click **Performance**,
   then **CPU**.
   - Bottom right, find **Virtualization**. It must say **Enabled**.
   - **When it worked:** it says Enabled. **Send:** a photo of this screen.
   - **If it says Disabled:** stop here and send the photo. It is switched on in the computer's start-up settings, and we
     will do that together, step by step.
3. Open **File Explorer** (the yellow folder on the taskbar) and click **This PC**.
   - Under **Local Disk (C:)** it says "… GB free of … GB". The free part must be **50 GB** or more. You told me this PC
     has **433 GB free** on C: (OB-260) — plenty.
   - **When it worked:** at least 50 GB free. **Send:** a photo of this screen.
4. Check the clock: **Settings → Time & language → Date & time**. The time zone must be
   **(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi**, and the time must be right.
   - **When it worked:** the zone and the time are right. **Send:** nothing, unless you had to change it.

## Part 2 — Install the three programs (from their official sites only)

Download each program **only from the site named here**. Never from a link in a message.

1. **Docker Desktop** — on **docker.com**, choose **Download Docker Desktop → Windows**.
   - Run the downloaded installer. When it asks, keep **"Use WSL 2 instead of Hyper-V"** ticked. Click OK, then **Close
     and restart** when it says so.
   - After the restart, open **Docker Desktop** from the Start menu. Accept its terms. If it asks you to sign in, choose
     **continue without signing in** (or skip).
   - If it says WSL needs to be installed or updated, it shows a command (for example `wsl --update`): open PowerShell
     (step 3 below shows how), type that command, press Enter, and restart the computer.
   - **When it worked:** bottom left of Docker Desktop it says **Engine running** (green). **Send:** a photo of that.
2. **Node.js 22 LTS** — on **nodejs.org**, download the **LTS** version whose number starts with **22**, the
   **Windows Installer (.msi)**. Run it and accept the normal choices (Next, Next, Install).
3. Open **PowerShell**: press the Windows key, type `PowerShell`, open **Windows PowerShell**. A blue window opens.
   Type:
   ```
   node --version
   ```
   - **When it worked:** it answers `v22.` and some more numbers.
4. Still in PowerShell, install **pnpm**:
   ```
   npm install -g pnpm
   ```
   - **If you see red text saying "running scripts is disabled on this system":** type this once, press Enter, and answer
     `Y`. It changes the setting for your own Windows account only:
     ```
     Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
     ```
     Then type `npm install -g pnpm` again.
   - Close PowerShell and open it again, then type:
     ```
     pnpm --version
     ```
   - **When it worked:** it answers a number such as `10.33.0`. **Send:** a photo of the window showing the `node` and
     `pnpm` answers.

## Part 3 — Get the code onto the computer

1. In your web browser, go to **github.com** and **sign in to your own account**.
2. Open the repository (the shop's system). Click the green **Code** button, then **Download ZIP**.
3. Open your **Downloads** folder. Right-click the ZIP file → **Extract All…** → in the box type `C:\` → **Extract**.
4. In File Explorer, open **This PC → Local Disk (C:)**. You will see a new folder named like the repository (for
   example `Hyper-Market-OS-ERP-main`). Right-click it → **Rename** → type `SRE` → Enter.
   - **The folder must be exactly `C:\SRE`.** Not on the Desktop, not in Documents, not in OneDrive, and no spaces in
     the name: those places can copy the secrets off this computer, or break the commands.
   - **When it worked:** opening `C:\SRE` shows folders such as `apps`, `docs`, `infra`, `scripts` and a file
     `package.json`. **Send:** a photo of that folder.
   - `C:\SRE` holds **the system** (this release). The shop's **data** — this copy's settings, the till's sales, the
     check records, the backup key — lives in a separate folder, `C:\SRE-data`, which the tool makes in Part 5. A new
     version of the system goes into a folder of its own beside `C:\SRE` (Part 29); `C:\SRE-data` never moves.

## Part 4 — Open PowerShell in that folder and install

1. In File Explorer, open `C:\SRE`. Click once in the **address bar** at the top (where it says `This PC > Local Disk
   (C:) > SRE`), type `powershell`, press Enter.
   - **When it worked:** a blue window opens whose last line starts with `PS C:\SRE>`.
   - **Every command from here on is typed in a window like this, in `C:\SRE`** (after an update: in the new release's
     folder, Part 29).
2. Type:
   ```
   pnpm install
   ```
   It takes a few minutes. Yellow "WARN" lines are fine.
   - **When it worked:** the last lines say `Done in …`. **Send:** a photo of the end of it.

## Part 5 — Check, prepare and start this copy

1. Check the computer:
   ```
   pnpm run store-computer -- doctor
   ```
   - **When it worked:** every line starts with `OK`, and the last line says `All OK.`
   - A line that starts with `FIX` says what to do on the line under it. Do that one thing, then run `doctor` again.
   - **Send:** a photo of the window.
2. Make this copy's settings file (once only):
   ```
   pnpm run store-computer -- prepare
   ```
   - **When it worked:** it says `Settings file written: C:\SRE-data\.env.real`, that it is in the shop's data folder
     `C:\SRE-data`, lists the names of the settings it filled (never their values), and says `This copy's tenant id:`
     followed by a long id with dashes.
   - **Write the tenant id in the workbook**, and the words "compose project sre-real" and today's date. The tenant id
     is a name, not a secret.
   - **Send:** a photo of the window. (This window has no secret in it. The file it made does — never photograph that.)
   - Run `prepare` only once. If you run it again it refuses on purpose: it never overwrites the file.
3. Start this copy:
   ```
   pnpm run store-computer -- up
   ```
   The first time takes several minutes (it builds the system).
   - **When it worked:** it says `READY — this copy is up on this computer, and needs no internet.`
   - If it says `NOT STARTED —`, the next line says the one thing to do (for example "Open Docker Desktop …"). Do it,
     then run `up` again.
   - **Send:** a photo of the window.

## Part 6 — The isolation check (pilot gate G4), first run

1. Type, with your own name in the quotes:
   ```
   pnpm run store-computer -- check --by "Your Name"
   ```
   - **When it worked:** it prints a table of ten checks, each `PASS`, `FAIL` or `NEEDS-YOU`, a line starting with
     `G4`, and `Record written: C:\SRE-data\records\…`.
   - The first time, three checks say **NEEDS-YOU**. That is expected:
     - **check 3** (this copy's secrets are not the demo's) waits for Part 9 (the demo's fingerprints);
     - **check 5** waits for Part 7 (the network cable);
     - **check 10** waits for Part 8 (your backup drive).
   - Every other check must say **PASS**. A **FAIL** says why on the line under it.
   - **Send:** a photo of the whole table.

## Part 7 — Prove it works with no internet

1. Take the internet away from this computer. This PC is on a **wired** network (OB-260): unplug the network cable from
   the back of **this computer**. (No tills are connected yet, so nothing else is affected.)
2. Wait one minute. Then type:
   ```
   pnpm run store-computer -- check --by "Your Name" --offline-confirmed
   ```
   - **When it worked:** **check 5** now says **PASS**.
   - **Send:** a photo of the table.
3. Plug the network cable back in.

## Part 8 — Your backup drive and the backup passphrase (check 10)

Nothing extra is installed for this: the backup runs **inside** this copy's own database box in Docker, and the file
goes straight onto your drive. Every backup is **encrypted**, and holds the database, the till's own saved sales and this
copy's settings. **Nothing is ever deleted** — no backup, no record (OB-262).

1. **Plug in your own backup drive** (the one you will take home). In File Explorer → **This PC**, find it (for example
   `Backup (E:)`). **The letter after its name is your drive letter.** Write it in the workbook. Everywhere below that
   says `E:`, type **your** letter instead.
2. Open PowerShell in `C:\SRE` (Part 4, step 1) and take the backup:
   ```
   pnpm run store-computer -- backup --to E:\sre-real
   ```
   - **The first time it asks you to choose the backup passphrase** — **this window holds a secret while you type**:
     at least the number of characters it says, a short sentence you will remember; nothing shows as you type; it asks
     twice. Write the passphrase on paper and lock that paper away from this PC (with the BitLocker key, Part 26d).
     **If it is forgotten, nobody can open the backups — not even me.** The PC keeps only a sealed key that the
     passphrase opens, never the passphrase. It then says `BACKUP PASSPHRASE SET — backup key …`.
   - **When it worked:** it says `BACKUP DONE —` with the backup's name, its size and how long it took, then a line
     `Manifest: E:\sre-real\…manifest.json`. **Write that manifest's file name in the workbook.**
   - It refuses, on purpose, a folder on `C:`, inside `C:\SRE` or inside `C:\SRE-data`: a backup on the same computer is
     not a backup.
   - **Send:** a photo of the window (after the passphrase questions; it shows no secret). The long line of letters and
     digits after "SHA-256" is the file's own fingerprint, not a password.
3. Prove the backup really comes back. Type the line below with the manifest's name (tip: type the start of the name
   and press the **Tab** key; PowerShell fills in the rest):
   ```
   pnpm run store-computer -- restore-check --from E:\sre-real\sre-real-backup-XXXX.manifest.json
   ```
   - It asks for the backup passphrase (nothing shows as you type). It copies the backup into a **new, empty,
     temporary** database inside the same Docker box (never into the real one), counts every table, compares the counts
     and the money with the manifest, writes the result onto your drive, and only then removes that temporary database.
   - **When it worked:** it says `restored_and_reconciled —` and that the scratch database was removed after the record
     was written, and that `sre_real` was never touched.
   - **If it says `NOT ACCEPTED`:** stop. Do not rely on that backup. Send a photo of the whole window.
   - **Send:** a photo of the window.
4. **Keep the drive plugged in** until Part 10 is done.

## Part 9 — The demo's fingerprints (check 3)

Check 3 asks: "is any secret on this computer the same as one on the demo?" The demo's secrets must never come to
this computer, and this computer's must never go to the demo. So each computer shows a **fingerprint** of each secret
instead: 12 letters and digits worked out from the secret in a way that cannot be turned back. The tool compares the
two sets; if any two are the same, check 3 fails and names the setting.

> **Why a fingerprint gives nothing away.** Each secret is at least 32 random characters. The fingerprint is a short
> piece of a one-way scramble of it (SHA-256). Nobody can run the scramble backwards; guessing would mean trying more
> values than any computer could in the life of the universe; and because only 12 characters are kept, a huge number of
> different values share each fingerprint — so a fingerprint cannot point at one secret. **A photo of the fingerprints
> is safe.** A photo of a settings file never is.

**On the demo box** — you sign in the same way you did for the demo's stand-up check, with your own login. This guide
does not write the box's address or any key: use the address you were given, and type your own password when asked.

1. On this computer, open PowerShell and sign in to the demo box (your login and the box's address where shown):
   ```
   ssh <your login>@<the demo box's address>
   ```
   - If PowerShell says `ssh` is not recognised: **Settings → Apps → Optional features → Add a feature → OpenSSH
     Client**, then open PowerShell again.
   - **When it worked:** the last line now ends with `$` — you are typing on the demo box.
2. On the demo box, type these two lines. The second runs the tool as the box's deploy user (it asks for your own
   password once; nothing appears while you type it):
   ```
   cd /opt/sre/app
   sudo -u deploy node scripts/store-computer.mjs fingerprints --out /opt/sre/fingerprints
   ```
   - **When it worked:** it says `Secret fingerprints from .env.pilot on this computer (Linux)`, then five lines, each a
     setting's name and 12 letters and digits, then `Fingerprint file written: /opt/sre/fingerprints/fingerprints-….json`.
     **Write that file's name in the workbook.**
   - If it says `Not understood: the command "fingerprints"`, the demo box is not on the newest release yet. Stop and
     send the photo.
   - **Send:** a photo of the window (safe: fingerprints only).
3. Type `exit` and press Enter. You are back on this computer (`PS …>`).

**Back on the store computer:**

4. In PowerShell in `C:\SRE`, make a folder for the file and copy it across (your login, the box's address and the
   file's name where shown):
   ```
   mkdir C:\SRE-demo-fingerprints
   scp <your login>@<the demo box's address>:/opt/sre/fingerprints/fingerprints-XXXX.json C:\SRE-demo-fingerprints\
   ```
   - **When it worked:** it shows the file name and `100%`.
5. Optional, for your own eyes: this computer's fingerprints, to compare with the photo from step 2 — every one must be
   different:
   ```
   pnpm run store-computer -- fingerprints
   ```
6. Run the check with the demo's file (tip: type `C:\SRE-demo-fingerprints\` and press **Tab**):
   ```
   pnpm run store-computer -- check --by "Your Name" --demo-fingerprints C:\SRE-demo-fingerprints\fingerprints-XXXX.json
   ```
   - **When it worked:** **check 3** says **PASS** and "all 5 of this copy's secret fingerprints differ from all 5 of
     the demo's".
   - **If check 3 says FAIL** and names a setting: stop. That secret is shared with the demo and must be replaced before
     any real data. Send the photo.
   - **Send:** a photo of the table.

## Part 10 — The final G4 check

1. Plug in your backup drive (if it is not still in), and unplug the network cable again (Part 7, step 1). Open
   PowerShell in `C:\SRE` and type — your name, the demo's fingerprint file from Part 9 and the backup manifest from
   Part 8:
   ```
   pnpm run store-computer -- check --by "Your Name" --offline-confirmed --demo-fingerprints C:\SRE-demo-fingerprints\fingerprints-XXXX.json --backup-record E:\sre-real\sre-real-backup-XXXX.manifest.json
   ```
   - **When it worked:** all ten checks say **PASS**, and the line under the table says
     `G4 PASSED — all ten isolation checks pass.`
   - Check 10 passes only when that backup has passed its restore-check (Part 8, step 3) and is on your drive.
   - **Send:** a photo of the table and the `G4` line.
2. Plug the network cable back in. Keep every record file: they are in `C:\SRE-data\records\`.

## Part 11 — The rollback drill (pilot gate G9)

The drill proves that if a new version of the system ever goes wrong, the shop can go back to the version before it,
and the data can be brought back from your drive — and how long each takes. The targets come from the plan: the
system back within **30 minutes**, the database back within **4 hours**. Over a target is **not** a pass.

What it does, in order, with a stopwatch on each step: backup onto your drive → restore-check of that backup → start
the **previous** version on this copy → start **this** version again. The database itself is not taken back: each new
version only **adds** to it, so the previous version runs on today's database — exactly what would happen on a real bad
night. The tool checks that this is safe first, and refuses if it is not.

1. **Get the previous version** (nothing to install). On **github.com**, open the repository's **commits** list. Click
   the **second** commit from the top, then **Browse files**, then the green **Code** button → **Download ZIP**. Extract
   it to `C:\` (Part 3, step 3) and rename the new folder to `SRE-previous`.
   - **The folder must be exactly `C:\SRE-previous`**, beside `C:\SRE` — never inside it. It needs no `pnpm install`
     and no settings file: the drill uses this copy's own settings in `C:\SRE-data`.
   - After your first update (Part 29), the previous version is simply the release folder you updated **from** — it is
     already beside the new one, and you name that folder instead.
   - If the drill later says "the same release", go one more commit down the list and do this step again.
2. Plug in your backup drive. Open PowerShell in `C:\SRE` and do the **dry run** (it changes nothing):
   ```
   pnpm run store-computer -- drill --by "Your Name" --to E:\sre-real --previous C:\SRE-previous
   ```
   - It asks for the backup passphrase first (the real drill opens the backup).
   - **When it worked:** it says `DRY RUN — nothing will change.` and lists five steps.
   - A line starting `REFUSED —` names the one thing to fix. Nothing was changed.
   - **Send:** a photo of the window.
3. **The real drill**, at a quiet time (the system restarts twice; no tills are connected yet). The same command with
   `--run` at the end:
   ```
   pnpm run store-computer -- drill --by "Your Name" --to E:\sre-real --previous C:\SRE-previous --run
   ```
   - It takes a while (it builds each version). Leave the window open; Docker's own lines scroll past.
   - **When it worked:** four lines starting `done`, a `times` line, then
     `G9 PASSED — every step worked, each inside its target …`, then `Record written: …` and
     `A copy is on your backup drive: …`.
   - `SLOW` on a step means it worked but took longer than its target: **G9 is not passed**. Send the photo.
   - **If it says `THIS COPY MAY NOT BE ON THIS RELEASE NOW`:** type `pnpm run store-computer -- up`, wait for
     `READY`, and send photos of both.
   - **Send:** a photo of the last lines. Then unplug the drive and put it away.

---

## Part 12 — Give the store system a fixed share of memory (OB-247)

This PC has 8 GB. The shop's own programs need only about half a gigabyte, but Windows, Docker and the browser need
most of the rest. Docker may take up to half the memory by default. This step caps it at 3 GB, so Windows and the till
always have room.

1. Open PowerShell (Part 2, step 3) — it does not need to be in `C:\SRE`. First check that no such file exists yet:
   ```
   Test-Path "$env:USERPROFILE\.wslconfig"
   ```
   - **When it worked:** it answers `False`.
   - **If it answers `True`:** stop. Someone has already made this file. Type
     `Get-Content "$env:USERPROFILE\.wslconfig"` and send a photo. Do not change it.
2. Make the file. Type this as **one** line (PowerShell writes the file itself, so Notepad cannot add `.txt` to its
   name by mistake):
   ```
   Set-Content -Path "$env:USERPROFILE\.wslconfig" -Value "[wsl2]","memory=3GB","swap=4GB","","[experimental]","autoMemoryReclaim=dropCache" -Encoding ascii
   ```
3. Check it:
   ```
   Get-Content "$env:USERPROFILE\.wslconfig"
   ```
   - **When it worked:** six lines: `[wsl2]`, `memory=3GB`, `swap=4GB`, an empty line, `[experimental]`,
     `autoMemoryReclaim=dropCache`. **Send:** a photo.
4. Let Docker pick up the new limit. Close Docker Desktop's window, then type:
   ```
   wsl --shutdown
   ```
   Open **Docker Desktop** again from the Start menu and wait for **Engine running**. Then open PowerShell in `C:\SRE`
   (Part 4, step 1) and type `pnpm run store-computer -- up` and wait for `READY`.
   - If Docker Desktop shows a warning about `.wslconfig`, stop and send a photo of it.
5. In Docker Desktop, open **Settings → Resources** and turn **Resource Saver** on, if your version shows it.
6. **The memory photo — later, during a practice hour** (not now). When the till is open and staff are practising
   (Part 24 onwards), press **Ctrl + Shift + Esc** → **Performance** → **Memory**. **Send:** one photo of that screen
   (it shows "In use" and "Committed"), and one of **Processes** with the **Memory** column clicked so the biggest is at
   the top. We decide about more memory from that photo: only if "In use" stays above about 6.5 GB, and nothing is
   bought without your OK.

> **Rebuilds use a lot of memory.** The first `up`, every rollback drill (Part 11) and every update (Part 29) rebuild
> the system. Do them only when the shop is closed.

## Part 13 — Install the till on this same PC (one lane)

In the pilot, **this PC is the till**: it stands at the pilot counter, with the scanner plugged into it, and runs one
lane. The till part runs on Windows itself, not inside Docker, because only a program on this PC can reach the till's
private save socket. No network is used for a sale.

1. Open PowerShell in `C:\SRE` (Part 4, step 1). Type:
   ```
   pnpm run till:install -- --lane lane-1 --settings C:\SRE-data\.env.real
   ```
   It takes a few minutes (it builds the till screen, the office screens and the till's own program).
   - **When it worked:** it says the till's settings and data go in `C:\SRE-data\till`, outside this release; that the
     till takes **guest sales only** (OB-252); that it runs the **mirror pilot** — every sale and refund "Paid on old
     system", with the old bill number (OB-248, OB-256, OB-264); that it starts **OFFLINE-FIRST** (it sells and saves
     every sale on this PC, and sends nothing yet — Part 20 connects it); then `Till installed.`, a line `Settings:`
     naming `C:\SRE-data\till\till.env`, a line `Start script:` naming `C:\SRE\till\start-till.cmd`, and a list under
     `Next:`.
   - The installer writes the two mirror-pilot settings into `till.env` **together**: the mirror pilot and guest sales
     only. It refuses to write a till for this copy without both — it then says `The till cannot be installed yet —`
     and names the setting, and nothing is written. A till installed before 20 Oct 2026 gets the missing one added when
     you type the same command again.
   - If it says `The till cannot be installed yet —` it lists every problem at once. Send a photo.
   - **Write in the workbook:** "till installed, lane-1" and the date. **Send:** a photo of the window.
2. `till.env` holds this till's keys. **Never open it, never photograph it, never copy it** — the same rule as
   `.env.real`. You never need to open it: every setting in it is written by the tool.
3. Only if `doctor` (Part 5) ever says **FIX Data** — which happens only on a copy set up before 20 Oct 2026 — close the
   till and type `pnpm run store-computer -- migrate-data-folder`. It copies the data into `C:\SRE-data`, checks every
   file, and says `MOVED —`. A copy set up with this guide is already there.

## Part 14 — Start the till by itself, and open it

1. Let the till and the system start by themselves whenever you sign in to Windows (after a power cut or an update):
   ```
   pnpm run store-computer -- autostart
   ```
   - **When it worked:** it says `AUTOSTART ON — when` (your Windows name) `signs in to Windows, the task` … `will, by
     itself:` and four steps: wait for Docker Desktop (and start it), start this copy, start the till in the background,
     and run the store computer check.
   - Read its lines under `THE TRUTH ABOUT WINDOWS`: nothing runs until **you** sign in. So after every restart: sign in
     first, then lock the PC (**Windows key + L**), and the cashier switches to the `Till` account (Part 26b).
   - The till now runs in the background, with no window to close by mistake. **Do not also double-click
     `start-till.cmd`.**
   - **Send:** a photo of the window.
2. Restart the computer, sign in, and wait two minutes. Then type:
   ```
   pnpm run store-computer -- status
   ```
   - **When it worked:** a list of checks, each `OK` or `RED` (or `?` where it cannot say yet), and `ALL OK — nothing
     needs you.` Before the hourly backup is set up (Part 28) the backup line is RED and the `Drive room` line is `?`
     — that is the truth, not a fault.
   - **Check the two mirror-pilot settings** the installer wrote (Part 13). Find the line that starts `OK   Mirror`. It
     must say `the till runs the mirror pilot with guest sales only (EDGE_MIRROR_PILOT=1, EDGE_GUEST_SALES_ONLY=1)`.
     **Both** must say `=1`. If the line says `RED  Mirror` instead, or either one says `0` or `(not set)`: ring nothing
     on the new till, type the Part 13 install command again, restart the till (step 2 again), and send a photo. You
     never open `till.env` to look: `status` reads the two settings for you and shows nothing else from that file.
3. Open **Microsoft Edge** on this PC. In the address bar, type the till address the installer printed in Part 13
   under `Next:` step 2 ("Open the till in a browser on THIS PC"). Press Enter.
   - **When it worked:** the till's Sale screen opens. Make it a favourite (the star in the address bar), so nobody
     has to type the address again.
   - Until the shop's products reach the till (Part 24), it says it has no price list. That is the truth, not a fault.
4. While you are here, stop the PC sleeping: **Settings → System → Power & battery → Screen and sleep** → set every
   "put my device to sleep" box to **Never**. And **Settings → Windows Update → Advanced options → Active hours** →
   set them to cover the shop's opening hours, so Windows never restarts itself while you trade.

## Part 15 — The first people: you, the accountant and the store manager (tenant:bootstrap)

The first people in the new system are laid down once, by this command. Every later person is added by **two people**:
one asks, another approves (Part 19). On this PC the only two people who can do that are the **store manager** (asks)
and **you** (approve) — the accountant's role cannot give roles. So the store manager must be in this first set.

**STOP AND ASK.** This step needs, in writing:
- **your own login name** for the new system (a short name, for example your first name; never a shared login);
- **the accountant**: the shop's accountant (role `accountant`), your chartered accountant (role
  `chartered_accountant`), or both — each with their own login name;
- **the store manager** (role `store_manager`) and their login name. Not named yet (OB-243). Without a store manager
  in this first set, no cashier can be added later.
Nobody may invent these (OB-243). Do not type the command below until you have written them down.

1. First the **dry run** (it changes nothing). Your tenant id is the one you wrote in the workbook in Part 5. Type it as
   one line, putting in your own values (for two people, put a comma between them after `--admin`, no spaces):
   ```
   pnpm run tenant:bootstrap -- --tenant <tenant-id> --owner <your-login> --admin <their-login>:<their-role>,<manager-login>:store_manager --operator "Your Name" --env-file C:\SRE-data\.env.real --dry-run
   ```
   - **When it worked:** it lists each person and their role, then `DRY RUN — nothing was written.`
   - Read the list. If anything is wrong, fix the line and run the dry run again.
   - **Send:** a photo of the window.
2. The real run is the same line **without** `--dry-run`.
   - **When it worked:** `The database is reached on this computer's own database port (5432), not the container
     name.`, then `SEEDED — 3 grant(s) recorded in one atomic append.` (the number is how many people you named). It
     refuses, on purpose, a second run: `NOT CHANGED — … already holds grants`.
   - **Send:** a photo of the window.

## Part 16 — Till PINs for you, the accountant and the manager

Every person has their own six-digit **till PIN**. It opens the till (for cashiers), the office screens (Part 26e), and
the head-office steps below: in each of Parts 17–25, the tool asks the person whose act it is to type **their own**
PIN. You never type anybody else's PIN.

1. With the person beside you, in PowerShell in `C:\SRE`, type — their login and your name:
   ```
   pnpm run till:pin -- --user <their-login> --by "Your Name"
   ```
   - It says `Using the till's settings in C:\SRE-data\till\till.env (never shown).`, then the new PIN **once**, then
     `Give it to them in person.` **This window holds a secret: never photograph it.** Turn the screen to the person and
     look away while they read it. Do not write it down for them, do not send it by phone. Then close that window.
   - The PIN is kept nowhere. If it is forgotten, make a new one the same way (sheet 4).
   - Someone leaves, or a PIN may be known to someone else: the same line with `--revoke` at the end.
2. Do this for **yourself**, the accountant(s) and the store manager.
   - **Write in the workbook:** each login and "PIN made" with the date — never the PIN.

## Part 17 — The shop's legal name, GSTIN and the store

**STOP AND ASK.** Write in the workbook first:
- the company's **legal name** exactly as on the GST certificate, and the **GSTIN** (the 15-character number on it, in
  capital letters);
- a short **company code** (for example `SRE`) and a short **store code** for this shop (for example `SRE-MAIN`), and the
  store's everyday name. The codes are names the system uses inside; none of these is a secret.

1. In PowerShell in `C:\SRE`, type as one line, with your values:
   ```
   pnpm run store-computer -- shop --as <your-login> --company <company-code> --legal-name "<legal name as on the GST certificate>" --gstin <GSTIN> --store <store-code> --store-name "<store name>"
   ```
   - It says `This will, at head office on this computer` and lists four steps in plain words. **Read them.** Then
     `Type YES and press Enter to do this`. Type `YES` only if every word is right; anything else stops it and nothing
     is done.
   - It then asks for **your** till PIN (nothing shows as you type) and says `your-login's PIN matches.`
   - **When it worked:** four lines starting `done —`, then `DONE — the shop is set up at head office on this
     computer`. Head office checks the GSTIN's check digit: a mistyped GSTIN is refused with `gstin_invalid`.
   - **Send:** a photo of the window.

## Part 18 — The store's settings

**STOP AND ASK.** These are your decisions; nothing is filled in for you:
- when the shop's day ends (`00:00` is midnight, the documented starting value OC-06);
- after how many minutes the store computer's copy of head office's setup counts as old;
- above how many rupees a stock-count difference needs a second person;
- how many rupees a cash handover, and a till's cash, may be out before it is a difference.
(Privacy requests are always answered within 15 days — fixed by OB-195.)

1. Type as one line, with your values:
   ```
   pnpm run store-computer -- store-settings --as <your-login> --store <store-code> --cutoff 00:00 --stale-after-minutes <minutes> --count-approval-rupees <rupees> --handover-tolerance-rupees <rupees> --cash-variance-rupees <rupees>
   ```
   - It reads your values back to you in words. Type `YES`, then your PIN.
   - **When it worked:** `done — store … settings saved as version 1.` and `DONE —`. Every later change is a new
     version; the older ones are kept.

## Part 19 — The till's bill prefix

The till numbers its bills under a **bill prefix** head office issues (`in-store-install.md` Step 5b). In the mirror
pilot the new bill is never given to a customer (OB-248), but the prefix still keeps every bill number unique.
**STOP AND ASK** if you are not sure which prefix to use (up to 10 letters, digits or `-`, for example `S1L1-`).

1. Type:
   ```
   pnpm run store-computer -- bill-prefix --as <your-login> --store <store-code> --till lane-1 --prefix <prefix> --reason "mirror pilot till"
   ```
   - Type `YES`, then your PIN. **When it worked:** `DONE — the bill prefix … is issued to till lane-1`.

## Part 20 — Connect the till to this copy's books

So far the till sells and keeps every sale on this PC. Now it gets the store's setup from head office and sends its
sales to this copy's books (for the evening check). Two steps.

1. **The till's own sign-in gets its role** — the store computer role, at this store only. This is the first act done by
   **two people**: the store manager asks, you approve. Both sit at the PC; each types their own PIN when asked.
   ```
   pnpm run store-computer -- grant --as <manager-login> --approver <your-login> --person store-edge --role store_computer --store <store-code> --reason "the till on the store PC"
   ```
   - It lists the two steps: the manager asks, you approve. Type `YES`. Then it asks the **manager** for their PIN (the
     manager types it), then **you** for yours.
   - **When it worked:** `done — … asked for it`, `done — … approved it`, then `DONE — store-edge holds "store_computer"
     at store …: asked by …, approved by …`.
   - A wrong PIN, for either person, and **nothing** is done.
2. **The till's settings.** The installer writes them itself — this copy's own address, the store, and a store token —
   and shows none of them:
   ```
   pnpm run till:install -- --lane lane-1 --store <store-code> --settings C:\SRE-data\.env.real
   ```
   - **When it worked:** a line `connected to this copy's books for store …: a NEW store token … was written into
     till.env — it is never shown`, a line saying which settings it set in `till.env` (names only), and at the end
     `Connected: this till sends its sales to this copy's books for store …`.
   - The store token lasts **30 days**. **Write today's date in the workbook**, and run this same command again before
     30 days are up (it makes a new token).
3. Restart the computer and sign in (the till starts again by itself, with its new settings). Then type
   `pnpm run store-computer -- status` — every line `OK` except, until Part 28, the backup.

## Part 21 — Staff and their till PINs

Every cashier signs in at the till with their own staff ID and their own six-digit PIN. **No shared logins.**

**STOP AND ASK.** The pilot cashier(s) are not named yet (OB-243, OB-254). For each cashier, once named:
1. **Their role at head office** — the store manager asks, you approve, each with their own PIN:
   ```
   pnpm run store-computer -- grant --as <manager-login> --approver <your-login> --person <cashier-login> --role cashier --store <store-code> --reason "pilot cashier"
   ```
   - **When it worked:** `DONE — <cashier> holds "cashier" at store …`. The till learns it the next time it reaches this
     copy's books (within a few minutes).
2. **Their till PIN**, with the cashier beside you (Part 16, step 1):
   ```
   pnpm run till:pin -- --user <cashier-login> --by "Your Name"
   ```
   - **This window holds a secret.** The cashier reads their PIN themselves; you look away.

## Part 22 — The pilot department: only after your written GO

**Nothing real is loaded before your written GO (OB-242).** The first load is one department's products, barcodes, tax
classes and prices (OB-241); the department is not named yet (OB-243). **STOP AND ASK.**

When the GO is written and the department is named:
1. On the migration screen ("The figures" → "Templates for the first department") download the four templates and
   fill them from the old ERP's export, into one folder, for example `C:\SRE-slice`, with its `slice.json`.
2. **Seal the exported files** (MG-02). The old ERP's own backup must have been **restored and checked** first; say on
   which day. The person who took the export seals it, in their own name:
   ```
   pnpm run store-computer -- seal --dir C:\SRE-slice --as <their-login> --backup-restored-on <YYYY-MM-DD>
   ```
   - It asks the person sealing for **their own till PIN** (`<their-login>'s till PIN:`); nothing shows while they
     type, and only they type it (OB-257). Without the right PIN nothing is sealed and nothing is sent.
   - **When it worked:** `<their-login>'s PIN matches.`, then one `SEALED —` line per file, then `All … file(s) are
     sealed. Next: stage the slice (--stage).` and `slice.json now holds the seals.` A file already sealed is never sealed
     again (`kept —`).
3. Then three commands, by two different people (the person who loads can never sign the totals):
   ```
   pnpm run migration:slice -- --dir C:\SRE-slice --stage --settings C:\SRE-data\.env.real
   pnpm run migration:slice -- --dir C:\SRE-slice --accept --as <their-login> --statement "<what they read and decided>" --settings C:\SRE-data\.env.real
   pnpm run migration:slice -- --dir C:\SRE-slice --apply --settings C:\SRE-data\.env.real --out C:\SRE-slice\outcome-1.json
   ```
   - **When it worked:** `RECORDED —`, then `ACCEPTED —`, then `APPLIED — every staged row landed`.
   - Any `REFUSED` line: stop and send a photo. `docs\runbooks\real-data-load.md` explains each message.

## Part 23 — The parallel-run terms (for the evening check)

The evening check (sheet 3) records each day only once the terms of the parallel run are written: who reconciles every
day, how many clean days in a row are needed, the most days it may last, and the first day. **STOP AND ASK** — these
are your decisions (you are the daily reconciler for the first two weeks, OB-254). The cutover id is the one on the
migration screen.
```
pnpm run store-computer -- parallel-policy --as <your-login> --cutover <cutover-id> --reconciler <your-login> --clean-days <N> --max-days <M> --start <YYYY-MM-DD>
```
- It asks for **your own till PIN** (`<your-login>'s till PIN:`); nothing shows while you type (OB-257). Without the
  right PIN nothing is written and nothing is sent.
- **When it worked:** `<your-login>'s PIN matches.`, then `POLICY RECORDED — from …, … reconciles every day; …`.

## Part 24 — The products reach the till (the catalogue pack)

After the department is loaded, head office **publishes** a signed price list (the catalogue pack), and the till takes it
the next time it reaches this copy's books.

1. Type:
   ```
   pnpm run store-computer -- publish-catalogue --as <your-login> --store <store-code>
   ```
   - Type `YES`, then your PIN. **When it worked:** `done — the catalogue pack version … is published.` and `DONE —`.
2. Within a few minutes the till's Sale screen stops saying it has no price list. Scan three products from the pilot
   department and check each name and price against the old ERP. **Send:** a photo of the till screen with the three
   lines.

## Part 25 — Practise before the first real day

With the cashier, ring practice sales on the till exactly as sheet 2 says, for at least one practice hour. Take the
memory photo (Part 12, step 6) during it. Do the power-cut test (Part 27) and the evening check (sheet 3) once on
practice figures.

## Part 26 — Lock the PC (OB-251)

You decided: only you hold this PC's administrator account, the disk is encrypted, and cashiers get their own standard
Windows account that opens only the till. Do this part **before** any real data.

### 26a — You keep the only administrator account

1. Open PowerShell and type:
   ```
   net localgroup Administrators
   ```
   - **When it worked:** under the line of dashes, only **your** account (and possibly a built-in `Administrator`
     account, which Windows keeps switched off). **Send:** a photo.
   - If anyone else is listed, stop and send the photo. Do not remove anyone yet.
2. Then:
   ```
   net localgroup docker-users
   ```
   - **When it worked:** only your account. Anyone in this group can control Docker, and through it the database.

### 26b — A separate standard account for the cashiers

1. **Settings → Accounts → Other users → Add account.** Choose **I don't have this person's sign-in information**,
   then **Add a user without a Microsoft account**.
2. Name it `Till` (one account for the counter's Windows screen only — each cashier still signs in **at the till**
   with their own staff ID and PIN, so every sale names who rang it). Give it a password the cashiers will use, and
   the three security questions.
3. Back in **Other users**, click the new account → **Change account type** → it must say **Standard User**. Never
   Administrator.
4. **How the day works with two accounts:** you sign in first (Docker Desktop and the till start in **your** account,
   Part 14). Then press **Windows key + L**, or **Start → your name → switch user**, and sign in as `Till`. Your
   programs keep running. **Never "Sign out" of your own account while the shop trades**: that stops Docker and the
   till. In the `Till` account, open only Microsoft Edge with the till favourite (Part 14, step 3).

### 26c — Cashiers cannot open the settings files (folder permissions)

`.env.real` and `till.env` hold this copy's keys, in `C:\SRE-data`. Windows lets every account on the PC read a folder
unless told otherwise, so this step removes every account except you, Windows itself (SYSTEM) and administrators — on
**both** folders: `C:\SRE` (the system) and `C:\SRE-data` (the shop's data).

1. In **your own** account, open PowerShell (no need to be in `C:\SRE`) and type these two lines, each as **one** line:
   ```
   icacls C:\SRE /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
   icacls C:\SRE-data /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
   ```
   - The first may take a minute (there are many files). **When it worked:** each says `Successfully processed 1
     files; Failed processing 0 files`.
   - After every update (Part 29), run the first line again for the **new** release folder.
2. Check it on the two settings files themselves:
   ```
   icacls C:\SRE-data\.env.real
   icacls C:\SRE-data\till\till.env
   ```
   - **When it worked:** each shows exactly three lines with `(I)(F)`: your PC's name and your account,
     `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators`. **Send:** a photo (it shows names of accounts only, never what
     is in the file).
   - **If you also see `BUILTIN\Users` or `NT AUTHORITY\Authenticated Users`:** the lock did not reach that file. Stop
     and send the photo.
3. Check from the cashier's side: switch to the `Till` account, open File Explorer and double-click `C:\SRE-data`.
   - **When it worked:** Windows says **You don't currently have permission to access this folder**. Click
     **Cancel** — never **Continue**, and never type your own password in the `Till` account. Do the same for `C:\SRE`.

### 26d — Encrypt the disk (BitLocker)

If the PC is stolen, an encrypted disk cannot be read. BitLocker is part of Windows 11 Pro.

1. Press the Windows key, type `Manage BitLocker`, open it. (Or **Control Panel → System and Security → BitLocker
   Drive Encryption**.)
   - If drive `C:` already says **BitLocker on**, Windows may have switched it on by itself and kept the recovery key
     in your Microsoft account. Still do step 3 (**Back up your recovery key → Print**), then go to step 6.
2. Next to `C:`, click **Turn on BitLocker**. When asked how to unlock at start-up, keep the normal choice.
3. **Back up your recovery key → Print the recovery key.** Print it on paper. This is the only way into the disk if
   Windows ever asks for it (for example after a hardware repair).
   - **Never photograph the recovery key, never type it into a phone or a message, never send it to anyone — including
     me.** Do not choose "Save to your Microsoft account" unless you already keep that account safe and private.
   - Put the paper in a sealed envelope and keep it **away from this PC**: at home, or in your locker, with the backup
     passphrase (Part 8). Write in the workbook where it is (not the key itself).
4. Choose **Encrypt entire drive**, then **New encryption mode**, then tick **Run BitLocker system check** and
   **Continue**, and restart when it asks.
5. Encryption runs in the background; the PC can be used meanwhile. Leave it switched on until it finishes.
6. Check it: right-click the **Start** button → **Terminal (Admin)** (or **Windows PowerShell (Admin)**) → **Yes**, and
   type:
   ```
   manage-bde -status C:
   ```
   - **When it worked:** `Percentage Encrypted: 100.0%` and `Protection Status: Protection On`. **Send:** a photo
     (it holds no key). Close this administrator window straight away.

### 26e — The office screens ask for the person's own PIN (OB-259)

The till PC also serves the office screens (the manager's day, the migration screen, the owner's screen). Each of them
now asks **"Enter your PIN" / "உங்கள் PIN-ஐ உள்ளிடுங்கள்"** before it opens: the person's staff ID and their own till
PIN. Only you, the store manager and the accountant(s) can open them; **a cashier's PIN opens the till only**. A
sign-in lasts 30 minutes; the **Sign out** button at the bottom right of every office page ends it at once.

1. Check it from the cashier's side: in the `Till` account, in Edge, change the word `pos` at the end of the till's
   address to `manager` and press Enter.
   - **When it worked:** the page says **Enter your PIN** in English and Tamil. Type a **cashier's** staff ID and PIN:
     it says **This PIN opens the till only.** Then open the till favourite again. **Send:** a photo of the refusal.
2. In your own account, open the same address and sign in with **your** staff ID and PIN: the manager's screen opens,
   with your name and **Sign out** at the bottom right. Press **Sign out**.

## Part 27 — The UPS and the power-cut test (OB-250 · OB-260)

You told us the shop has **three Numeric Onfinity 6 kVA UPS units**, with a **diesel generator** behind them (OB-260).
The system does not rely on the generator; it relies on the UPS keeping this PC on until it can shut down cleanly.

1. **Wire this PC, its screen and the internet router to a UPS** (one of the three), not to a wall socket (OB-260). A
   sale never needs the router (everything the till uses is on this PC), but with the router on the UPS the shop's
   network stays up through a short cut too. **Send:** a photo of the plugs at the UPS, and tell me what else is plugged into it.
2. **The power-cut test**, at a quiet time with no customer at the counter, with the till open and practice data only:
   - Pull the **UPS's own plug out of the wall** (not the PC's plug out of the UPS). The UPS beeps; the PC stays on.
   - Ring one practice sale on the till. **When it worked:** it completes and its bill number appears, on battery.
   - Then shut down cleanly, still on battery: right-click Docker's whale icon by the clock → **Quit Docker Desktop**,
     wait until the icon goes; then **Start → Power → Shut down**. Write down how many minutes it was on battery.
   - Plug the UPS back into the wall. Switch the PC on and sign in; the system and the till start by themselves
     (Part 14). **When it worked:** the till opens, and the practice sale you rang on battery is still there.
   - **Send:** photos of the till before and after, and the minutes on battery.
3. If the PC switched off by itself when the plug came out, stop: the UPS is not protecting it. Send what happened.

## Part 28 — Automatic backups, and your own daily copy (OB-249 · OB-262)

You decided: an automatic, encrypted backup **every hour**, of everything (the database, the till's saved sales and the
settings), onto a second USB drive that **stays plugged in**; and once a day you plug in **your own** drive, take a copy,
and keep it. **Nothing is ever deleted** — every backup is kept (OB-262).

1. Plug in the drive that will stay in this PC and find its letter (Part 8, step 1). `F:` below stands for it.
   ```
   pnpm run store-computer -- schedule-backup --to F:\sre-auto --every 60
   ```
   - **When it worked:** `AUTOMATIC BACKUP ON — every 60 minutes to F:\sre-auto, encrypted to backup key …, while you are
     signed in to Windows.`, the names of two Windows tasks, then `Taking the first backup now…` and `BACKUP DONE —`.
     It uses the backup key you made in Part 8 and never asks for the passphrase (a backup only needs the sealed key;
     opening one needs the passphrase).
   - If it says `Access is denied`, it says the one thing to do on the next line.
   - Then prove that first backup restores: the line it printed after `Next:` (a `restore-check`).
2. Every morning, check it:
   ```
   pnpm run store-computer -- backup-status
   ```
   - It shows the backup key, `Automatic: every 60 minutes to F:\sre-auto`, `Last good:` with how long ago, and **what
     is on the drive: how many backups, how much space they use, how much is free, and about how many more days fit**.
   - **When it worked:** the last line says `OK — the last good backup is less than 2 hours old.`
   - **Because nothing is ever deleted, the drive slowly fills** (OB-262). `backup-status` shows, every morning, how
     many backups are kept, the space they use, the space left and **about how many more days fit** at the current
     rate (the newest backup's size, times the backups a day). Write the days-left number in the workbook each Monday.
   - **Under 30 days left, it turns RED** (OB-268): `backup-status` ends with `RED — the backup drive has room for about
     … more day(s)`, `status` shows `RED  Drive room`, and the office screens show the red banner "The backup drive has
     room for about … more day(s) of backups". Then decide what to keep, or plug in a bigger drive; bring the drive to
     me if you want help. The tool never deletes a backup by itself.
   - Before the first backup, or when the drive cannot be read, the room left says **NOT KNOWN** (and `status` shows
     `?  Drive room`). That is the truth, not a number: plug the drive in and let the first backup run.
   - If the drive does fill, the backups stop, and within two hours `status` and the red banner on the office screens
     say the last backup is too old.
   - A `RED —` line: plug the drive in, then send a photo.
3. **Your own daily copy**, at closing: plug in **your own** drive and type
   `pnpm run store-computer -- backup --to E:\sre-real` (Part 8, step 2). Then unplug it and take it with you.
4. To stop the hourly backup (only if told to): `pnpm run store-computer -- unschedule-backup`. Every backup already on
   the drives is kept, and the office screen turns red after two hours with no backup — on purpose.

## Part 29 — Installing a new version (update)

Never replace or delete `C:\SRE` by hand. Each new version goes into **its own folder** beside the old one; the shop's
data stays in `C:\SRE-data`; and the file `C:\SRE-data\run\current-release.json` says which folder is the live one — the
Windows tasks follow it by themselves.

1. Do it only when the shop is closed (it rebuilds the system, Part 12). Plug in the backup drive that stays in the PC.
2. Download the new version's ZIP (Part 3) and extract it to `C:\`. Rename the new folder with the month, for example
   `SRE-2026-11` — **never** `SRE`, and never inside another folder.
3. Open PowerShell in the **current** live folder (the first time: `C:\SRE`) and type:
   ```
   pnpm run store-computer -- update --from C:\SRE-2026-11
   ```
   - It takes a backup first (to the drive that stays in), stops the till, installs and builds the new version (it needs
     the internet once, for its packages), starts it on the **same** data, makes it the live release and starts the
     till.
   - **When it worked:** `1.` … `BACKUP DONE`, `2.` the till stopped, `3.` installing, `READY — the new release runs on
     this copy's own database`, `4. TILL —`, then `UPDATED — the shop system now runs from C:\SRE-2026-11. The shop's
     data stayed in C:\SRE-data.`
   - If anything fails it says `NOT UPDATED —`, puts the old version back on the same data and starts the till again.
     Send a photo.
4. From now on open PowerShell in the **new** folder. Keep the old folder: it is now the **previous** release (the
   rollback drill's `--previous`, Part 11). Never delete the live or the previous release folder; only older ones.
5. Lock the new folder (Part 26c, step 1, first line, with the new folder's name), and run
   `pnpm run store-computer -- status`.

## Part 30 — The daily routine (mirror pilot)

In the mirror pilot the **old ERP bills every customer**, as today, and stays the legal GST record. A trained person
also rings the pilot department's lines on the new till. The customer never gets the new bill (OB-248). Guest sales
only: the new till takes no mobile number and no loyalty (OB-252). You are the daily reconciler and the incident owner
for the first two weeks (OB-254).

**The cashier sheets** (print the **English** sheets for the pilot, OB-261; the Tamil sheets are kept, marked not yet
checked by a Tamil reader):

| Sheet | English | Tamil |
|---|---|---|
| 1. PC down or new till stopped → old till only (OB-255) | `docs\sop\sop-01-pc-down.en.md` | `docs\sop\sop-01-pc-down.ta.md` |
| 2. Mirror keying for the pilot department (OB-248) | `docs\sop\sop-02-mirror-keying.en.md` | `docs\sop\sop-02-mirror-keying.ta.md` |
| 3. Owner's evening check (OB-254) | `docs\sop\sop-03-owner-evening-check.en.md` | `docs\sop\sop-03-owner-evening-check.ta.md` |
| 4. When a cashier forgets their PIN | `docs\sop\sop-04-forgotten-pin.en.md` | `docs\sop\sop-04-forgotten-pin.ta.md` |

**Morning, before opening (you):**
1. Switch the PC on if it is off, and sign in to **your** account. Docker, this copy and the till start by themselves
   (Part 14). Wait two minutes.
2. `pnpm run store-computer -- status` — read what it says. Anything other than `ALL OK`: send a photo before trading on
   the new till. The `Mirror` line must say `EDGE_MIRROR_PILOT=1, EDGE_GUEST_SALES_ONLY=1` (Part 14, step 2).
3. `pnpm run store-computer -- backup-status` — the last hourly backup is recent, and the drive has room.
4. Switch user to `Till` (Part 26b). Open the till favourite. The cashier signs in with their own staff ID and PIN.

**During the day (staff):** sheet 2 for every pilot-department line; sheet 1 if the new till stops. You lock your own
account when you leave the PC (**Windows key + L**), never sign out.

**Evening (you):**
1. The till's mirror sales need no cash-up: every one was "Paid on old system", with the old bill number (sheet 2,
   steps 5 to 7), so the new till's drawer holds no money from them.
2. Sheet 3: enter and sign the day on the migration screen (it asks for your PIN, Part 26e).
3. Your own daily copy (Part 28, step 3), then unplug your drive and take it with you.
4. If you switch the PC off at night, use the clean shutdown in Part 27, step 2.

## Part 31 — Real trading: after the pilot passes and your written GO only (OB-271)

**Do not do anything in this part during the mirror pilot.** It explains what is built and switched OFF, so nothing
surprises you later.

The new till can already do the three things real trading needs. All three are **off** while the mirror pilot runs:

1. **The legal GST bill.** The till's bill becomes the shop's tax invoice: the words "Tax Invoice", the shop's legal
   name, address and GSTIN, the bill number and date, each item's HSN code (6 digits, because the shop's turnover is
   ₹5–10 crore — OB-149), quantity, unit, value and GST rate, CGST and SGST, the place of supply (Tamil Nadu) and the
   total. If anything is missing, the till **refuses the sale** and says what is missing, so a wrong bill is never given.
   A bill with any item that has no GST is headed **"Invoice-cum-Bill of Supply"**, and that item shows "Exempt / nil"
   (OB-278). The bill's CGST and SGST are each rounded to the rupee (OB-279), but a bill is **never more than the
   items' MRP total**: if the rounding would make it more, a minus **Round off** line brings it back down, so a ₹105
   packet of dal is charged ₹105, never ₹106 (OB-285). A bill of ₹50,000 or more, or a business (B2B) bill, is refused with "bill this on the
   old system" (OB-280). Your CA confirms these four before the switch.
2. **The paper bill, in English or Tamil.** After each sale the cashier presses **Print bill**. The bill prints through
   the printer's own Windows driver on an 80 mm roll (58 mm also works). A second print says **DUPLICATE**. If the
   printer fails, the sale is still saved and the bill can be printed again (More → **Reprint the last bill**).
3. **Card and UPI approval numbers.** After the shop's own card machine or UPI says "approved", the cashier types the
   number from the machine's slip into one field, **Approval / Auth code / RRN** (never the card number). Any card
   machine and any bank works (OB-274). The day's list (More → **Card and UPI today**, and
   at **Close till**) shows each number, so you can tick it against the machine's settlement slip. A refund to a card
   is done on the machine, its reference typed, and a manager checks it with their own PIN.

**The switch.** Real trading is switched on by one setting on the store computer, `EDGE_REAL_TRADING=1`, or by the store
pack. The installer **never** writes it. The mirror pilot and real trading are **never on together**: a store computer
set for both refuses to start and says why. Today's install and the `status` check keep the mirror pilot on; the exact
switch-over steps are given to you **with** the real-trading GO, not before.

**Before that GO, these must be true** (each is a question we will ask you then):
- the shop's address for the bill is recorded with the store: type the Part 17 `shop` command again with
  `--place-of-business "<line 1 | line 2>"` added at the end (the `|` splits the lines, up to 4);
- every product the till sells has its real 6-digit (or 8-digit) HSN code in the price list;
- the bill printer is installed in Windows with its own driver (any receipt printer Windows can print to works —
  OB-274), it has printed a Windows test page in Tamil, and you have **set the paper width**: 80 mm (the default) or
  58 mm;
- your CA has confirmed the combined bill for items with no GST (OB-278), the rounding (OB-279) and that bills of
  ₹50,000 or more and business bills stay on the old system (OB-280).

---

## The gaps found while checking this guide, and how each was closed (20 Oct 2026)

Every command in this guide was checked against the scripts and `package.json`, and each one below has an automated
test. **None of it has run on real Windows yet.**

| Id | Gap | Closed by |
|---|---|---|
| W-1 | The installer refused the `--` the runbooks show after `till:install`. | The installer skips it (Parts 13, 20). |
| W-2 | `tenant:bootstrap` could not reach the database from the PC (`getaddrinfo ENOTFOUND db`). | It now uses this PC's own database port (Part 15). |
| W-3 | No way on this PC to record the shop, its GSTIN, the bill prefix, people's roles, or to publish the catalogue. | The owner setup commands, each person with their own PIN (OB-257, Parts 17–21, 24). |
| W-4 | `token:store` needs `--store`. | Not needed on this PC: the installer makes the store token itself (Part 20). |
| W-5 | The till's address, token and store had to be typed into `till.env` in Notepad. | The installer writes them, never showing them (Part 20). |
| W-6 | `pnpm run till:pin` did not load the till's settings. | It finds and loads `till.env` itself (Parts 16, 21). |
| W-7 | A cashier could type an office screen's address. | The office screens ask for the person's own PIN; a cashier's PIN opens only the till (OB-259, Part 26e). |
| W-8 | No way to seal the old ERP's export files. | `store-computer seal` (Part 22). |

**Still open** (each said where it is used): which day-end report the old ERP can give for the pilot department
(OB-263 — the evening check's bill-by-bill list is ready if it ends bill-wise); the names OB-243 still waits for (the
department, the cashier, the store manager); and the production sign-in (OA-4) — until then the PC lock (OB-251) and
each person's own PIN are what stand behind every name on the records.

---

## If a step fails

- **Red text, or `FAIL`, `NOT STARTED`, `NOT READY`, `NOT DONE`, `NOT ACCEPTED`, `NOT PASSED`, `NOT UPDATED`, `RED` or
  `REFUSED`:** stop. Do not try other commands. Send me a photo of the **whole PowerShell window**, so every line is
  readable.
- The tool always says the one thing to do on the line under the problem. If you did that thing and it still says the
  same, send the photo.
- **Never** send a photo of `.env.real` or `till.env`, never open them, never copy them anywhere, and never copy them
  to a file called `.env`. The same for a window that shows a till PIN (Parts 16, 21), the backup passphrase (Part 8),
  or the BitLocker recovery key (Part 26d).
- If Docker Desktop is closed, the system stops. Open Docker Desktop again and run `pnpm run store-computer -- up`.
- Before you send anything, check the photo shows only the blue window or a Windows screen.
