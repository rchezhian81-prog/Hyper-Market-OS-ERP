# Pilot feature matrix — what is ON, SIMULATED, or DISABLED

_Release candidate `pilot-rc-1` (commit `c45b948`). Non-production pilot only._

Legend: **ON** = live in the pilot · **SIMULATED** = runs against a sandbox/mock/test adapter (no real
provider, no real money, no statutory submission) · **DISABLED** = off by default, kill-switched, requires an
owner GO + external gate to enable.

## ON for the pilot (test-mode where money/identity is involved)

| Capability | Mode | Control |
|---|---|---|
| POS sale → tender → receipt → return/cancellation → day close | ON, **tender in test mode** | offline-first; commit-local-first (hard rule #1) |
| Product/catalogue, pricing, promotions, loyalty | ON | signed packs; append-only price changes |
| Stock: availability, movements, transfers, counts, adjustments, write-offs | ON | reason codes + approval; append-only ledger |
| Purchasing: PO → GRN → match | ON | maker-checker on approvals |
| Warehouse PWA + supervisor ERP | ON | scan-first; FEFO/expiry/recall guards |
| Cash office: blind count, over/short, sign-off | ON | SoD sign-off |
| Company-wide reports + authorised CSV export | ON | RBAC + branch scope; export audited |
| Delivery/OMS: serviceability, slots, routing, substitution | ON | test-payment; **maps geodata injected** |
| Customer app: guest browse + basket + checkout | ON, **test payment** | guest-by-design |
| Login (staff + portal) | **SIMULATED** — local/test IdP | production IdP deferred (OA-4 / EX-03) |
| Loss prevention, facilities, HR stores (roster/attendance/cert/SOP), ESS | ON | RBAC |
| Audit trail + tamper-evident chain | ON | `verify:audit`; append-only (hard rule #6) |

## SIMULATED (sandbox / mock adapters — provider-neutral)

| Capability | Simulated via | Real provider (deferred) |
|---|---|---|
| Card/UPI tender, refunds, settlement | mock/sandbox payment adapter | EX-03 payment provider |
| GST return prep + e-invoice / e-way-bill | sandbox GSP adapter | EX-07 GST/GSP credentials + CA |
| SMS / WhatsApp / email notifications | mock transport + dead-letter | EX-04 / EX-05 providers |
| Tally / accounting posting | mapping-driven adapter | EX-06 Tally licence |
| AI agents (advisory only) | deterministic simulator + kill switch | EX-12 model gateway |
| Delete-my-data erasure sources + processor delivery | simulated event-sourced PII holding | real domain stores + providers |
| Legacy-data migration | rehearsal only (`MIGRATION_TARGET_KIND=rehearsal`) | real cutover (owner GO) |

## DISABLED by default in the pilot (Phase 3 — kill-switched; owner GO + external gate to enable)

- Live **GST filing** and live **e-invoice / e-way-bill** submission (sandbox only).
- Live **payroll** run / real **bank-file** release.
- **Autonomous** financial or inventory actions (AI only ever recommends; a human commits — hard rule #5).
- **"Delete my data" production execution** against real customer data (simulation only; legal confirmation
  required).
- **Production messaging** (real SMS/WhatsApp/email to customers).
- **Production payment capture** (real card/UPI money).
- **Irreversible legacy-data migration** into production (`MIGRATION_TARGET_KIND` stays `rehearsal`).

## Controls required for sensitive pilot actions

- **Feature flags / entitlements** default-off per tenant (`checkEntitlement`, M36-FR-01).
- **Kill switches** — the AI gateway and connector delivery can be halted without a redeploy.
- **Maker-checker** on refunds, price changes, privilege grants, erasure execution, cash sign-off.
- **RBAC default-deny** at the router; **tenant isolation** on every read/write.
- The production-only paths above additionally require an explicit owner GO (see `PILOT-GATES` in Phase 7).
