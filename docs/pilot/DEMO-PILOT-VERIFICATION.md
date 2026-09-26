# Demo-pilot verification & handoff (Option 1)

_Authorized by the owner, 25 Sep 2026 — **Option 1: stand up a safe, isolated, non-production pilot
environment and run the complete deployment tests and operational drills using synthetic/demo data
only.** This is authorization for demo-pilot deployment and verification. It is **not** approval for real
store operation, real customer/product data, live payments, live tax submissions, production providers or
public launch._

Release candidate `pilot-rc-1`. Branch `claude/new-session-lw91i4`. This document is the single handoff
for the demo-pilot verification: what was executed, the evidence, what remains an owner/external gate, and
the readiness recommendation.

---

## 0. Executable-evidence summary (what was actually run, this work package)

| Check | How it was run | Result |
|---|---|---|
| Migrations on a **fresh separate pilot DB** | `pnpm db:migrate` against a fresh `sre_pilot` (disposable PG16) | ✅ 11/11 applied; re-run applied 0 (idempotent); 8 tables |
| **Real-PostgreSQL** DB + migration suites | `DB_TESTS_REQUIRED=1 pnpm test:db` against a real PG database | ✅ 290 files, **1855 tests**, exit 0 |
| **Role-based demo UAT** (auth + role restrictions + isolation) | `tests/integration/demo-uat.test.ts` on the fully-seeded demo tenant | ✅ 5 cases; 7 roles authenticate, 7 refused out-of-scope (403), tenant isolation holds |
| **Controlled seed** (connected flows, synthetic data) | `tests/integration/pilot-seed.test.ts` (22) via the real routes | ✅ foundation→catalogue→stock→transactions, all read back |
| **Feature safety** (dangerous features off/gated) | `tests/integration/pilot-feature-safety.test.ts` (8) | ✅ (in full gate) |
| **Failure drills** (idempotency, no-oversell, isolation, stale token) | `tests/integration/pilot-failure-drills.test.ts` (5) | ✅ (in full gate) |
| **Full local gate** (typecheck+lint+secret-scan+unit/integration+perf+e2e) | `pnpm run check` | ✅ `FULLGATE_EXIT=0` — _see §6_ |
| **Reproducible build** | `pnpm build:api build:edge build:pos build:erp build:owner` | ✅ bundles written |
| **SBOM** (dependency inventory) | `pnpm sbom` → `docs/evidence/sbom.json` | ✅ 218 components (11 direct) |
| **Backup → restore → reconcile** | `pnpm db:backup` then `db:restore` into a clean DB | ✅ checksum verified; control totals reconcile exactly |
| **Overwrite refusal** | `db:restore` into a populated DB without `--force` | ✅ REFUSED (destructive-overwrite guard fired) |

No defect of any severity (P0–P4) was found during this verification (§7). Everything that requires a real
host, real data, a paid provider, or a human sign-off is listed in §12 and is **not** done here.

---

## 1. Hosting boundary (owner's §1)

**Finding: no persistent, isolated, non-production host is configured that is available without new
expenditure.** The environment this verification ran in is an **ephemeral cloud build container**: it is
isolated and non-production, but it has **no container runtime (no Docker daemon)** and is **not
persistent** (it is reclaimed after the session). It therefore serves as a **verification harness** — it
can run the migrations, the whole test/gate suite, the reproducible build, and the backup/restore drill
(all done above) — but it **cannot** be the standing pilot that store staff log into over days, and it
cannot run the `docker-compose.pilot.yml` stack. No production database, storage, secret or network was
touched (there are none in scope here).

Per the owner's instruction, nothing was purchased and no paid infrastructure was created. The hosting
choice for a **standing** demo pilot is already worked out in `../adr/0002-hosting-and-deployment.md` and
`../registers/cost-forecast.md` (owner ceiling **D3 = ₹15,000/month**). Consolidated for this decision:

| Option | Shape | Indicative ₹/month | India region | Ops effort | Scale | Backups | Fit vs ₹15k |
|---|---|---|---|---|---|---|---|
| **A — this build container** | ephemeral, no runtime | ₹0 | n/a | none | n/a | n/a (not persistent) | Verification only — **not a standing pilot** |
| **B — one India-region VM, self-managed** _(recommended)_ | 1 VM runs PG+Redis+containers; managed off-site backups | **₹6,465–12,500** | ✅ (Mumbai/Chennai/Pune) | moderate — patching/restore move to the 2nd custodian (D4) | one store, headroom | managed off-site (M35) | ✅ fits with headroom |
| **C — all-managed services** | managed PG/Redis/compute/storage | ₹14,000–24,500 | ✅ | low | easy | provider-managed | ⚠️ fits only at the very bottom; breaches at upper bound |

