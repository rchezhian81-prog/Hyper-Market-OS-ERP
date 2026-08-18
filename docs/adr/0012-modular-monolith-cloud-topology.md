# ADR 0012 — Modular-monolith cloud topology

- **Status:** Accepted
- **Date:** 18 August 2026
- **Context:** Roadmap §19 names "modular domain services." The 13 domain APIs are built as separate,
  independently-tested modules (`services/*`, each on its tested `packages/*` engine — enforced by the
  `services-run-on-their-tested-engine` guardrail) but assembled into **one deployable process** behind a
  single router (`services/api/src/main.ts`); the architecture overview itself says a deviation from this
  "would be recorded as an ADR" (`docs/architecture/README.md`). The audit register raised this as
  proposed `ADR-A01`; this promotes it. (The earlier single-`pg.Client` SPOF that `ADR-A02` flagged is
  already fixed — `main.ts` now uses a `pg.Pool`.)

## Decision

Retain a **modular monolith**: one deployable cloud API composing the 13 domain modules in-process. Scale
horizontally by running multiple identical instances behind a load balancer (see ADR-0009 for the shared
state that unlocks), **not** by splitting into independently-deployed microservices. Module boundaries are
real (per-domain packages + guardrails), giving the modularity §19 asks for without a service fleet.

## §19-substitution impact

This is best read as **conformance with a topology choice**, not a substitution: §19's "modular domain
services" is satisfied by real module boundaries; only the deployment topology (one process vs many) is
the decision recorded here. The six axes:

- **Offline:** Neutral — the offline guarantee lives at the edge (ADR-0004/0011), independent of cloud
  topology.
- **Support:** Much lower — one process to deploy, migrate and monitor; in-process calls, no inter-service
  network, no distributed-transaction choreography. Suits a single store's cloud footprint.
- **Security:** Smaller surface — one ingress, one auth pipeline; module isolation is enforced by
  guardrails rather than network policy.
- **Cost:** Lower — no per-service infrastructure multiplier; one deploy.
- **Portability (P-06):** Good — the module boundaries are the seams along which a domain could later be
  extracted into its own service if one domain's scaling profile ever demands it.
- **Maintainability:** Good at this scale — the blast radius of one process is the accepted trade, held in
  check by the pool (no shared-connection SPOF), the guardrails, and horizontal replication for
  availability.

## Consequences

- One migration, one deploy, one local run; bounded contexts preserved as packages.
- Module boundaries must stay honoured by discipline — which the guardrails already enforce.
- A single domain can be extracted to its own service later along its existing package seam, without a
  ground-up rewrite.

## Reconsider-when

Multi-region deployment, or one domain's load/scaling profile diverges sharply enough to justify its own
independently-deployed service.
