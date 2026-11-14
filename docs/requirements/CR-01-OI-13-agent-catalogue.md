# CR-01 OI-13 — Agent catalogue for the owner (draft for decision, 14 November 2026)

**Status:** DRAFT FOR DECISION. Nothing in this paper is built. Nothing here is a requirement until the owner picks it
in writing. Silence is not approval.

**Where this comes from**

- CR-01 item OI-13 (`docs/roadmap/roadmap-v2.2-change-CR-01-owner-installable-product.md`): a catalogue of proposed new
  agents, each with what it does, what it saves and what it costs to run, is put to the owner; only the ones he picks are
  built, each as a new requirement with its acceptance test.
- Owner decision OB-712, option A (`docs/registers/decisions.md`): AI everywhere it helps, plus owner-set auto-approve
  limits (CR-01 OI-12) that a fixed rule applies.
- The ten agents that already exist, A01 to A10, are in `packages/ai/src/authority.ts`. This paper proposes A11 onwards.

**The rules every agent below keeps (no exceptions)**

- An agent only **drafts**. It never writes to the shop's records itself (hard rule 5, P-05).
- An agent never commits a price, payment, refund, purchase, stock or permission change. The list of forbidden acts in
  `packages/ai/src/authority.ts` is closed. No new agent adds to it or gets around it.
- A draft is committed by a named person, or (under OI-12) by a fixed rule with a limit the owner set. A refund, a payment
  to a new payee and a permission change can **never** be auto-approved.
- Every draft shows its evidence: which records it read.
- Every agent has its own on/off switch and its own monthly spend limit, and the one "stop all AI" switch stops it.
- If the AI stops, the shop does not. Every job below still works by hand.

**About the money figures.** Every saving and every live-AI cost below is an **estimate**, not a measurement. Each one
states its assumption. Today no AI service is contracted (OB-296, OB-382), so every agent would run on fixed, tested
rules and cost **₹0 a month** until the owner opens an AI service account. Live-AI costs assume a small, low-cost model
at roughly ₹0.20 to ₹0.60 per question (an assumption; the real price is only known once a provider is chosen). Any
live-AI cost must fit inside the shop's own AI cap, which itself must sit inside the ₹15,000 a month ceiling for the whole
platform (decision D3, `D3_PLATFORM_CEILING_MINOR` in `services/ai/src/index.ts`).

---

## Summary table

| No. | Name | What it saves (estimate) | Cost on rules | Cost with live AI (estimate) | Recommendation |
|---|---|---|---|---|---|
| A11 | GST input-tax mismatch checker | 3–5 accountant hours a month; protects tax credit that would otherwise be missed | ₹0 | ₹50–₹200 a month | Recommended first (just after go-live) |
| A12 | Supplier-bill match explainer | 3–6 hours a week of accounts and receiving time | ₹0 | ₹150–₹550 a month | **Recommended first (before go-live)** |
| A13 | Shrink and waste pattern finder | 2–4 manager hours a week; some reduction in waste | ₹0 | ₹50–₹150 a month | Recommended first (after 4 weeks of data) |
| A14 | Cash-office variance explainer | 2–4 hours a week of manager and cashier time | ₹0 | ₹100–₹350 a month | **Recommended first (before go-live)** |
| A15 | Festival demand planner | Fewer festival stock-outs and less leftover stock | ₹0 | ₹30–₹100 a month | Later (build in December, before Pongal) |
| A16 | Rebate and claim finder | Supplier money not left unclaimed | ₹0 | ₹20–₹60 a month | Later |
| A17 | Staff roster drafter | 2–3 manager hours a week | ₹0 | ₹20–₹80 a month | Later |
| A18 | Complaint summariser | 1–2 owner hours a week | ₹0 (counts only) | ₹100–₹350 a month | Later (useful only with live AI) |
| A19 | Tamil product description drafter | 10–20 hours of typing, once, plus ongoing new items | ₹0 (template only) | ₹200–₹1,000 a month while loading | Later (useful only with live AI) |
| A20 | Competitor flyer reader | Saves typing in competitor prices | Not possible on rules | ₹300–₹1,200 a month | Not recommended |

**Considered and dropped (they would duplicate what exists):**

- *Slow-mover clearance planner* — A03 (Inventory) already suggests markdowns for overstock and near-expiry, and the
  markdown ladder (addendum D-4) already exists. A new agent would repeat them.
- *Shelf-label price-integrity checker* — the price-integrity audit (addendum B25 and D-7,
  `packages/self-checkout/src/price-integrity-ageing.ts`) already compares shelf, till and app prices and shows how long
  each mismatch has lasted. It needs no AI.

