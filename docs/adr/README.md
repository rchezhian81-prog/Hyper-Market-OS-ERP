# Architecture Decision Records

Every significant architecture decision, its reasoning and its consequences. Part of the repository
layout defined in `CLAUDE.md`. New ADRs use the plain `NNNN-title.md` filename and follow
[`template.md`](./template.md).

CLAUDE.md (Technology baseline, roadmap §19) requires: **"Any substitution requires an ADR in
`docs/adr/` covering offline, support, security, cost, portability and maintainability impact."** The
0007–0012 records below discharge that obligation for the deliberate §19 substitutions the pilot ships.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-baseline-decisions.md) | Baseline decisions and the rules the machine enforces | Accepted |
| [0002](./0002-hosting-and-deployment.md) | Hosting and deployment approach | Proposed (owner decision OA-5 / OB-02) |
| [0003](./0003-multi-tenant-configurable-product.md) | Multi-tenant, configuration-driven product | Accepted |
| [0004](./ADR-0004-the-disk-lives-on-the-lane.md) | The durable write lives on the lane | Accepted |
| [0005](./ADR-0005-projection-snapshots.md) | Projection snapshots | Accepted |
| [0006](./ADR-0006-batch-on-sale-attribution.md) | Batch-on-sale attribution | Accepted |
| [0007](./0007-erp-no-framework-shell.md) | Web ERP as a no-framework static/PWA shell (§19 substitution) | Accepted (pilot); production framework deferred |
| [0008](./0008-messaging-postgres-outbox.md) | Durable messaging via a Postgres outbox, not a broker (§19 substitution) | Accepted |
| [0009](./0009-redis-deferred-single-instance.md) | Redis deferred for the single-instance pilot (§19 substitution) | Accepted |
| [0010](./0010-documents-as-events-not-object-storage.md) | Documents stored as append-only events, not object storage (§19 substitution) | Accepted |
| [0011](./0011-edge-durability-file-log.md) | Edge durability via an append-only file-log, not a local relational DB (§19 substitution) | Accepted |
| [0012](./0012-modular-monolith-cloud-topology.md) | Modular-monolith cloud topology | Accepted |

Further de-facto and proposed decisions (transaction boundaries, Postgres RLS, SHA-256 audit chain,
observability exporters, OpenAPI, DSR API, hosting/IaC/CD) are catalogued as recommendations in
[`../audit/ARCHITECTURE_DECISION_REGISTER.md`](../audit/ARCHITECTURE_DECISION_REGISTER.md); they are
implementation work for later phases, not architecture-baseline substitutions, and are promoted here
individually as they are decided.

## Filename note

Records 0001–0003 use `NNNN-title.md`; 0004–0006 use `ADR-NNNN-title.md`. Both styles are kept as-is to
avoid breaking cross-references; **new records use `NNNN-title.md`** per `template.md`. The number, not
the filename, is the identity.
