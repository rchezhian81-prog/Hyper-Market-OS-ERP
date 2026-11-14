# The real-staff usability session (UAT-06, QG-02) — session pack, updated 14 November 2026

_First prepared 7 Nov 2026 (OB-703). Since then the owner moved the session to AFTER every UI/UX round (OB-723, OB-726)
and after the new look (OB-728 emerald and gold, OB-729), so it now tests the finished screens as staff will get them —
merged in #906 and #911 and live on the demo box since 14 Nov 2026. This pack turns the Stage 3 script
(`usability-test-script.md`) into the sheets for that evening: the owner's set-up (page 1), the cashier (page 2), the
manager (page 3), the warehouse handheld (page 4), the owner's own checks — the cheap-phone speed, the look and the
Tamil words (page 5) — and the verdict (page 6). Print pages 2–6; keep page 1 for yourself._

## Ready-made inputs — used unless the owner says otherwise

The owner asked (14 Nov 2026) for the session to be prepared on common inputs rather than wait for names and a date.
These are those inputs; change any of them by writing over it.

| Input | Ready-made answer |
|---|---|
| **When** | **Tuesday 17 November 2026, 7:00–8:30pm** at the shop — a busy weekday evening under the real lights. Any weekday evening works the same way. |
| **Who** | Three staff in these roles, none of whom helped build or test the screens: a **cashier**, a **floor or store manager**, a **back-store / warehouse person**. Write each real name on their sheet. |
| **Their sign-in on the demo box** | The demo box holds practice data only, with one practice login per role: the cashier signs in as **Pilot Cashier (demo)**, the manager as **Pilot Store Manager (demo)**, the warehouse person on the handheld as **Pilot Warehouse Staff (demo)** (`pilot-warehouse`, the plain warehouse role — it can record, never approve); the warehouse person's stock adjustment (C7) is approved by the manager on their own login. The handhelds and the till sign in with staff ID + till PIN (`pnpm run demo:till-pins`). Each login is used by ONE person for the evening; the person's real name goes on the paper sheet. The passwords are the administrator's — ask for them before the day; never write them on a sheet. |
| **The products** | The demo box knows six practice products. Print `usability-session-UAT-06-labels.pdf` at 100% and stick each label over the barcode of a similar real item: soap, toothbrush, a 1 kg rice bag, biscuits, oil, **curd (kept in the fridge — the chilled item)** — plus the loose-rice scale label (0.850 kg) on a bag of loose rice. Peel them off afterwards. |
| **The cashier's basket (A3)** | 10 labelled items: 2 soap, 2 toothbrush, 2 rice bag, 2 biscuits, 2 oil (the repeats should become quantities). |
| **A5 weighed item** | The bag of loose rice with the scale label. **A6 no barcode:** one oil pouch WITHOUT a label — the cashier finds "Sunflower Oil" by name. **A8 offline sale:** soap, biscuits, rice bag. |
| **The manager's names (page 3)** | B2 the waiting approval is a **write-off of six leaking oil pouches, ₹540**, raised by the warehouse supervisor; B4 the receipt to review is the **Demo Foods Distributors** delivery the warehouse person received on page 4; B5 the loss is **two packets of Demo Marie Biscuits, torn**; B6 the count is of the **chilled bin (C1)** with curd and oil added. |
| **The warehouse delivery (page 4)** | The demo has an open order from **Demo Foods Distributors** (`po-uat06-demo-foods`: rice bag 10, biscuits 12, oil 6, curd 12). Bring a few labelled packs of each — rice bag, biscuits, oil, and **curd straight from the fridge** for the temperature (C3) and the chilled checklist (C4) — and one torn biscuit packet for C7. Count bin **A1**. |
| **Order of the evening** | Cashier first (their till close in A13 is the drawer the manager signs off in B3), then the **warehouse person** (their receipt is what the manager reviews in B4), then the manager. |

