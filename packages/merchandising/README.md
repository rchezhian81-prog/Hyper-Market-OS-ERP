# `packages/merchandising/`

Merchandising, space and planograms — **M04 / D02**. What each store carries, where it
sits, and whether that space earns its keep.

## The range is an answer, not a habit (`src/assortment.ts`, M04-FR-01)

Without a per-store assortment, two things go wrong in opposite directions:
replenishment cheerfully reorders an item this branch stopped carrying eighteen months
ago, and an item rings up at a store with no shelf, no reorder point and no supplier line
for it. So the rule is enforced both ways — **sold ⇒ in the range; not in the range ⇒ never
reordered** — and clearance sits deliberately in between: it **sells** but is **never
reordered**, which is the whole point of clearance.

**Dropping is the dangerous operation.** Removing a stocked item from the range makes its
stock invisible: not counted, not replenished, not sold, eventually written off. So a drop
with stock on hand **routes to clearance instead of deleting**. Every range decision is
effective-dated, names who made it, and carries a reason — "why did we stop carrying this?"
is asked six months later by someone who was not in the meeting.

## Shelf location sequences the picker's route (`src/shelf.ts`, M04-FR-02)

This is quietly one of the highest-value pieces in the system. A picker without a route
walks the shop the way the order was typed — dairy, rice, back to dairy. With one they walk
it once. **Picking time is the largest controllable cost in online grocery**, and it is
decided here.

The address is ordered, not just labelled: aisle → rack → bay → shelf → position, all
**numbers**. As text, `A10` sorts before `A9`, and a picker sent up and down an aisle twice
never knows why. Unmapped items go **last and marked** — hiding them sends the picker back
across the shop; dropping them loses the line.

An item has **exactly one primary location**. Two primaries means the route and the
replenishment disagree about where it lives, and both are then wrong. Secondary facings
(a promotional display) are fine and add to capacity.

## The empty shelf with a full stockroom (`src/shelf.ts`, M04-FR-03)

The most expensive out-of-stock there is: the sale is lost, the stock is already paid for,
and the system reports the item as in stock. `planogramCompliance` turns it into a task for
a named role — and distinguishes it sharply from an empty shelf with an empty stockroom,
which is a **reorder, not a refill**. Tasks bring only what the stockroom actually has (never
send someone to fetch nothing), carry a priority, and are handed over **in route order** so
the shelf-filler also walks the shop once. Compliance is measured in basis points against a
per-tenant refill level.

## Turnover flatters; margin decides (`src/space.ts`, M04-FR-04)

A 14,000 sq ft shop has a fixed floor: every square foot given to one category is taken from
another. `spacePerformance` ranks areas by **margin** per square foot, not sales — a category
with big turnover and thin margin can be the worst use of space in the building while looking
like the best — and flags an area whose share of margin sits materially below its share of
floor. A ratio that cannot be computed says **`not_meaningful`**, because "0 per sq ft" and
"we never measured this area" lead to opposite decisions.

**Display contracts** name the space, the money and the dates, and reconcile against what
finance actually received. The finding that matters commercially: a contract that **expired
while the display is still on the floor** — the supplier stopped paying and nobody took the
stand away, so the shop is giving away its best space.

Pure and deterministic — dates are injected, no clock, no I/O. Tested in
`tests/unit/merchandising-assortment.test.ts` (12), `merchandising-shelf.test.ts` (11) and
`merchandising-space.test.ts` (8).
