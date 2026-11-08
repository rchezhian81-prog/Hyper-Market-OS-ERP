# Roadmap change CR-01 — the owner-installable product

_Ratified by the owner on **8 November 2026**, in writing: "1A 2A 3A" (decisions OB-707, OB-708, OB-709). This record
extends — never replaces — `docs/roadmap/roadmap-v2.0.docx` and the v2.1 addendum. It adds one execution stage, placed
**before the pilot resumes**, and changes no existing requirement's meaning._

## Why

Setting up the shop's store computer (5–8 November 2026) took ZIP files, folders, Docker, Node and about twenty typed
commands, guided line by line. It worked, but it is the wrong experience for the people who will run the shop. The owner's
words: _"you should develop this as a setup file and it must have tenant id individually; after installation any update
must be just one click, without code; after installation the app must ask for a desktop shortcut for regular use; old files
and reports must be easily imported and exported; the roles must come with the software setup; permissions have to be
decided by the owner or admin."_

The roadmap already asks for most of this in its cross-cutting completion ("import/export", "RBAC", "recovery"), in
**P-07** (the simplest interface each role needs), **M30** (import, export and data quality), **M33-FR-04** (licence /
entitlement and service management) and its delivery baseline ("containers, infrastructure as code, CI/CD"). What it did
not say is that the **shop itself installs and updates the product without a technician**. This stage says so.

## The stage: Owner-installable product (OI)

| ID | Requirement | Acceptance criterion (testable) | Extends |
|---|---|---|---|
| OI-01 | **One setup program** for Windows (`SRE-Setup.exe`) installs everything the store computer needs | On a clean Windows 10/11 PC, one run of the setup program — no typed command — leaves the shop's services running and starting by themselves at sign-in; a test on a clean Windows runner proves it | §19 delivery, M33 |
| OI-02 | **A first-run wizard** on screens: shop name, legal name, GSTIN, data drive, the owner's name and PIN | Every value the wizard asks is checked as the commands check it today (GSTIN check digit, a drive that is not the system disk …); nothing is typed into a console | M01, P-07 |
| OI-03 | **The tenant ID is made by the setup program**, one per shop, never typed | Two installs give two different tenant ids; the id is shown on the About screen | M33 |
| OI-04 | **Desktop shortcuts are offered** at the end of setup: Till, Office, Import & export | The wizard's last screen offers each; the chosen ones open the right screen | P-07 |
| OI-05 | **One-click update**: "A new version is ready → Update" in the Office app | One click downloads the release, checks its signature, takes a backup, installs, and puts the old version back by itself if anything fails (the rollback drill, G9, still passes); no ZIP, folder or command | §19 CI/CD, MG-11 |
| OI-06 | **Users & roles on screens**, on the store computer, with staff ID + PIN | The owner or an administrator adds a person, gives a role and changes what a role may do on screens; a privilege change still needs a second person (§28 maker-checker, hard rule 5) and is audited | M02, §28 |
| OI-07 | **Import & export centre inside the Office app** | The old-system import (OB-704 … OB-706) and the exports of every authorised domain (M30-FR-02) are reached from the Office menu, with the same rules | M30 |
| OI-08 | **The existing shop data is kept**: setup adopts an existing data folder | Run on the store PC set up in November 2026, setup finds `D:\SRE-data`, keeps the shop, settings and people, and passes the G4 checks | MG-11, P-04 |
| OI-09 | **Tamil** on every screen this stage adds | Every new word has its Tamil twin (the language toggle) | P-07 |
| OI-10 | **Licensing for sale to other shops** (M33-FR-04) — _scope awaits the owner's decision OB-710_ | Proposed: a licence file signed by the seller's own key, checked offline; expiry never stops a sale mid-day (warnings, then a grace period); the shop can always view and export its own data | M33-FR-04, P-01, P-06 |

## What does not change

- The rules: two people for important acts, PINs, append-only ledgers, offline-first selling, no shared logins, AI never
  commits. The setup program and the update button follow them; they do not go around them.
- The pilot plan (mirror pilot, one department first, OB-241). It **waits** for this stage (OB-709) and resumes with the
  same decisions (OB-692 … OB-706).
- The technology of everything except how the store computer runs: see ADR-0032 for the one substitution (Windows services
  in place of containers on the store PC), ratified as OB-708.

## Order of work

1. Run the store computer's services directly on Windows (ADR-0032), proven on a clean Windows test machine.
2. The setup program and first-run wizard, adopting existing data (OI-01 … OI-04, OI-08).
3. One-click update (OI-05).
4. Users & roles, and the import & export centre, on the store PC (OI-06, OI-07).
5. Licensing (OI-10), once OB-710 is decided.
6. Tamil throughout (OI-09); then the pilot resumes.

Each step is shown working (screens, tests) before the owner installs anything.
