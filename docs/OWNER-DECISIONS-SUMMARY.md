# What the build needs from you now — one page

_For Mr. Elanchezhian. Plain English. Last updated 8 August 2026._

The autonomous build has now wired and tested every part of the system that could be
completed **without a decision from you**. This page lists the decisions that are now the
only thing standing between "built and tested" and "switched on for real," newest first.
None of them stops the store trading, and none is urgent this week — but each one unblocks
a specific slice of the product. Full detail for every item is in
`docs/OWNER-ACTION-REGISTER.md`; this is the short version.

> **Update — 8 Aug 2026:** You chose **guest browsing** and to **keep payment in test mode**
> for the pilot. Good news on the first: the customer app is **already built for guest browsing**
> — it browses the catalogue and reviews a basket today, with no login, and it is tested. The one
> thing still needed to take a full online order is your **delivery areas** (the OA-11 row below);
> paying stays in safe test mode until you pick a payment provider before go-live.

## Where the product stands

- **Requirements & design:** ~85% documented against the roadmap.
- **Built, wired and automatically tested end-to-end:** ~35% of the product, growing steadily.
- **Fully wired modules:** the POS sale path, security/roles, pricing, stock availability, the
  warehouse, fresh-food/production (M11), and loss-prevention (M15) — all proven against a real
  database.
- **The customer shopping app** browses the catalogue and reviews a basket today, as a guest with
  no login — built, served offline-first, and tested. Taking a full online order additionally needs
  your delivery areas (OA-11 below).
- **What is left** is either one of the decisions below, or deeper analytics that depend on
  the **stock-valuation method** decision (also below).

## The decisions, and what each one switches on

| # | The decision | Recommended first step | What it switches on | Urgency |
|---|---|---|---|---|
| **OA-4** | **Payment provider + login (identity) provider.** Real card/UPI payment and real staff single-sign-on both need a chosen provider and keys. | ✅ **You chose: keep test mode for the pilot.** Choose providers before real money / real logins. | Online payment, real settlement matching, production staff logins. | Before production (pilot runs without it). |
| **OA-13** | **How customers log in to the shopping app** — browse as a guest, or sign in with a one-time SMS code. | ✅ **You chose: guest browsing.** Already built and tested — browse + basket review work today, no login. | Nothing left to decide; accounts can be added later if you want them. | Done. |
| **OA-11** | **Delivery service areas** — how far the store delivers and how many slots. | ✅ **You chose: main store, within 10 km, 8 slots a day.** Slot engine built. **One thing left:** the store's map coordinates (for the 10 km check) — see note below. Hours/capacity defaulted to **9 am–9 pm, 10 orders/slot** (say the word to change). | Online-order routing + delivery slots (M18-FR-03, M20-FR-03) — switches on when coordinates are given. | Coordinates before delivery goes live. |
| **OA-12** | **Subscription plans & pricing** (only relevant when selling this system to other retailers). | Defer — keep per-tenant feature switches (already built) for now. | Paid plans, metered billing for a multi-retailer product (M36). | Only when commercialising to other shops. |
| **Valuation method** | **How stock is valued** — weighted-average, FIFO, or standard cost. This is an accounting-policy choice. | Confirm the method your accountant already uses. | Stock-value & margin analytics (ageing/turns/GMROI, M08-FR-04), margin reporting (M29), and stock valuation feeding the books (M23). | Before month-end stock valuation and margin reports. |

## What continues regardless

Everything that does **not** need a decision is being built and merged as it becomes ready —
in-store operations, the warehouse, back-office controls (credit, collections, commissions,
supplier statements, facilities, waste, integration health), and the multi-tenant platform
controls (data export, branding, feature entitlements). The engines behind the blocked items
above are also **already built and tested** — only their live switch-on waits on you.

## What I recommend

You have now settled the pilot decisions — payment in test mode, guest browsing, and delivery
(main store, 10 km, 8 slots a day). The slot engine is built and tested. **The one thing left to
switch delivery on is your store's map coordinates** — the latitude and longitude, so the system
can tell a 9 km address (deliver) from an 11 km one (refuse). Get them from Google Maps: search
your store, right-click the pin, and the two numbers at the top are the latitude and longitude —
send me those two numbers and delivery goes live. Until then everything else works and delivery
stays safely switched off (no order to a wrong-distance address can slip through). The remaining
decisions (subscription pricing, stock-valuation method) can wait for their moment.
