# UI/UX gap audit — 1 November 2026

**Asked by the owner:** "do the gap audit in UI/UX." **Scope:** every screen a person uses, judged against the product's own
usability rules — not taste. The rules are the design system (`docs/design/design-system.md` §1, §2, §4, §4.1, §7), roadmap
§27 (the screen inventory per role) and §27.1 (the states every screen must handle), QG-02 (frequent actions in ≤ 3
interactions; a new cashier bills unsupervised after 30 minutes), NFR-07 (accessibility), NFR-08 (English and Tamil),
NFR-13 (usability), and principles P-03, P-07 and P-08.

This is the same shape as the 31 October screen gap audit (`SCREEN-GAP-AUDIT-2026-10-31.md`), which asked "does the page do
its job?". This one asks "can a shop person use it, and is it honest?". Nothing was changed in the product; this file, the five
lane tables in `ui-ux-gap-audit-2026-11-01/` and a STATUS entry are the only files written.

## How it was checked

1. **A browser sweep on the real stack.** A throw-away Playwright script (not kept) opened every one of the 127 menu screens
   on a REAL store computer fed by a REAL in-memory head office (the W1 office harness, `tests/e2e/lib/office-shop.ts`:
   24 customers who bought, two approvals waiting, one product, no sales today), as **every role that may open it** —
   cashier, accountant, store manager, owner — at a desk (1280px) in English and Tamil and on a cheap phone (360px). For each
   of the 295 page-and-role rows it ran the product's own WCAG audit (`tests/e2e/lib/a11y-audit.ts`) and recorded: the
   connection badge, words left in English after the toggle, text under 14px, how many buttons are marked primary, figures
   drawn as 0, "all clear" sentences, sample stand-ins, disabled buttons with no reason, and a screenshot. The eight device
   shells the box serves (till, owner phone, picker, driver, warehouse, customer, self-checkout, price kiosk) were opened the
   same way. No page failed to open and no page threw a script error; one menu item answered 403 (below).
2. **Five checkers read the code** behind every page (`apps/*/web/*.html`, `*.js`, `apps/web-erp/src/*-session.ts`) for the
   things a sweep cannot see: how many steps the page's main job takes, whether an error says what happened / whether data was
   saved / what to do next, whether a money or stock action shows its consequence and asks to confirm, which §27.1 states exist,
   and which §27 mandatory screens are missing. Their tables are `ui-ux-gap-audit-2026-11-01/lane-1.md` to `lane-5.md`.
3. **What was already proven was not re-proven:** the static WCAG audit of every office page on sample data
   (`the-erp-pages-meet-the-spec.e2e.ts`), the 66 head-office pages saying so when head office is down, the W1 menu and
   register, the till's, handhelds', owner phone's and customer app's tap budgets, and every page's English/Tamil dictionary
   keys (the chrome guardrail and a 20-file script this audit ran over the device shells: no key missing anywhere).

The raw sweep output and 380 screenshots were kept outside the repository (they hold nothing but synthetic data).

## Verdicts

| Verdict | Meaning |
|---|---|
| CLEAR | Meets every rule checked |
| ROUGH | Usable, but breaks one or more of the design rules (named per page in the lane table) |
| HARD | A shop person would struggle: an unreadable or unreachable control, more than three steps with no guidance for the main job, English-only parts on a Tamil screen, a figure shown as 0 or "all clear" when it is not known, or a money or stock action with no consequence or confirm |

| Lane | Screens | CLEAR | ROUGH | HARD |
|---|---|---|---|---|
| 1 · Today, Products & prices, Buying, Goods coming in | 29 | 5 | 23 | 1 |
| 2 · Stock, Floor, Production, Waste, Orders, Checks | 29 | 2 | 19 | 8 |
| 3 · Cash & GST, Reports, Customers | 30 | 5 | 22 | 3 |
| 4 · Staff, My work, Setup & access, Devices | 34 | 3 | 25 | 6 |
| 5 · Till, kiosks, handhelds, owner phone, customer app, portals, site | 18 | 7 | 11 | 0 |
| **All** | **140** | **22** | **100** | **18** |