---

## The proposed agents

### A11 — GST input-tax mismatch checker
**What it does.** Each month, when the accountant uploads the GSTR-2B statement, it lists every supplier bill that does
not match and drafts a polite reminder to each supplier who has not reported a bill.
- **Builds on:** M23 (finance and tax), addendum A17 (GSTR-2B matching, `packages/input-tax/src/gstr2b.ts`), M07 (bills
  that passed the three-way match).
- **Closest existing agent:** A01 (Owner Intelligence) reads money summaries, but it does not look at tax bills line by
  line and drafts nothing. A11 works for the accountant, not the owner.
- **Reads:** the uploaded GSTR-2B file, the shop's matched supplier bills, the supplier list.
- **May draft:** (1) a list "accept / keep pending / ask the supplier" for each line; (2) a reminder message to a supplier.
- **Who commits:** accepting a tax-credit line is always the accountant, by name (the law already requires a named person
  here). Sending the standard reminder to an *existing, approved* supplier **could** be auto-approved by an OI-12 rule the
  owner sets. Claiming tax credit is **never** auto-approved.
- **What it saves (estimate):** 3–5 accountant hours a month, assuming about 300 supplier bills a month and 15–30
  mismatches. More importantly, credit that would be lost when a supplier forgets to report a bill is chased in time.
- **Cost to run:** (a) on rules: ₹0 a month; (b) with live AI: ₹50–₹200 a month, assuming about 10 questions a day for a
  week each month (writing the reminders in plainer words), small model. Must fit inside the shop's AI cap.
- **Risk and how it is kept safe:** a wrong "accept" would claim credit the shop is not owed. So it never accepts; it
  only lists. Each line cites the bill and the 2B line. Kill switch: its own off switch, and the "stop all AI" switch.
- **Build effort:** small (the matching already exists; this adds the drafted list and the reminder).
- **Recommendation:** **Recommended first** — but needed only from mid-December, when the first post-go-live 2B arrives.

### A12 — Supplier-bill match explainer
**What it does.** When a supplier bill does not match the purchase order and the goods received, it explains why in one
plain sentence ("Bill says 50 cases, we received 48; price per case ₹12 higher than the order") and drafts the query or
debit-note request to the supplier.
- **Builds on:** M07 (receiving and three-way match, `packages/receiving/src/three-way-match.ts`,
  `packages/purchasing/src/three-way-match.ts`), M06 (suppliers).
- **Closest existing agent:** A02 (Purchase) drafts orders *before* buying. A12 works *after* the goods arrive, on the bill.
- **Reads:** the purchase order, the goods received note, the supplier bill, the supplier's price history.
- **May draft:** an explanation for the accounts team; a supplier query; a debit-note request.
- **Who commits:** the accounts person. A debit note and anything that changes what the shop pays is **never**
  auto-approved — it touches a payment. The bill stays on hold until a person decides.
- **What it saves (estimate):** 3–6 hours a week, assuming 60–80 bills a week and 1 in 5 not matching first time, at
  15–20 minutes each to work out why by hand.
- **Cost to run:** (a) on rules: ₹0 a month (the explanation is built from the match result); (b) with live AI:
  ₹150–₹550 a month, assuming about 25 questions a day, small model. Must fit inside the shop's AI cap.
- **Risk and how it is kept safe:** a wrong explanation could lead to a wrong query. Every sentence names the line and
  figure it came from, so the person can check it in seconds. Kill switch as for all agents.
- **Build effort:** small.
- **Recommendation:** **Recommended first, before go-live** — bills arrive from day one of the checked start.

### A13 — Shrink and waste pattern finder
**What it does.** Once a week it looks at all recorded waste, damage and count differences and points out patterns —
for example "curd waste is three times higher on Mondays" or "biscuit damage is mostly from one aisle" — and drafts a
short list of actions.
- **Builds on:** M28 (waste, `packages/waste`), addendum D-5 (waste reasons and analysis), M10 (expiry, `packages/fefo`),
  M08 (stock counts, `packages/counts`), M15 (loss prevention).
- **Closest existing agent:** A07 (Security and Fraud) looks for *dishonest* loss. A03 (Inventory) predicts expiry. A13
  looks for *honest* everyday loss — handling, ordering too much, poor rotation — and is not about any person.
- **Reads:** waste records with their reasons, count results, expiry records, sales by day.
- **May draft:** a weekly pattern note; a recount task; a suggestion to lower an order quantity or move a display.
- **Who commits:** the store manager. Creating a recount task **could** be auto-approved by an OI-12 rule (a task is not a
  stock change). Any stock adjustment or order change it suggests is committed by a person, never by the agent.
