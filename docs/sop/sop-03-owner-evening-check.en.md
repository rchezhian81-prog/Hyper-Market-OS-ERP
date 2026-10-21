# Sheet 3 — The owner's evening check (parallel-run day)

**Sheet id:** SOP-03 · **Decisions:** OB-254 (the owner is the daily reconciler and the incident owner for the first two
weeks), MG-10, OB-263 (the old ERP's item-wise and bill-wise reports, loaded as files), OB-256 and OB-265 (payments and
loyalty are not compared in the mirror pilot), OB-264 (the old bill number), OB-269 (exchanges on the old ERP only) ·
**Language:** English (Tamil: `sop-03-owner-evening-check.ta.md`)
**For:** the owner, every evening after closing.

> **Before the first day:** the parallel-run terms (who reconciles every day, how many clean days) must be written once,
> with `store-computer parallel-policy` (owner guide Part 23), and the pilot department's products loaded (Part 22). The
> new till's side of the check is the store computer's own record of the day's mirror sales and refunds: every one was
> keyed "Paid on old system" with the old bill number (Sheet 2, steps 5 to 7).

**Have ready:** today's Sheet 1 table; today's Sheet 2 list; a USB stick or folder for two files.

1. Read Sheet 1. If the new till stopped today, note the times: the items rung on the old till while it was stopped are
   missing from the new system. That is the reason for those differences.
2. Read Sheet 2's list: each barcode not in the catalogue, each price that differed, and each exchange (done on the old
   ERP only, OB-269). Each one explains a difference.
3. **On the old ERP, save the item-wise sales report for today.** The menu names differ from one ERP to another, so look
   for the sales reports and choose the one that lists each item with its quantity, value and tax ("item-wise",
   "product-wise" or similar). Choose today's date only. If the report lets you choose a department or category, choose
   the pilot department only. Send it to Excel (an "Export" or "Excel" button). If you cannot find the report, **STOP AND
   ASK**: send a photo of the reports menu.
4. **On the old ERP, save the bill-wise list for today** the same way: the report that lists each bill with its bill
   number, date and total ("bill-wise", "invoice register" or similar). If it can also show the items on each bill, choose
   that — the check is then fuller. Today's date only.
5. **In Excel, save each one as CSV.** Press **File**, then **Save As**, then choose the type **CSV UTF-8 (Comma
   delimited) (\*.csv)**. Give them names you will know, for example `item-wise 21-10-2026.csv` and
   `bill-wise 21-10-2026.csv`, in a folder such as `C:\SRE-evening`. If a barcode column shows numbers like
   `8.90123E+12`, its digits are lost: select that column, choose **Format Cells**, **Text**, type the codes again or
   export again, and save. Leave the customer name and mobile columns as they are — the new system never reads them.
6. In **your own** Windows account, open the migration screen: in Microsoft Edge open the till favourite, and in the
   address bar change the word `pos` at the end to `migration`. Press Enter. The screen says **Enter your PIN**: type
   your own staff ID and your own till PIN, and press **Sign in** (OB-259).
7. Click **Running both**. Under **Evening check from the old system's files**, check the pilot department it names, and
   set **Which day** to today.
8. **The first time only — say which column is which.** Under **1.** pick the item-wise file. The screen shows
   **Which column is which**: for each of our fields (**Item code or barcode**, **Quantity sold**, **Sales value (₹)**,
   **Tax (₹)**, the date if the report has one) choose the old ERP's own column from the list. Never choose a customer's
   name or mobile column. Answer **How does the report write its dates?** and **Does the report's sales value already
   include the tax?**.
   - If the report has a department column (OB-263 A): choose it for **Department**, then in
     **Which of these is the pilot department?** choose the pilot department's own name, from the names the file holds. The other departments'
     rows are then left out, and the screen says how many — never silently. If the report has no department column,
     leave **Department** at **Not in this report** and save the report for the pilot department only (step 3).
   - Press **Save the mapping**.

   Then under **2.** pick the bill-wise file and do the same (**Bill number**, **Bill date**, **Bill total (₹)**, and the
   item columns if the report has them). With the item columns, answer
   **Do the bill lines' values already include the tax?** (OB-263 B): look at one bill on the old ERP — if a line's amount is the price the customer paid, choose yes; if
   it is the amount before tax, choose no. Then each bill is compared without tax on both sides. Press **Save the
   mapping**.
   - The mapping is kept on the store computer and shown under **Which column is which (saved on this store computer)**,
     with who set it and when. If the old ERP's report ever changes, the screen says a column is missing: press
     **Change** and choose again. Every earlier mapping is kept.
   - **Item-wise template** and **Bill-wise template** download our own column names, if you want to see what each means.
9. **Every evening — load the two files.** Pick the item-wise file under **1.** and the bill-wise file under **2.**; each
   must say **Columns found — ready to load**. Leave **Allowed difference in value (₹)** and **Allowed difference in tax
   (₹)** at 0 unless you have decided otherwise. Press **Load and compare**.
   - A file for another day, a missing column, or a line it cannot read is refused, and the screen says which line. Fix
     the file in Excel, save it as CSV again, and load again.
10. **Read the differences**, top to bottom:
    - **The day's totals (pilot department)**: sales value, tax, number of bills and quantity — old system beside the new
      till. **Payments taken (₹)** and **Loyalty points** say **Not compared in the mirror pilot** (OB-256, OB-265): the
      old ERP takes every payment and keeps loyalty. They are never counted as zero. **Not known** means a file did not
      say it — it is never a zero.
    - **Items that differ** and **Not in the new catalogue**: an item on the old report the new till does not have.
    - **Bill by bill**: an old bill with pilot items **not keyed on the new till**; a bill keyed on the new till **not on
      the old list** (the old bill number was mistyped, or it is another day's); a bill whose pilot items **differ in
      value**. If the bill-wise list has no item lines, the screen says that only the keyed bills could be checked.
    - **To explain: returns, credit notes and exchanges on the old system** — write what each one was (OB-269).
    - To check one bill by hand, **Bill by bill (mirror pilot)** further down lists the day's sales on the new till:
      **New bill**, **Old bill**, **Amount** and **Refunded**.
11. **Write a reason on every difference.** In **Why do they differ** write what really happened, in a full sentence, and
    choose in **Which one was wrong**: the old system, the new system, both, or neither — a timing difference. Never
    write "the new one is probably right". Press **Save the reasons**.
12. In **What you checked (in your own words)**, write a full sentence, for example "compared the old ERP's item-wise
    report and bill list with the new till, item by item and bill by bill". Press **Sign the day**.
    - It refuses while any difference has no reason, and names it. Go back to step 11.
    - If you load the files for the day again later, the new figures replace the old ones, the screen shows the earlier
      load in its history, and the earlier signature no longer applies: write the reasons and sign again.
13. Press **Sign out** (bottom right of the screen). Put today's Sheets 1 and 2 in the day's folder and initial them.

| Date | Differences found | All explained (yes/no) | Day signed (yes/no) | Owner's initials |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |
