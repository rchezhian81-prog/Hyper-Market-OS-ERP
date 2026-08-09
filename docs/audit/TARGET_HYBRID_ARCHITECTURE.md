# Target Hybrid Architecture (3–5 years)

_Deep architecture audit, 2026-08-09. The design principle is the roadmap's own: **the simplest architecture
that meets the verified requirements.** The research (RESEARCH_SOURCES_AND_BENCHMARKS.md) confirms that at
one-store scale the lightweight variant of every pattern suffices. This target is therefore an **evolution, not
a rebuild** — most of the domain core stays; the operational/integration half and a few data-layer fixes are
what get built._

## Architecture style: **modular monolith + offline-first edge + thin control plane**
Keep one deployable cloud API assembling the 13 domain APIs (ADR-A01). Scale horizontally by running multiple
instances behind a load balancer, fronted by a small control plane for tenant/entitlement/config. Do **not**
adopt microservices, Kubernetes, Kafka, CRDTs, or a vector DB — none is justified (GAP-register "avoid" list).

## Target diagram

```mermaid
flowchart TB
  subgraph Clients["User channels"]
    P[POS PWA]; E[web-erp]; O[owner-app]; C[customer-app]; H[handheld apps]
  end
  subgraph EdgeTier["Store-edge box (offline system of record)"]
    SS[served screens\n+ headless-offline e2e]
    FL[(fsync file-log + outbox)]
    SA[SyncAgent — outbound]
    IP[inbound pack poller\nsigned, atomic swap  ← NEW]
  end
  subgraph CP["Cloud control plane (thin)"]
    TEN[tenant / entitlement / config\n+ pack builder & signer]
    IDP[(external IdP OIDC)]
  end
  subgraph DP["Cloud data plane (modular monolith, ≥2 instances)"]
    LB[load balancer + TLS]
    KP[kernel pipeline\nauthn/authz/idempotency/egress\n+ rate limiting  ← NEW]
    APIS[13 domain APIs\n(collapsed onto packages/ engines)  ← REFACTOR]
    WF[rules / workflow engine\n+ approval inbox  ← NEW]
    AIG[AI gateway — live provider behind ports\n+ AI audit route  ← NEW]
  end
  subgraph Data["Data & platform"]
    PGP[(PostgreSQL 16 + RLS + tenants FK\nprimary + read replica  ← NEW)]
    POOL[pg.Pool  ← NEW]
    SNAP[(snapshots  ← NEW)]
    OBS[metrics exporter + tracing + alert delivery\n4 golden signals  ← NEW]
    SEC[secret store + rotation, backup encryption  ← NEW]
    AUD[(audit_log + SHA-256 hash-chain  ← NEW)]
  end
  P --> SS; P --> FL --> SA -->|HTTPS idempotency-key| LB
  IP -->|signed pack| SS
  TEN -->|signed pack| IP
  E & O & C & H -->|OIDC tokens| LB
  IDP --- TEN
  LB --> KP --> APIS --> PGP
  APIS --> POOL --> PGP
  APIS --> WF --> AIG
  APIS --> AUD
  PGP --> SNAP
  KP --- OBS
  APIS --- SEC
```
`← NEW` = build; `← REFACTOR` = collapse thin services onto the tested engines. Everything unmarked already
exists and stays.

## Layer-by-layer target

