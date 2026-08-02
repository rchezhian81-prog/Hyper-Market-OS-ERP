# ADR 0002 — Hosting and deployment approach

- **Status:** **Proposed** — a recommendation pending the owner's commercial validation
  against real vendor quotes and the D3 ceiling. Moves to Accepted once a vendor and cost
  are signed off.
- **Date:** 2 August 2026
- **Deciders:** Owner (Mr Elanchezhian — commercial/final), second custodian (Mr Sivakumar,
  D4), developer/implementation lead.

An ADR captures a decision, why it was made, and what it commits us to.

## Context
The technology baseline (ADR-0001, §19) fixes containers + PostgreSQL + Redis + object
storage + a durable broker + a central AI gateway, delivered via containers/IaC/CI-CD, with
an **offline-first store edge**. **D3 sets a ₹20,000/month cloud running-cost ceiling.**
OD-09 requires SRE to own everything; AID-10 requires a **quarterly rebuild** by the second
custodian. This ADR records **how and where the cloud tier is hosted and deployed** — the
hosting shape *within* the baseline, not a change to it. Design detail:
`../architecture/infrastructure.md`.

## Decision (proposed)
1. **Two tiers:** an on-prem **store edge** (capex) + a **cloud central tier** (the
   ₹20k/month D3 ceiling).
2. **India region** for the cloud tier — data residency (DPDP Act 2023) and GST/tax-evidence
   locality.
3. **Portable, container-first hosting:** managed PostgreSQL + Redis + object storage + a
   container runtime, all defined as **IaC** — standard, portable engines over proprietary
   lock-in (P-06, OD-09).
4. **Vendor shortlist for the owner's commercial choice:** AWS (Mumbai), Google Cloud
   (Mumbai/Delhi), Microsoft Azure (Pune/Chennai), or a reputable Indian provider —
   evaluated on quoted cost within D3, India support, and portability. The recommendation is
   a **major-cloud India region** for managed-service reliability; **the final vendor is the
   owner's decision on real quotes.**
5. **Four separated environments** (dev/test/staging/prod; AID-06) and the §20 CI/CD pipeline
   (AID-02/03/08).

## Consequences
- **Positive:** fits D3 at single-store scale (see the cost model); portable and owned
  (P-06, OD-09); supports the quarterly rebuild (AID-10); keeps PII/financial data in India.
- **Cost risk:** AI model-gateway usage is metered separately and **capped** (AI-NFR); heavy
  AI use (R7) must be re-budgeted. The ₹20k figure is an **envelope** — final commitment
  needs real vendor quotes (D3 still shows "commercial validation required").
- **Portability cost:** avoiding proprietary managed features keeps some ops effort in-house
  — accepted for ownership/portability.
- This ADR stays **Proposed** until the owner validates a vendor and cost; it then moves to
  **Accepted** with the chosen vendor recorded.

## Alternatives considered
- **Single all-cloud tier (no store edge):** rejected — violates P-01 / hard rule #1 (the
  store must trade offline).
- **Fully self-hosted cloud tier for a single owner:** rejected — backup/DR/uptime burden and
  key-person risk; revisit only with strong justification.
- **Proprietary serverless-heavy stack:** rejected — data/lock-in risk against OD-09 / P-06.
