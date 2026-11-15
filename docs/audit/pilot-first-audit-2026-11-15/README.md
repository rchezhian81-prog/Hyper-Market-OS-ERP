# Pilot-first audit (OB-739) — 15 November 2026

_Owner decision OB-739 "A": every page and action the pilot department (packaged groceries, OB-276) needs, as each role,
on the store PC's own version; bugs and setup gaps listed apart, then fixed in rounds the owner orders. Three read-only
auditors ran the real code (head office's routes in the in-memory harness, the store box's screen server in real Chromium,
the demo seed `db/seed/pilot`); scripts and raw output were kept outside the repository. Nothing was changed by the audit._

Classes: **BUG** (does the wrong thing) · **MISSING** (the pilot needs it, nothing does it) · **SETUP GAP** (works, the
store PC has not been given it) · **DOC** (a guide is wrong). Severity: **BLOCKS PILOT** · **HURTS** · **COSMETIC**.

## The root cause behind most of the owner's photo (C-1 = D-1)

The store PC runs the database, the office API and the till as Windows services (ADR-0032). Its office pages sign in by
staff ID + PIN (OB-259), but every page that reads or saves through the office API (`/v1/...`) needs a head-office
sign-in issuer (OB-388); the Windows-services install has none, so the screen server cuts those calls
(`edge/store-edge/src/screen-server.ts` ~806–815). That is why "Connected" (the store box's own sync) and "Head office
could not be reached" (the page's own reads) appear together, and why **no item, barcode, price, HSN, approval, report
or settlement page can read or save on the store PC**. CR-01 step 4a (OB-731, ADR-0033) began exactly this for Users &
roles only. This is the first thing to fix.

## Items and prices (C)

| id | class | severity | finding |
|---|---|---|---|
| C-1 | BUG | BLOCKS PILOT | Every item/price page on the store PC says "Head office could not be reached. Nothing was saved" — see the root cause. Only the Import page and commands work. |
| C-2 | BUG | HURTS | A packaged item with no MRP saves as Active and goes into the pack; no "no MRP" check. |
| C-3 | BUG | HURTS | HSN is not checked ("abc" accepted); an HSN with no GST rate shows "On sale" yet is silently left out of the till pack. |
| C-4 | BUG | HURTS | Lowering MRP below the shelf price is accepted with no warning; the item then drops out and the pack publish is refused. |
| C-5 | BUG | HURTS | A store manager can set a first price with no second person, down to ₹1, when no cost is known (margin floor skipped). |
| C-6 | BUG | HURTS | Price lists page refuses a price while the cost is unknown; the API accepts it — a new item cannot be priced on screen before its first receipt. |
| C-7 | MISSING | HURTS | A barcode cannot be removed or moved; a mis-keyed barcode blocks the right item for good. |
| C-8 | MISSING (decision) | HURTS | Only the owner can add/change an item, barcode, GST rate or the pack; the owner is the single bottleneck. |
| C-9 | BUG | HURTS | The accountant approves GST/HSN changes but cannot open the GST rates or Product details pages. |
| C-10 | MISSING | HURTS | No "New item" button: the person must invent a product id. |
| C-11 | DOC | HURTS | Owner guide Parts 19–27 still use `pnpm run store-computer` / `migration:slice` and "Quit Docker Desktop". |
| C-12 | MISSING | HURTS | Item import template has no barcode, MRP, price or cost columns and cannot update existing items (CR-01 4f). |
| C-13 | BUG | COSMETIC | A 14-digit GTIN with leading zeros is not found at the till. |

## Buying (B)

| id | class | severity | finding |
|---|---|---|---|
| B-1 | BUG | BLOCKS PILOT | No supplier can ever be paid with the pilot's people: the payer/approver check runs against EVERY open bill of the supplier, not the bills being paid; only owner and accountant may pay and one of them always matched. |
| B-2 | BUG | HURTS | Goods receipt review shows quantities 100 times too small (10 pieces → "0.1 units"). |
| B-3 | BUG | HURTS | A warehouse user can sign in on the handheld and scan a delivery, but head office refuses every receipt from that role; the scans sit refused. |
| B-4 | SETUP GAP | HURTS | The receiving person needs the Receiver / QC (or store manager) role — Users & roles page. |
| B-5 | MISSING | HURTS | A goods receipt cannot be corrected (no compensating entry that also fixes the order and the bill match). |
| B-6 | MISSING | HURTS | A proposed order cannot be refused, withdrawn or changed. |
| B-7 | BUG | HURTS | A supplier's GSTIN is never checked ("NOT-A-GSTIN" approved). |
| B-8 | BUG | HURTS | After approval, the proposer can change a supplier's name and GSTIN with no second person; a partial update blanks other fields. |
| B-9 | BUG | HURTS | A supplier bill's GST rate is not checked against the item's rate (18% item billed at 5% "agrees"). |
| B-10 | MISSING | HURTS | A Tamil Nadu bill with a "round off −0.40" line, or a rounded line total, cannot be typed in. |
| B-11 | MISSING | HURTS | A supplier's bank record has no IFSC, account holder or bank name. |
| B-12 | BUG | COSMETIC | Bill-match wording is misleading for order lines not on the bill; summary before GST vs payable after GST. |
| B-13 | SETUP GAP | HURTS | Buying page: "not been told what this shop stocks" until a price list is published (guide Parts 22–24). |
| B-14 | SETUP GAP | HURTS | Pilot suppliers need a GSTIN and a verified bank (Suppliers page) before payment and e-way checks. |
| B-15 | SETUP GAP | HURTS | An order's deliver-to place must exist on the Organisation page. |
| B-16 | MISSING | COSMETIC | Imported products have no handling class; every receipt is flagged `handling_unknown`. |
| B-17 | BUG | COSMETIC | Office sign-in refusal names only owner/manager/accountant; four more roles may open the office. |
| B-18 | BUG | COSMETIC | Head office refusals are English only; some buying pages say "not checked yet" while others say "Connected". |
| B-19 | MISSING | HURTS | No import of suppliers, orders or bills from a screen (CR-01 4f). |

## The shop day (D)

| id | class | severity | finding |
|---|---|---|---|
| D-1 | BUG | BLOCKS PILOT | = C-1: with PIN sign-in, office pages cannot read the office API on the same PC (Approvals, Company report, Morning brief, GST returns, Settlement). |
| D-2 | BUG | BLOCKS PILOT | Cash over/short says "every drawer is signed off" right after a till closed ₹649.50 short; a failed read falls back to an empty list (P-08 breach). |
| D-3 | MISSING | BLOCKS PILOT | No page or command sets the store rules (closing checklist, near-expiry days, approval limit, margin floor, finance settings): Today's tiles stay Not known; Reports and Expiry show sample data. |
| D-4 | BUG | HURTS | Till quantity box starts at "1": tapping 3 gives 13. |
| D-5 | BUG | HURTS | The till takes cash with no float taken, and More has no "Close till", so no blind count. |
| D-6 | BUG | HURTS | UPI asks "What did the card machine say?" (Tamil too). |
| D-7 | BUG | HURTS | "Not yet sent" and the day-close list count only sales, not the float and till-close records. |
| D-8 | BUG | COSMETIC | Day-close blocker shows the raw name "SaleCommitted". |
| D-9 | BUG | COSMETIC | Tasks-today reason is English only in Tamil and worded unlike the Checklist tile. |
| D-10 | BUG | HURTS | Reports/Expiry say "Sample data", "as head office last sent it" and "never sent anything" on one screen; Expiry says nobody is signed in while the manager is. |
| D-11 | BUG | HURTS | Without their pack section, Cash over/short, Day book and Reopen a day show sample figures WITH action buttons. |
| D-12 | DOC | HURTS | = C-11. |
| D-13 | SETUP GAP | HURTS | Till bill-number prefix (guide Part 19); until then every sale carries a long notice and "ZZ…" bill numbers. |
| D-14 | BUG | COSMETIC | OK on an empty Cash sheet closes it silently. |

**Today photo, tile by tile:** Tasks / Checklist / Expiring soon — SETUP GAP, the store rules (D-3). Deliveries today —
MISSING for every store PC (head office builds no deliveries section). Approvals 0 — counts only three box-relayed kinds;
head office's inbox unreachable (D-1). Lane devices — MISSING (no device adapter ships). Purchase orders 0 — the box's own
copy, believable; the note is D-1. `/manager/` — the office Today page; the `/office/` front door is CR-01 4f.

## What was verified working

Supplier approval by a second person; the PO total and issue by a second person; receiving short / excess / damaged with
a second person deciding, debit notes, the stock ledger append-only; owner creates a packaged item with HSN, MRP, label
facts and two barcodes (Tamil reads correctly); price-above-MRP refused; HSN change on a live item waits for Finance; the
pack carries every barcode, GST and MRP; the till finds items by both EANs and by name; GST on the slip correct; 34
existing browser tests in these areas pass.

## Not verified (said plainly)

The real store PC's data (which roles, rules, prefix and suppliers it holds); printer, scanner and card-machine hardware;
sync draining after a real outage; the Import page end to end; the WF-01 new-item test on PostgreSQL.