- **What it saves (estimate):** 2–4 manager hours a week of looking through waste reports. Assuming waste is around
  1–2% of fresh sales, even a small cut is worth more than the build. The money figure is not estimated here because the
  shop's real waste level is not yet known in the new system.
- **Cost to run:** (a) on rules: ₹0 a month; (b) with live AI: ₹50–₹150 a month, assuming one weekly note plus about 5
  follow-up questions a day, small model. Must fit inside the shop's AI cap.
- **Risk and how it is kept safe:** it must never blame a named person; it reports by product, place and day only.
  Anything that looks like theft goes to A07 and the security officer, not to this note. Draft only; kill switch.
- **Build effort:** small to medium.
- **Recommendation:** **Recommended first**, but it needs about 4 weeks of waste data, so build it just after go-live.

### A14 — Cash-office variance explainer
**What it does.** At day close, when a till is short or over, it lays out the likely reasons from the records — a pickup
not entered, a UPI payment counted as cash, a refund on the wrong tender — and drafts a note for the manager.
- **Builds on:** M14 (till, cash office and day close, `packages/cash`, `packages/day-close`), addendum C13 (daily
  payment matching, `packages/settlement`), M23 (bank statement, `packages/finance/src/bank-statement.ts`).
- **Closest existing agent:** A06 (Operations) explains *system* problems such as sync. A07 looks for fraud. A14
  explains *money* differences at one till on one day, before anyone assumes anything.
- **Reads:** the till's cash movements (float, pickups, safe drops), sales by tender, the payment provider's settlement
  file, the bank statement when imported.
- **May draft:** a variance note with the likely causes, ranked, each with its evidence.
- **Who commits:** the manager accepts or rejects the explanation. Writing off a shortage is **never** auto-approved, and
  the agent never changes a cash balance. A pattern over many days goes to the security officer through A07.
- **What it saves (estimate):** 2–4 hours a week, assuming 6–8 tills and 2–4 variances a day needing a look, at 10–15
  minutes each by hand.
- **Cost to run:** (a) on rules: ₹0 a month; (b) with live AI: ₹100–₹350 a month, assuming about 15 questions a day,
  small model. Must fit inside the shop's AI cap.
- **Risk and how it is kept safe:** a cashier could be wrongly suspected. So it lists records, not people, and never
  says "theft". Draft only; evidence cited; kill switch.
- **Build effort:** small.
- **Recommendation:** **Recommended first, before go-live** — day close runs from the first day of the checked start.

### A15 — Festival demand planner
**What it does.** Six to eight weeks before a Tamil Nadu festival (Pongal, Tamil New Year, Deepavali, local temple
festivals) it drafts the festival entry for the store calendar with last year's effect, and a pre-buy list for the buyer.
- **Builds on:** addendum D-24 (store calendar of festivals, `packages/calendar/src/demand-events.ts`), D-1 and D-2
  (forecast and order proposals, `packages/demand`), M09 (replenishment).
- **Closest existing agent:** A02 (Purchase) drafts everyday reorders. A15 looks weeks ahead at one festival and feeds
  A02; it does not place orders itself.
- **Reads:** the store calendar, last year's sales around the same festival, supplier lead times.
- **May draft:** a festival calendar entry; a festival pre-buy list.
- **Who commits:** the manager records the festival entry. Orders still go through A02 and the buyer; only orders under
  the owner's OI-12 reorder limit, from an approved supplier, could be auto-approved — the same limit as everyday reorders.
- **What it saves (estimate):** fewer festival stock-outs and less leftover stock after the festival. Not given in rupees
  because the shop's festival history is only in the old system until it is loaded.
- **Cost to run:** (a) on rules: ₹0 a month; (b) with live AI: ₹30–₹100 a month, assuming a few questions a day in the
  weeks before each festival, small model. Must fit inside the shop's AI cap.
- **Risk and how it is kept safe:** over-buying. Every figure names the festival and last year's numbers it came from.
- **Build effort:** medium.
- **Recommendation:** **Later** — build in December so it is ready for Pongal planning.

### A16 — Rebate and claim finder
**What it does.** Finds supplier rebates the shop has earned but not claimed, and claims sent but not answered, and
drafts the claim.
- **Builds on:** M06 (suppliers), D03-FR-03 rebate claims (`packages/purchasing/src/rebate-claims.ts`, OB-404).
- **Closest existing agent:** A02 (Purchase) compares quotations before buying. A16 chases money owed *after* buying.
- **Reads:** rebate schemes, matched bills, open and overdue claims.
- **May draft:** a rebate claim; a reminder for an overdue claim.
- **Who commits:** Finance approves every claim before it is sent (roadmap §28). **Not** auto-approvable.
- **What it saves (estimate):** depends on how many rebate schemes the shop has. If, say, ₹20,000 a year of rebates go
  unclaimed today, that is the size of the gain. Not measured.
