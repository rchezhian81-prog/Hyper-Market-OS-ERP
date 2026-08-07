# Environment inventory and secrets ownership

**Roadmap §23 mandatory deliverable · SEC-04 · hard rule #4 · OD-09 (SRE owns everything).**

Two questions this document exists to answer, immediately, without asking anyone:

1. **Where does the system run, and what talks to what?**
2. **Who holds each secret, where does it live, and what happens the day it leaks?**

---

## 1. Environments

| Environment | Purpose | Data | Who may reach it | State today |
| --- | --- | --- | --- | --- |
| **local** | A developer's machine. Docker Compose: PostgreSQL + migration runner + reverse proxy. | Synthetic only. **Never production data** (hard rule #7). | The developer | ✅ Working — `infra/compose/` |
| **verification** | Throwaway PostgreSQL used to prove migrations, backup and restore. Created and destroyed per run. | Synthetic, generated | CI and developers | ✅ Working — see `docs/evidence/stage-5-recovery-proof.md` |
| **store-edge** | The shop's own hardware. Local services + local database. **Keeps trading with no internet** (P-01). | Real store data, held locally, synced up | Store devices on the shop LAN | Designed; needs store hardware (EX-09) |
| **staging** | Pre-production rehearsal, same shape as production. | Masked or synthetic — **never a copy of live personal data** (PRV) | Platform admin | Needs hosting (EX-01) |
| **production** | The live business. | Real | Least-privilege, MFA, audited | Needs hosting (EX-01, deferred by OB-02) |

**Hard rule #7 — never touch production data from development or test.** There is no
configuration in this repository that points a development tool at a production database,
and the restore script refuses a non-empty target without an explicit `--force`.

## 2. What runs where

```
   Store (keeps trading with no internet)          Cloud (control, reporting, omnichannel)
   ┌────────────────────────────────────┐          ┌─────────────────────────────────────┐
   │  POS lanes ──┐                     │          │  domain services                    │
   │              ├── store-edge        │  sync    │        │                            │
   │  scales,     │   • local database  │ ───────► │  PostgreSQL  ──►  read models       │
   │  printers ───┘   • sync agent      │  (queued,│        │                            │
   │                  • local catalogue │  idem-   │  object storage (documents)         │
   └────────────────────────────────────┘  potent) └─────────────────────────────────────┘
        RPO 0 for committed sales                       RPO ≤15 min · RTO ≤4 h
        RTO ≤30 min
```

The arrow goes **one way at commit time**: a sale is written locally and queued. Nothing in
the sale path waits on the cloud (hard rule #1, enforced by `tests/guardrails/pos-offline`).

## 3. Secrets — where they live and who owns them

**No secret is in this repository, and none ever may be** (hard rule #4). A pre-commit hook
and a CI job scan every file on every change; both have already caught real attempts during
development, including my own test fixtures.

| Secret | Used by | Where it lives | Owner | Rotation |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | migrations, services | Environment variable, injected by the platform. Locally: a git-ignored `.env` | Platform admin | On staff change or suspicion; immediately on leak |
| Backup encryption key | `scripts/backup.mjs` | Managed key store. **Never beside the backups** — a key stored with the data it protects protects nothing | Security admin | Annually; old keys retained to read old backups |
| Off-site storage credentials | backup replication | Platform secret store | Platform admin | Annually |
| Payment provider keys | tender, refunds | Provider vault; **card data itself never reaches us** (hard rule #3) | Owner + platform admin | Per provider policy |
| Messaging provider tokens | WhatsApp/SMS/email | Platform secret store | Platform admin | Annually |
| Tally / GST portal credentials | finance adapters | Platform secret store, finance scope | Finance + platform admin | Per portal policy |
| CI tokens | GitHub Actions | Repository secrets, least privilege (`contents: read`) | Platform admin | Annually |
| Staff credentials | sign-in | **The identity provider — never this codebase.** `packages/identity` holds no password field, no hash, no token | Security admin | Policy-driven |

### The day a secret leaks

1. **Revoke first, investigate second.** A revoked working key costs an outage; a live leaked
   key costs the business.
2. Rotate it in the platform secret store; redeploy.
3. Record it as an **incident** linked to the control it defeated
   (`packages/compliance` — an incident that links to nothing teaches nothing).
4. If personal data may be involved, start the **CERT-In 6-hour** reporting workflow (§35).
5. Add the leak path to `scripts/secret-scan.mjs` so the same shape cannot recur.

## 4. Ownership (OD-09)

SRE owns the source, the repositories, the databases, the documentation, the deployment
assets, the backups and the credentials. Nothing here depends permanently on one vendor, one
developer or one tool:

- every external system sits behind a **port** (`SqlClient`, `PrinterPort`, `SyncTransport`,
  `Hasher`), so changing vendor changes an adapter, not the business logic;
- the product has **zero third-party runtime dependencies** — 216 packages are installed,
  all of them build or test tooling, none shipped;
- every domain exports to **open CSV with a schema** (`packages/export`), proven by
  round-tripping through our own importer;
- the SBOM (`docs/evidence/sbom.json`) is regenerated by CI, which **fails if it drifts** —
  a stale bill of materials is worse than none, because it reads as accurate.
