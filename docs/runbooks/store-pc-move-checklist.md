# Store PC checklist — moving the shop onto the setup program (CR-01 step 2, OI-08)

_For the owner, on the store PC (DESKTOP-RTMAULK). Plain steps; nothing is typed into a command window. About 20 minutes.
Do it at a quiet time, outside trading hours. Have your phone ready to take photos._

**What it does:** the setup program moves the shop from Docker into three Windows programs ("services") that Windows starts
by itself. It keeps every record, setting, person and PIN. If anything does not match, it puts everything back as it was.
Docker's own copy is never deleted.

## Before you start

**Pre-flight (from the gap audit of 13 November 2026) — all five, every time:**
- Use the newest release from **13 November 2026 or later** (Releases → newest "Store PC 1.0.…"), and delete older
  SRE-Setup.exe files from Downloads.
- **Docker Desktop open, saying "Engine running"** — without it the setup now refuses and changes nothing.
- **Close the Services window and Task Manager.** If they are open, Windows can keep a removed service "marked for
  deletion" and the new one cannot be made.
- **Do not delete or move the November release folder** (e.g. `C:\SRE-2026-11c`): Docker's copy was made from it.
- **No sales on SRE Till** until I confirm the move (use the old billing system meanwhile).

1. **Check the last backup is recent.** Open any office page and look at the banner at the top: it must not be red
   (a red banner names what is wrong, for example an old backup). If it is red, stop and send me a photo.
2. **Open Docker Desktop** from the Start menu and wait until it says **Engine running**. It is needed one last time,
   to take the data out. **Do not delete or move the folder you first set the shop up from** (the release folder from
   November, e.g. `C:\SRE-2026-11`): Docker's copy was made from it and the move uses its files.
3. **Download the setup program.** Easiest: on GitHub, **Code** → **Releases** (right side) → the newest **Store PC 1.0.…** →
   under **Assets** click **SRE-Setup.exe**. (Or: **Actions** → the newest green row marked **main** → scroll to
   **Artifacts** → **store-pc-setup** → download, open the zip.) Save **SRE-Setup.exe** on the Desktop. Use a release made
   on or after 10 November 2026: older ones cannot open the setup screens on this PC (see "If something goes wrong").

## Run it

4. Double-click **SRE-Setup.exe**. Windows shows a blue box "Windows protected your PC" (no certificate yet, OB-714):
   click **More info**, then **Run anyway**. Click **Yes** when Windows asks to allow changes.
   (If instead a box says **"Smart App Control blocked an app"**, there is no "Run anyway": Smart App Control must be turned
   off first — Start → **Windows Security** → **App & browser control** → **Smart App Control settings** → **Off**. It
   cannot be turned back on without reinstalling Windows; Microsoft Defender keeps protecting the PC. Done on DESKTOP-RTMAULK
   on 9 November 2026.)
5. Click **Next / Install** through the setup screens. At the end your browser opens the **first-run screen**, and a
   shortcut **Finish SRE setup** appears on the desktop. If no browser comes up, double-click that shortcut. It must say
   **"This PC is already set up"** with your tenant id and `D:\SRE-data`. Check the tenant id is the one in your workbook.
   If it asks for a shop's name and GSTIN instead, **stop** and send me a photo.
6. Click **Finish setup**. Lines appear as it works. Wait for **MATCHED**, then **MOVED**, then **SETUP DONE**
   (a few minutes). Take a photo of the screen at the end.
   - If you see **PUTTING THE SHOP BACK AS IT WAS**: nothing is lost. Take a photo, restart the computer, and send me the photo.
7. **Shortcuts:** tick **Till**, **Office** and **Import & export**, then click **Put them on the desktop**.

## Check it

8. Press the **Windows key**, type **Services**, press **Enter**, click the **Name** column. Under **S** you should see
   three rows starting **SRE Retail OS**, each **Running** and **Automatic**. Photo.
9. Double-click **SRE Till** on the desktop. Sign in with your staff ID and your own PIN, exactly as before.
10. Open **http://127.0.0.1:8091/about/** in the browser. It shows your tenant id (the same as the workbook) and the release.
11. **Restart the computer.** Without signing in, wait two minutes, then sign in and open **SRE Till** again: it works
    straight away. Windows started everything by itself — Docker Desktop is no longer needed.
12. Send me the photos from steps 6 and 8.

## If something goes wrong

- **No browser, and no "Finish SRE setup" on the desktop** (or a box says the setup screens did not start): restart the
  computer and run SRE-Setup.exe again. If it happens again, send me a photo of the last lines of
  `C:\ProgramData\SRE\setup.log` (open it with Notepad).
- **"DeleteFile failed; code 5 — Access is denied"** while copying files: click **Cancel installation**, restart the
  computer, and run SRE-Setup.exe again. (Seen with the 1.0.1996 release on 9 November 2026: an earlier run's setup screens
  were still running. Releases from 10 November 2026 stop them by themselves.)
- **"Finish SRE setup" on the desktop does nothing** after a restart: the setup screens stop when the PC restarts. Run
  SRE-Setup.exe again; it makes a new shortcut.
- **"NOT DONE — the Docker copy's database did not start … docker-compose.yml … cannot find the file"** (release
  1.0.2005, 10 November 2026): the move looked for Docker's file in the installed program instead of the folder the
  copy was made from. Nothing was changed. Restart the computer (the till comes back as before) and use a release made
  on or after 11 November 2026.
- **"REFUSED — … where it was made"** or **"… not on this PC any more"**: the move could not find the folder Docker's
  copy was made from. Nothing was changed and the till keeps running. Send me a photo.
- **"NOT INSTALLED — the shop database could not be made."** with no reason (release 1.0.2009, 11 November 2026):
  this PC had no Microsoft Visual C++ runtime (double-clicking `initdb.exe` in
  `C:\Program Files\SRE Retail OS\runtime\pgsql\bin` said "VCRUNTIME140.dll was not found"). The shop was put back,
  Docker and the till running. Releases from 11 November 2026 install that runtime themselves.
- **SETUP DONE, but no "MATCHED" and no "MOVED" line** (12 November 2026: Docker Desktop was not running): the services
  were made with a NEW, EMPTY database and the shop's data stayed in Docker. **Do not sell on SRE Till** until it is put
  right. Open Docker Desktop (Engine running) and run a release from 12 November 2026 or later: it sets the empty
  database aside (kept) and does the move. Releases from then on refuse instead when Docker Desktop is not running.
- Nothing here touches the shop's data: until step 6 says MOVED, the shop is still in Docker exactly as before.

Docker Desktop can be uninstalled later, once I confirm from your photos; its stopped copy is the only thing it still holds.
