# The real-staff usability session (UAT-06, QG-02) — session pack, 7 November 2026

_Owner decision OB-703 (7 Nov 2026, decision 6 of the UI/UX gap audit): the session runs **next**, on the merged
screens, before rounds U5 and U6; its findings set the order of U3, U5 and U6. This pack turns the Stage 3 script
(`usability-test-script.md`) into the sheets for that evening: one for the cashier, one for the manager, one verdict
sheet, and the owner's set-up list. Print pages 2–4; keep page 1 for yourself._

**The one rule:** stand behind the person, start the stopwatch, and say nothing. No hints, no "try the other button".
If they stop and ask, write the question down and say "do what you would do". A pause is a finding. Silence is data.

## Page 1 — the owner's set-up (do this before 7pm)

| # | Do | Tick |
|---|---|---|
| 1 | **The demo box is running the merged release.** Open the repository's Actions page; the top row, "Merge pull request #867", must have a green tick, and the job named *Deploy the merged release to the demo box* must say **success**, not *skipped*. If it says skipped, the box still has the old screens: ask the administrator to deploy (`docs/runbooks/automatic-deployment.md`) and move the session to the next evening. | ☐ |
| 2 | **Synthetic data only.** The session runs on the demo box's practice data. Never on the store's live system (hard rule 7). | ☐ |
| 3 | **Two people who have NOT used the new screens:** one cashier, one floor or store manager. Not the person who helped build or test it. | ☐ |
| 4 | **Each person signs in as themselves** (their own login, UAT-05). No shared login, no owner login lent for the evening. If a person has no login yet, make it before 7pm. | ☐ |
| 5 | **Devices:** the demo till on a lane PC with its scanner, printer and the drawer; **the cheapest Android phone your staff actually own** for the manager's pages (not your phone); a network cable you can pull from the lane PC and put back. | ☐ |
| 6 | **Props:** ten real products with barcodes in a basket (two of them the same item), one weighed item (vegetables or fruit), one item with no barcode you know by name, a ₹200 note and a few coins, a receipt from a sale made earlier the same evening (for the refund). | ☐ |
| 7 | **A stopwatch** (any phone's clock app). **A pen.** These three sheets printed, one set per person. | ☐ |
| 8 | **Time:** start at 7pm, when the shop is busy and the light is as it really is. About 60 minutes: 5 to brief, 25 at the till, 20 on the manager's pages, 10 for the verdict. | ☐ |
| 9 | **Say to each person, word for word:** "Do what you would normally do. I will not help. There are no wrong answers — we are testing the screen, not you. Think out loud if you like." | ☐ |
| 10 | **Afterwards:** photograph every sheet (both sides) and send the photos to the build session, or type the numbers in. Nothing is changed until the findings are written down (QG-02: silence is not approval). | ☐ |

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

Tasks B1–B4 on **the phone**. Tasks B5–B8 on **the store computer**. These five pages have never been timed with a real person; this sheet is the first measurement.

| # | Task (say only the words in **bold**) | What good looks like | Time | Taps | Notes ✋❓🖊❌ |
|---|---|---|---|---|---|
| B1 | **"Sign in on this phone and open the office."** | Own login; the menu fits the phone with no sideways scroll. | | | |
| B2 | **"Something is waiting for your approval. Decide it."** (page: *Approvals*, under Today) | Finds the request; reads what it is and who asked; Approve or Reject; the confirm sheet says what will happen in whose name. Counted at 3 for the decision. | | | |
| B3 | **"The cashier has just closed till 1. Sign off the drawer."** (page: *Cash over / short*, under Finance) | Finds the drawer; the over/short figure is shown, not "Not known"; the confirm sheet before sign-off. | | | |
| B4 | **"A delivery has arrived from our rice supplier. Receive it."** (page: *Goods receipt review*, under Receiving) | Picks the supplier **by name** from the list (never types a code); the order appears; lines received; the confirm before stock moves. | | | |
| B5 | **"Two crates of tomatoes went bad. Record the loss."** (page: *Record a write-off*, under Waste) | Picks the item and the place by name; the reason; the confirm sheet says the quantity and the value in their name. | | | |
| B6 | **"Plan a stock count of the cold room for tomorrow morning."** (page: *Count plans*, under Inventory) | Picks the place from the store's own list; the date typed as day/month/year; adds two products by name; saves. | | | |
| B7 | **"Try to approve a purchase of ₹5 lakh."** (or any action above their authority) | **Refused in words**: what happened · nothing was changed · what to do next. Copy the words: ______________________________ | | | |
| B8 | Switch the office to Tamil. **"Read me this page's heading and the first button."** | Reads them; the heading matches the menu word. Write any word they stumble on. | | | |

Ask at the end: "Which of these would you do on the phone at home, and which only at the desk?" ______________________________

"Did any page leave you unsure whether it had saved?" ☐ No ☐ Yes — which: _________________________

---

## Page 4 — Sheet C: the verdict (10 minutes, both people gone)

| Question | Answer |
|---|---|
| Did the cashier bill the basket (A3) and the offline sale (A8) **unsupervised**? | ☐ Yes ☐ No — where they needed help: |
| Did the receipt print with the cable out, and did "1 unsent" appear and then clear? | ☐ Yes ☐ No |
| Did the manager finish every page task without asking how? | ☐ Yes ☐ No — which pages: |
| Any task over its counted number of taps? (A1 3 · A2 8 · A4–A6 3 · A7 11 · A10 3 · A11 2 to reach · A13 3+notes · B2 3) | List: |
| Any figure that said "Not known"? Any button that did nothing? | List: |
| Every refusal said what happened, that nothing was changed, and the next step? | ☐ Yes ☐ No — copy the one that did not: |
| Tamil: any word either person could not read or misread? | List: |
| Top three confusions, in order of how much they would cost on a busy day | 1 ____________________ 2 ____________________ 3 ____________________ |
| Would each person be comfortable on a busy Saturday? | Cashier ☐ Yes ☐ No · Manager ☐ Yes ☐ No — why: |

**What happens with this sheet.** The build session turns every line into a finding against the screen specs in
`docs/design/screens/`, records the first real tap counts in the frequent-actions register, and proposes the order of
rounds U3 (Tamil for the product's words, OB-699), U5 (the shared parts on every page, the cashier's menu per OB-702) and
U6 (the missing screens) from what hurt most. The owner approves that order in writing. UAT-06 in
`docs/registers/uat-calendar.md` moves to Done only when this sheet is filled and filed.