In one sentence: the look is consistent and accessible (the audit is clean on 121 of 126 office pages at a desk and 117 on a
phone), but most office pages are still built from the pre-W1 template — their own buttons, tables and forms — so the rules
that make a screen *usable by a shop person* (one obvious action, pick a thing rather than type its code, say "not known"
rather than 0, confirm before money moves, Tamil for every word) hold on only a few pages.

## The eighteen HARD screens

| Screen | Why a person struggles | Lane |
|---|---|---|
| Floor indents; Production | The only save buttons ("Save the indent on this device", "Record the run", "Save the weights") are dark words on the dark green button, 1.73:1 — unreadable at desk, on the phone and in Tamil (`indents.html:32`, `production.html:57`) | 2 |
| Store setup / Settings | 26 switches at 26×26px (bar: 44px); the page scrolls sideways on a phone; 26 greyed "Save" buttons with no reason; every setting's question English-only on the Tamil screen; "0 / 26 settings chosen" on a shop already trading | 4 |
| Users & roles | The owner, on a head office holding five people, reads "This screen has not been told about any accounts" and "You may not see who has a sign-in"; nothing gives or takes back a role | 4 |
| Tills & devices | "Every device is up to date and checking in." with 0 devices registered (`fleet.js:215`); no way to register one | 4 |
| Audit log | The menu promises an audit log; the page is retention rules ("Records kept"); the menu offered it to the accountant and the store computer refused with 403 | 4 |
| Migration | Served to the real owner on sample data ("this is not your shop"); nothing can be signed, decided or rolled back from the hosted copy | 4 |
| Morning brief | "Nothing needs your attention today" and "the figures above are complete and correct" while sales, margin and cash read "not available" (`packages/owner-control/src/scheduled-brief.ts:90`) | 3 |
| Bill findings and attendance flags | 48 identical cards in one 9,000-pixel column: no count by kind, no grouping, search or paging — the control-by-exception page shows noise | 3 |
| Customer cases | Opening a case needs a hand-typed case number plus five more fields; "Every resolved case has a root cause." shown in green with no cases at all | 3 |
| Buying | On the real store computer every invoice line reads "an item we do not carry" (the pack feeds the page no stock list); a one-line order is seven or more steps with supplier and item typed as codes | 1 |
| Record a loss | Two whole forms for the same loss shown at once (online and line-down) plus a third, three filled buttons; the manager types what the loss is worth | 2 |
| Count plans; Packaging; Store events; Scrap | A manager must type location ids, product ids, item codes, branch codes and a forecast multiplier ("1.5 = half as much again") — programmer's inputs, no list to pick from | 2 |
| Warehouse (supervisor) | Scrolls sideways on a phone (431px in 360); the information-blue tone used as the action colour; a typed unit cost on a transfer the Transfers page says is never priced here | 2 |

## Product-wide gaps (de-duplicated across the five lanes, with the sweep's numbers)

