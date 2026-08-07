# Stage 6 gate evidence — offline/sync vertical slice

**Gate:** roadmap Stage 6 — *"Internet-off, duplicate, reorder and recovery tests pass."*
Path: **product/price → local POS sale → cloud ledger → reconciliation.** Also satisfies
**QG-04 Offline** and contributes to **QG-07 Data**.

**Executed:** 4 August 2026 against **PostgreSQL 16.13**, using the real product master,
price list, catalogue snapshot builder, POS session, pricing, tender, sale commit, sync
outbox, sync agent and SQL event store. Nothing is mocked except the **network** — which is
the point: the design claim is that the shop trades when the network is absent, and you
cannot prove that with a network that works.

Automated as `tests/integration/offline-sync-slice.test.ts`, run in CI against a real
PostgreSQL service container. Without `DATABASE_URL` the suite **skips rather than passes**,
because a skipped test reporting green is how a broken guarantee ships.

---

## Two defects found — both invisible to unit tests

### 1. The first real sale could not sync at all

```
invalid input syntax for type uuid: "evt-S-OFFLINE-1"
```

`event_ledger.id` was declared `uuid`; a `DomainEvent` carries a readable,
domain-supplied identifier. The `SqlEventStore` unit tests used a fake SQL client that
accepted any string, so nothing caught it. **Only real engines against a real database
could.**

### 2. Fixing that exposed a worse problem underneath

The constraint was `UNIQUE (id)` — **global across every tenant**. With domain-supplied ids
that is a cross-tenant collision waiting to happen: two shops each minting `evt-S-1` from
their own gap-free numbering would collide, and **the second tenant's sale would be silently
rejected by the first tenant's data**. In a multi-tenant product the uniqueness boundary is
the tenant, always (ADR-0003).

**Migration `0005_event_id_domain_scoped.sql`** makes `id` text and scopes uniqueness to
`(tenant_id, id)`. Safe and reversible; `text` accepts every value the `uuid` column held.

---

## The five gate tests

### 1. Internet-off — a sale completes with the cable out (hard rule #1, QG-04)

The cable is pulled **before the customer arrives**. Two items scanned from the local
catalogue, priced at ₹450.00 + ₹180.00 = ₹630.00, +5% GST = **₹661.50**, tendered and
**committed locally**. A drain attempt while offline delivers nothing and loses nothing;
the queue shows **1 unsent**. The cable goes back in, one drain, and the sale is in the
cloud ledger in PostgreSQL.

### 2. Duplicate — delivered twice, banked once (§31.1)

The classic real case: the cloud accepted the sale, the acknowledgement was lost coming
back, the lane sent it again. After the replay the stream still holds **exactly one**
event, and the store reports the second delivery as deduped.

### 3. Reorder — three sales delivered back to front

All three land exactly once. The cloud sequence records **arrival** order while each event
keeps the time it actually **happened** — both facts are needed: one to replay
deterministically, the other to report the day correctly.

### 4. Recovery — the link dies mid-drain

Three queued sales; the link fails after the first. The pass acknowledges 1 and leaves
**2 still queued — not lost, not dead-lettered**. When the link returns the agent picks up
exactly where it stopped: 2 acknowledged, 0 unsent, 0 dead letters, and each event present
once.

### 5. Reconciliation — the lane and the cloud agree to the paisa (QG-07)

A morning's trading with **no internet at all**: four baskets, ₹661.50 each. At lunchtime
the link returns and the queue drains to zero. Summing the cloud ledger gives
**₹2,646.00** — exactly what the tills took. Not "about the same".

---

## Result

```
✓ tests/integration/offline-sync-slice.test.ts (5 tests)
  ✓ rings up and commits a sale with the network cable OUT
  ✓ produces ONE business effect when the same sale is delivered twice
  ✓ lands the right answer when events arrive OUT OF ORDER
  ✓ recovers from a link that fails mid-drain, losing nothing and duplicating nothing
  ✓ reconciles: what the lane took equals what the cloud holds
```

**Stage 6 gate conditions — internet-off, duplicate, reorder, recovery — all pass**, with
reconciliation proven on top.

CI now runs this job on every pull request against a real PostgreSQL, plus a full
backup → destroy → restore → reconcile cycle, so neither guarantee can rot silently.