- **Cost to run:** (a) on rules: ₹0 a month; (b) with live AI: ₹20–₹60 a month, assuming a few questions a week.
- **Risk and how it is kept safe:** claiming the same money twice. The existing rule already stops a double claim.
- **Build effort:** small.
- **Recommendation:** **Later** — first the shop must enter its rebate schemes.

### A17 — Staff roster drafter (no HR decisions)
**What it does.** Drafts next week's roster from the forecast of how many people each hour needs, within the Tamil Nadu
Shops and Establishments rules (weekly holiday, hours, spread-over).
- **Builds on:** M25 (workforce), addendum D-9 (staff needed per hour, `packages/workforce/src/labour-demand.ts`), C16 and
  C18 (working-time rules, `packages/workforce/src/working-time.ts`).
- **Closest existing agent:** A10 (Workforce and SOP) only *reads* roster gaps and guides tasks. A17 drafts a full week.
- **Reads:** the staff-needed forecast, who is available, leave already approved, the working-time rules.
- **May draft:** a weekly roster.
- **Who commits:** the manager publishes it. **Not** auto-approvable. It makes no HR decision: no hiring, pay, leave
  approval, warning or dismissal.
- **What it saves (estimate):** 2–3 manager hours a week, assuming about 40 staff on shifts.
- **Cost to run:** (a) on rules: ₹0 a month; (b) with live AI: ₹20–₹80 a month, assuming one draft a week and a few changes.
- **Risk and how it is kept safe:** an unfair or illegal roster. The working-time rules check every draft and refuse a
  shift that breaks them.
- **Build effort:** medium.
- **Recommendation:** **Later** — the roster can be done by hand for the first weeks.