**The one rule:** stand behind the person, start the stopwatch, and say nothing. No hints, no "try the other button".
If they stop and ask, write the question down and say "do what you would do". A pause is a finding. Silence is data.

## Page 1 — the owner's set-up (do this before 7pm)

| # | Do | Tick |
|---|---|---|
| 1 | **The demo box is running the new look.** Open the demo box's office page: the menu on the left must be **dark emerald with a gold "SRE" badge** and the page background ivory. If it is still the old pale-green look, the browser kept the old copy: close every tab of it and open it again (it updates itself on the next visit). If it still looks old, the box did not get #911 (deployed 14 Nov 2026, main run 43562212425): ask the administrator (`docs/runbooks/automatic-deployment.md`) and move the session to the next evening. | ☐ |
| 2 | **Synthetic data only.** The session runs on the demo box's practice data. Never on the store's live system (hard rule 7). | ☐ |
| 3 | **Three people who have NOT used the new screens:** one cashier, one floor or store manager, one back-store / warehouse person. Not the person who helped build or test it. If you can only find two, run the cashier and the manager, and the warehouse sheet on another evening. | ☐ |
| 4 | **Each person signs in with their role's practice login** (see *Ready-made inputs*): one login per person for the evening, never two people on one login, never the owner's login lent. On the live system every person will have their own login (UAT-05). | ☐ |
| 5 | **Devices:** the demo till on a lane PC with its scanner, printer and the drawer; **the cheapest Android phone your staff actually own** for the manager's pages and the speed check on page 5 (not your phone); the warehouse handheld (or a second cheap phone) for page 4; a network cable you can pull from the lane PC and put back. | ☐ |
| 6 | **Props:** the labelled basket, the loose rice with its scale label and the unlabelled oil (see *Ready-made inputs*), a ₹200 note and a few coins, and a receipt from a practice sale made on the demo till earlier the same evening (for the refund). | ☐ |
| 7 | **A stopwatch** (any phone's clock app). **A pen.** Pages 2–6 printed: one sheet per person for pages 2–4, one copy of pages 5 and 6 for you. | ☐ |
| 8 | **Time:** start at 7pm, when the shop is busy and the light is as it really is. About 90 minutes: 5 to brief, 25 at the till, 20 on the manager's pages, 15 on the warehouse handheld, 15 for your own checks on page 5, 10 for the verdict. The three people can go one after another; you do page 5 while the next person gets ready. | ☐ |
| 9 | **Say to each person, word for word:** "Do what you would normally do. I will not help. There are no wrong answers — we are testing the screen, not you. Think out loud if you like." | ☐ |
| 10 | **Afterwards:** photograph every sheet (both sides) and send the photos to the build session, or type the numbers in. Nothing is changed until the findings are written down (QG-02: silence is not approval). | ☐ |
| 11 | **Warehouse props:** the labelled packs, the curd from the fridge and the torn biscuit packet (see *Ready-made inputs*); the manager approves the adjustment on their own login (Pilot Store Manager) — the person who records it can never approve it. | ☐ |
| 12 | **The administrator has refreshed the demo box's practice data** (once, any day before): `pnpm run seed:pilot` and the till PINs for `pilot-warehouse` (`docs/runbooks/demo-practice-environment.md` §6.4). Run it within two days of the session. Check: the manager's *Approvals* page shows the oil write-off waiting. | ☐ |

**What to write in the "Notes" column, for every task** — use the four marks:
✋ hesitated (where?) · ❓ asked how (what did they ask?) · 🖊 reached for paper or a calculator (why?) · ❌ wrong path or error (what happened?)

**Also write down, whenever you see one:** a word on the screen the person read aloud wrongly or did not understand; a figure that says "Not known"; a refusal — copy its words (it should say what happened, that nothing was changed, and what to do next); a button they pressed that did nothing.

---

## Page 2 — Sheet A: the cashier, at the till (25 minutes)

Person: ______________________ Role: cashier · Years at a till: ____ · Date/time: ___________ · Language: ☐ English ☐ Tamil

Till / lane: __________ · Scanner working ☐ · Printer working ☐ · Drawer working ☐ · Cable can be pulled ☐

Before the first task, tell them only: "Sign in, open the till, and bill this basket as you would for a customer."

| # | Task (say only the words in **bold**) | What good looks like | Time | Taps | Notes ✋❓🖊❌ |
|---|---|---|---|---|---|
| A1 | **"Sign in for your shift."** | 3 taps (Sign in → ID → PIN), no help | | | |
| A2 | **"Open the till with a ₹2,000 float."** | Finds *More → Take float*; types 2000; the confirm sheet says the figure and the name; Confirm. Counted at 8. | | | |
| A3 | **"Bill this basket."** (10 items, two the same; scan them) | Every scan lands as one line; the repeated item becomes a quantity, not a second line. Note the total time for all 10. | | | |
| A4 | **"Make the biscuits 3 packets instead of 1."** | Tap the line → quantity → confirm. ≤ 3. | | | |
| A5 | **"Add these vegetables."** (the weighed item) | The scale's weight lands on the line, or they key the code. ≤ 3. | | | |
| A6 | **"Add this one — it has no barcode."** (say the item's name) | Finds *Find*; types a few letters; taps the row. Counted at 3. | | | |
| A7 | **"Take ₹200 in cash and the rest on UPI."** | Tender → Split → Cash 200 → UPI → the machine's answer. 2 taps to reach the tender; counted at 11 in all. Does the "no member" notice stop them? | | | |
| A8 | **NOW PULL THE NETWORK CABLE.** Then: **"Bill these three items, the customer pays cash."** | The sale completes and the receipt prints with the cable out. The badge top-right turns to "offline" and shows **1 unsent**. | | | |
| A9 | Put the cable back. **"Is the till online now? How many sales are still unsent?"** | Reads the badge correctly; the 1 unsent goes to 0 within a minute. | | | |
| A10 | **"A customer stepped away — put this bill aside and start a new one. Now bring it back."** | Hold ≤ 3, recall ≤ 3. | | | |
| A11 | **"This customer wants to return this item."** (hand over the earlier receipt) | Finds *More → Returns & exchanges → Refund* (2 taps to reach it); the receipt is found; the refund asks for confirmation. | | | |
| A12 | **"Move ₹5,000 from the drawer to the safe."** | *More → Cash to safe*; the confirm sheet says the figure and the name. If the drawer holds less, the refusal says so in words — copy them. | | | |
| A13 | **"Close the till. Count the notes."** | Blind count: the screen never shows the expected figure. 3 taps + one per note. | | | |
| A14 | Switch the till to the other language. **"Read me the three buttons at the bottom."** | Reads them without guessing. Write any word they stumble on. | | | |

Ask at the end (write the answer in their words): "Which step would annoy you on a Saturday evening?" ____________________________________________

"Was there any moment you were not sure whether the sale had gone through?" ☐ No ☐ Yes — when: _________________________

---

## Page 3 — Sheet B: the manager, on the cheapest phone and the store computer (20 minutes)

Person: ______________________ Role: ______________ · Phone make/model: ______________ · Language: ☐ English ☐ Tamil

Tasks B1–B4 on **the phone**. Tasks B5–B10 on **the store computer**. None of these pages has been timed with a real person; this sheet is the first measurement.

| # | Task (say only the words in **bold**) | What good looks like | Time | Taps | Notes ✋❓🖊❌ |
|---|---|---|---|---|---|
| B1 | **"Sign in on this phone and open the office."** | Own login; the menu fits the phone with no sideways scroll. | | | |
| B2 | **"Something is waiting for your approval. Decide it."** (page: *Approvals*, under Today) | Finds the request; reads what it is and who asked; Approve or Reject; the confirm sheet says what will happen in whose name. Counted at 3 for the decision. | | | |
| B3 | **"The cashier has just closed till 1. Sign off the drawer."** (page: *Cash over / short*, under Finance) | Finds the drawer; the over/short figure is shown, not "Not known"; the confirm sheet before sign-off. | | | |
| B4 | **"The warehouse has just received the Demo Foods Distributors delivery. Review it."** (page: *Goods receipt review*, under Receiving) | Finds the receipt by the supplier's **name** (never a code); sees what came, what is still to come on the order, and the curd's temperature; the confirm before anything is accepted. | | | |
| B5 | **"Two packets of Marie biscuits are torn. Record the loss."** (page: *Record a write-off*, under Waste) | Picks the item and the place by name; the reason; the confirm sheet says the quantity and the value in their name. | | | |
| B6 | **"Plan a stock count of the chilled bin for tomorrow morning."** (page: *Count plans*, under Inventory) | Picks the place from the store's own list; the date typed as day/month/year; adds two products by name; saves. | | | |
| B7 | **"Try to approve a purchase of ₹5 lakh."** (or any action above their authority) | **Refused in words**: what happened · nothing was changed · what to do next. Copy the words: ______________________________ | | | |
| B8 | Switch the office to Tamil. **"Read me this page's heading and the first button."** | Reads them; the heading matches the menu word. Write any word they stumble on. | | | |
| B9 | Back in English, on **Today**. **"How many supplier claims are in dispute, and are any overdue?"** | Reads the figure *Disputed supplier claims open* on the Today band without searching; if it says "Not known", reads the reason under it (never a zero). Taps it and lands on *Supplier claims*. | | | |
| B10 | **"Find the oldest requisition and the one before it."** (page: *Requisitions*) | Uses **Next / Previous** at the foot of the list; says which page they are on. | | | |

Ask at the end: "Which of these would you do on the phone at home, and which only at the desk?" ______________________________

"Did any page leave you unsure whether it had saved?" ☐ No ☐ Yes — which: _________________________

---

## Page 4 — Sheet C: the warehouse handheld (15 minutes)

Person: ______________________ Role: back store / warehouse · Device: ______________ · Language: ☐ English ☐ Tamil

Before the first task, tell them only: "A delivery has come in. Do what you would do with it."

| # | Task (say only the words in **bold**) | What good looks like | Time | Taps | Notes ✋❓🖊❌ |
|---|---|---|---|---|---|
| C1 | **"Sign in on this handheld."** | Own login; the screen names them. | | | |
| C2 | **"Receive this delivery."** (the six packs) | *Receive a delivery*; each scan lands as a line; a repeated item becomes a quantity. | | | |
| C3 | **"The curd is chilled — record its temperature."** (the curd from the fridge) | Finds *Arrival temperature*; keys it; a reading that is too warm is said in words. | | | |
| C4 | **"The delivery is complete — send the receipt."** | *Delivery complete — send the receipt*; the checklist; the confirm sheet says what is being sent. | | | |
| C5 | **"Put the rice away in its bin."** | *Put away*; scans or picks the bin; confirm. | | | |
| C6 | **"Count what is in this bin."** (the bin label) | *Count a bin*; the screen never shows how many there should be (a blind count); keys the count. | | | |
| C7 | **"This pack is damaged — take it off the stock."** | *Adjust stock → Missing / damaged (−)*; a reason; it waits for a second person — the same person can never approve it. Ask the manager to approve it on their screen; note whether both understood. | | | |
| C8 | **NOW TURN THE HANDHELD'S WI-FI OFF.** **"Count this bin again."** | The count is saved on the handheld and says it will be sent; turn Wi-Fi back on — it goes to the store computer within a minute. | | | |
| C9 | Switch to Tamil. **"Read me the two biggest buttons."** | Reads them without guessing. Write any word they stumble on. | | | |

Ask at the end: "Is there a step you would skip when the shop is busy?" ____________________________________________

---

## Page 5 — Sheet D: the owner's own checks — the phone's speed, the look, the Tamil words (15 minutes)

**D1 — the cheap phone's speed (the OB-728 brief: "a low-spec Android phone opens the till and a handheld no slower
than before").** There is no "before" figure on a real phone — the old screens were replaced — so this evening's numbers
become the baseline every later change is measured against. Use the cheapest staff phone, on the shop's Wi-Fi.

| Screen | First open after the phone is switched on (seconds to the first usable button) | Second open (seconds) | Felt slow? |
|---|---|---|---|
| The till (on the phone's browser) | | | ☐ No ☐ Yes |
| The picker handheld | | | ☐ No ☐ Yes |
| The warehouse handheld | | | ☐ No ☐ Yes |
| The office's Today page | | | ☐ No ☐ Yes |

Then **turn the phone's Wi-Fi off and open the till again**: ☐ it opens · the words are in the new font ☐ · Tamil shows no boxes ☐.

**D2 — the look (OB-728).** At the till and on the Today page, under the shop lights at 7pm:

| Check | Tick |
|---|---|
| Ivory background, emerald menu, a gold "SRE" badge, rounded pill-shaped buttons — as on the design system page | ☐ |
| From arm's length (about one metre), the total, the prices and any warning are clear; nothing shines or glares | ☐ |
| A "Not known" figure is **burnt orange** with its word and icon — it does not look like the gold badge | ☐ |
| Green still means OK, orange pending or not known, red a problem, grey idle — nowhere is gold used for a status | ☐ |

**D3 — the Tamil words.** The Tamil on these screens was written by the build team, not yet read by your staff. Ask
each of the three people, after their sheet: **"Switch to Tamil. Read this screen aloud. Stop at any word that sounds
wrong, too formal, or that you would say differently."** Write each word and what they would say instead.

| Screen | Word on the screen | What staff would say instead | Who |
|---|---|---|---|
| | | | |
| | | | |
| | | | |
| | | | |

---

## Page 6 — Sheet E: the verdict (10 minutes, everyone gone)

| Question | Answer |
|---|---|
| Did the cashier bill the basket (A3) and the offline sale (A8) **unsupervised**? | ☐ Yes ☐ No — where they needed help: |
| Did the receipt print with the cable out, and did "1 unsent" appear and then clear? | ☐ Yes ☐ No |
| Did the manager finish every page task without asking how? | ☐ Yes ☐ No — which pages: |
| Did the warehouse person receive, count and adjust without asking how? Did the count with Wi-Fi off reach the store computer? | ☐ Yes ☐ No — where: |
| Cheap phone (page 5): did any screen feel slow, or take more than about 5 seconds to a usable button? | ☐ No ☐ Yes — which: |
| The look (page 5): every tick in D2? | ☐ Yes ☐ No — which: |
| Any task over its counted number of taps? (A1 3 · A2 8 · A4–A6 3 · A7 11 · A10 3 · A11 2 to reach · A13 3+notes · B2 3) | List: |
| Any figure that said "Not known"? Any button that did nothing? | List: |
| Every refusal said what happened, that nothing was changed, and the next step? | ☐ Yes ☐ No — copy the one that did not: |
| Tamil: any word either person could not read or misread? | List: |
| Top three confusions, in order of how much they would cost on a busy day | 1 ____________________ 2 ____________________ 3 ____________________ |
| Would each person be comfortable on a busy Saturday? | Cashier ☐ Yes ☐ No · Manager ☐ Yes ☐ No · Warehouse ☐ Yes ☐ No — why: |

**What happens with this sheet.** The build session turns every line into a finding against the screen specs in
`docs/design/screens/`, records the first real tap counts in the frequent-actions register and the cheap phone's
speeds as the baseline, turns the Tamil words into corrections for the owner to approve, and proposes ONE fix round (U8)
ordered by what hurt most. The owner approves that order in writing before anything is built. UAT-06 in
`docs/registers/uat-calendar.md` moves to Done only when these sheets are filled and filed.