**Recommendation:** Option **B** — one India-region VM, self-managed data services, managed off-site
backups. It fits the ₹15k ceiling with room (including AI at full usage) and keeps data in India (DPDP
Act 2023). Standing it up is **owner expenditure (EX-01 / OA-5)** — I stop here and ask; I did not
provision it. The final vendor is the owner's choice on real quotes (ADR-0002 stays *Proposed* until then).

---

## 2. Release identity & deployment manifest (owner's §4)

| Field | Value |
|---|---|
| Release candidate tag | `pilot-rc-1` |
| RC commit | `c45b948` |
| Verified branch head | `fe88e15` (branch synced to merged `main`) |
| **Runtime code vs RC** | **Unchanged.** Every change since `pilot-rc-1` is docs, tests, the demo seed (`db/seed/pilot/`), pilot infra **config** (`docker-compose.pilot.yml`, `.env.pilot.example`), `.gitignore` and `tsconfig.json`. No file under `apps/`, `services/`, `packages/` or `edge/` changed. The pilot deploys the exact RC runtime. |
| Migrations | 11 (`db/migrations/0001…0011`), validated on a fresh DB (§0) |
| Node / pnpm / TypeScript | v22.22.2 / 10.33.0 / 5.9.3 |
| Database | PostgreSQL 16 |
| Build artifacts | `services/api/dist/start.js`, `edge/store-edge/dist/start.js`, POS/ERP/owner app bundles (esbuild) |
| SBOM | `docs/evidence/sbom.json` — 218 components, 11 declared directly |
| Secrets in repo/image/logs | **None.** `secret-scan` clean across the tree; `.env.pilot` is git-ignored; every secret is a `REPLACE_WITH_…` placeholder the service refuses to boot on |
| Legacy/current store system | **Untouched** — nothing in this work package reaches it |

## 3. Environment architecture (owner's §2)

The pilot is a four-service stack, isolated by a distinct compose **project name** (`sre-pilot`), which
namespaces its volumes and network away from any other stack:

```
        (HTTPS / TLS terminated in front — reverse proxy or nginx TLS block)
                               │
   ┌────────────┐      ┌───────┴────────┐      ┌──────────────┐
   │  web (PWA) │◀────▶│   api (cloud)  │◀────▶│ db: PostgreSQL│  volume sre-pilot_db-data
   │  POS/ERP   │      │  default-deny  │      │  sre_pilot    │
   └────────────┘      │  RBAC + audit  │      └──────────────┘
                       └───────┬────────┘
                               │ sync (idempotent)
                       ┌───────┴────────┐
                       │  edge (store)  │  volume sre-pilot_edge-data — offline-first
                       └────────────────┘
```

Isolation/hardening checklist and how each item is met: `SAFE-PILOT-ENVIRONMENT.md`. Section-2 controls
present and evidenced: separate DB, separate storage (namespaced volumes), separate secrets (`.env.pilot`),
test/local IdP, pilot-only users/roles (§5), synthetic data (§0), HTTPS (TLS-in-front, operator step),
secure sessions (Bearer tokens, no ambient cookie auth), tenant isolation + RBAC (§0, §5), audit trail
(tamper-evident hash chain, migration 0010; `pnpm verify:audit`), monitoring + alerts
(`MONITORING-AND-ALERTS.md`), encrypted backups + tested restore (§8), deployment rollback (§8), resource
limits (`docker-compose.pilot.yml`). **"DEMO / PILOT — NOT PRODUCTION" identification** is structural: all
demo data lives under the `pilot-demo` tenant and carries `SEED_MARKER.syntheticDataOnly = true`; the
`.env.pilot` posture pins `MIGRATION_TARGET_KIND=rehearsal` (never `production`).

## 4. Enabled / disabled features (owner's §2 & §3)

Disabled or gated by default, proven by `pilot-feature-safety.test.ts` (8 cases) and documented in
`FEATURE-SAFETY.md` + `PILOT-FEATURE-MATRIX.md`:

| Capability | State in the demo pilot |
|---|---|
| Live payment capture | ❌ off — sandbox/simulator only |
| Live GST submission | ❌ off — GST portal gate returns `canGoLive:false` (`not_enabled`); killable |
| Live e-invoice / e-way-bill | ❌ off — sandbox Rule-46 gate only |
| Live Tally posting | ❌ off |
| Live payroll / real bank-file release | ❌ off — payroll only as demo-marked **draft** |
| Production messaging (SMS/WhatsApp) | ❌ off — consent enforced in code |
| Production/autonomous AI actions | ❌ off — AI kill switch ON (agent runs → 503) |
| Production "Delete my data" execution | ❌ gated — maker-checker; legal confirmation required |
| Irreversible migration | ❌ off — `MIGRATION_TARGET_KIND=rehearsal`; production target → 403 |
| Optional dept/loyalty/delivery/b2b features | default-OFF; enabled per-tenant only where the demo needs them |

## 5. Test-user role matrix (owner's §8 — no passwords)

Authentication is Bearer-token via the **test/local IdP** — there are no stored passwords in this model.
All users live under the `pilot-demo` tenant and are provisioned by the seed. Executed access matrix
(`demo-uat.test.ts`):

| Demo login | Role (enforced) | Permissions | Representative allowed | Representative refused (403) |
|---|---|---|---|---|
| `pilot-owner` | owner | 226 | set a governed price | platform partner administration |
| `pilot-manager` | store_manager | 149 | run the shop / self-read | platform partner administration |
| `pilot-cashier` | cashier | 20 | self-read / POS scope | set a price |
| `pilot-accountant` | accountant | 31 | post a journal | set a price |
| `pilot-ca` | chartered_accountant | 4 | read reconciliation / sign control total | set a price |
| `pilot-supplier` | supplier | 2 | read its own portal data | set a price |
| `pilot-platform-admin` | platform_admin | 25 | partner administration | post a business transaction (set a price) |

The twelve UAT personas the owner listed map onto these seven enforced roles (administrator→platform_admin;
purchase/picker/delivery/customer-service→store_manager scope; finance→accountant; HR/payroll→owner/
accountant scope; B2B→b2b entitlement; retail customer→customer app). RBAC is enforceable and tested at the
seven roles above; the per-persona witness UAT is `UAT-ROLE-CHECKLIST.md` (human sign-off, §12).

## 6. Pilot gate results (owner's §5)

Executed against `PILOT-GATES.md`. `FULLGATE_EXIT=0` — the full local gate is green (typecheck, lint,
secret-scan, ~7,700 unit/integration, perf, ~130 browser e2e). Per-gate:

| Gate | Evidence executed | Result |
|---|---|---|
| G1 Release baseline | build from `fe88e15`; runtime = RC (§2) | ✅ |
| G2 Isolated environment | project-namespaced volumes/DB/secrets; §3 | ✅ (stand-up on the box ⛔ EX-01) |
| G3 Feature safety | `pilot-feature-safety.test.ts` (8) | ✅ |
| G4 Controlled data | `pilot-seed.test.ts` (22), demo-marked | ✅ |
| G5 Resilience | `pilot-failure-drills.test.ts` (5) + suite; offline/reconnect + concurrent tills + duplicate/replay in e2e | ✅ |
| G6 Backup + restore | §8 — executed on PG16 | ✅ |
| G7 Monitoring | `/livez` `/readyz`, `standup:check`, watch-list | ✅ (alert channel wire ⛔ on the box) |
| Auth / authz / role restrictions | `demo-uat.test.ts` + `access-control-sweep`, `authorization-is-enforced` | ✅ |
| Tenant isolation | `demo-uat.test.ts` + `access-durability.test.ts` | ✅ |
| English / Tamil | bilingual e2e + substitution message builder | ✅ |
| Performance / capacity | `pnpm test:perf` (in the gate) | ✅ |
| G8 UAT blocking cases (people) | `UAT-ROLE-CHECKLIST.md` | ⛔ live — owner/store execution + sign-off |
| G9 Rollback rehearsed (redeploy half) | §8 restore proven; timed redeploy on the box | ⛔ live — on the stood-up box |
| G10 Named incident owner + daily reconciliation | store pilot plan | ⛔ live — owner names the person |

No gate was marked green on code review alone; each ✅ cites an executed test or drill.

## 7. Defect log (owner's §7)

**No defect of any severity was found during this verification.** Every gate, the real-PG suite, the demo
UAT matrix, the seed, the build, and the backup/restore drill passed. There are therefore no P0/P1 to
block, no P2 to document for acceptance, and no P3/P4 to backlog from this run. The one pre-existing,
already-documented item carried forward is a **pre-production** security hardening note, not a pilot
defect: **GAP-SEC-06** (no API-tier step-up re-auth) — see `FEATURE-SAFETY.md` and §11/§12.

