# Compliance register

Stable IDs `C-##`. Every external legal / regulatory obligation, the requirement
it places on the product, the validator role that signs it off, and any fixed
immovable date.

> **Sourcing.** From Annexure G (§35, CERT-In, DPDP dates), Annexure H (Stage 0,
> 10, 14, 16 prompts) and the roadmap technology baseline. Validator roles are as
> named by the roadmap where available; confirm against roadmap §35 / §36 RACI
> when `docs/roadmap/roadmap-v2.0.docx` is added. Regulatory dates are stated for
> planning and are not legal advice.

Status legend: **Not started** · **In design** · **Implemented** · **Verified**.

| ID | Obligation | What the product must do | Validator role | Fixed date | Status | Source |
| --- | --- | --- | --- | --- | --- | --- |
| C-01 | **GST** (incl. e-invoice) | GST configuration; credit & debit notes; tax audit evidence; e-invoice provider integration; period close and balance validation. | CA / Finance | — | Not started | Stage 10 (M23, D10) |
| C-02 | **FSSAI / food safety** | Food-safety traceability from supplier lot to customer sale; recall initiation & closure evidence; cold-chain evidence; licence & certificate expiry alerts to a named person. | Store Operations / food-safety lead | — | Not started | Stage 8, Stage 16 (M11, D05) |
| C-03 | **Legal Metrology** | Correct handling of weighed and packed goods; variable-weight barcodes; declarations for packed goods. | Store Operations | — | Not started | Stage 16 |
| C-04 | **DPDP (data protection)** | Itemised notice separate from T&Cs; marketing consent taken separately; withdrawal as easy as consent; rights centre (access, correction, export, erasure); grievance route; retention that preserves what tax law requires; **detailed breach report within 72 hours**; **security logs retained ≥ 1 year**; named published grievance officer. Applies to customer data **already held at billing**, not only the future app. | Grievance Officer / DPO | **13 Nov 2026** Consent Manager framework operational; **13 May 2027** DPDP Rules full compliance — both immovable | Not started | Annexure G A-06; Stage 0 & Stage 14 |
| C-05 | **CERT-In** | Six-hour security-incident reporting workflow; evidence sufficient to report. | Security lead | 6-hour report window (per incident) | Not started | Annexure G (§35) |
| C-06 | **Consumer / e-commerce** | Grievance route; service desk with SLA; compensation approval; clear returns/refunds policy. | Customer service lead | — | Not started | Stage 14 (M21) |
| C-07 | **Payment (RBI)** | Use **only an RBI-authorised payment aggregator**, verified against the RBI published list; **never see, transmit or store a card number, CVV or expiry**; saved cards = provider tokenisation only; **independent penetration test must pass before customer launch**. | Owner + Finance + Security | Pentest before go-live | Not started | Annexure G G-11; Stage 14; hard rule #3 |