### A18 — Complaint summariser
**What it does.** Once a week it reads all customer service cases and gives the owner the top themes ("12 complaints
about late delivery in one area").
- **Builds on:** M21 (service desk, `packages/service-desk/src/service-cases.ts`), M16 (customer consent).
- **Closest existing agent:** A05 (Service) answers one customer at a time. A18 looks across all cases, for the owner.
- **Reads:** service cases (with personal details hidden), order status.
- **May draft:** a weekly themes note. It proposes nothing else.
- **Who commits:** nothing to commit; it is read-only, like A01.
- **What it saves (estimate):** 1–2 owner hours a week, assuming 50–150 cases a week.
- **Cost to run:** (a) on rules: ₹0 a month, but only counts by category, which the reports already show; (b) with live
  AI: ₹100–₹350 a month, assuming one weekly summary of up to 150 cases plus a few questions a day.
- **Risk and how it is kept safe:** personal data. Names and phone numbers are removed before it reads anything.
- **Build effort:** small.
- **Recommendation:** **Later** — its real value needs live AI, which waits for Release 8 (OB-382).

### A19 — Tamil product description drafter
**What it does.** Drafts a short Tamil name and description for each product on the online store, for a person to check.
- **Builds on:** M03 (product master, Tamil names in `packages/product/src/product.ts`), M20 (online store), CR-01 OI-09
  (Tamil throughout).
- **Closest existing agent:** A08 (Data Quality) finds *missing* details; A09 (Marketing) drafts offers. Neither writes
  product text.
- **Reads:** the product master (name, brand, size, category and its Tamil name).
- **May draft:** a Tamil name and a short description.
- **Who commits:** the data steward. **Not** auto-approvable: a wrong word on a label or app is a customer and legal risk.
- **What it saves (estimate):** 10–20 hours of typing for the first load of about 2,000 online products (assumption:
  30–40 seconds each to check a draft versus 1–2 minutes to write one), then about an hour a week for new products.
- **Cost to run:** (a) on rules: ₹0 a month, but only a fill-in-the-blanks template; (b) with live AI: ₹200–₹1,000 in the
  month of the first load, then under ₹100 a month. Must fit inside the shop's AI cap.
- **Risk and how it is kept safe:** a wrong or odd translation. Every line is checked by a Tamil-reading person before it
  goes live.
- **Build effort:** small.
- **Recommendation:** **Later** — useful only with live AI.

### A20 — Competitor flyer reader
**What it does.** Would read photos of competitors' flyers and shelf prices and type them in as competitor sightings.
- **Builds on:** D-18 competitor price rule (`packages/pricing/src/competitor-rule.ts`, OB-216), M05 (pricing).
- **Closest existing agent:** none. The D-18 rule already drafts a price change once a sighting is typed in, so the only
  new part is reading the photo.
- **May draft:** a competitor sighting. The price change itself stays with the existing price route and a person.
- **Cost to run:** cannot run on rules at all; with live AI ₹300–₹1,200 a month, assuming 20–50 photos a day on a model
  that reads pictures, which costs more than a small text model.
- **Risk:** a misread price could start a wrong price draft. Collecting competitor material may raise legal questions.
- **Build effort:** medium.
- **Recommendation:** **Not recommended** — it cannot work without live AI and saves little against typing a few prices.

---

## What you need to decide

Six days remain before go-live on Friday 20 November 2026. The checked start (OI-11) and Tamil throughout (OI-09) must
also finish in that time. Honestly, only small agents running on rules can fit before go-live. Live AI cannot fit at all,
because no AI service account exists.

**Option A — Build the four "recommended first" agents now, on rules; live AI later.**
A11 GST input-tax mismatch checker, A12 Supplier-bill match explainer, A13 Shrink and waste pattern finder,
A14 Cash-office variance explainer.
- Time: about 5–7 working days of build and testing in total. That uses up all the time before go-live and puts the
  checked start and Tamil work at risk of slipping.
- Cost: ₹0 a month to run.
- Risk: medium. Two of the four (A11, A13) have nothing useful to do on 20 November anyway — the first GSTR-2B comes in
  mid-December and A13 needs weeks of waste data.

**Option B — Build only the two that are needed from day one, on rules; the other two straight after go-live.**
Before go-live: A12 Supplier-bill match explainer and A14 Cash-office variance explainer. In the first two weeks after
go-live: A11 and A13. Later, after a fresh decision: A15 (in December, before Pongal), A16, A17, and — once there is an
AI service account — A18 and A19.
- Time: about 2–3 working days before go-live; the rest after.
- Cost: ₹0 a month to run.
- Risk: low. Both help the checked start directly (bills and day close happen every day).

**Option C — Build none now; revisit after go-live.**
- Time: none before go-live.
- Cost: ₹0.
- Risk: lowest for the go-live date, but bill mismatches and till differences are worked out by hand during the busy
  first weeks. OI-13 stays open with a named target date.

**Recommendation: Option B.** It gives you the two agents that save time from the first day, without putting the
20 November date at risk, and costs nothing to run. A20 is not recommended in any option.

Please reply in writing with A, B or C (or your own list of agent numbers). Until you do, nothing is built.

---

## Live AI needs an account

- Switching any agent from rules to live AI needs an **AI service account** — a contract with an AI provider.
- That account needs a **monthly budget that you set** and a **kill switch** that stops it at once (roadmap §19,
  AI-NFR-10). Each agent also gets its own smaller limit inside that budget. Your budget must sit inside the ₹15,000 a
  month platform ceiling (decision D3). Any figure you have not set is shown as "not set", never guessed.
- The account's key is kept in the **secrets vault** only — never in the code, never in a file in the repository, never
  in a chat or an email.
- **Today no such account exists** (OB-296, OB-382). So every agent runs on fixed, tested rules at ₹0, and the AI pages
  say plainly that live AI is off until Release 8 (OB-561).

---

## How each chosen agent is built

1. It becomes **its own requirement** (for example "OI-13-A12"), with written acceptance tests, before any code.
2. It gets a **row in `docs/traceability.md`**, linking the requirement to its tests and release.
3. It is added to the **existing agent list** (`packages/ai/src/authority.ts`) with a short list of what it may read and
   draft. The forbidden list does not change. A test proves it cannot be given any forbidden act.
4. It runs **draft-only through the existing AI gateway**. Every draft names its evidence, and a named person or an
   OI-12 rule commits it — never the agent.
5. It has **its own monthly spend limit** (₹0 while on rules) inside the shop's AI cap.
6. It **starts switched OFF**. You or your manager switch it on after seeing it work, and can switch it off at any time.

---

## In plain English

We already have ten AI helpers. This paper offers ten more ideas and recommends only the ones that will really save time
in this shop. None of them can change a price, pay anybody, give a refund, buy stock, change stock or change who can do
what. They only prepare work for a person to check. They cost nothing to run until you decide to pay for live AI.

**What to check:** read the summary table at the top. Then reply with A, B or C. If you choose B, during the checked
start look at a supplier bill that did not match and at a till that was short or over, and see whether the explanation
on screen matches what the staff find when they check by hand.
