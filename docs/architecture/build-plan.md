# The plan to close every gap

**What this is.** The sequenced plan from where the project stands (`gap-analysis.md`) to a system a
hypermarket can actually be run on. Design, architecture, UI/UX and deployment, in the order the
work has to happen.

**The principle it is ordered by.** Build the thing a person uses first, because **a screen is the
only test that cannot be passed by a system that merely looks assembled**. Seven silent faults were
found in two sessions by driving real paths; the modules nobody has driven are the ones with no
screen, which is most of them.

---

# Phase 1 — One screen, all the way through

**Deliverable: a cashier rings a real sale on real hardware, and it appears in the cloud.**

Not a demo. The POS screen, on a touchscreen with a scanner and a cash drawer, against the real
edge, the real API and real PostgreSQL.

## Why this first

It is the most-used surface in the product — eight hours a day, every day, by the staff least able
to work around a bad design. It is also the surface where every architectural decision already made
gets tested at once: offline commit, durable write, sync, pack signing, exception handling, the
sync badge. **Everything after it is easier for having done it first**, and anything wrong in the
foundation surfaces here rather than at the pilot.

## What gets built

**The Sale screen**, to the spec already written in `docs/design/screens/pos-cashier.md`:

- Running total as the largest element on the screen. A cashier reads it across a counter.
- Scrolling line list. Scan is one interaction; nothing else on the happy path.
- One dominant **Tender** action. Everything else secondary.
- Permanent **sync badge**: online/offline and the unsent count. Never hidden, never a lie.
- Number pad sized for a finger, not a mouse.

**Then, in order:** Tender (cash first) → Suspend/recall → Product search → Returns → Cash movements
→ Open/close till.

## The UI decisions to settle now, once

These apply to every screen after it, so they are decided here rather than six times.

| Decision | Choice | Why |
| --- | --- | --- |
| **Technology** | Plain web components, no framework | The roadmap's baseline allows a modern SSR framework; the POS is the wrong place for one. It must boot from a local disk with no network, survive a hard power cut, and run on a cheap Android tablet for years. Zero runtime dependencies is already this product's discipline and it holds here |
| **Offline** | Service worker + the edge's local pack | The lane already holds a signed catalogue pack. The screen reads that, never the network |
| **Touch targets** | ≥ 48px, ≥ 8px apart | Fingers, gloves, a queue behind the customer |
| **Type** | ≥ 18px body, ≥ 40px for the total | Read across a counter, in shop lighting, by someone who may not have their glasses |
| **Colour** | Never the only signal | 1 in 12 men has some colour blindness. A red total and a black total must also differ in words |
| **Language** | English + Tamil, switchable per user | Already the default. Tamil is not a translation afterthought — it is a lot of staff's first language |
| **Errors** | The three-part error, on screen, in words | Already built in the kernel: what happened, whether it was saved, what to do next. The screen shows all three |
| **Latency** | Scan to line on screen < 100ms | Below the threshold where a person perceives delay. Already proved in the performance suite; now it must survive the DOM |

## Done when

- A cashier who has never seen it bills ten items unsupervised after 30 minutes' training.
- Every frequent action is ≤ 3 interactions, measured, not estimated.
- **Pull the network cable mid-sale: it completes, prints, and the badge says unsent.**
- **Pull the power mid-sale: nothing the cashier was told was complete is lost.**
- Plug back in: every sale in the cloud, exactly once.

---

# Phase 2 — Real data

**Deliverable: SRE's actual product master, suppliers, customers and stock in the rehearsal
environment, with an exception list the owner has worked through.**

Every migration control is built and none has met a real export. This is where 20,000 real SKUs meet
software that has only seen fixtures.

Follow `docs/runbooks/extraction-work-plan.md`. The field list is
`docs/requirements/data-requirements.md`. The two things that will bite:

- **HSN codes are probably missing.** Map by category with the CA; every unmapped product is a named
  exception the owner signs. Do not guess from a description.
- **Barcodes will be messy.** Duplicates across products, missing check digits, and in-store
  variable-measure barcodes from the cafe scale that carry weight or price inside them. The last of
  those is a build item — see Phase 4.

Running Phase 2 in parallel with Phase 1 is fine and preferable: the extraction is the owner's and
the CA's time, not engineering time.

---

# Phase 3 — The other five surfaces

Ordered by **how much of the shop stops without them**.

### 3a. Store manager (web, tablet)
Receiving, stock counts, price approvals, the day's exceptions, day close.
*Without it: goods cannot be received and the day cannot be closed.*

### 3b. Owner (mobile)
Today's takings, margin, exceptions needing a decision, approvals.
*Without it: the owner cannot see the shop.* Small surface, high value.

### 3c. Purchase and receiving (web)
Purchase orders, goods received, invoice capture, three-way match, supplier payments.
*Without it: three-way match has no invoice lines and commitments answer "not known".* This is what
turns two of the honest ◐s into ✅.

### 3d. Picker and delivery (Android handhelds)
Pick lists, substitutions, dispatch, proof of delivery, cash per driver.
*Without it: no online orders can be fulfilled, and delivery runs report unassigned attempts.*

### 3e. Customer app and storefront
Browse, basket, slot, pay, track. The session model is already built and tested.
*Without it: no online channel.* Last because the shop trades without it.

---

# Phase 4 — Compliance, built rather than assumed

Runs alongside Phase 3. Each is a genuine build item, not configuration.

| Item | What it needs | Trigger |
| --- | --- | --- |
| **HSN on the product** | Field, validation (4 or 6 digits by turnover), CA-reviewed mapping | Always |
| **E-invoicing (IRP)** | Register every B2B invoice, receive IRN + signed QR, print it, handle portal downtime **without stopping the till** | **Only if turnover has exceeded ₹5 crore in any year since FY 2017–18 — and then permanently** |
| **E-way bill** | Generate for goods movements above ₹1,00,000 intra-Tamil-Nadu, ₹50,000 inter-state | Wholesale, B2B delivery, stock transfer |
| **Variable-measure barcodes** | Read the reserved prefix and take weight or price from inside the barcode | A cafe or deli — which SRE has (OB-04) |
| **FSSAI records** | Licence number displayed and printed; food-handler certificates with expiry; the 1-supervisor-per-25-handlers ratio; Schedule 4 hygiene logs | Always, food business |
| **Legal metrology** | Scale stamping dates with expiry warnings; unit sale price on shelf-edge labels | Always |
| **DPDP** | Itemised consent per purpose; withdrawal as easy as giving; breach notification; parental consent if under-18 loyalty | Core obligations due **13 May 2027** |

**The one to decide early.** E-invoicing is a government-portal integration on the critical path if
it applies. The question to answer in Part A of the data requirements is not "what is turnover now"
but "**has it ever exceeded ₹5 crore since 2017–18**". If yes, it is permanent, and it must be built
before go-live rather than discovered at it.

**The design rule for all of it:** a government portal being down must never stop the till. The
invoice queues and registers when the portal returns — the same offline-first pattern the sync agent
already implements, applied to compliance.

---

# Phase 5 — Deployment

Most of this exists. What remains is the decisions and the hardening.

## What is already built

Containers for the API and the edge; compose for the whole stack; CI that builds the image, proves
the configuration refusals by name, brings the stack to ready and checks it drains rather than being
killed. Non-root, read-only root filesystem, no-new-privileges, no ports published from the edge.

## The shape, and why