| # | Gap | Rule | Where | Size |
|---|---|---|---|---|
| G1 | **The page heading stays English after the Tamil toggle on 35 screens.** The chrome draws the header line from the page's `h1#who`; the pages repaint a child title, never the h1 (e.g. `approvals.html:60`, `cash-office.html:61`, `day-book.html:68`) | R6 · NFR-08 | 35 of 126 office pages (sweep) | S — one fix in the chrome |
| G2 | **Words that come from the store computer or head office are English only:** the Today page's own notes (`edge/store-edge/src/screen-data.ts:618, :629`), every report's name on Reports, the morning brief's sentences, head office's GST findings, the Finance page's state sentence, the setup questions, role names ("Store manager", "Cashier") | R6 | 56 of 126 pages carry at least one English fragment on the Tamil screen (279 fragments) | M · needs decision 1 |
| G3 | **No page marks its one primary action.** None of the 121 page scripts uses `.sre-btn-primary`; each page styles its own `button` in the accent, so a screen with three actions has three primaries (Customers 3, Campaigns 2, Tally files 3, Month-end 15 alike, Schedule 4, Help 3, Scrap 2, Packaging 2, Warehouse 2, Record a loss 3) | R3 · §1.3 | 110 of 126 pages show 0 marked primaries; the rest 1–2, Setup 27 | M |
| G4 | **Money, stock, price and privilege actions run on one click with no consequence line and no confirm step.** Post a day to the accounts, record supplier money, send a campaign, publish the online store, sign off a drawer, close the month, lend authority, commit a roster, release a batch for sale, send a transfer, start a recall, issue an order refund, take the float and move cash to the safe at the till, a price cut before the manager sees the cut and the limit. (A reason and a second person are asked where §28 requires — that is the authority part; the consequence and confirm parts are missing.) | R3 · §27.1 | ~20 actions across lanes 2, 3, 4, 5 | M · one shared confirm sheet, then page by page |
| G5 | **Forms ask for codes, not things.** Product id, Supplier code, Store code, Place/location id, Branch code, Staff id (`u-ravi`), Approval id, Requisition number, Scheme code, HSN, Recipe id — on at least 30 pages; no search or picker anywhere in the office; the signed-in person's own store is typed although the box knows it | F · P-07 · NFR-13 | lanes 1–4 | L — one shared picker (product by name or barcode, supplier, person, place), then page by page |
| G6 | **Empty reads as "all clear" and 0 stands for "not known".** Tills & devices, Facilities ("every scheduled check is up to date" with no schedule), Shelves ("everything on the plan has been counted" under "there is no plan"), Expiry ("nothing is close to its date" with no batches), the morning brief, Customer cases, the owner phone's three lists ("No alerts today" with no freshness guard, `owner-app/web/app.js:266–274`). "Not known" is used on 2 of 126 pages; 23 pages draw big zeros, some honest (read and empty), some not (Stock value ₹0.00 with stock at −0.24; "Value at variance ₹0.00" with no count reconciled) | S · P-08 | ~12 pages, plus the owner phone | S each |
| G7 | **Sample stand-ins still reach a real store computer:** Products nobody can sell, Migration (office); supplier and B2B portals offline; the picker and driver handhelds opened with no work show "Sample wave" | S · P-08 | 5 shells/pages | S |
| G8 | **Text a person must read under 14px** (labels, hints, captions, error lines, the rule a person must follow): `.meta`, `.facts`, `.why`, `.hint`, `.tag` at 12–13px on pages built before the type scale | R7 · §3.2 | 30 of 126 pages (sweep); 26 of 31 Lane 4 stylesheets | S — one token sweep |
| G9 | **Sideways scroll on a phone:** Customers (485px in 360 — the W1 flagship), Offer form (412), Warehouse (431), Store setup (396), the till at 360 (447; the till is never used at that width, noted only) | R7 · §1.8 | 4 office pages | S |
| G10 | **Errors say what happened but not the next safe action.** The shared pattern is "Head office refused: " + the server's English sentence, or the raw code (`unreadable_answer`) when there is none; only the lost-link sentence adds "nothing was changed"; two pages list three or four possible causes in one sentence instead of the real one (Checklists, Delivery exceptions, Investigations) | R5 · §1.5 | most pages' `outcomeWords` | S — fix the shared helper |
| G11 | **The chrome fills the first phone screenful** (breadcrumb, Pin, Find, Screens, badge, toggle) and repeats the page's name three times before the first task; subpage tiles cut the purpose line to a fragment ("1.", "Saved on this scr…") | F · P-07 | every office page on a phone | S |
| G12 | **Menu name ≠ page name:** Rota/Rostering, Tills & devices/Devices, Connections/Integration health, Audit log/Records kept, Workforce (= the helper's findings) | F · §4.2 | 5 items | S |
| G13 | **Record states as plain words, ⚠/✓ characters or two-tone pills**, not the tone chip with its icon: only ~15 pages use `chip` | L · §4 | lanes 1–3 | S each |
| G14 | **Dates:** native `type="date"` shows the browser's locale (mm/dd in the demo), free-text "YYYY-MM-DD" fields, and machine times on screen ("2026-11-01T16:22:56.319Z") | NFR-08 · OB-606/607 spirit | ~15 pages | S — one shared date field |
| G15 | **Role fit (P-07):** a cashier can open Cash over/short and sees every till's variance; a cashier sees the owner-only loyalty programme panels with six greyed buttons and no reason; the accountant's Supplier bills opens on a "daily work" card for work they may not do; a store manager reads the owner's alert thresholds addressed as "you" | P-07 | 4 pages | S |
| G16 | **Raw ids on screen:** `u-cash`, `u-owner`, `u-box`, `Asia/Kolkata`, `dairy`, `p-milk @ S1` — the person's or thing's name is never shown where its id is | F | many | S (shared "name for id") |
| G17 | **None of the 122 office pages uses the shared office parts beyond the five W1 touches** (`sreOffice.table/state/cards/field/chip`); 20 pages render a register through the chrome's anatomy, 0 use the field or chip helpers; 14 raw tables in Lane 4 alone | F · §4.1 | 117 pages | L — page by page |
| G18 | **The till's "More" button opens a flat list of up to 22 choices** with no headings, search or most-used-first (`apps/pos/web/app.js:2137–2183`); the till has **no product search** by name or keyed barcode (§27 POS row MISSING) | F · I | till | M |
| G19 | **Self-checkout shows no connection badge or unsent count while running**; "It has not answered" does not say whether the basket counts as paid or what the colleague does next | R4 · R5 | self-checkout | S |
| G20 | **Four static pages print both languages at once with no toggle and `lang="en"` fixed:** the concession tag, the customer sign-in, the site home and subscribe pages | R6 · 3.1.1 | 4 pages | S |

## What is proven, and what has never been measured (QG-02)

- **Measured ≤ 3 interactions** (a `Tally` browser test): the till's core (sign in 3 · scan 1 · quantity 3 · tender 1 · cash 3 ·
  hold 1 · recall 1), refund lookup 3, the manager's approve 3 and start day-close 2, assign a task 3, the owner phone
  (drill 1 · approve 2), the customer app (reorder 3 · add 2 · checkout 2), the three handhelds (pick 3 · substitution 3 ·
  quality fail 2 · proof 2 · COD 2 · failed 3 · put away 3 · receive 2 · issue 3 · blind count 2 · adjustment 3), the AI
  control page, the service desk, a catalogue price change, an over-budget order.
