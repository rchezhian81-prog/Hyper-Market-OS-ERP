# External Dependency Register

Everything outside this repository that the finished product depends on — so that no
dependency is discovered late, and none of them is a **permanent** dependency on one vendor,
one developer or one AI tool (roadmap §23, OD-01/OD-09).

Type: **Blocking** (needs the owner: money, a contract, or credentials) · **Deferred**
(planned, not needed yet) · **Satisfied**.

| ID | Dependency | Needed for | Type | Owner action required | Current handling |
| --- | --- | --- | --- | --- | --- |
| EX-01 | **Cloud hosting + managed PostgreSQL** | Stage 5 deploy proof in a real environment; everything cloud-side | Deferred by owner (**OB-02**) | Choose vendor + pay | Everything runs locally on Docker Compose; the DB is behind a `SqlClient` port, so the vendor choice changes configuration, not code |
| EX-02 | **Previous-system data extraction** | Real-data migration | **CLOSED — 7 Aug 2026. Superseded by owner decision OB-06: we extract our own data ourselves.** The incumbent vendor has no incentive to help a customer leave, so a plan whose first step was *"wait for them"* handed the schedule to somebody whose interests run the other way | **None.** The drafted letter is retained on file; if the vendor ever answers, that is a bonus and not a dependency | Route and verification rules in `packages/migration/src/extraction.ts`; procedure in `docs/runbooks/legacy-self-extraction.md`. What the owner obtains instead is **outside evidence** — bank statements, filed GST returns, supplier statements, a physical count — none of which involves the vendor, and all of which are stronger evidence than a vendor export |
| EX-03 | **Payment provider (RBI-authorised, tokenising)** | POS card/UPI tender, refunds, settlement reconciliation | **Blocking at Stage 9 for live tender** | Commercial agreement + credentials | Tender engine is provider-agnostic; card data never stored (hard rule #3); sandbox/mock provider used |
| EX-04 | **WhatsApp Business API provider** | M31 customer notifications | Deferred (Stage 14) | Account + template approval | Notification engine, consent guard and dead-letter built and tested against a mock transport |
| EX-05 | **SMS / email provider** | Notifications fallback | Deferred (Stage 14) | Account | As EX-04 |
| EX-06 | **Tally licence + company structure** | M23 accounting integration | Deferred (Stage 10) | Confirm version and company setup (AVR-09) | Finance posting is mapping-driven; the adapter is the only Tally-specific part |
| EX-07 | **GST / e-invoice portal credentials** | Statutory filing and e-invoicing | Deferred (Stage 10) | Credentials | Tax computed exactly in-system; filing is an adapter |
| EX-08 | **FSSAI, Legal Metrology and local licences** | Lawful trading; M34-FR-03 alerting | **Owner data** (AVR-11) | Provide the certificates and a named owner each | Register built; alerts cannot fire until entered (OC-19) |
| EX-09 | **Store hardware** — lanes, scanners, printers, scales, cash drawers | Pilot | Deferred (Stage 12) | Purchase / confirm existing | All device access is behind ports; ESC/POS implemented |
| EX-10 | **Maps / logistics provider** | Delivery routing (M19) | Deferred (Stage 15) | Account | Delivery engine works on injected geodata |
| EX-11 | **Apple / Google developer accounts** | Customer iOS + Android app publication | Deferred (Stage 14) | Enrolment + annual fee | Apps are cross-platform; publication is the only gated step |
| EX-12 | **Model gateway / AI provider** | LIVE-model evaluation only (pre-pilot gate) | **Deliberately deferred — owner decision, 4 Aug 2026 (Option A approved)** | None now. Provider selected at the pre-pilot integration gate, after the provider-neutral implementation, safety controls and evaluation harness are complete | **Does NOT block Stage 17.** The whole of Stage 17 is built and tested against a provider-neutral gateway and a deterministic simulator; changing provider must remain a configuration + adapter change, never a rewrite. Only the live-model evaluation run depends on an account |
| EX-13 | **Independent penetration test** | QG-06 before customer launch | **Blocking at Stage 14** | Engage a tester (paid) | Threat model, guardrails and security tests in place |
| EX-14 | **`roadmap-v2.1.docx`** (the audit-closed baseline named in the owner's authorization) | Confirming the traceability diff against v2.0 | Non-blocking (**AS-01**) | Drop the file into `docs/roadmap/` | Working from v2.0, whose change-control rule guarantees v2.1 cannot have removed scope |

## No permanent lock-in

Each row is deliberately reachable through a **port**: the database (`SqlClient`), the
printer (`PrinterPort`), sync (`SyncTransport`), hashing (`Hasher`). Swapping a vendor
changes an adapter and a configuration value, never the domain logic — which is what OD-09
("SRE owns everything") and NFR-12 ("no proprietary-only route to your data") require.
