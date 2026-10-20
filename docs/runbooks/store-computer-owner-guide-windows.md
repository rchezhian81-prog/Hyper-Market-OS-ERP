# Owner's guide — setting up the store computer yourself, on Windows (OB-240 · OB-244)

**Who this is for:** you, the owner. You do every step yourself, on the shop's Windows 10 or Windows 11 computer. You do
not need to be a programmer: you type what is in the grey boxes, exactly, and press Enter.
**What it does:** puts a second, sealed-off copy of the new system on that computer, for the shop's real data only. It
works with no internet and is never connected to the demo. Parts 1–11 set up and prove the copy; Parts 12–25 put the
till on this same PC, lock the PC, and give you the daily routine for the mirror pilot (OB-248).
**How long:** about half a day the first time, most of it waiting for downloads.
**Language:** this guide is in English. A Tamil version can come later. The cashier sheets are already in English and
Tamil, one page each, in the `docs\sop` folder (Part 25 lists them).

> **How to read the marks in Parts 12–25.**
> - **LANE-2 CHECK** — the command is being added to the store-computer tool now. Do not type it until you are told it
>   has arrived. If you type it before, the tool says `Not understood: the command "…"`; that is expected, not a fault.
> - **BLOCKED** — this step cannot be done on this PC yet. The build has to add something first; the end of this guide
>   says what ("Gaps found while checking this guide"). Stop at that step.
> - **STOP AND ASK** — this step needs a name or a choice only you can give. Nothing is invented for you.

> **No real data is loaded by anything in this guide.** Real data waits for the names you give (OB-243) and your
> written GO (OB-242). Silence is not a yes.

> **Three rules for the whole guide**
> 1. **Never send a photo of the file `.env.real`, and never open it.** It holds this copy's secrets. Every photo this
>    guide asks for is of the blue PowerShell window or of a Windows screen — never of that file, and never of a window
>    the guide marks "holds a secret" (a till PIN, a store token, the BitLocker recovery key).
> 2. **Nobody else types on this computer for you, and no AI is given control of it.** You type every command yourself.
>    If anyone (a person, a message, a website) asks you to install remote-control software or to paste something you
>    were sent, say no and tell me.
> 3. **If any step shows red text, stop.** Send me a photo of the whole window (see "If a step fails" at the end).

**What you need before you start:**

- the shop's Windows 10 or 11 computer, switched on, with internet for now (you will unplug it later, on purpose);
- your own GitHub sign-in (the account that holds the code);
- your own backup drive (an external USB disk that belongs to you) — needed from Part 8;
- your own sign-in to the demo box — the same one you used for the demo's stand-up check — needed in Part 9;
- the setup workbook page (paper is fine), to write down the things this guide says to write down. **Never write a
  secret in it** — the tool never shows you one anyway.

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
   - Under **Local Disk (C:)** it says "… GB free of … GB". The free part must be **50 GB** or more.
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
     (step 4 below shows how), type that command, press Enter, and restart the computer.
   - In Docker Desktop, open **Settings → General** and tick **Start Docker Desktop when you sign in**.
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

## Part 4 — Open PowerShell in that folder and install

