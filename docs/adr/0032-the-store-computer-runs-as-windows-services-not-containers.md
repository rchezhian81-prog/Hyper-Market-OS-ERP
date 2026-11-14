# ADR 0032 — The store computer runs as Windows services, not containers

- **Status:** Accepted (owner, 8 November 2026, decision OB-708: "2A")
- **Date:** 8 November 2026
- **Context:** Roadmap §19 sets the store edge as "containerised local services + local relational database". On the
  shop's real store PC (Windows 11, 8 GB, shared with the purchase staff, OB-284) that meant Docker Desktop with WSL2:
  its per-user install failed and had to be redone as administrator; it needed a memory cap (`.wslconfig`, OB-247) to
  leave room for Windows; and every step of the set-up — Node, pnpm, `docker compose`, the store-computer tool — was a
  typed command. The owner asked for a setup program and one-click updates (CR-01). Docker Desktop cannot be installed,
  updated or repaired silently and reliably by a shop's own setup program, and it is the heaviest thing on the PC.

## Decision

On the **store computer**, the shop's services run as ordinary **Windows services** installed by the setup program:
the API, the store edge (till) and a **local PostgreSQL** of the same major version the containers use, each started by
Windows at boot, each listening on loopback only. The setup program carries its own Node runtime and PostgreSQL binaries;
nothing is downloaded from a package registry on the shop's PC.

What does **not** change: the code, the database schema and migrations, the event ledger, the ports and the security
boundaries are the same as in the containers. **Head office (cloud) keeps containers** as §19 says; this ADR is about the
store PC only. CI keeps building and testing the containers, and adds a clean-Windows job that installs and tests the
services.

## §19-substitution impact

- **Offline:** unchanged or better — everything still runs on the PC with no network; one fewer layer (WSL2's virtual
  machine) that can fail to start after a Windows update. A sale still commits locally first (hard rule 1).
- **Support:** better for a shop with no IT person — the setup program installs, the Windows Services list shows each
  service, and a service restarts itself on failure. Worse in one way: we now support a Windows install path ourselves
  instead of relying on Docker's.
- **Security:** smaller surface — no Docker daemon, no WSL VM with its own network; services run as a low-privilege local
  service account, bound to 127.0.0.1; data folder permissions as today (the `icacls` lock, G4). Releases are signed and
  the update checks the signature before installing (OI-05).
- **Cost:** no Docker Desktop licence question for future commercial customers (Docker's free use is limited by company
  size); less memory (no VM), so the 8 GB PC is less likely to need more RAM. Engineering cost: building and testing an
  installer and a Windows CI job. A code-signing certificate for the setup program is a recurring cost (decided later).
- **Portability:** unchanged — the same PostgreSQL, the same exports (P-06); a shop can still move to containers (Linux
  server) because the code is identical.
- **Maintainability:** two ways to run the same code (containers in the cloud, services on the store PC). Kept honest by
  CI testing both on every change.

## Consequences

The store-computer tool's commands (`up`, `update`, `backup`, `drill` …) are re-pointed at Windows services and wrapped by
the setup program and the Office app's buttons; the owner no longer types them. The existing store PC is migrated by the
setup program (CR-01 OI-08): its data folder is adopted, its containers retired once the services pass the G4 checks.

## Reconsider-when

A shop's store computer is a Linux server, or the store PC must run several stores' services at once.

## Implementation — CR-01 step 1 (8 November 2026)

How the decision is carried out. Nothing here changes the decision; each point is an implementation choice inside it.

- **Three services, each under its own account.** `SRE-Database` (PostgreSQL 16, registered by its own
  `pg_ctl register`), `SRE-API` and `SRE-Till` (the two Node programs). Each runs as its Windows *virtual service
  account* (`NT SERVICE\<name>`): an account nobody can sign in as, with no password anywhere. Folder rights are given by
  that account's SID (worked out from the service name, the same in every language of Windows): the database its
  database folder; the API the settings file, read-only; the till its till folder; each its own log folder. The
  data-folder lock check (OB-284) counts these three as the shop's own; every other reader is still a FIX.
- **The service host for the Node programs is WinSW 2.12** (MIT licence, one small program, no installer). Node cannot
  answer Windows' service manager by itself; WinSW does that and restarts the program after 10 s, 30 s and 60 s if it
  stops. The service definitions hold only paths; each program reads its settings file when it starts
  (`scripts/store-computer-service.mjs`), so no secret is ever in a definition, a command line or a log (hard rule #4).
- **This PC only.** PostgreSQL listens on 127.0.0.1 (its own `sre-store-computer.conf`); the API on 127.0.0.1 (the new
  `API_LISTEN_HOST` setting, which accepts only a loopback address); the till's screens and save socket were already
  loopback-only. The handheld door (OB-422) keeps its own deliberate, encrypted shop-network address.
- **Order and independence.** The API depends on the database, so Windows starts the database first. The till depends
  on nothing: with the API and the database stopped it still sells (P-01). The API's program brings the database tables
  up to date (`scripts/migrate.mjs`) every time it starts, as compose's `migrate` did on every `up`.
- **Proven on a clean Windows machine** by the `store-pc-windows` job in `.github/workflows/ci.yml`
  (`tests/windows/store-pc-on-windows.check.mjs`). GitHub's Windows machines are Windows Server, which the tool refuses
  (OB-282); the job is let through only when GitHub says the machine is one of its own throw-away hosted machines and the
  job asks for it by name.
- **Not in step 1** (CR-01 order of work): the setup program, adopting the existing Docker copy's data (OI-08 — the tool
  refuses while the Docker copy runs), and moving `backup`, `check`, `status`, `autostart` and `update` from Docker to
  the services. Those are steps 2 and 3.

