# Legacy data access — request to the incumbent ERP/POS vendor

**Why this exists and why it is first.** The Annexure G audit calls the request to
your current ERP vendor _"the longest-lead item in the whole programme"_, and the
Stage 1 acceptance list says it should be **sent** before Stage 1 is accepted.
Getting your own data out of the old system is the single thing most likely to
delay cutover if it is left late — so this letter is ready to send now. Fill the
bracketed blanks and send it.

> This is preparation drafted during Stage 0. Send it as soon as the owner is
> ready; you do not need to wait for the Stage 0 gate to sign.

---

## The letter (copy, fill the blanks, send)

> **To:** [Vendor company name], [Support / Account manager name]
> **From:** SRE Hyper Market, [your address], Tamil Nadu
> **Date:** [date]
> **Subject:** Request for access to and export of our business data held in [current ERP/POS product name]

Dear [name],

We are the owners of the SRE Hyper Market business data held and processed in
[current ERP/POS product name], which we license from you under [contract/licence
reference, if known]. We are undertaking an internal data review and modernisation
and require full, ongoing access to **our own business data**.

Please provide, within **[15] working days**:

1. **A complete export of our data** in an open, documented format (CSV, XML, JSON
   or SQL dump), covering at least: products and barcodes; price and MRP history;
   suppliers and purchase orders; goods receipts and invoices; stock and stock
   movements; customers and loyalty; sales/bills and tenders; tax records (GST);
   accounting ledgers and balances; and any documents/attachments.
2. **A data dictionary** or schema describing the tables/fields, their meaning,
   types and relationships.
3. **The method of ongoing access** you support — one of: read-only database
   access, a documented API, or a scheduled file export — so we can reconcile
   during a parallel-running period.
4. **The full historical range** available, with the earliest date held.
5. Confirmation of **any format, size or frequency limits**, and any fee.

We are requesting access to our own operational records; this is not a request for
your source code or proprietary software. Please confirm receipt and give us a
named contact and a date by which each item will be provided.

Yours sincerely,
[Owner name], Proprietor, SRE Hyper Market
[phone] · [email]

---

## What to do if they refuse, delay, or stall

1. **Get the refusal in writing** and the specific reason. "It is not possible" is
   not a reason; ask which of the five items specifically, and why.
2. **Point to ownership.** The operational records are your business data, not the
   vendor's software. Reference your licence/contract terms on data access and
   termination assistance.
3. **Escalate** from support to your account manager to their management, in
   writing, keeping a dated trail (this becomes evidence in the issues register).
4. **Set a fallback in motion in parallel — do not wait:**
   - **Screen/report exports:** every standard report the old system can print or
     export to Excel/PDF, pulled systematically and dated.
   - **Manual/assisted extraction:** structured re-keying or OCR of printed
     reports for the records that cannot be exported, into the migration staging
     area with the same reconciliation checks.
   - **Database-level read** if you host the system yourself or hold credentials.
5. **Record it.** Log the refusal as an issue (`I-##`) and, if it changes scope or
   timeline, raise a change (`CH-##`). This risk maps to migration risk **R-19**.

> **Never** learn a data-access problem during the real cutover. That is exactly
> what this early letter is designed to prevent.