1. In File Explorer, open `C:\SRE`. Click once in the **address bar** at the top (where it says `This PC > Local Disk
   (C:) > SRE`), type `powershell`, press Enter.
   - **When it worked:** a blue window opens whose last line starts with `PS C:\SRE>`.
   - **Every command from here on is typed in a window like this, in `C:\SRE`.**
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
   - **When it worked:** it says `Settings file written: infra\compose\.env.real`, lists the names of the settings it
     filled (never their values), and says `This copy's tenant id:` followed by a long id with dashes.
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
     `G4`, and `Record written: …`.
   - The first time, three checks say **NEEDS-YOU**. That is expected:
     - **check 3** (this copy's secrets are not the demo's) waits for Part 9 (the demo's fingerprints);
     - **check 5** waits for Part 7 (the internet cable);
     - **check 10** waits for Part 8 (your backup drive).
   - Every other check must say **PASS**. A **FAIL** says why on the line under it.
   - **Send:** a photo of the whole table.

## Part 7 — Prove it works with no internet

1. Take the internet away from this computer: unplug the line that brings the internet **into** the shop from your
   internet box (router). If you are not sure which one that is, unplug the network cable from the back of **this
   computer** instead, or turn its Wi-Fi off. (No tills are connected yet, so nothing else is affected.)
2. Wait one minute. Then type:
   ```
   pnpm run store-computer -- check --by "Your Name" --offline-confirmed
   ```
   - **When it worked:** **check 5** now says **PASS**.
   - **Send:** a photo of the table.
3. Plug the internet back in.

## Part 8 — Your backup drive (check 10)

Nothing extra is installed for this: the backup runs **inside** this copy's own database box in Docker, and the file
goes straight onto your drive. Nothing on the computer is deleted, ever.

1. **Plug in your backup drive.** In File Explorer → **This PC**, find it (for example `Backup (E:)`). **The letter
   after its name is your drive letter.** Write it in the workbook. Everywhere below that says `E:`, type **your** letter
   instead.
2. Open PowerShell in `C:\SRE` (Part 4, step 1) and take the backup:
   ```
   pnpm run store-computer -- backup --to E:\sre-real
   ```
   - **When it worked:** it says `BACKUP DONE —` with the file's name, its size and how long it took, then a line
     `Manifest: E:\sre-real\sre-real-backup-….manifest.json`. **Write that manifest's file name in the workbook.**
   - It refuses, on purpose, a folder on `C:` or inside `C:\SRE`: a backup on the same computer is not a backup.
   - **Send:** a photo of the window. (It has no secret in it. The long line of letters and digits after "SHA-256" is
     the file's own fingerprint, not a password.)
3. Prove the backup really comes back. Type the line below with the manifest's name (tip: type
   `E:\sre-real\sre-real-backup-` and press the **Tab** key; PowerShell fills in the rest of the name):
   ```
   pnpm run store-computer -- restore-check --from E:\sre-real\sre-real-backup-XXXX.manifest.json
   ```
   - It copies the backup into a **new, empty, temporary** database inside the same Docker box (never into the real
     one), counts every table, compares the counts and the money with the manifest, writes the result onto your drive,
     and only then removes that temporary database.
   - **When it worked:** it says `restored_and_reconciled —` and `The scratch database … was removed after the record
     was written. sre_real was never touched.`
   - **If it says `NOT ACCEPTED`:** stop. Do not rely on that backup. Send a photo of the whole window.
   - **Send:** a photo of the window.
4. **Keep the drive plugged in** until Part 10 is done. Then unplug it and put it away with the person who keeps it.
   It is plugged in only for each backup and each drill.

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

1. Plug in your backup drive (if it is not still in), and unplug the internet again (Part 7, step 1). Open PowerShell in
   `C:\SRE` and type — your name, the demo's fingerprint file from Part 9 and the backup manifest from Part 8:
   ```
   pnpm run store-computer -- check --by "Your Name" --offline-confirmed --demo-fingerprints C:\SRE-demo-fingerprints\fingerprints-XXXX.json --backup-record E:\sre-real\sre-real-backup-XXXX.manifest.json
   ```
   - **When it worked:** all ten checks say **PASS**, and the line under the table says
     `G4 PASSED — all ten isolation checks pass.`
   - Check 10 passes only when that backup has passed its restore-check (Part 8, step 3) and is on your drive.
   - **Send:** a photo of the table and the `G4` line.
2. Plug the internet back in. Keep every record file: they are in `C:\SRE\infra\compose\records\`.

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
     and no settings file: the drill uses this copy's own settings.
   - If the drill later says "the same release", go one more commit down the list and do this step again.
2. Plug in your backup drive. Open PowerShell in `C:\SRE` and do the **dry run** (it changes nothing):
   ```
   pnpm run store-computer -- drill --by "Your Name" --to E:\sre-real --previous C:\SRE-previous
   ```
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
   (Part 19 onwards), press **Ctrl + Shift + Esc** → **Performance** → **Memory**. **Send:** one photo of that screen
   (it shows "In use" and "Committed"), and one of **Processes** with the **Memory** column clicked so the biggest is at
   the top. We decide about more memory from that photo: only if "In use" stays above about 6.5 GB, and nothing is
   bought without your OK.

> **Rebuilds use a lot of memory.** The first `up`, every rollback drill (Part 11) and every update (Part 24) rebuild
> the system. Do them only when the shop is closed.

## Part 13 — Install the till on this same PC (one lane)

In the pilot, **this PC is the till**: it stands at the pilot counter, with the scanner plugged into it, and runs one
lane. The till part runs on Windows itself (a black window), not inside Docker, because only a program on this PC can
reach the till's private save socket. No network is used for a sale.

1. Open PowerShell in `C:\SRE` (Part 4, step 1). Type — **with no `--` after `till:install`** (with it, the installer
   refuses):
   ```
   pnpm run till:install --lane lane-1 --settings infra\compose\.env.real
   ```
   It takes a few minutes (it builds the till screen, the office screens and the till's own program).
   - **When it worked:** it ends with `Till installed.`, a line `Settings:` naming `C:\SRE\till\till.env`, a line
     `Start script:` naming `C:\SRE\till\start-till.cmd`, and a list under `Next:`.
   - It also says `no cloud URL set — the till starts OFFLINE-FIRST`. That is expected for now: the till sells and
     saves every sale on this PC, and sends nothing yet (Part 17 turns sending on).
   - If it says `The till cannot be installed yet —` it lists every problem at once. Send a photo.
   - **Write in the workbook:** "till installed, lane-1" and the date. **Send:** a photo of the window.
2. `till.env` holds this till's keys. **Never open it, never photograph it, never copy it** — the same rule as
   `.env.real`.

**LANE-2 CHECK — move the data out of the release folder.** Today the till's saved sales and this copy's settings sit
inside `C:\SRE`. Replacing that folder with a new version would delete them. Once lane 2's command arrives, the data
moves to `C:\SRE-data`, where an update never touches it:
```
pnpm run store-computer -- migrate-data-folder
```
- **When it worked:** to be written from the tool's own words once it arrives. Until then: do not move, rename or
  delete anything in `C:\SRE` by hand.

## Part 14 — Start the till and open it

1. In File Explorer, open `C:\SRE\till` and **double-click `start-till.cmd`**. A black window opens.
   - **When it worked:** among its lines are `lane socket on` … `loopback only` and `screens on` … `loopback only`, and
     `this box is lane lane-1`. **Leave this window open** while the shop trades: it **is** the till. Minimise it;
     never close it during trading.
   - **Send:** a photo of the black window.
2. Open **Microsoft Edge** on this PC. In the address bar, type the till address the installer printed in Part 13
   under `Next:` step 2 ("Open the till in a browser on THIS PC"). Press Enter.
   - **When it worked:** the till's Sale screen opens. Make it a favourite (the star in the address bar), so nobody
     has to type the address again.
   - Until the shop's products reach the till (Part 20), it says it has no price list. That is the truth, not a fault.
3. **LANE-2 CHECK — start the till by itself after a restart.** Once lane 2's command arrives, the till starts on its
   own after a power cut or a Windows update, as soon as you sign in:
   ```
   pnpm run store-computer -- autostart
   ```
   - **When it worked:** to be written from the tool's own words once it arrives. Until then, double-click
     `start-till.cmd` after every restart.
4. While you are here, stop the PC sleeping: **Settings → System → Power & battery → Screen and sleep** → set every
   "put my device to sleep" box to **Never**. And **Settings → Windows Update → Advanced options → Active hours** →
   set them to cover the shop's opening hours, so Windows never restarts itself while you trade.

## Part 15 — The shop's name, GSTIN and bill prefix at head office

The new system must know the shop's **legal name**, its **GSTIN** (the 15-character number on your GST registration
certificate) and the **bill prefix** the till numbers its bills under (`in-store-install.md` Step 5b: head office
issues each till its prefix). In the mirror pilot the new bill is never given to a customer (OB-248), but the prefix
still keeps every bill number unique.

1. **Write in the workbook now:** the legal name exactly as on the GST certificate, the GSTIN, and the bill prefix you
   want for this till. None of these is a secret. **STOP AND ASK** if you are not sure which prefix to use.
2. **BLOCKED (gap W-3):** there is no screen or command on this PC yet to record them. Head office's setup screens are
   not started on this PC, and nothing here signs you in to them. Stop here until the build adds the way.

## Part 16 — The owner and the accountant: the first two people (tenant:bootstrap)

The first people in the new system are laid down once, by this command. Every later person is added under the
two-person rule (one asks, another approves).

**STOP AND ASK.** This step needs two things only you can give, in writing:
- **your own login name** for the new system (a short name, for example your first name; never a shared login);
- **who the accountant is and which role they get:** the shop's accountant (role `accountant`), your chartered
  accountant (role `chartered_accountant`), or both — each with their own login name.
Nobody may invent these (OB-243). Do not type the command below until you have written them down.

1. With the names written down, first the **dry run** (it changes nothing). Your tenant id is the one you wrote in the
   workbook in Part 5. Type it as one line, putting in your own values:
   ```
   pnpm run tenant:bootstrap -- --tenant <tenant id> --owner <your login> --admin <their login>:<their role> --operator "Your Name" --env-file infra\compose\.env.real --dry-run
   ```
   - **When it worked:** it lists each person and their role, then `DRY RUN — nothing was written.`
   - Read the list. If anything is wrong, fix the line and run the dry run again.
   - **Send:** a photo of the window.
2. The real run is the same line **without** `--dry-run`.
   - **BLOCKED (gap W-2):** on this PC the real run cannot reach the database yet. It would say
     `Could not write to the ledger: getaddrinfo ENOTFOUND db`. Nothing is written when that happens. Stop after the
     dry run until the build fixes it.
   - **When it works (after the fix):** `SEEDED — 2 grant(s) recorded in one atomic append.` (or 3, with three
     people). It refuses, on purpose, a second run: `NOT CHANGED — … already holds grants`.

## Part 17 — The store token: let the till send its sales to this copy's books

So far the till sells and keeps every sale on this PC. To send the sales to this copy's books (for the evening check),
the till needs a **store token**: a long secret that says "this till belongs to this shop and this store".

1. **BLOCKED (gap W-4):** the token must name the store (`--store`), and the store exists only after Part 15. The
   `store-edge` login it names must also hold the cashier role, which needs head office's people screen (gap W-3).
2. When those are done, the command is (one line, your own values):
   ```
   pnpm run token:store -- --tenant <tenant id> --user store-edge --store <store id> --ttl-hours 720 --settings infra\compose\.env.real
   ```
   - It prints the token **once**. **This window holds a secret: never photograph it, never copy it into a message.**
   - The token lasts 30 days (720 hours). Write the date it was made in the workbook; it must be made again before then.
3. **BLOCKED (gap W-5):** the token, the store and this copy's address must then go into the till's settings file.
   Doing that today means opening `till.env` in Notepad, which shows its keys on the screen. Stop here until the build
   gives a command that does it without showing anything.

## Part 18 — Staff and their till PINs

Every cashier signs in at the till with their own staff ID and their own six-digit PIN. **No shared logins.**

**STOP AND ASK.** The pilot cashier(s) and the manager are not named yet (OB-243, OB-254). Each needs:
1. **a staff ID and a role at head office** (Cashier, or Store manager) — **BLOCKED (gap W-3)**: no screen on this PC
   yet;
2. **a till PIN made on this PC.** This part works today. In **your own** Windows account (never the cashier's), open
   PowerShell in `C:\SRE` and type, with their staff ID and your name:
   ```
   C:\SRE\till\start-till.cmd till-pin --user <their staff id> --by "Your Name"
   ```
   - It prints the six-digit PIN **once**, then `Press any key to continue`. **This window holds a secret: never
     photograph it.** Tell the person their PIN face to face. Do not write it down for them, do not send it by phone.
   - The PIN is not kept anywhere. If it is forgotten, you make a new one the same way (sheet 4, `docs\sop`).
   - Someone leaves, or a PIN may be known to someone else: the same line with `--revoke` at the end.
3. You and the accountant need a till PIN too (for approvals and reopening a closed day). Make them the same way.

**LANE-2 CHECK:** after Part 13's `migrate-data-folder`, the start script may live under `C:\SRE-data`. Use the path
the tool names.

## Part 19 — The pilot department: only after your written GO

**Nothing real is loaded before your written GO (OB-242).** The first load is one department's products, barcodes, tax
classes and prices (OB-241); the department is not named yet (OB-243). **STOP AND ASK.**

When the GO is written and the department is named:
1. On the migration screen ("The figures" → "Templates for the first department") download the four templates and
   fill them from the old ERP's export, into one folder, for example `C:\SRE-slice`. The folder's `slice.json` needs
   each file's seal — **BLOCKED (gap W-8)**: there is no screen or command for sealing yet.
2. Then three commands, by two different people (the person who loads can never sign the totals):
   ```
   pnpm run migration:slice -- --dir C:\SRE-slice --stage --settings infra\compose\.env.real
   pnpm run migration:slice -- --dir C:\SRE-slice --accept --as <their login> --statement "<what they read and decided>" --settings infra\compose\.env.real
   pnpm run migration:slice -- --dir C:\SRE-slice --apply --settings infra\compose\.env.real --out C:\SRE-slice\outcome-1.json
   ```
   - **When it worked:** `RECORDED —`, then `ACCEPTED —`, then `APPLIED — every staged row landed`.
   - Any `REFUSED` line: stop and send a photo. `docs\runbooks\real-data-load.md` explains each message.

## Part 20 — The products reach the till (the catalogue pack)

After the department is loaded, head office **publishes** a signed price list (the catalogue pack), and the till
pulls it the next time it reaches this copy's books.

1. **BLOCKED (gap W-3):** publishing needs head office's catalogue screen, which is not on this PC yet. The till can
   pull the pack only once Part 17 is done.
2. **When it works:** the till window says the catalogue pack was updated, and the till's Sale screen stops saying it
   has no price list. Scan three products from the pilot department and check each name and price against the old
   ERP. **Send:** a photo of the till screen with the three lines.

## Part 21 — Lock the PC (OB-251)

You decided: only you hold this PC's administrator account, the disk is encrypted, and cashiers get their own standard
Windows account that opens only the till. Do this part **before** any real data.

### 21a — You keep the only administrator account

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

### 21b — A separate standard account for the cashiers

1. **Settings → Accounts → Other users → Add account.** Choose **I don't have this person's sign-in information**,
   then **Add a user without a Microsoft account**.
2. Name it `Till` (one account for the counter's Windows screen only — each cashier still signs in **at the till**
   with their own staff ID and PIN, so every sale names who rang it). Give it a password the cashiers will use, and
   the three security questions.
3. Back in **Other users**, click the new account → **Change account type** → it must say **Standard User**. Never
   Administrator.
4. **How the day works with two accounts:** you sign in first (Docker Desktop and the till window start in **your**
   account). Then press **Windows key + L**, or **Start → your name → switch user**, and sign in as `Till`. Your
   programs keep running. **Never "Sign out" of your own account while the shop trades**: that stops Docker and the
   till. In the `Till` account, open only Microsoft Edge with the till favourite (Part 14, step 2).
5. **Optional — kiosk mode (Windows 11 Pro "assigned access").** Windows can lock an account so it opens only one
   program (Settings → Accounts → Other users → **Set up a kiosk**). For a browser till it can lock Microsoft Edge to
   one address. Honest notes before you try it: it creates **its own** new account (not `Till`) and signs it in by
   itself after a restart; Edge in kiosk mode runs as a private window and can restart itself after a quiet spell,
   which would clear a basket that is half rung up (saved sales are safe: they are on the PC's disk, not in the
   browser); and it has never been tried with this till. It would stop a cashier opening other screens (gap W-7). Try
   it only in a practice hour, and only keep it if a full practice day works. Send photos of each screen if you try it.

### 21c — Cashiers cannot open the settings files (folder permissions)

`.env.real` and `till.env` hold this copy's keys. Windows lets every account on the PC read `C:\SRE` unless told
otherwise, so this step removes every account except you, Windows itself (SYSTEM) and administrators.

1. In **your own** account, open PowerShell (no need to be in `C:\SRE`) and type as **one** line:
   ```
   icacls C:\SRE /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
   ```
   - It may take a minute (there are many files). **When it worked:** `Successfully processed 1 files; Failed
     processing 0 files`.
2. Check it on the settings file itself:
   ```
   icacls C:\SRE\infra\compose\.env.real
   ```
   - **When it worked:** exactly three lines with `(I)(F)`: your PC's name and your account, `NT AUTHORITY\SYSTEM` and
     `BUILTIN\Administrators`. **Send:** a photo (it shows names of accounts only, never what is in the file).
   - **If you also see `BUILTIN\Users` or `NT AUTHORITY\Authenticated Users`:** the lock did not reach that file. Stop
     and send the photo.
3. Check from the cashier's side: switch to the `Till` account, open File Explorer and double-click `C:\SRE`.
   - **When it worked:** Windows says **You don't currently have permission to access this folder**. Click
     **Cancel** — never **Continue**, and never type your own password in the `Till` account.
4. **LANE-2 CHECK:** after Part 13's `migrate-data-folder`, run the same two commands for `C:\SRE-data` (put
   `C:\SRE-data` where step 1 says `C:\SRE`; in step 2 check a file the tool names), unless the tool says it already
   locked that folder.

### 21d — Encrypt the disk (BitLocker)

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
   - Put the paper in a sealed envelope and keep it **away from this PC**: at home, or in your locker. Write in the
     workbook where it is (not the key itself).
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

## Part 22 — The UPS and the power-cut test (OB-250)

You told us a UPS already powers this PC.

1. **Send:** a photo of the UPS's label (it shows the model and the VA or W number), and tell me how long it runs this
   PC on battery, if you know (the box or manual says). Also tell me what else is plugged into it (screen, internet
   box, printer).
2. **The power-cut test**, at a quiet time with no customer at the counter, with the till open and practice data only:
   - Pull the **UPS's own plug out of the wall** (not the PC's plug out of the UPS). The UPS beeps; the PC stays on.
   - Ring one practice sale on the till. **When it worked:** it completes and its bill number appears, on battery.
   - Then shut down cleanly, still on battery: in the black till window press **Ctrl + C** and answer `Y`; right-click
     Docker's whale icon by the clock → **Quit Docker Desktop**, wait until the icon goes; then **Start → Power → Shut
     down**. Write down how many minutes it was on battery.
   - Plug the UPS back into the wall. Switch the PC on, sign in, wait for Docker's **Engine running**, start the till
     (Part 14). **When it worked:** the till opens, and the practice sale you rang on battery is still there.
   - **Send:** photos of the till before and after, and the minutes on battery.
3. If the PC switched off by itself when the plug came out, stop: the UPS is not protecting it. Send what happened.

## Part 23 — Automatic backups (OB-249)

You decided: an automatic backup **every hour**, of everything (the database and the till's own saved sales),
encrypted, onto a second USB drive that **stays plugged in**; and once a day you plug in **your own** drive, take a
copy, and keep it.

**LANE-2 CHECK — the hourly backup.** Once lane 2's commands arrive (`F:` stands for the letter of the drive that
stays plugged in; use yours):
```
pnpm run store-computer -- schedule-backup --to F:\sre-hourly --every 60
pnpm run store-computer -- backup-status
```
- **When it worked:** to be written from the tool's own words once it arrives. `backup-status` must say when the last
  hourly backup was made; a backup older than an hour or two is a problem to send a photo of.
- To stop the hourly backup (only if told to): `pnpm run store-computer -- unschedule-backup`.

**Your own daily copy** works today: plug in your drive and type `pnpm run store-computer -- backup --to E:\sre-real`
(Part 8). Today it copies the database only; **LANE-2 CHECK:** once lane 2's change arrives it also copies the till's
saved sales.

## Part 24 — Installing a new version (update)

**LANE-2 CHECK.** Never replace or delete `C:\SRE` by hand: today that would delete the till's saved sales and this
copy's settings. Once lane 2's command arrives, a new version is downloaded as a ZIP (Part 3), extracted beside the old
one (for example `C:\SRE-new`), and installed with:
```
pnpm run store-computer -- update --from C:\SRE-new
```
- Do it only when the shop is closed (it rebuilds the system, Part 12).
- **When it worked:** to be written from the tool's own words once it arrives.

## Part 25 — The daily routine (mirror pilot)

In the mirror pilot the **old ERP bills every customer**, as today, and stays the legal GST record. A trained person
also rings the pilot department's lines on the new till. The customer never gets the new bill (OB-248). Guest sales
only: the new till takes no mobile number and no loyalty (OB-252). You are the daily reconciler and the incident owner
for the first two weeks (OB-254).

**The cashier sheets** (print each in English and Tamil, and keep them at the counter):

| Sheet | English | Tamil |
|---|---|---|
| 1. PC down or new till stopped → old till only (OB-255) | `docs\sop\sop-01-pc-down.en.md` | `docs\sop\sop-01-pc-down.ta.md` |
| 2. Mirror keying for the pilot department (OB-248) | `docs\sop\sop-02-mirror-keying.en.md` | `docs\sop\sop-02-mirror-keying.ta.md` |
| 3. Owner's evening check (OB-254) | `docs\sop\sop-03-owner-evening-check.en.md` | `docs\sop\sop-03-owner-evening-check.ta.md` |
| 4. When a cashier forgets their PIN | `docs\sop\sop-04-forgotten-pin.en.md` | `docs\sop\sop-04-forgotten-pin.ta.md` |

**Morning, before opening (you):**
1. Switch the PC on if it is off, and sign in to **your** account. Wait for Docker's **Engine running**.
2. Start the till (Part 14) — **LANE-2 CHECK:** after `autostart` it starts by itself; check the black window is there.
3. **LANE-2 CHECK:** `pnpm run store-computer -- status` — read what it says. Anything other than all well: send a
   photo before trading on the new till.
4. **LANE-2 CHECK:** `pnpm run store-computer -- backup-status` — the last hourly backup is recent.
5. Switch user to `Till` (Part 21b). Open the till favourite. The cashier signs in with their own staff ID and PIN.

**During the day (staff):** sheet 2 for every pilot-department line; sheet 1 if the new till stops. You lock your own
account when you leave the PC (**Windows key + L**), never sign out.

**Evening (you):**
1. The till's cash-up and day close: **waiting for lane 1** (sheet 2 has the marked place).
2. Sheet 3: enter and sign the day on the migration screen.
3. Your own daily copy (Part 23), then unplug your drive and take it with you.
4. If you switch the PC off at night, use the clean shutdown in Part 22, step 2.

---

## Gaps found while checking this guide (20 Oct 2026)

Every command in Parts 12–25 was checked against the scripts and `package.json`. **None of it has run on real Windows.**
These are the places the guide has to stop:

| Id | Gap | Where it stops | What would close it |
|---|---|---|---|
| W-1 | The installer, typed with a `--` after `till:install`, is refused: `Unknown option(s): --`. pnpm 10 passes the `--` on and the installer does not skip it. Without the `--` it works (Part 13 uses that). `in-store-install.md` and the real-data runbook show the form with `--`. The installer's usage line also leaves out `--lane`. | Nowhere, with Part 13's form | Let the installer skip a leading `--` (S) |
| W-2 | `tenant:bootstrap` reads `DATABASE_URL` from `.env.real`, which names the database by its Docker name `db`. From the PC that name does not exist: `Could not write to the ledger: getaddrinfo ENOTFOUND db` (reproduced). The dry run works. | Part 16 step 2 | Translate `db` to this PC's own database port, as the demo smoke already does (S) |
| W-3 | No screen or command on this PC for head office's own acts: create the store, record the legal name and GSTIN, issue the till's bill prefix, give people their logins and roles (two-person), give the `store-edge` login its role, publish the catalogue pack, write the parallel-run terms. `store-computer up` starts only the database, the schema check and the API; nothing signs a person in to head office's screens here. | Parts 15, 17, 18, 20; sheet 3 | Owner choice (see the build session's report) (M) |
| W-4 | `token:store` needs `--store <store id>` (OB-54); both runbooks leave it out. The store id exists only after W-3. | Part 17 | W-3, then the runbooks corrected (S) |
| W-5 | The till's settings need this copy's address, the token, the store id and "take the store setup from head office". The installer leaves the address and token blank and has no option for the other two, so today they are typed into `till.env` in Notepad, with its keys on screen. | Part 17 step 3 | A command that writes them without showing anything (S) |
| W-6 | `pnpm run till:pin` runs the till program without loading `till.env`, so it cannot find the till's data. Part 18 uses `start-till.cmd till-pin`, which loads it. | Nowhere | Point the package script at the settings, or drop it (S) |
| W-7 | The office screens are served by the till window on this PC to **every** Windows account, and on this copy they act as the person the store setup names for each screen, with no sign-in. A cashier in the `Till` account could type an office screen's address. | Part 21b ("opens only the till") | Kiosk mode (21b step 5, untested), or a sign-in on those screens (M) |
| W-8 | Sealing the old ERP's export files (MG-02) has no screen or command (audit row 8). | Part 19 step 1 | A seal screen or command (S–M) |

---

## If a step fails

- **Red text, or `FAIL`, `NOT STARTED`, `NOT READY`, `NOT DONE`, `NOT ACCEPTED`, `NOT PASSED` or `REFUSED`:** stop. Do not try other commands. Send me a photo of
  the **whole PowerShell window**, so every line is readable.
- The tool always says the one thing to do on the line under the problem. If you did that thing and it still says the
  same, send the photo.
- **Never** send a photo of `.env.real`, never open it, never copy it anywhere, and never copy it to a file called `.env`.
  The same for `till.env`, for a window that shows a till PIN (Part 18), a store token (Part 17), or the BitLocker
  recovery key (Part 21d).
- If Docker Desktop is closed, the system stops. Open Docker Desktop again and run `pnpm run store-computer -- up`.
- Before you send anything, check the photo shows only the blue window or a Windows screen.
