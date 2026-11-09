# Store computer as Windows services (ADR-0032 · CR-01 step 1)

_For the administrator and for CI. The owner will not type any of this: from CR-01 step 2 the setup program runs it._

The shop database, the office API and the till run as three Windows services on the store PC — no Docker. Windows starts
them at boot, restarts them if they stop, and each runs under its own account that nobody can sign in as.

| Service | What it is | Account | Listens on | Depends on |
| --- | --- | --- | --- | --- |
| `SRE-Database` | PostgreSQL 16, data in `<data folder>\database` | `NT SERVICE\SRE-Database` | 127.0.0.1:5432 | nothing |
| `SRE-API` | the office API (runs the database migrations at each start) | `NT SERVICE\SRE-API` | 127.0.0.1:8081 | `SRE-Database` |
| `SRE-Till` | the till's store edge: screens and save socket | `NT SERVICE\SRE-Till` | 127.0.0.1:8091 and :8090 | nothing (P-01) |

## Install (once, as an administrator, on Windows 10 or 11)

The copy must be prepared and the till installed in the data folder first:

```powershell
pnpm run store-computer -- prepare
pnpm run till:install -- --settings C:\SRE-data\.env.real --lane lane-1
pnpm run store-computer -- install-services --pg-bin <folder>\pgsql\bin --service-host <folder>\WinSW-x64.exe
```

`--pg-bin` is the `bin` folder of the PostgreSQL 16 Windows binaries; `--service-host` is WinSW 2.12 (`WinSW-x64.exe`).
Running it again is safe: an existing database is kept, nothing is installed twice.

It refuses, changing nothing, when: the computer is not Windows, or is a Windows Server (OB-282); the copy has no settings
or keeps them inside the release folder; the till is not installed; a port is taken; the folder for the database holds
files that are not a database; or this shop still runs in Docker (moving it across with its data is CR-01 step 2).

## Check

```powershell
pnpm run store-computer -- services-status
```

One line per service (running, starts by itself, its account) and whether the API says ready. Exit 0 when all is well.
Each service's own words are in `<data folder>\logs\<service>`; the database's are in Windows' Event Viewer → Application.

## Remove

```powershell
pnpm run store-computer -- remove-services
```

Stops and removes the three services, the till first. The database folder, the settings file, the till's data and every
log are kept untouched.

## The setup program (CR-01 step 2a)

`SRE-Setup.exe` does all of the above in one run, with nothing typed. It is built by the `store-pc-setup` CI job
(`scripts/build-store-pc-release.mjs` makes the release folder, `infra/windows/sre-setup.iss` makes the setup program) and
kept as that run's artifact. It brings its own Node, PostgreSQL 16 programs and service host, so nothing is downloaded on
the shop's PC. It installs to `C:\Program Files\SRE Retail OS`, then runs `store-computer setup`:

1. this PC's settings: made once with a new tenant id, or kept exactly when the PC already has them;
2. the till, in the data folder (kept when already there);
3. the three Windows services.

Its words are kept in `C:\ProgramData\SRE\setup.log`. Running it again replaces nothing. Uninstalling (Windows Settings →
Apps → SRE Retail OS → Uninstall) removes the program and the three services; the data folder is never touched.

For a technician or a test, silently: `SRE-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DATADRIVE=D:`. Its exit
code is 0 only when the setup said SETUP DONE.

Not yet (CR-01 steps 2b–2d): the first-run screens, moving a Docker copy's database across, desktop shortcuts and the
About screen. Until 2c, a PC whose shop still runs in Docker is refused, with nothing changed.