| Layer | Target | Keep / Refactor / Build |
|---|---|---|
| **Cloud control plane** | Thin: tenant/entitlement/config + signed-pack builder; delegate auth to an external OIDC IdP | Build the pack builder/signer service (edge inbound counterpart); choose IdP (OA-4) |
| **Tenant data plane** | Modular monolith, ≥2 instances behind LB+TLS; pooled Postgres | Keep monolith; **build** pool (ADR-A02), TLS, LB |
| **Branch / edge runtime** | Store-edge box: served screens + durable commit + outbound sync + **inbound pack poller** | Keep; **build** inbound sync (ADR-A06), wire offline numbering (ADR-A07), headless-offline e2e |
| **Local database** | fsync file-log (lane) — keep as-is (it is excellent) | Keep |
| **Sync engine** | Outbound (keep) + inbound signed-pack pull + structured conflict object + operator resolution UI | Build inbound + conflict UI (SYNC-03) |
| **Event / messaging** | In-process events + **transactional outbox in the same DB transaction**; a durable queue only if a real async consumer appears | **Build** transaction boundaries (ADR-A03); keep outbox; **no Kafka** |
| **Integration framework** | Existing ports/adapters + **one real provider per category in sandbox** + vendor contract tests | Keep engine; build live adapters + contract tests |
| **Workflow / rules engine** | Small deterministic rules engine + unified approval inbox (the substrate for autonomy) | **Build** (ADR-A12); wire `packages/owner-control` alerts-inbox |
| **AI orchestration & governance** | Keep the governed authority/gateway; add a **live model behind the ports**, an **AI audit route**, cost controls, and a red-team battery. RAG only if a real retrieval need is proven | Keep governance; build live provider + audit + eval-in-CI |
| **Identity / RBAC / policy** | External OIDC + existing default-deny RBAC + **token revocation/short-TTL**; **Postgres RLS** as defense-in-depth | Keep RBAC; build IdP integration, revocation, RLS (ADR-A04) |
| **Audit & observability** | SHA-256 hash-chained `audit_log`; metrics exporter + tracing + alert delivery (four golden signals) | Build (ADR-A05, ADR-A08) |
| **Analytics / reporting** | Projections + read models from the ledger; add snapshots for speed; publish OpenAPI | Keep; build snapshots (ADR-A03-adjacent), OpenAPI (ADR-A09) |
| **Backup / DR** | Keep restore-reconcile-in-CI; **exercise** encryption+offsite; add a **read replica** (warm-ish) | Build encryption/offsite + replica |
| **Web / PWA / mobile** | Keep framework-free PWAs; add Playwright e2e + a11y sweep; native-Tamil review; low-spec-device test. A native mobile wrapper only if PWA install proves insufficient | Keep; build e2e + verification |
| **Deployment topology** | Managed container host (owner's chosen provider), managed Postgres w/ HA, LB+TLS, secret store; IaC + CD + automated rollback | **Build** post-hosting decision (ADR-A11) |

## Deployment topology (target, minimal-HA)
- **Cloud:** 2× API container instances behind a TLS load balancer; managed **PostgreSQL 16 primary + 1 read
  replica**; managed secret store; object storage for encrypted backups + documents.
- **Store:** 1 store-edge box per store (the SPOF is accepted for a pilot; a second cold-standby box is the
  post-pilot HA step). Lanes are PWAs talking to the box on loopback.
- **Environments:** local → **staging** (mirror of production topology) → production. Make `integration` and
  `deploy` CI jobs **required** merge checks.

## Graceful-degradation strategy (target, mostly already true)
1. **Internet/cloud down:** store keeps trading (already true, integration-tested); inbound pack freshness is
   surfaced with age so staff know how stale prices/recalls are (build).
2. **DB replica/primary failover:** pooled connections reconnect; readyz sheds traffic without crash-looping
   (livez/readyz split already exists).
3. **AI/provider down:** shop keeps trading (AI budget/health already fail-safe `shopKeepsTrading:true`).
4. **Integration provider down:** manual fallback + reconciliation (ports already model this; `posUnaffected`).

## What must NEVER be automated (carried into every design)
Committing a payment, refund, price change, purchase order, stock adjustment, privilege grant/revoke, period
close, or audit deletion — Hard Rule #5 + `FORBIDDEN_TOOLS`. The AI drafts; deterministic rules + authorized
humans commit. The target preserves this structurally (no AI commit path ever added).

## Reconsider-when triggers
- Multi-store rollout at scale → revisit pooled-vs-silo tenancy and edge HA.
- A genuine async cross-service consumer appears → revisit a durable broker (still likely a simple queue, not
  Kafka).
- A proven retrieval need (large supplier-doc corpus) → revisit RAG (with provenance store), not before.
- Read-load outgrows projections+snapshots → revisit CQRS read stores.