```
   SHOP                                    CLOUD
   ┌──────────────────────────────┐        ┌────────────────────────────┐
   │  Lanes (POS)                 │        │  API — 13 services         │
   │     ↓ local, durable         │        │     ↓                      │
   │  Store edge  ── sync agent ──┼───────▶│  PostgreSQL (append-only)  │
   │  • signed catalogue pack     │        │  • event ledger            │
   │  • sales log (fsync'd)       │        │  • audit log (immutable)   │
   │  • outbox + cursor           │        │  • idempotency keys        │
   └──────────────────────────────┘        └────────────────────────────┘
        keeps trading with the line down         one truth, many channels
```

**The line between them is one-directional in importance.** The shop needs nothing from the cloud to
trade. The cloud needs everything from the shop to be right.

## Decisions still open — the owner's

| Decision | Why it is blocking what it blocks | Cost against D3 (₹15,000/mo cap) |
| --- | --- | --- |
| **Hosting** (OB-02) | Nothing can be deployed anywhere real | Managed PostgreSQL + a small VM + object storage fits comfortably. Forecast in `docs/registers/` |
| **Identity provider** | **Nobody can log in.** No user acceptance testing can run | Several are free at this scale |
| **AI provider** | Agents stay off (kill switch defaults on) | Budget-capped by design; can stay ₹0 |
| **Store hardware** (EX-09) | Tills, scanners, scales, handhelds, back-office box, UPS | One-off, not runtime |

**The identity provider is the one to decide first.** It is small, it is cheap, and everything about
user testing is behind it.

## Hardening still to do

- **Backups tested by restoring**, not by existing. The runbook is written; the restore has to be
  performed and timed.
- **Penetration test** (EX-13) before go-live.
- **A UPS on the back-office box.** The software now survives a power cut correctly; a UPS means it
  does not have to.
- **Monitoring that pages a human** when sync lag or the dead-letter queue crosses a threshold.

---

# What good looks like, and how we will know

Not a feature list — the five things a shop actually judges.

| | Measured how |
| --- | --- |
| **It never loses a sale** | Unplug the network, sell ten, plug in: ten in the cloud, once. Pull the plug mid-sale: nothing the cashier was told was complete is lost |
| **A new cashier bills alone after 30 minutes** | Watch one do it. Count the interactions |
| **The shop trades with the internet down all day** | Do it for a full trading day |
| **The month closes and the CA signs it** | Against a bank statement and a filed return, not against ourselves |
| **It is legal on day one** | The CA and a compliance review say so, before go-live |

---

# The sequence, on one page

```
NOW ──┬─ Phase 1: POS screen, end to end, real hardware        ← the critical path
      │
      ├─ Phase 2: real data into rehearsal   (owner + CA time, runs in parallel)
      │
      ├─ Decide: identity provider, hosting  (owner, small, unblocks UAT)
      │
      ▼
   Phase 3: store manager → owner → purchase → picker/delivery → customer
      │              (Phase 4 compliance runs alongside throughout)
      ▼
   Phase 5: hardening — restore rehearsal, penetration test, monitoring
      │
      ▼
   Pilot: one lane, one week, both systems watched, old system read-only
      │
      ▼
   Cutover weekend  (docs/runbooks/cutover-weekend.md — already planned hour by hour)
```

---

## What I need from the owner, and it is short

Everything else on this page can proceed without him.

1. **`docs/discovery/store-facts-questionnaire.md`** — fifteen minutes. Most of it he knows without
   looking anything up.
2. **Has turnover ever exceeded ₹5 crore in any year since 2017–18?** One number, and it decides
   whether a government-portal integration is on the critical path.
3. **An identity provider.** Small, cheap, and everything about user testing waits behind it.
4. **The two phone calls** already named in the extraction plan: whoever installed the current
   system, and the CA's journals-only list.

## Related

- `docs/architecture/gap-analysis.md` — where the project stands, honestly
- `docs/requirements/data-requirements.md` — every field, and where it comes from
- `docs/design/screens/` — the fourteen screen specifications this plan builds
- `docs/runbooks/extraction-work-plan.md` · `docs/runbooks/cutover-weekend.md`