- **Never measured:** every other office action (receive goods, raise an indent, record a write-off, plan a count, sign off a
  drawer, match a supplier bill, make a quotation, close the month, draft a roster …), and at the till: taking the float, a
  split tender ("≤ 3 taps to tender" in the usability script), closing the till, a 10-item basket as one timed task, a
  cable pulled mid-basket that still prints, self-checkout and the queue till. `packages/a11y` has had the ≤ 3 bar as an
  assertable number (`checkInteractionBudget`) since Stage 3; it is used only by its own unit test.
- **The QG-02 gate itself is still open.** "Cashier training/performance targets proven" needs a real person: UAT-06 in
  `docs/registers/uat-calendar.md` ("QG-02 usability testing with real staff") is *Scheduled — not yet required*; no session
  has ever been run with the printable script. The design system's §9 says "sit a real, untrained cashier down" — nobody has.
- **The rendered WCAG audit** runs on the till, handhelds, customer app, sign-in and office pages. It does not run on the owner
  phone (its test counts taps only), self-checkout, the kiosks, the queue till or the portals.

## §27 screens still missing (the inventory, after Rounds 4a and 4b)

| Surface | Missing | Note |
|---|---|---|
| POS | Product search (by name or keyed barcode) | scan only at the audit; **built in U4 (4 Nov 2026)**: "Find" on the till bar, from the lane's own signed price list |
| Store/Manager | Staff list and roster (Round 4c) | Rota shows gaps only |
| Product | ESL (electronic shelf labels) | shelf tags print; no ESL screen or integration row |
| Purchase | RFQ sent to suppliers; one supplier-claims screen for short/damaged deliveries | quotes are keyed in; claims are spread over goods receipt and rebates |
| Inventory | Stock ledger screen; quarantine register; plain "adjust a quantity with a reason" office screen | the ledger is read only through routes |
| Finance | Ledger mapping / posting map (the day book points to it); bank reconciliation; AP/AR account view | Round 4d |
| CRM | Compensation raised for a separate approver; satisfaction/feedback capture; a consent check by name in ≤ 2 | |
| Admin/Security | Give and take back a role; register a till or device; keys; a readable audit trail | Round 4c; "Audit log" currently opens retention |
| Migration | Source profiling, trial load and delta load as their own steps; the page itself runs on sample data for the real owner | |
| Owner phone | Audit and system-health views; side-by-side branch comparison | the office has them |
| Customer app | Category browsing; a loyalty view | search only |
| Delivery | Customer contact on a stop | blocked by the §31 no-customer-identity rule — needs decision 3 |

