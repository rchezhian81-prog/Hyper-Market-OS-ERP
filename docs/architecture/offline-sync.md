# SRE Retail OS — Offline-first & sync design (Stage 4)

- **Roadmap:** §31 (offline behaviour & matrix), §31.1 (conflict & idempotency), §4.2 (durable local commit), §32 (performance). Principles **P-01** (offline first), **P-08** (no silent failure); **hard rules #1** (POS never depends on the network), **#6** (never drop dead-letter), **#10** (conflicts are exceptions).
- **Purpose:** The detailed design that keeps the store trading with no internet and no cloud, and makes sync safe, idempotent and honest. This is the load-bearing part of the architecture — the other docs defer to it.

## 1. The rule that drives the design
A core POS sale never depends on a network call (**hard rule #1**). So the edge is **not**
a cache in front of the cloud — it is a **self-sufficient trading system that happens to
sync**. The cloud is the central truth for reporting, control and omnichannel; the store
edge is the truth for trading while it is offline. Enforced by
`tests/guardrails/pos-offline.test.ts`.

## 2. Offline classification (§31 matrix)
Every operation has a class; the UI always shows the current class and connection state
(§27.1 — online / degraded / offline / reconnecting / unsent count / freshness).

| Class | Operations | Behaviour offline |
| --- | --- | --- |
| **Full offline** | POS core sale & cash/store-credit tender, scan/price/weight, suspend/recall, receipt, org calendar/config read | Completes locally and prints; **durable commit before "success"** (§4.2); syncs idempotently on reconnect |
| **Queue-capable** | Receiving, stock count, transfer, adjustment (store/handheld) | Appends events with **globally unique command ids**; queued; conflicts surface on sync |
| **Cached / minimized** | Customer lookup, loyalty | Cached or minimized; **guest-sale fallback**; offline caps prevent double-spend; freshness shown |
| **Generally online** | Purchase issue/approval, finance posting/period, admin structural change | Drafts may cache where approved; **no unsafe stale approval or period mutation** |
| **Online required** | Customer app order/payment, card/UPI authorization | Needs online for the promise/authorization; **cart may cache**; clear unavailable message — never a fake approval |
| **Assigned-work offline** | Picking, delivery | Assigned work cached; scans/proof queue; **location/PII minimized** on device |

## 3. The store edge
- Durable **append-only file-log** + containerised local services (the §19 local relational DB is deliberately substituted — ADR-0011).
- **Signed, versioned packs** of config/product/price/tax published from cloud (M01-FR-03);
  the store keeps last-known-good and **never activates an unpublished/expired pack**.
- A durable **outbox** (local events awaiting sync) and **inbox** (cloud updates to apply).
- A **sync agent**: bidirectional, idempotent, resumable.

## 4. The sync protocol
- **Local-first commit:** a transaction is written durably to the local **append-only log** **and** appended
  to the outbox in one atomic step **before the receipt is declared successful** (§4.2,
  hard rule #1). A power cut at commit yields exactly one correct result on restart.
- **Outbound:** the sync agent drains the outbox to the domain API with an
  **`Idempotency-Key`** (§31.1); cloud applies **once**; the same sale/movement replayed
  produces one ledger effect. An ack advances a per-stream **watermark**; unacked items
  stay in the outbox and show as the **unsent count**.
- **Inbound:** cloud publishes config/price/master-data updates as signed versioned packs;
  the edge applies them and rebuilds its projections.
- **Ordering:** events carry a deterministic order key + source; out-of-order arrival is
  reordered to the correct result (M08 acceptance).

## 5. Conflicts become exceptions (hard rule #10, §31.1)
- **Never last-write-wins.** When two edits collide — the same config edited in two places,
  a command that cannot apply cleanly — the system raises a visible **conflict exception**
  carrying both sides and a next action, routed to the right role surface for a human to
  resolve.
- A **pending approval invalidated by a later change** is flagged, not silently applied
  (§31.1 — see the owner and manager screen specs).

## 6. Document numbering offline (M01-FR-02)
Each lane holds a **reserved number range** per document type; offline documents draw from
it; ranges reconcile on sync — so two lanes offline for a day produce **no duplicate
numbers**.

## 7. Freshness, unsent count & health (P-08)
- Every transactional surface shows **online/degraded/offline + unsent count + last-sync
  time** (§27.1).
- The owner dashboard shows **last-synced data with per-branch/domain freshness** — nothing
  stale is presented as live.
- Sync-lag and edge health are observable (M35).

## 8. Dead-letter (hard rule #6)
A sync item that repeatedly fails to apply (a "poison" item) moves to a **visible
dead-letter queue** with its reason — **never dropped, never retried forever silently**; an
operator resolves it. The same discipline governs the Tally connector (M23-FR-04) and the
sync outbox (ADR-0008).

## 9. Recovery
- **Reconnect:** the sync agent resumes from the last watermark; no manual replay.
- Store↔cloud recovery and business-continuity runbooks with **tested restores** (M35);
  RPO/RTO targets (NFR).

## 10. Acceptance (QG-04 / §32)
- Cable pulled mid-basket → the sale completes, prints, the unsent count increments, and it
  syncs **exactly once** on reconnect.
- Two lanes offline a full day → **no duplicate document numbers**.
- Replayed / out-of-order / power-cut-at-commit → **one correct result**.
- A real conflict appears as an **exception with a next action**, never a silent overwrite.
- A poison sync item is **visible in dead-letter**, not lost.
- Scan-to-line p95 ≤ 300 ms; total/tender p95 ≤ 500 ms excl. external auth (§32).
