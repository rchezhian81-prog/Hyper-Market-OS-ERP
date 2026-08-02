# SRE Retail OS - Project Rules

## What this project is
A hybrid retail operating system (offline-first plus cloud) for SRE Hyper Market,
a 14,000 sq ft hypermarket in Tamil Nadu, India. It replaces a manpower-heavy
standalone ERP and POS. The owner is not a programmer. He is the decision maker.

## The controlling document
docs/roadmap/roadmap-v2.0.docx is the single source of truth.
36 modules M01-M36, 14 extensions D01-D14, 20 workflows WF-01-WF-20,
20 execution stages, 12 quality gates QG-01-QG-12, 8 releases R0-R8,
10 AI agents A01-A10, migration controls MG-01-MG-12.
Never invent a requirement. If it is not in the roadmap, stop and ask.
Never silently drop a requirement. Implement it, or ask the owner to defer it
in writing with a named target release.

## Non-negotiable principles
P-01 Offline first - the store keeps trading with no internet and no cloud.
P-02 One commerce truth - all channels share product, price, stock, customer,
     loyalty and order truth.
P-03 Control by exception - surface risks, approvals and variances, not noise.
P-04 Secure by design - least privilege, encryption, traceable approvals,
     tested recovery.
P-05 Human-governed AI - AI recommends or drafts; deterministic rules and
     authorised humans commit critical actions.
P-06 Open and portable - versioned APIs, exports, documented data models.
P-07 Usability by role - the simplest interface each role needs.
P-08 No silent failure - sync lag, stale data and reconciliation differences
     are visible.

## Hard rules - never break these, in any module, for any reason
1.  A core POS sale never depends on a network call. Commit locally first,
    then sync idempotently.
2.  Ledgers are append-only. Never overwrite a quantity or a balance.
    Corrections are compensating events.
3.  Never store a card number, CVV or expiry date. Provider tokens only.
4.  No shared logins. No secrets in code, config, images or logs.
5.  An AI agent never writes to the database directly and never commits a
    price, payment, refund, purchase, stock or privilege change.
6.  Never delete audit evidence, dead-letter items or migration exceptions.
7.  Never touch production data from development or test.
8.  Never push to main. Branch, test, open a pull request.
9.  Nothing is done without automated tests that prove it.
10. Conflicts become visible exceptions, never silent last-write-wins.

## Technology baseline (roadmap section 19)
Web ERP/Admin      TypeScript + modern SSR web framework
Cloud services     modular domain services
Cloud data         PostgreSQL + Redis; object storage for documents
Store edge         containerised local services + local relational database
POS                desktop/PWA shell; sub-second scan; no cloud round trip
Mobile             cross-platform; must run well on a low-spec Android phone
Messaging          durable broker with idempotency, retry and dead letter
AI                 central model gateway; scoped tools, evidence, budget,
                   kill switch
Delivery           containers, infrastructure as code, CI/CD
Any substitution requires an ADR in docs/adr/ covering offline, support,
security, cost, portability and maintainability impact.

## Repository layout
apps/       pos, web-erp, owner-app, customer-app, picker-app, delivery-app
services/   one folder per domain service
packages/   shared contracts, types, ui, utils
edge/       store-edge services and sync agent
db/         migrations, seed data, data dictionary
infra/      infrastructure as code, environments, CI/CD
tests/      unit, integration, e2e, contract, performance, migration,
            security, guardrails
docs/       roadmap, requirements, adr, api, runbooks, sop, traceability

## Definition of Done - every item must be true
- Requirement ID referenced and acceptance criteria met
- Automated tests written and passing
- Permissions, approval path, audit events and error paths implemented
  and tested
- Offline behaviour implemented and tested where roadmap section 31 requires it
- Traceability row updated in docs/traceability.md
- Plain-English summary written for the owner
- Merged only through a pull request with passing checks

## How to work with this owner
He is not a programmer. Therefore:
- End every response with a plain-English explanation. No jargon.
- Always list exactly what he should check, and how to check it in the store.
- When a decision is needed, give two or three concrete options with
  consequences. Never an open question.
- If a requirement is ambiguous, STOP and ask. Do not guess and do not fill
  the gap with a reasonable assumption.
- Never treat silence as approval.
- If you think a request is a mistake, say so before doing it.

## Session discipline
- Start every session by reading this file and docs/STATUS.md.
- End every session by updating docs/STATUS.md: what changed, what is next,
  what is blocked, what needs an owner decision.
- One stage at a time. Never start new work while a gate is open.
- If the session is getting long or confused, say so and propose stopping
  at a clean point.
