# Full-roadmap gap audit, 23 October 2026 (OB-288)

The owner decided (OB-288) to complete the whole roadmap in software before the store install. Four read-only checkers compared every roadmap row with the code and the tests (not with the documents' own labels). Their full tables are in `docs/audit/full-2026-10-23/lane-1.md` … `lane-4.md`.

## Scope

| Lane | Rows checked |
|---|---|
| 1 | M01–M09, WF-01–05, QG-01–04, addendum A1–A13, NFR and security |
| 2 | M10–M18, WF-06–10, QG-05–08, MG-01–06, A14–A29, B1–B12 |
| 3 | M19–M27, WF-11–15, QG-09–12, MG-07–12, D01–D07, B13–B24 |
| 4 | M28–M36, WF-16–20, D08–D14, agents A01–A10, AI governance, addendum C1–C21, R8 items |

## Result (391 rows)

| Lane | Done | Partial | Missing | Decision | External | Rows |
|---|---|---|---|---|---|---|
| 1 | 33 | 31 | 1 | 1 | 2 | 68 |
| 2 | 49 | 21 | 0 | 6 | 3 | 79 |
| 3 | 57 | 39 | 2 | 5 | 3 | 106 |
| 4 | 67 | 57 | 4 | 3 | 7 | 138 |
| **Total** | **206** | **148** | **7** | **15** | **15** | **391** |

Thirty-nine decisions were found. Fifteen are rows whose status is DECISION; the others sit inside PARTIAL rows. The owner answered all thirty-nine on 23 October 2026: see OB-289 to OB-327 in `docs/registers/decisions.md`.

Numbers the owner still has to enter are shown on screen as "not set". The software never invents them. They are:
- return windows;
- floor champions;
- alert thresholds;
- loyalty tier and expiry numbers;
- the delivery fee;
- the staff-discount cap;
- the related-party list;
- the delivery-contribution threshold;
- the C9 threshold.

**What EXTERNAL means.** These items need an outside party, real hardware or staff, such as:
- live payment, GST, SMS and courier providers;
- real Tally;
- sensors, ESL and RFID;
- a live AI model;
- a penetration test;
- the real old-ERP data and the CA;
- staff UAT.

They are built and tested with stand-ins. They cannot be "verified" until the real thing exists.

## Build waves (four builders in parallel; no two in one wave share files beyond one-line route registrations)

| Wave | Builder 1 | Builder 2 | Builder 3 | Builder 4 |
|---|---|---|---|---|
| 1 | Procure-to-pay: blanket PO, segregation of duties, RFQ, rebates, scope, dock diary/ASN, landed cost, WF-03, Tally voucher export | Recall and trace: PO block, owner alert, automatic pack publish, backward trace, read audit, call list | Store-box offline queues: food safety, quality, production, weighed runs, labels, transfers, expiry sweep, clock drift | Gates: SAST/image/IaC/DAST, QG-05 load tests, QG-06 high blocks, scenario lists for WF-06–10, QG-12 register, A25 guard |
| 2 | Identity and authority: role limits, department scope, approval escalation, price second person, passkeys | Till bill, GST and cash office: FY reset, cess, inter-State, scan timing, delivery sale, till recall, day evidence pack, FSSAI on bill, expiry tap, BIS gate | AI governance and the ten agents: real control screen, scoped kill switch, budgets, model register, incidents, evaluations, model gateway off | Finance bridge and contracts: Tally daily file, trial balance, cost centres, MG-10/11, OpenAPI/AsyncAPI, close checks |
| 3 | Catalogue, pricing and product legal: bundles, nutrition, substitutes, multibuy, bank offer off, heat-map, tobacco and liquor guards | Customer, loyalty, CRM and the online cart: tiers and expiry, repeat orders, complaints on the customer record, promotions/coupons/points online, AI notice | Fulfilment and delivery: wave builder, app code proof, geofence, courier link off, ETA, routing, contribution approval | Loss prevention, workforce and facilities: fraud signals, staff and related-party rules, productivity, curriculum, assets and cold rooms, SOP help |
| 4 | Commercial desks: B2B contracts, supplier review, concessions (off), EDI note | Owner reporting and data: dashboard, alerts, scheduled reports, all import types, the two-export comparison | SaaS and rollout: metering, tenant life cycle, partner SDK, per-branch and per-lane switches | Store devices: self-checkout, mobile POS, ESL, RFID, IoT, CCTV, relabel tasks, offline write-off |
| 5 | One end-to-end store day on the full stack, the records (STATUS, traceability, completion ledger) and the final gate | | | |

Each package meets the Definition of Done in `CLAUDE.md`. That means unit tests, real-PostgreSQL tests with a cold restart, refusal paths, a browser test for each screen, English and Tamil, traceability, and a pull request with green checks.
