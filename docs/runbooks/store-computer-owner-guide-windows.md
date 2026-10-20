# Owner's guide — setting up the store computer yourself, on Windows (OB-240 · OB-244)

**Who this is for:** you, the owner. You do every step yourself, on the shop's Windows 10 or Windows 11 computer. You do
not need to be a programmer: you type what is in the grey boxes, exactly, and press Enter.
**What it does:** puts a second, sealed-off copy of the new system on that computer, for the shop's real data only. It
works with no internet and is never connected to the demo.
**How long:** about half a day the first time, most of it waiting for downloads.
**Language:** this guide is in English. A Tamil version can come later.

> **No real data is loaded by anything in this guide.** Real data waits for the names you give (OB-243) and your
> written GO (OB-242). Silence is not a yes.

> **Three rules for the whole guide**
> 1. **Never send a photo of the file `.env.real`, and never open it.** It holds this copy's secrets. Every photo this
>    guide asks for is of the blue PowerShell window or of a Windows screen — never of that file.
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

## If a step fails

- **Red text, or `FAIL`, `NOT STARTED`, `NOT READY`, `NOT DONE`, `NOT ACCEPTED`, `NOT PASSED` or `REFUSED`:** stop. Do not try other commands. Send me a photo of
  the **whole PowerShell window**, so every line is readable.
- The tool always says the one thing to do on the line under the problem. If you did that thing and it still says the
  same, send the photo.
- **Never** send a photo of `.env.real`, never open it, never copy it anywhere, and never copy it to a file called `.env`.
- If Docker Desktop is closed, the system stops. Open Docker Desktop again and run `pnpm run store-computer -- up`.
- Before you send anything, check the photo shows only the blue window or a Windows screen.
