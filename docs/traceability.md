# Traceability

Traces every requirement from design through to a passing test and the release it
shipped in. Part of the Definition of Done in `CLAUDE.md`.

The roadmap (§37) provides a **family-level** baseline proving every requirement
family has an implementation route. **Stage 2 expands this to one row per
individual requirement** (`M##-FR-##`, `D##-FR-##`, `SEC-##`, `PRV-##`, `AI-NFR-##`,
`MG-##`, etc.) with design, code, automated-test and release references. No
requirement may reach **Done** without a complete individual row.

## Family-level baseline (roadmap §37)

| Requirement family | Workflow | Screens | Contract | Data | Test family | Release | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M01–M02, M33–M35 | WF-20 | Admin/Security | API-01/API-11 | Identity/Platform | Security, RBAC, DR, release | R1 | Not started |
| M03–M05 | WF-01/WF-06 | Product/Merchandising | API-02 | Product/Commercial | Catalogue/price/promotion/offline pack | R2 | Not started |
| M06–M07, M24 | WF-02–WF-05 | Purchase/Supplier | API-03 | Commercial/Purchase | PO/receipt/match/import | R2 | Not started |
| M08–M11 | WF-06–WF-09 | Inventory/Warehouse | API-04 | Inventory | Ledger/count/expiry/recall/offline | R2 | Not started |
| M12–M15 | WF-10–WF-12 | POS/Cash | API-05 | POS/Finance | Performance/offline/tender/fraud | R2 | Not started |
| M23, M29 | WF-05/WF-12/WF-18 | Finance/Owner | API-09/API-10 | POS/Finance | GST/Tally/reconciliation/profitability | R2 | Not started |
| MG programme | WF-19 | Migration | API-12 | Migration + all domains | Full-history trial/reconcile/cutover | R3 | Not started |
| M16–M17, M20–M21 | WF-13/WF-16/WF-17 | Customer/CRM | API-06/API-07 | Commercial/Order | Privacy/loyalty/order/refund | R4 | Not started |
| M18–M19 | WF-14–WF-15 | Picker/Delivery | API-07/API-08 | Order/Fulfilment | Reservation/substitution/proof/settlement | R5 | Not started |
| M22, M25–M28 | Relevant | B2B/Workforce/Facilities | Domain APIs | Operations/Commercial | Role UAT/compliance | R6 | Not started |
| A01–A10 | All governed | AI control + role surfaces | API-13 | AI + authorized domains | Evaluation/injection/authority/cost/kill switch | R7 | Not started |
| M36/innovation | Controlled extension | Admin/selected | Versioned APIs/events | Tenant/config | Isolation/upgrade/rollback | R8 | Not started |

## Individual requirement trace (expanded in Stage 2)

| Requirement ID | Stage | Design | Code | Tests | Release | Status |
| --- | --- | --- | --- | --- | --- | --- |
| M01-FR-01 | 2 | `docs/requirements/M01.md` | — | — | R1 | In design |
| M01-FR-02 | 2 | `docs/requirements/M01.md` | — | — | R1 | In design |
| M01-FR-03 | 2 | `docs/requirements/M01.md` | — | — | R1 | In design |
| M01-FR-04 | 2 | `docs/requirements/M01.md` | — | — | R1 | In design |
| M02-FR-01 | 2 | `docs/requirements/M02.md` | — | — | R1 | In design |
| M02-FR-02 | 2 | `docs/requirements/M02.md` | — | — | R1 | In design |
| M02-FR-03 | 2 | `docs/requirements/M02.md` | — | — | R1 | In design |
| M02-FR-04 | 2 | `docs/requirements/M02.md` | — | — | R1 | In design |
| M03-FR-01 | 2 | `docs/requirements/M03.md` | — | — | R2 | In design |
| M03-FR-02 | 2 | `docs/requirements/M03.md` | — | — | R2 | In design |
| M03-FR-03 | 2 | `docs/requirements/M03.md` | — | — | R2 | In design |
| M03-FR-04 | 2 | `docs/requirements/M03.md` | — | — | R2 | In design |
| M04-FR-01 | 2 | `docs/requirements/M04.md` | — | — | R2 | In design |
| M04-FR-02 | 2 | `docs/requirements/M04.md` | — | — | R2 | In design |
| M04-FR-03 | 2 | `docs/requirements/M04.md` | — | — | R2 | In design |
| M04-FR-04 | 2 | `docs/requirements/M04.md` | — | — | R2 | In design |
| M05-FR-01 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M05-FR-02 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M05-FR-03 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M05-FR-04 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M06-FR-01 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M06-FR-02 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M06-FR-03 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M06-FR-04 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M07-FR-01 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-02 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-03 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-04 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M08-FR-01 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-02 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-03 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-04 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M09-FR-01 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M09-FR-02 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M09-FR-03 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M09-FR-04 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M10-FR-01 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M10-FR-02 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M10-FR-03 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M10-FR-04 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M11-FR-01 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-02 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-03 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-04 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M12-FR-01 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-02 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-03 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-04 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M13-FR-01 | 2 | `docs/requirements/M13.md` | — | — | R2 | In design |
| M13-FR-02 | 2 | `docs/requirements/M13.md` | — | — | R2 | In design |
| M13-FR-03 | 2 | `docs/requirements/M13.md` | — | — | R2 | In design |
| M13-FR-04 | 2 | `docs/requirements/M13.md` | — | — | R2 | In design |
| M14-FR-01 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M14-FR-02 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M14-FR-03 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M14-FR-04 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M15-FR-01 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M15-FR-02 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M15-FR-03 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M15-FR-04 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M23-FR-01 | 2 | `docs/requirements/M23.md` | — | — | R2 | In design |
| M23-FR-02 | 2 | `docs/requirements/M23.md` | — | — | R2 | In design |
| M23-FR-03 | 2 | `docs/requirements/M23.md` | — | — | R2 | In design |
| M23-FR-04 | 2 | `docs/requirements/M23.md` | — | — | R2 | In design |
| M29-FR-01 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M29-FR-02 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M29-FR-03 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M29-FR-04 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M30-FR-01 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-02 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-03 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-04 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M32-FR-01 | 2 | `docs/requirements/M32.md` | — | — | R1 | In design |
| M32-FR-02 | 2 | `docs/requirements/M32.md` | — | — | R1 | In design |
| M32-FR-03 | 2 | `docs/requirements/M32.md` | — | — | R1 | In design |
| M32-FR-04 | 2 | `docs/requirements/M32.md` | — | — | R1 | In design |
| M33-FR-01 | 2 | `docs/requirements/M33.md` | — | — | R1 | In design |
| M33-FR-02 | 2 | `docs/requirements/M33.md` | — | — | R1 | In design |
| M33-FR-03 | 2 | `docs/requirements/M33.md` | — | — | R1 | In design |
| M33-FR-04 | 2 | `docs/requirements/M33.md` | — | — | R1 | In design |
| M34-FR-01 | 2 | `docs/requirements/M34.md` | — | — | R1 | In design |
| M34-FR-02 | 2 | `docs/requirements/M34.md` | — | — | R1 | In design |
| M34-FR-03 | 2 | `docs/requirements/M34.md` | — | — | R1 | In design |
| M34-FR-04 | 2 | `docs/requirements/M34.md` | — | — | R1 | In design |
| M35-FR-01 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-02 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-03 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-04 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| _(non-module requirement sets — SEC-01…12, PRV-01…10, NFR-01…15, AI-NFR-01…12, MG-01…12 — traced during their build stages)_ | | | | | | |
