# Store PC checklist — moving the shop onto the setup program (CR-01 step 2, OI-08)

_For the owner, on the store PC (DESKTOP-RTMAULK). Plain steps; nothing is typed into a command window. About 20 minutes.
Do it at a quiet time, outside trading hours. Have your phone ready to take photos._

**What it does:** the setup program moves the shop from Docker into three Windows programs ("services") that Windows starts
by itself. It keeps every record, setting, person and PIN. If anything does not match, it puts everything back as it was.
Docker's own copy is never deleted.

## Before you start

1. **Check the last backup is recent.** Open any office page and look at the banner at the top: it must not be red
   (a red banner names what is wrong, for example an old backup). If it is red, stop and send me a photo.
2. **Open Docker Desktop** from the Start menu and wait until it says **Engine running**. It is needed one last time,
   to take the data out.
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
- Nothing here touches the shop's data: until step 6 says MOVED, the shop is still in Docker exactly as before.

Docker Desktop can be uninstalled later, once I confirm from your photos; its stopped copy is the only thing it still holds.