## Proposed fix rounds (most serious first; each its own pull request with tests)

- **U0 — Same-day fixes (S, no decision needed).** The two unreadable buttons (Floor indents, Production); the 26px
  switches and sideways scroll on Store setup; sideways scroll on Customers, Offer and Warehouse; the heading repaint on the
  Tamil toggle (one change in the chrome, 35 pages); the under-14px token sweep (30 pages); "Audit log" renamed to what it
  opens and taken off the accountant's menu until an audit trail exists; the five menu-name/page-name mismatches; the
  "Not known" guards on Tills & devices, Facilities, Shelves, Expiry, Customer cases, the morning brief and the owner phone's
  three lists; the two sample stand-ins on the real box (Products nobody can sell, Migration) and the handhelds' "Sample wave"
  with no work; the shared refusal helper to say the next safe action and never a raw code; self-checkout's badge and
  outcome words; the four static pages' language toggle.
- **U1 — One primary action, and a confirm sheet for money, stock, price and privilege (M).** A shared consequence-and-confirm
  sheet in the chrome ("₹X will be posted to the accounts for 31 Oct in your name — Confirm / Go back"), used by the ~20
  actions in G4 and by the till's float, cash to safe and price cut; every page's real primary moved onto
  `.sre-btn-primary`, the others onto secondary; disabled buttons say why. Needs decision 2.
- **U2 — Pick a thing, never type its code (L).** One shared picker in the chrome (product by name or barcode, supplier,
  person, place/store, approval) and one shared dd/mm date field; the signed-in person's store filled in; "(required)" in
  words; names shown for ids. Applied first to the HARD pages (Buying, Count plans, Packaging, Store events, Scrap,
  Record a loss, Store tasks, Delegation, Quotations, Customer cases), then the rest.
- **U3 — Tamil for every word a person reads (M; needs decision 1).** The store computer's notes, report names, setup
  questions, role names, the Finance state sentence and the brief's sentences carried in both languages; head office's own
  findings per decision 1.
- **U4 — The till's second layer (M).** The "More" list under a dozen headings with the most-used first (the W1 treatment);
  product search by name or keyed barcode; budgets counted for the float, split tender and close till; a mid-basket
  cable-pull test that prints.
- **U5 — Every office page on the shared parts (L, page by page, with the Lane tables as the list).** Register with search,
  sort and paging (Bill findings first), states, cards, fields and chips; the findings page grouped and counted; the phone
  chrome compacted; the cashier's and accountant's menus trimmed to their jobs (decision 5).
