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

## Part 6 — The isolation check (pilot gate G4)

1. Type, with your own name in the quotes:
   ```
   pnpm run store-computer -- check --by "Your Name"
   ```
   - **When it worked:** it prints a table of ten checks, each `PASS`, `FAIL` or `NEEDS-YOU`, a line starting with
     `G4`, and `Record written: …`.
   - The first time, three checks say **NEEDS-YOU**. That is expected:
     - **check 3** says "not checked here: the demo's settings are not on this computer, which is itself the expected
       state". That is the honest answer on a computer that never held the demo's settings. How check 3 is signed off
       is a decision still to be made with you — just send the photo;
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

This part uses the existing backup script. It needs one more program, and it reads the database's address from the
settings file **inside PowerShell's memory only** — nothing is shown on the screen and nothing is saved.

1. **Install PostgreSQL's command-line tools** (the backup uses them): on **postgresql.org**, choose **Download →
   Windows**, and download the installer for version **16**. In the installer, on the **Select Components** page, untick
   everything except **Command Line Tools**. Finish the installer.
2. **Plug in your backup drive.** In File Explorer → **This PC**, find it (for example `Backup (E:)`). **The letter
   after its name is your drive letter.** Write it in the workbook. Everywhere below that says `E:`, type **your** letter
   instead.
3. Open PowerShell in `C:\SRE` (Part 4, step 1) and make an empty database for the restore test (first time
   `sre_real_restore_1`; the next time `sre_real_restore_2`, and so on — it must be a new, empty one each time):
   ```
   docker compose -p sre-real -f infra\compose\docker-compose.yml --env-file infra\compose\.env.real exec -T db createdb -U sre_admin sre_real_restore_1
   ```
   - **When it worked:** it prints nothing and comes back to `PS C:\SRE>`.
4. Type these four lines, one at a time. They tell PowerShell where the PostgreSQL tools are, and read the two database
   addresses into memory **without showing them**:
   ```
   $env:Path += ";C:\Program Files\PostgreSQL\16\bin"
   $s = Get-Content infra\compose\.env.real -Raw | ConvertFrom-StringData
   $env:DATABASE_URL = 'postgres' + '://' + $s.POSTGRES_USER + ':' + $s.POSTGRES_PASSWORD + '@localhost:5432/' + $s.POSTGRES_DB
   $env:RESTORE_TARGET_URL = 'postgres' + '://' + $s.POSTGRES_USER + ':' + $s.POSTGRES_PASSWORD + '@localhost:5432/sre_real_restore_1'
   ```
   - **When it worked:** each line comes back to `PS C:\SRE>` with nothing printed.
5. Take the backup onto your drive and prove it restores (type your drive letter instead of `E:`):
   ```
   node scripts\recovery-rehearsal.mjs --work C:\SRE-backups --offsite E:\sre-real
   ```
   - **When it worked:** near the end it says `outcome  restored_and_reconciled`, and the last line says
     `record   C:\SRE-backups/rehearsal-….json`. **Write that record's file name in the workbook.**
   - **Send:** a photo of the last lines.
6. **Close this PowerShell window** (the X at the top right). That wipes the addresses from memory.
7. Unplug the backup drive and put it away with the person who keeps it. It is plugged in only for each backup and each
   drill.

## Part 9 — The final G4 check

1. Unplug the internet again (Part 7, step 1). Open PowerShell in `C:\SRE` and type — your name, and the record file
   name from Part 8 step 5:
   ```
   pnpm run store-computer -- check --by "Your Name" --offline-confirmed --backup-record C:\SRE-backups\rehearsal-XXXX.json
   ```
   - **When it worked:** checks 5 and 10 say **PASS**. Check 3 still says NEEDS-YOU (see Part 6).
   - **Send:** a photo of the table and the `G4` line.
2. Plug the internet back in. Keep every record file: they are in `C:\SRE\infra\compose\records\`.

## Part 10 — The rollback drill (pilot gate G9): the dry run only, for now

The drill's real run cannot work on this Windows computer yet: it uses a release script that runs only on Linux and
needs a code copy made with git, and this computer has the ZIP instead. **Do not add `--run`.** (This is listed as gap
G-RD-6 in the store-computer runbook, for you to decide.) The dry run is safe: it changes nothing and only checks the
plan.

1. On github.com, open the repository's **commits** list. Copy the full id (40 letters and digits) of the newest commit
   and of the one before it.
2. Plug in your backup drive, open PowerShell in `C:\SRE`, and type (the two ids where shown, your drive letter instead
   of `E:`):
   ```
   node scripts\rollback-drill.mjs --previous <the older id> --current <the newer id> --project sre-real --work C:\SRE-drills --backup-drive E:\sre-real --settings infra\compose\.env.real
   ```
   - **When it worked:** it says `DRY RUN — nothing will change.` and lists four steps.
   - **Send:** a photo of the window. Then unplug the drive and put it away.

---

## If a step fails

- **Red text, or `FAIL`, `NOT STARTED`, `NOT READY` or `REFUSED`:** stop. Do not try other commands. Send me a photo of
  the **whole PowerShell window**, so every line is readable.
- The tool always says the one thing to do on the line under the problem. If you did that thing and it still says the
  same, send the photo.
- **Never** send a photo of `.env.real`, never open it, never copy it anywhere, and never copy it to a file called `.env`.
- If Docker Desktop is closed, the system stops. Open Docker Desktop again and run `pnpm run store-computer -- up`.
- Before you send anything, check the photo shows only the blue window or a Windows screen.
