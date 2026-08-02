# AVR closure — Audit Validation Required items (roadmap §13)

Twenty items the roadmap flags as **needing validation before final specification**.
Stage 1 closes them. Annexure G finding A-11 adds the control: **a stage may not
enter GO while an AVR item mapped to it remains open**.

Each AVR needs a **named person who will answer it** (Stage 1 acceptance) plus the
finding and its status. Fill the right-hand columns during Stage 1.

> **Owner-friendly version:** `store-facts-questionnaire.md` (the **Store Setup Profile**)
> turns every item below into a plain-language, choose-able setting grouped by who answers it
> (owner / floor manager / accounts / IT / payments / privacy), plus the trading-day cut-off.
>
> **Per ADR-0003 (commercial, multi-tenant product):** these items are **per-tenant
> configuration**, not product constants. The answers below configure **SRE Hyper Market as
> tenant #1** (the pilot); every future retail tenant supplies its own the same way, at
> onboarding. Nothing here is hard-coded into the product.

Status legend: **Open** · **In progress** · **Closed**.

| AVR ID | Audit decision / fact required | Who answers | Finding / answer | Status |
| --- | --- | --- | --- | --- |
| AVR-01 | Legal company/GST/branch structure | | | Open |
| AVR-02 | Store area, departments, lanes, warehouses and future branches | | | Open |
| AVR-03 | Previous-system source/version/export method, data coverage and **lawful extraction rights** | | | Open |
| AVR-04 | SKU, barcode, supplier, customer and transaction volumes | | | Open |
| AVR-05 | Current stock accuracy, batch/expiry quality and negative stock | | | Open |
| AVR-06 | Hardware, OS, LAN, internet, server, UPS and peripheral inventory | | | Open |
| AVR-07 | Purchase, receiving, pricing, billing, return, cash and closure workflows | | | Open |
| AVR-08 | Roles, approval limits, shared credentials and manpower dependencies | | | Open |
| AVR-09 | Tally version/company structure and current accounting workflow | | | Open |
| AVR-10 | Payment providers, terminals, settlement and refund processes | | | Open |
| AVR-11 | FSSAI, Legal Metrology and local licences/registrations | | | Open |
| AVR-12 | Fresh production, pharmacy, food court, concession or regulated departments (**conditional module trigger**) | | | Open |
| AVR-13 | Delivery radius, model, capacity, slots, fleet and partner strategy | | | Open |
| AVR-14 | Customer app launch geography, payments, loyalty and service policy | | | Open |
| AVR-15 | Data retention, privacy notice, consent and grievance practices | | | Open |
| AVR-16 | Backup, restore, cyber controls and historical incidents | | | Open |
| AVR-17 | Peak billing throughput, outage history and performance baseline | | | Open |
| AVR-18 | Migration coexistence, cutover window and legacy archive obligation | | | Open |
| AVR-19 | Languages, accessibility and staff training needs | | | Open |
| AVR-20 | Build team, budget, timeline, hosting and support operating model | | | Open |

> **AVR-12** decides which conditional departments (roadmap §2.2) are built in
> Stage 16 — do not build a module for a department the store does not operate.
> **AVR-03** feeds the ERP-vendor data-access letter (`legacy-data-access.md`).
