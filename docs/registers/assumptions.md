# Assumption Register

Every assumption made while building without a confirmed fact, so none of them becomes an
invisible decision. Each one names what happens if it turns out to be wrong.

Status: **Open** (unconfirmed, safe default in use) · **Confirmed** · **Corrected**.

| ID | Assumption | Basis | If wrong | Status |
| --- | --- | --- | --- | --- |
| AS-01 | The controlling roadmap in the repo (`roadmap-v2.0.docx`, "Consolidated developer-ready baseline") carries the same **scope** as the v2.1 "Final Audit-Closed" baseline named in the owner's authorization. | v2.0's own change-control rule: *"No feature is removed. It is either approved, deferred, rejected with reason, or marked AVR"*, and *"AVR identifies facts to confirm; it never authorizes omission."* An audit-closed revision therefore **closes AVR facts**; it cannot have removed scope. | No scope is lost either way — v2.1 would add closed facts, which arrive through the Owner Configuration Register regardless. **Requested**: add `roadmap-v2.1.docx` to `docs/roadmap/` when convenient, and I will re-run the traceability diff. | **Open** |
| AS-02 | Currency is INR and the store trades in one currency. | Roadmap §29.1, Tamil Nadu single site. | `SETTINGS.BASE_CURRENCY` changes it; money is currency-tagged throughout, so nothing breaks. | Open |
| AS-03 | One company, one GSTIN, one branch at go-live. | Roadmap §5 M01; AVR-01 unanswered. | The hierarchy already models many companies/GSTINs/branches; adding them is data entry. | Open |
| AS-04 | Payment card data never reaches our systems — provider tokens only. | Hard rule #3, roadmap §35. | Non-negotiable; not an assumption we would revise. | **Confirmed** (rule) |
| AS-05 | The lane must keep trading through a 72-hour outage. | Roadmap §31 / AVR-17 baseline. | Longer needs a bigger local cache; the design is already outage-length-agnostic. | Open |
| AS-06 | Weighed departments use an EAN-13 embedded weight/price barcode with prefix `2`. | Common Indian retail scale default (M03-FR-02, D01). | `EmbeddedBarcodeRule` is per tenant; changing it changes both the label and the scan together. | Open |
| AS-07 | Suppliers deliver against a purchase order, and invoices arrive per delivery. | Roadmap M06/M07 flows. | Direct-store delivery without a PO is already handled (`poId: null`); invoice-per-period would need a matching variant — recorded as a gap, not a silent one. | Open |
| AS-08 | Tally is the accounting system of record for statutory filing. | OD-06 / roadmap §5 M23, AVR-09 unanswered. | The finance posting engine is mapping-driven; another package needs a new mapping, not new logic. | Open |
| AS-09 | The store's scales, printers and scanners are ordinary ESC/POS and HID devices. | Roadmap §33 certified-matrix approach. | Adapters are ports (`PrinterPort`); an unusual device needs an adapter, not a redesign. | Open |
| AS-10 | Staff each get their own login at go-live (no shared accounts). | Hard rule #4; the system **refuses** to create shared accounts. | If the store cannot supply enough named users at go-live, that is a **cutover blocker**, not a system change. Flagged early deliberately. | Open |
| AS-11 | Production data will live in a single-region managed PostgreSQL with daily backups. | ADR-0002 / roadmap §19, hosting deferred (OB-02). | The `SqlClient` port keeps the engine portable; restore proof is rehearsed locally first. | Open |
| AS-12 | Café output is sold same-day; nothing the café makes is stored beyond its use-by. | Food-safety norm; OC-03 unconfirmed. | Shelf life is per recipe and already mandatory — a longer-life item just carries a longer value. | Open |
