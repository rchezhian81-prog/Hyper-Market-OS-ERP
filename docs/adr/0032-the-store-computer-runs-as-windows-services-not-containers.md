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
