# Pilot-readiness gap audit — 20 October 2026 (OB-247)

**Question asked by the owner:** before anything is installed on the store PC, what stops the one-department pilot from running safely?
**Store PC:** Windows 11 Pro, 8 GB RAM, virtualisation enabled. No IT person (OB-244).
**Method:** three read-only audit lanes, each checking claims against code and tests, not against docs. Full tables are in
`docs/pilot/audit-2026-10-20/lane-A.md` (trading day), `lane-B.md` (data, recovery, security, legal) and `lane-C.md`
(PC, memory, install, people). Severity follows `docs/pilot/PILOT-GATES.md` (P0 blocks, P1 blocks, P2 workaround, P3 cosmetic).
**Nothing was run on real Windows or real Docker.** No staff UAT has happened.

## What is proven today (tests run during the audit, all passing)

- Lane A: 53 integration files (330 tests) on real PostgreSQL 16, 28 browser files (98 tests), POS hot-path and sync performance.
- Own-PIN sign-in at the till; manager approval with the manager's own PIN; age check blocks the sale; holds, voids,
  refunds, offers, float; bill numbers from the store computer, never repeated; committed sales survive a restart;
  sync collapses duplicates; unsent count is honest; goods receipt, counts, waste, blind cash-up, day close, day book;
  only the pilot department's rows can be loaded; a parallel-run day cannot be signed while a difference has no reason.
- Hard rules 2, 6, 7 and 10 hold on the real-copy path (lane B; caveats in lane-B S6, B11, H7).
- Memory measured (lane C): API ≤254 MB, store box ≤136 MB, PostgreSQL ≈188 MB, 0.55 GB in all at 3,000 sales;
  sale p50 13 ms, p95 22 ms (Linux, plain Node).

## The one decision everything else hangs on

**Decision P — how the pilot runs.** Not recorded anywhere as decided. It decides which bill is the legal GST bill,
whether a printer and card-machine link are needed on day one, how GST returns and Tally are fed, and what happens to a
basket with pilot and non-pilot goods.

| Option | What it means | What must be built first |
|---|---|---|
| **Mirror (recommended)** | The old ERP bills every customer as today; a trained person rings the pilot department's lines on the new till too; the customer never gets the new bill. | The gaps marked "all options" below. Bill, printer, card link, GST filing, B2B and mixed basket do **not** block. |
| Real trading at one pilot counter | The new till bills pilot-only baskets for real customers. | Everything below, plus the legal tax invoice (A3), paper printing (A4/A5), card/UPI approval capture (A9), a GST-return path with the CA (A7/L1–L3), B2B e-invoice rule (L4), mixed-basket rule (A2). Weeks. |
| Wait | No pilot until all of the above are built and staff have practised. | Same as above; the date moves. |

## Blockers found, grouped

| # | Gap | Severity | Blocks under | Size to close |
|---|---|---|---|---|
| 1 | Till does not retry after a lost reply; tells the cashier "do not take money" when the sale was saved — phantom then double sale (lane A, A8) | P0 | all options | S |
| 2 | Backups are manual only; the till's own data (unsent sales, queue, dead letters, PINs) is never backed up; one disk (lane B, B2–B4; lane C, C-13) | P0 | all options | M |
| 3 | Backups not encrypted; no off-site copy; roadmap §33/§35 vs OB-240 "data never leaves the shop" (B7, B8) | P1 | all options | S–M + owner choice |
| 4 | Owner guide stops at the rollback drill: no till install, staff and PINs, store token, department load, catalogue pack, shop name/GSTIN/bill prefix (A, C-06) | P1 | all options | M |
| 5 | Nothing restarts after a reboot; no UPS named; one PC is a single point of failure; no "PC down → old till" sheet (C-09–C-11, A28/A29) | P1 | all options | S + owner choice |
| 6 | No alert anyone sees on the store PC (sync failure, failed backup, full disk) (B M1, C-19) | P1 | all options | M |
| 7 | Security on the PC: stand-in sign-in (KL-01) lets whoever holds the PC's key act as anyone; no Windows-account step; `.env.real` file permission has no effect on Windows; no BitLocker step; cashier would sit in the session holding the keys (S1, S3–S5, C-27) | P1 | all options | S–M + owner acceptance |
| 8 | Owner steps with no screen or command: seal files (MG-02), parallel-run policy (MG-10b) (lane B) | P1 | all options | S–M |
| 9 | Updating to a new version could lose the till's data and settings, all inside `C:\SRE`; no update procedure (B11, C-12) | P1 | all options | M |
| 10 | People: OB-243 names pending; 0 staff UAT sessions; no Tamil cashier material (`docs/sop/` empty); no written mirror-keying procedure; no support plan (C-21–C-26) | P1 | all options | owner + S |
| 11 | The till's bill is not a legal tax invoice (CGST Rule 46: no "Tax Invoice", GSTIN, HSN, CGST/SGST split, place of supply); the A1 field checker exists but the till never calls it (A3) | P0 | real trading | M |
| 12 | No paper printing path; printer encoder is ASCII-only, Tamil prints "???" (A4, A5) | P0 | real trading | M |
| 13 | Card/UPI: no approval code or bank reference saved; card refunds stay "pending" (A9, A11) | P1 | real trading | S–M |
| 14 | No path for new-till sales into GST returns or Tally; B2B bills need e-invoice at ₹5–10 crore turnover and e-invoicing is sandbox (A7, L1–L4) | P0 | real trading | M–L + CA |
| 15 | Mixed basket (pilot + non-pilot goods) has no design (A2) | P0 | real trading | owner rule + S |
| 16 | Customer mobile numbers are taken while the grievance officer (OB-223) is pending (S8) | P1 | any option that records customers | S switch, or name the officer |
| 17 | Memory: 8 GB is **tight** — about 5.9–6.3 GB in steady trading of ~7.7 GB usable; 8.3–8.9 GB during an image build (first start, drill, rollback). Helped by a `.wslconfig` limit. Below roadmap §33 (16 GB till) (C-01–C-04) | P2 | all options | owner choice; measure on the real PC first |
| 18 | A second till PC cannot sync (API bound to the PC itself) (C-07) | P2 | only if two lanes | M + ADR |
| 19 | Docker Desktop licence not confirmed (free under 250 staff and US$10 M turnover) (C-14) | P2 | all options | owner confirmation |
| 20 | Delta capture after the export is manual until old-ERP questions D-1/D-2 are answered (MG-09) | P2 | all options | owner + old-ERP support |

## Gates G1–G10 as they really stand for the store PC

None is green for the store PC yet. G1 points at an old release and a ZIP install cannot report its commit; G2/G4 are
built for the real copy but never run; G6/G9 built, never run; G7 has no alert channel on the store PC; G8 has 0
staff sessions; G10 waits for OB-243. (Lane B §1.)

## Recommended path

1. Owner chooses Decision P. Recommendation: **Mirror** for the first pilot weeks.
2. Build, in this order: #1 lost-reply retry; #2–#3 automatic encrypted backup including the till's data; #5 auto-start
   and the "PC down" sheet; #4 and #9 the rest of the Windows guide (till, staff, PINs, update procedure); #6 an alert
   the owner sees; #7 the Windows-account and BitLocker steps; #8 the two missing owner screens; #16 guest-only switch.
3. Owner: names (OB-243), UPS choice, memory photo from the real PC, Docker licence confirmation, CA question on Decision P.
4. Then install on the store PC with synthetic data only, staff practise (G8), and only then the written GO (OB-242).