The defect policy (`PILOT-GATES.md`) remains in force for the human UAT and live drills that follow:
P0/P1 block and are never downgraded; P2 needs written acceptance with a target release; P3/P4 backlog;
nothing closed without a recorded retest; expected results are never edited to force a pass.

## 8. Backup / restore & rollback proof (owner's §4 & §5)

- **Backup:** `pnpm db:backup` produced a custom-format dump + a manifest carrying its SHA-256 checksum and
  the per-table control totals (`event_ledger:3`, `schema_migrations:11`, 8 tables).
- **Restore into a clean DB:** `pnpm db:restore` verified the checksum, restored, and **reconciled exactly**
  against the manifest (same tables, same rows, same money).
- **Overwrite refusal:** restoring into a populated DB without `--force` was **REFUSED** — the
  destructive-overwrite guard fired.
- **Rollback:** migrations are forward-only; the rollback path is *restore the prior release's backup +
  redeploy the prior build* (`MIGRATION-AND-ROLLBACK.md`). The **restore-to-clean half is proven** here.
  The **redeploy half** is a timed drill on the stood-up box (⛔ EX-01, G9).

## 9. Monitoring status (owner's §5)

Health signals (`/livez`, `/readyz`), the plain-English `standup:check`, and the trading-integrity
watch-list are defined and tested (`MONITORING-AND-ALERTS.md`). Wiring alerts to a real channel and naming
the person who owns them are stand-up-on-the-box + owner actions (⛔ G7/G10).

## 10. Security findings

- Default-deny RBAC and tenant isolation **executed** and holding across all seven roles (§5) — a role is
  refused every action outside its authority, and a business route refuses the platform admin.
- No secrets in the repo, build artifacts or logs (`secret-scan` clean; SBOM generated).
- Audit trail is tamper-evident (hash chain, migration 0010); `verify:audit` available.
- **GAP-SEC-06 (open, pre-production):** there is no API-tier step-up re-authentication for the most
  sensitive actions. It does **not** block the demo pilot (no live money/statutory actions run), and it
  **must** be closed before production launch. Independent penetration test (EX-13/QG-06) is also a
  pre-customer-launch gate.

## 11. Maturity of this verification

Per the owner's labels: this work package is **simulator/integration verified** — every claim is backed by
an executed test or drill in an isolated environment with synthetic data. It is **not yet** "pilot
verified" (that needs the stood-up box) or "UAT approved" (that needs the store's people), which are the
⛔-live items below.

## 12. Remaining external dependencies (I stop here and ask)

| Ref | What the owner/outside party must do | Blocks |
|---|---|---|
| **EX-01 / OA-5** | Choose + pay for the standing host (Option B) + managed PostgreSQL | Standing the pilot up so people can log in over days; G2/G7/G9 live halves |
| **OA-6** | Name the pilot's genesis owner/tenant on the box | First real admin login |
| **G8 — UAT sign-off** | The store's people execute `UAT-ROLE-CHECKLIST.md`; owner signs each section | Starting the floor pilot |
| **G9 — live rollback drill** | Timed redeploy + restore on the box | Starting the floor pilot |
| **G10 — incident owner + daily reconciliation** | Owner names the person; commits to daily sign-off | Starting the floor pilot |
| **Option 2** | Approve loading a controlled copy of **real** product/price data | Running UAT on real catalogue (deliberately not done here) |
| Paid/statutory providers (EX-03/04/05/06/07/08), hardware (EX-09), IdP (OA-4), legal/CA/HR, GAP-SEC-06 | As per `../registers/external-dependencies.md` | Any **live** action + production launch — all off for the demo pilot |

## 13. Readiness recommendation

**CONDITIONAL GO** for a standing demo pilot.

Everything that can be proven without a real host, real data, a paid provider or a human sign-off has been
**executed and passes** in an isolated environment with synthetic data: fresh-DB migrations, the real-PG
suite, the full gate (typecheck/lint/secret-scan/unit/integration/perf/e2e), the role-based access matrix
and tenant isolation, the controlled seed, feature-safety, failure drills, a reproducible build + SBOM, and
a backup/restore/overwrite-refusal drill. No defect was found.

The **conditions** on GO are exactly the ⛔-live items in §12 — they are not software gaps I can clear
autonomously; they need the owner to choose and pay for a host (Option B), name an incident owner, and have
the store's people run and sign the UAT and the live rollback drill on that box. **No standing pilot has
been created and no live provider connected.** Per the owner's instruction, after this isolated demo
verification I **stop and request separate approval for Option 2** (loading a controlled copy of real
product and price data), and I do **not** start any real in-store pilot automatically.