## Implementation — CR-01 step 2c (9 November 2026)

- **The move from Docker** (`scripts/lib/store-computer-adopt.mjs`, run by `setup`): one counted snapshot through the Docker
  copy, the Docker copy stopped (its storage kept as the way back), the snapshot restored into the service's database
  before the office starts, and reconciled table by table, money and newest event; any difference puts Docker back.
- **One way to the database** (`scripts/lib/store-computer-db.mjs`): `install-services` records
  `run\services\database.json` (the PostgreSQL folder and port, no secret); from then on backup, restore check, G4 checks 1
  and 2, the red light, `up` and `autostart` use the PostgreSQL programs on 127.0.0.1, the administrator's password in
  PGPASSWORD only. The backup's Windows script keeps the one-snapshot guarantee (GT-07) with psql's `\o` file for the totals
  and the Windows shell's `%SRE_SNAPSHOT%` for pg_dump.
- **Still Docker-only, said plainly:** the timed rollback drill and `update` — their Windows versions are CR-01 step 3
  (the update: step 3d, below; the drill: step 3e).

## Implementation note — Microsoft's Visual C++ runtime (11 November 2026)

PostgreSQL's Windows programs (initdb, postgres, pg_ctl, psql, pg_dump, pg_restore) need Microsoft's Visual C++ runtime
(`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`). The owner's store PC had none: the move's `initdb.exe`
could not start ("VCRUNTIME140.dll was not found") and the move put the shop back. GitHub's Windows machines always have
it, so CI never saw this. SRE-Setup.exe now carries Microsoft's own installer (`runtime\vcredist\vc_redist.x64.exe`,
fetched from Microsoft by CI and refused unless validly signed by Microsoft Corporation — Microsoft updates the file in
place, so a hash pin would break) and runs it quietly, before anything of the shop is touched, when the runtime is
missing. Installed system-wide rather than copied beside PostgreSQL, so Windows Update keeps it patched (P-04). Offline:
unchanged — nothing is downloaded on the shop's PC. Portability, cost: none (Microsoft's free redistributable).

## Implementation note — the one-click update (CR-01 step 3d, 12 November 2026)

- **Who acts:** a Windows task as SYSTEM (`SRE\Software update`, every 5 minutes), because only an administrator may stop
  the services and replace the program. It acts only on the owner's request; the request, written by the till's own
  low-privilege account, is a wish, never authority — only a release signed with the shop's key, verifying with the PC's
  own public key, and newer, can be installed.
- **The program, not the data, is what is updated and put back.** SRE-Setup.exe installs into one fixed folder, so "beside
  the old one" is done by KEEPING the running release whole (`…\SRE Retail OS kept\<version>`, under Program Files, so only
  administrators may write it) and mirroring it back on failure. The database and the till's data are never restored or
  copied over (hard rule #2; the rollback drill's own rule). An encrypted backup is taken first.
- **Two halves:** SRE-Setup.exe stops every node.exe of the program's folder before it copies, so the install and the way
  back run from the kept copy's node.exe, as their own task.
- **Offline:** a sale never waits on any of this (P-01): the update runs only when the owner asks, with every till closed.
  No internet, no update — the shop keeps the version it has. **Security:** least privilege kept for the services; SYSTEM
  only for the updater; no secret in any task, file or log. **Portability, cost:** Windows' own Task Scheduler and
  robocopy; nothing bought.

## Implementation note — the rollback drill on Windows services (CR-01 step 3e, 13 November 2026)

- The G9 drill keeps its order and §32 targets. "Put the previous release back" is the updater's own way back (step 3d):
  the previous release's program mirrored over the program folder from its kept copy, its own `setup` run, and its own
  checks; then this release the same way. The database is never rolled back (the previous release's steps must be the
  first steps of this one's, and must be unchanged by it).
- Steps 3–4 run as a one-off SYSTEM task from the kept copy of this release (a program cannot replace the folder it runs
  from); the backup and restore check stay at the keyboard because the passphrase opens the backup. `drill-result` reads
  the outcome. Refused while any till shift is open, as the update is (OB-718's reason: the services restart).

