# ADR 0028 — The queue till (mobile POS, D04-FR-05) reaches the store computer through the device socket's own door, behind two switches that are off until set

- **Status:** Proposed (built behind two rollout switches that are OFF until set; the money switch is high-impact, so the
  owner approves it before it is switched on)
- **Date:** 25 October 2026
- **Context:** D04-FR-05 asks for "mobile POS, queue busting". It was deferred to R5 (OB-73) and is back in scope under
  OB-288. A staff member walks the queue with a low-spec Android handheld, scans a customer's basket, and either takes the
  payment or hands the basket to a till. The till's own sale path lives on the lane's loopback socket and must stay there
  (ADR-0004: nothing on the shop network can write to it). The handhelds reach the store computer only through the
  authenticated device socket (ADR-0019), which so far served only the warehouse, picker and driver shells and the device
  outbox — "never the till". The handheld must keep working with no internet (hard rule #1), use the signed pack for every
  price and gate, use the person's own verified PIN (ADR-0020), and send head office the same sale record as a till.

## Decision

1. **A separate door on the device socket, `/queue-pos/…`** (`edge/store-edge/src/queue-pos-door.ts`), reached only after
   the device socket has authenticated the enrolled device (`device-server.ts`). It serves the queue-till shell
   (`apps/queue-pos`) with the store computer's signed pack, and nothing of the till's own screen. ADR-0019 §1 ("it never
   serves the till") is amended for this door only.
2. **Its own sign-in, for selling.** The person signs in with their staff ID and the SAME personal till PIN, checked on the
   box by the till's register for `pos.sale.sync` (`TillOperators.signInOnDevice`). The session belongs to the phone
   (`device:<id>`), lasts four hours (OB-184) and ends when someone else signs in. A warehouse or picker sign-in on the
   same phone opens nothing here.
3. **The till's own model, and the till's own pipeline.** The handheld runs the till's tested session (`apps/pos`
   `bootPos`) against the served pack, so price, offers, bundles and the tobacco, liquor, BIS, expiry and age gates are
   the till's. A card or UPI sale goes to a loopback instance of the SAME lane pipeline (`lane-server.ts`), one per
   handheld, lane `device:<id>`: the attempt recorded before the machine is asked, the box's receipt number, the legal
   gates again before the disk, card data removed, the seal on who rang it (ADR-0023), the fsync, then the box's sales
   queue to head office — the same record as a till's.
4. **Only what a queue till needs.** The door relays the operator status, sync status, sale, receipt numbers, card/UPI
   attempts and void evidence. It never reaches refunds, cash movements, a shift or day close, approvals, holds, the device
   outbox or the till sign-in. A sale with any tender other than card or UPI is refused before anything is written:
   the owner decided a handheld takes **no cash** (OB-372, 25 Oct 2026). It has **no printer** either (OB-373): its paid
   screen says "Ask at a till or the service desk to print this bill" with the bill number, and a till served by the same
   store computer prints a copy by that number (`POST /lane/bill-copies`, `edge/store-edge/src/bill-copies.ts`) — marked
   DUPLICATE, recorded on the box (who, which copy, why) before it is answered, then relayed to head office
   (`BillCopyPrinted` → `/v1/bill-copies/:copyId/synced`). The queue-till door never reaches it.
5. **Otherwise, a hand-over by code.** The basket is kept on the store computer's disk under a four-digit code
   (`queue-baskets.ts`, rules in `packages/suspended-sales/src/queue-basket.ts`); a till served by that store computer keys
   the code (`POST /lane/queue-baskets/recall`, loopback, offline) and re-rings every line through its own pack, once.
6. **Two switches, per branch and per lane (OB-316), OFF until set:** `pos.queue_busting` (the door and the till's recall)
   and `payments.mobile_pos` (the handheld may take money). Both are judged for the store computer's own lane from the
   signed pack. `payments.*` is high-impact, so head office asks the owner's approval before it is turned on.

## Consequences

- With the internet down the queue keeps moving: the handheld, the box and the till talk over the shop's own wifi.
- With the wifi or the store computer down the handheld still scans (the page and the pack are cached), but it can
  neither hand over nor take money — the screen says the store computer is not answering.
- A money write now crosses the shop network. The device socket still speaks plain HTTP (ADR-0019 "what this does not
  do"): the handhelds must stay on a staff-only WPA2/WPA3 network separate from guest wifi. No card data travels — only the
  box's attempt reference and the machine's approval number — but a session cookie is readable by a device already on that
  network. TLS on the device socket remains the follow-up ADR-0019 names.
- A handheld's bills are numbered by the store computer for lane `device:<id>`. Head office issues that lane its own
  bill-number prefix through the till-prefix route (OB-376, `POST /v1/stores/:storeId/tills/device:<id>/receipt-prefix`,
  only for a handheld registered at that store); until it does, they carry the store computer's own store-coded prefix and
  head office flags each one (as for any till with no prefix).
- The hand-over AND the handheld's bills live on ONE store computer. Where each till PC is its own store computer
  (ADR-0004), the owner decided (OB-377, 25 Oct 2026): **enrol each handheld to the PC of the till it serves**. A till on
  another PC refuses the code and the bill number in words (tested: `tests/integration/the-queue-till-scans-pays-and-hands-
  over-through-the-store-computer.test.ts`, step 3c). The install steps are in `docs/runbooks/in-store-install.md` Step 6b.
- A handheld names no scale, so loose weighed goods are refused on it by the till's own B6 rule; the till scans those.

## Reconsider-when

The owner reverses OB-372 (cash on the handheld); TLS is added to the device socket; tills share one store computer, or a
cross-box hand-over or reprint is wanted; a Bluetooth printer is bought for the handheld's bill (OB-373 would then be
revisited).
