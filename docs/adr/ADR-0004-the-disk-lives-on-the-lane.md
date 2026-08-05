# ADR-0004 — The durable write lives on the lane, not on a back-office box

**Status:** Accepted · **Date:** 5 August 2026 · **Supersedes:** nothing · **Relates to:** P-01,
hard rule #1, §19, §31, ADR-0002

---

## The question

A sale must be on a disk before the receipt prints. **Whose disk?**

Two shapes were available, and the choice decides how the shop behaves on its worst day.

### Option A — one edge for the shop, lanes talk to it over the shop network

The back-office box owns the disk. Every lane posts its sale to it and waits for the write.

### Option B — every lane owns its own disk *(chosen)*

Each lane runs its own edge process, writes its own sales, and syncs them itself. The back-office
box is just another node with no special authority over a sale.

---

## The decision

**Option B.** Each lane owns its own durable log.

## Why

**Option A puts a single point of failure between the customer and the receipt.** If the
back-office box is off, rebooting, out of disk, or on the wrong end of a switch somebody unplugged
while looking for a socket, then **every lane stops taking money at once**. That is not a degraded
mode; that is a closed shop with customers holding baskets. And it fails in exactly the situation
offline-first exists for — the bad day.

It is also the wrong direction for hard rule #1. The rule says a sale never depends on a network
call. Option A replaces the *internet* with the *shop LAN* and calls the problem solved, but a
switch, a cable and a shared box are a network, and each of them fails. A lane writing to its own
disk depends on nothing outside the till it is standing in.

Option B costs redundancy: four lanes hold four logs, four outboxes and four cursors, and the same
sale is never in two of them. That is the correct trade. **Redundant hardware is cheap; a shop that
cannot take money is not.**

## What follows from it, and these are the load-bearing consequences

- **The lane server binds to `127.0.0.1` and nothing else.** The lane's browser and the lane's edge
  are on the same machine, so a loopback socket is the whole of the surface. Anything reachable from
  the shop LAN could otherwise be written to by any device on it — a guest phone on the shop wifi
  is a device on the shop LAN.
- **No shared secret is needed, and adding one would be theatre.** An attacker who can reach
  loopback is already running code on the till, and at that point a token in the same browser buys
  nothing. The control is the bind address.
- **Each lane needs a small disk allowance** — a few days of its own trading, which is megabytes,
  not gigabytes.
- **Sales are identified per lane.** A sale id carries its lane, so four lanes cannot mint the same
  identity. This is already true: the lane id is in the sale.
- **The back-office box does the shop-wide work** — receiving, counting, reporting, day close — and
  runs the same edge process. It simply has no lane attached.
- **The cloud dedupes across all of them.** Four lanes syncing independently is four streams of the
  same shape, and the idempotency key was minted at the lane that took the money.

## What we give up

- **Four things to patch instead of one.** Mitigated by them being the same container image, and by
  the deployment being containers already.
- **No single place to look at "the shop's unsent queue".** Each lane reports its own; the shop view
  is the sum. That is a reporting job, not an architecture problem, and the per-lane number is the
  one a cashier needs anyway.
- **A dead lane holds its sales until it is repaired.** Real, and the honest answer: its log is on a
  disk that can be read, and the sales are recoverable by moving the disk. Option A's failure — no
  lane can trade — has no such recovery.

## How we will know it was right

Unplug the back-office box in the middle of trading. **Every lane keeps selling.** That is the test,
and it is on the pilot list.
