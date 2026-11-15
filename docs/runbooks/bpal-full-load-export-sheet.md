# Bpal full load — what to export, and the steps on the store PC
## Bpal முழு ஏற்றம் — என்ன எடுப்பது, கடை கணினியில் என்ன செய்வது

_One page. Print it. For the owner (OB-800, 15 Nov 2026: no pilot department — the whole store, every department, is
loaded from Bpal and run alongside it). Made from the owner guide, Part 22 and Part 24. The Tamil headings are not yet
checked by a Tamil reader._

---

### 1. Before anything is read: the backup check (MG-02) — முதலில்: காப்பு நகல் சோதனை

Do this **first**. Nothing is read from Bpal until it is done.

1. Take Bpal's own backup, the way your Bpal vendor set it up for you.
2. **Restore it on another PC** — never on the PC that bills customers.
3. Open Bpal on that other PC. Check that it **opens**, and that the **latest bill** is there (the last bill number and
   date from the shop's billing PC).
4. Write it down:

   | Day checked | Latest bill number | Its date | Checked by |
   |---|---|---|---|
   | | | | |

The Import page asks this day the first time you read the files.

**If it does not open, or the latest bill is missing: STOP.** Call your Bpal vendor. Do not export.

---

### 2. What to export from Bpal — Bpal-இல் இருந்து என்ன எடுப்பது

From Bpal's **report screens only**. **Every department**: if a report asks for a department, group or category, choose
**All** (or leave it blank). Save each as **Excel (.xlsx)**.

| Report in Bpal | Dates to put in Bpal's date boxes (month first) | Files |
|---|---|---|
| **EANCODE** report (Item Id, Item Name, EanCode) | No dates — all items | 1 |
| **HSN** report (Item Id, Hsn Code, Item Quantity, Gst %) | The **same 12 months** as the prices (OB-738): `11/01/2025` to today | 1 (or more, if Bpal splits it) |
| **Product wise Detail Report** (Purc Date, MRP, Selling, NetCost) | **3 months per file**, 12 months: `11/01/2025`–`01/31/2026` · `02/01/2026`–`04/30/2026` · `05/01/2026`–`07/31/2026` · `08/01/2026`–`10/31/2026` · `11/01/2026`–today | 5 |

- **Month first:** `11/01/2025` means **1 November 2025**. If you export in a later month, move every box forward by
  the same number of months.
- **Where to save:** on the store PC, one new folder for this export, for example `C:\SRE-Bpal-export\2026-11-15`. Put
  every file in it. The names do not matter — the page tells the files apart by their columns.
- **Never** email, WhatsApp or upload these files. They hold the shop's prices and costs.

**Please confirm (write ✓ or the right name):** the three report names above are the ones used so far (owner guide,
Part 22). If Bpal's Reports menu calls any of them something else, or a report has a department box: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_.
If a report also has a **date box** we have not listed (for example the EANCODE report): \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_.

---

### 3. On the store PC, in this order — கடை கணினியில், இந்த வரிசையில்

| # | Step | Who | What you should see |
|---|---|---|---|
| 1 | Double-click **SRE Import** on the desktop (first time: owner guide Part 22). Sign in with your staff ID and till PIN. | You | `Signed in: owner-01` at the top. |
| 2 | Choose **all** the files together (hold **Ctrl**, click each), type the backup check day (section 1), press **Read the files**. | You | `Read: … items, every department. Barcodes: 1 file(s) · HSN: 1 file(s) · prices: 5 file(s), … rows, from … to …`. A line **By department —** with each department and how many are ready or waiting. |
| 3 | **Fix the gaps, best sellers first** (the list starts with them). Open an item, fix it, **Save this fix**. **Barcode or sold loose**: scan the pack — or, for loose goods, choose **By weight (kg)** or **By count**, the scale PLU if any, **Save: sold loose**. **Price**: MRP, selling, cost. **Label facts (needed first)**: every department except packaged groceries. **Leave it out of the load**: items no longer sold. | You or the store manager | `Saved for <item>.` The tile numbers go **down**. Tobacco, medicines and gold say **Set up on the Products page** — they never load from Bpal. |
| 4 | **Finance marks the two-rate HSN codes.** The accountant signs in on the same page, opens the tile **GST rate (Finance)**, chooses the right HSN and slab for each item, writes why. Your staff or Bpal vendor makes the **same correction in Bpal** (OB-697). | Accountant (or you) | `Saved for <item>.` The **GST rate (Finance)** tile goes to **0**. Anyone else trying gets `only Finance`. |
| 5 | **Load, by two people.** You: **Prepare a load** (your PIN). Store manager: reads the list, writes what he read, **Accept** (his PIN). You: **Load** (your PIN). | You + store manager | `Prepared … with … item(s) — Packaged groceries: … · Personal care: … ·` then `Accepted.` then `Loaded. Publish the price list to the till next`. **Download what was set aside** gives the list of what did not load and why. |
| 6 | **Publish prices** (owner guide Part 24): `.\runtime\node\node.exe .\scripts\store-computer.mjs publish-catalogue --as owner-01 --store <store-code>`, type `YES`, then your PIN. | You | `done — the catalogue pack version … is published.` and `DONE —`. |
| 7 | **First sale.** On the till, scan three packed items from **different departments**, and weigh one loose item on the scale and scan the **scale's label**. Check each name and price against Bpal. | Cashier, you watching | Within a few minutes the till stops saying it has no price list. Each line matches Bpal. A loose item scanned **without** a scale label is refused: "sold by weight … weigh it on a verified scale and scan the scale's label". |

**Send:** a photo of the till screen with the lines from step 7.

---

### 4. Questions for you — உங்களுக்கான கேள்விகள்

- **Label facts outside packaged groceries.** Today only packaged groceries may load before their label facts are read
  (OB-738, "sell at the till only"). Household, personal care, dairy and loose foods wait until their facts are typed.
  Whether to change that is your decision — it is asked separately, with options.
- **The evening check** (owner guide Part 31) now compares the **whole store**: every department's totals (the same
  departments as this load, from the HSN code) and the whole store's total; loose goods to the gram. Export Bpal's
  item-wise report for **every department** — never one. Whether to allow a small kg rounding difference is asked
  separately; until you decide, even one gram shows as a difference.
