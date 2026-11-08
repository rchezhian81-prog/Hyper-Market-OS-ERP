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