- **U6 — The missing §27 screens.** Overlaps Round 4c/4d of the combined list (`COMBINED-FIX-LIST-2026-10-31.md`): give and
  take back a role, register a device, the audit trail, the posting map, staff list and roster; plus the new ones above.
- **Gate — QG-02 with real people.** Run UAT-06 with the printable script on the till and the five most-used office pages
  (approvals, goods receipt, record a loss, counts, cash over/short), on the cheapest phone staff own, at 7pm, before U5 is
  declared done. The order relative to the fix rounds is decision 6.

## Owner decisions this audit needs

**All six decided.** Decision 2: A, 2 Nov 2026 (OB-698). Decisions 1, 3, 4, 5 and 6: B, B, B, A, A, 7 Nov 2026
(OB-699 to OB-703 in `docs/registers/decisions.md`). **OB-704 (7 Nov 2026, evening):** the owner then asked for every
remaining round to be built at once, the staff session afterwards — U3, U5 and U6 run together. The options are kept below as they were asked.

1. **Head office's own words in Tamil.** Report names, the morning brief's sentences, GST findings, role names and the store
   computer's notes are English on a Tamil screen. Options: **A** translate all of them (the product's words and head office's
   findings alike); **B** translate only the product's own words (notes, report names, setup questions, role names) and keep
   head office's findings in English, as OB-553 did for alert messages; **C** leave as is. Recommendation: B.
2. **A confirm step before money and stock move in the office.** The design rule (§1.3, §27.1) asks for consequence,
   authority and a confirm step. Options: **A** add the shared confirm sheet to every money, stock, price and privilege
   action (one extra tap each); **B** keep one click where a written reason or a second person is already required, add the
   sheet only where neither is asked (posting a day, publishing the store, sending a campaign, the float, cash to safe).
   Recommendation: A for money and stock; the till's float and cash to safe included.
3. **Customer contact on the driver's phone.** §27 lists it; the §31 rule keeps the customer's identity off the phone.
   Options: **A** a masked call through a relay number (an outside service, cost and contract); **B** no contact from the
   phone — the store calls on the driver's behalf (as today, say so on the stop). Recommendation: B until the relay is costed.
4. **Audit and system health on the owner's phone.** Options: **A** add both views to the phone; **B** office only, the
   phone links to the office page. Recommendation: B.
5. **The cashier's menu.** Cash over/short and the loyalty programme panels are visible to the cashier. Options: **A** hide
   them from the cashier (the cashier keeps enrol, OB-560); **B** keep them read-only. Recommendation: A.
6. **Order.** Options: **A** U0 and U1 first, then the real-staff session (UAT-06), then U2–U6 in the order the session
   says; **B** the session first on the screens as they are, then every round; **C** all rounds, then the session.
   Recommendation: A.

## Plain English for the owner

The screens look like one product and read well for a person with normal sight: the contrast, button sizes and headings
pass on almost every page, in both languages, on a desk and on a phone. What the audit found is that most office pages were
built before the 1 November shared parts, so they still make a shop person work like a programmer: type a product's code
instead of picking it by name, press one of three green buttons and guess which one is the real one, read a "0" that may mean
"nothing" or "not known", move money with one tap and no "are you sure", and see English words on a Tamil screen. Eighteen
screens are genuinely hard today, and two of them (Floor indents, Production) have save buttons nobody can read. Nothing here
loses data or money; it costs time, trust and training. The one thing that has never been done is to sit a real cashier down
with the printed script — that is the quality gate for usability, and it is still open.

**What to check in the store (5 minutes):** open Floor indents on the office computer and try to read the green save button;
open Store setup on your phone and try to tap a switch; switch any office page to Tamil and look at the heading line at the
top; open Tills & devices before any till is registered and read what it says; on the till press "More" and count how many
choices you scroll through to find "Refund".
