# External Dependency Register

Everything outside this repository that the finished product depends on — so that no
dependency is discovered late, and none of them is a **permanent** dependency on one vendor,
one developer or one AI tool (roadmap §23, OD-01/OD-09).

Type: **Blocking** (needs the owner: money, a contract, or credentials) · **Deferred**
(planned, not needed yet) · **Satisfied**.

| ID | Dependency | Needed for | Type | Owner action required | Current handling |
| --- | --- | --- | --- | --- | --- |
| EX-01 | **Cloud hosting + managed PostgreSQL** | Stage 5 deploy proof in a real environment; everything cloud-side | Deferred by owner (**OB-02**) | Choose vendor + pay | Everything runs locally on Docker Compose; the DB is behind a `SqlClient` port, so the vendor choice changes configuration, not code |
| EX-02 | **Previous-system export access + lawful extraction rights** | Stage 11 migration rehearsal (MG-01/02) | **Blocking at Stage 11** | Vendor letter (draft exists at `docs/discovery/legacy-data-access.md`) | Migration design complete; no extraction attempted |
| EX-03 | **Payment provider (RBI-authorised, tokenising)** | POS card/UPI tender, refunds, settlement reconciliation | **Blocking at Stage 9 for live tender** | Commercial agreement + credentials | Tender engine is provider-agnostic; card data never stored (hard rule #3); sandbox/mock provider used |
| EX-04 | **WhatsApp Business API provider** | M31 customer notifications | Deferred (Stage 14) | Account + template approval | Notification engine, consent guard and dead-letter built and tested against a mock transport |
| EX-05 | **SMS / email provider** | Notifications fallback | Deferred (Stage 14) | Account | As EX-04 |
| EX-06 | **Tally licence + company structure** | M23 accounting integration | Deferred (Stage 10) | Confirm version and company setup (AVR-09) | Finance posting is mapping-driven; the adapter is the only Tally-specific part |
| EX-07 | **GST / e-invoice portal credentials** | Statutory filing and e-invoicing | Deferred (Stage 10) | Credentials | Tax computed exactly in-system; filing is an adapter |
| EX-08 | **FSSAI, Legal Metrology and local licences** | Lawful trading; M34-FR-03 alerting | **Owner data** (AVR-11) | Provide the certificates and a named owner each | Register built; alerts cannot fire until entered (OC-19) |
| EX-09 | **Store hardware** — lanes, scanners, printers, scales, cash drawers | Pilot | Deferred (Stage 12) | Purchase / confirm existing | All device access is behind ports; ESC/POS implemented |
| EX-10 | **Maps / logistics provider** | Delivery routing (M19) | Deferred (Stage 15) | Account | Delivery engine works on injected geodata |
| EX-11 | **Apple / Google developer accounts** | Customer iOS + Android app publication | Deferred (Stage 14) | Enrolment + annual fee | Apps are cross-platform; publication is the only gated step |
| EX-12 | **Model gateway / AI provider** | A01–A10 governed agents (Stage 17) | Deferred | Account + budget | Agents are designed behind a gateway with scoped tools, budgets and a kill switch; none writes to the database |
| EX-13 | **Independent penetration test** | QG-06 before customer launch | **Blocking at Stage 14** | Engage a tester (paid) | Threat model, guardrails and security tests in place |
| EX-14 | **`roadmap-v2.1.docx`** (the audit-closed baseline named in the owner's authorization) | Confirming the traceability diff against v2.0 | Non-blocking (**AS-01**) | Drop the file into `docs/roadmap/` | Working from v2.0, whose change-control rule guarantees v2.1 cannot have removed scope |

## No permanent lock-in

Each row is deliberately reachable through a **port**: the database (`SqlClient`), the
printer (`PrinterPort`), sync (`SyncTransport`), hashing (`Hasher`). Swapping a vendor
changes an adapter and a configuration value, never the domain logic — which is what OD-09
("SRE owns everything") and NFR-12 ("no proprietary-only route to your data") require.
