# UAT and owner-witness calendar

Activities that **require the owner or the store**, scheduled to the gate where they
belong. Nothing here blocks development; each item is already built and automatically
tested, and the entry exists because the roadmap requires a **human** to witness or supply
something at a specific point.

**These are not open questions.** Do not raise them again before their gate.

Status: **Scheduled** · **Done** · **Waived with reason**.

| ID | Activity | Requirement | Gate / when | Owner approval | Status |
| --- | --- | --- | --- | --- | --- |
| **UAT-01** | **Owner-witnessed destroy-and-restore.** A test database is destroyed and restored while the owner watches (~10 minutes). | M35-FR-01 acceptance · QG-08 | **Pre-go-live, Stage 12 pilot** | ✅ **Approved as a deferred pre-go-live UAT activity (owner, 4 Aug 2026).** Do not ask again before Stage 12. | Scheduled |
| UAT-02 | Master-data configuration workshop — work down the **Owner Configuration Register** (28 items), accepting defaults or giving values. | OC-01…28 | Stage 12 pilot preparation | Not yet required | Scheduled |
| UAT-03 | Café configuration — recipes, yields, portion sizes, use-by periods, what is made on site. | OC-01…05, M11 | UAT-02 session | Not yet required | Scheduled |
| UAT-04 | Licence and certificate register — the actual FSSAI, Legal Metrology, trade and fire documents, each with a **named** responsible person. | M34-FR-03 · OC-19 · AVR-11 | UAT-02 session | Not yet required | Scheduled |
| UAT-05 | Staff account provisioning — one named login per person; no shared accounts exist and none can be created. | M02-FR-01 · AS-10 | Stage 12 pilot | Not yet required | Scheduled |
| UAT-06 | **QG-02 usability testing with real staff** — cashier, manager, warehouse task targets on the real screens. | QG-02 · Stage 3 open gate | Whenever staff are available | Not yet required | Scheduled |
| UAT-07 | Store-recovery drill — the ≤30-minute RTO target proven in the store, with committed sales lost = 0. | M35-FR-02 · QG-08 | Stage 12 pilot | Not yet required | Scheduled |
| UAT-08 | Outage drill — pull the network cable mid-basket; the sale completes, prints and later syncs exactly once. | QG-04 · hard rule #1 | Stage 12 pilot | Not yet required | Scheduled |
| UAT-09 | Migration reconciliation sign-off — control totals for stock, financial, tax and loyalty signed by the owner and the CA. | QG-07 · MG-06 | Stage 13 cutover | **Owner + CA signature required** | Scheduled |
| UAT-10 | Independent penetration test before customer launch. | QG-06 · EX-13 | Stage 14 | **Paid engagement — owner decision** | Scheduled |
| UAT-11 | Formal GO for production cutover. | QG-12 · OD-10 | Stage 13 | **Owner GO required** | Scheduled |
| UAT-12 | **Live recall drill** — pick a real batch, recall it, and time how long it takes the manager to say how much went out and which customers can be telephoned. The lane must refuse it with the network cable out. | M10-FR-02/04 · QG-07 · Stage 8 gate | Stage 12 pilot | Not yet required | Scheduled |
| UAT-13 | **Blind stock count walkthrough** — count one product without looking at the screen; confirm the system refuses to correct itself until a second, more senior person approves the difference with a reason, and that the corrected figure equals what was physically counted. | M09-FR-04 · M08-FR-03 · §28 · Stage 8 gate | UAT-02 session | Not yet required | Scheduled |
| UAT-14 | **Parked-bill power-cut test** — park a bill, pull the lane's power, restart it: the bill comes back with every line. Then try to recall the same bill on a second lane and confirm it refuses. | M12-FR-02 · Stage 9 gate | Stage 12 pilot | Not yet required | Scheduled |
| UAT-15 | **Settlement list walkthrough** — confirm the cash office sees *two* separate figures (not due yet vs genuinely late), and that every late one has a named owner and a date. | M14-FR-03 · Stage 9 gate | UAT-02 session | Not yet required | Scheduled |
| UAT-16 | **Refund-uncertainty drill** — ask what happens when the card machine does not answer during a refund. Confirm nobody can mark it refunded by hand, and that the customer is told the true state. | M13-FR-04 · §4.3 · Stage 9 gate | Stage 12 pilot | Not yet required | Scheduled |

## How UAT-01 runs when we reach it

Ten minutes, in this order, with the owner watching the screen:

1. Show the current data — row counts and the day's takings.
2. Take a backup; show the checksum and the control totals it recorded.
3. **Drop the database.** Show it is gone.
4. Restore from the backup.
5. Show the reconciliation line: `✅ Restore reconciles exactly against the manifest.`
6. Attempt to edit a sale record directly; show the database refuse it.

The script is `docs/runbooks/backup-and-recovery.md` Part 4. It has already been executed
end-to-end against a real PostgreSQL server — `docs/evidence/stage-5-recovery-proof.md` —
so the demonstration is a repeat of a proven procedure, not a first attempt.
