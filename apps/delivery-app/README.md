# `apps/delivery-app/`

The rider/driver app — assigned route, proof of delivery, COD collection, failures and
end-of-shift settlement (**M19 / M18 / D09**). Built to the Stage 3 spec in
`docs/design/screens/delivery.md`.

Runs on a **low-spec Android phone in a moving vehicle**, so `src/route-session.ts` is
**synchronous and local by construction**: stops are cached, proof and COD are captured on the
device, and nothing awaits the network (§31 delivery row).

## What it enforces

- **Nothing is "delivered" without proof** — photo / OTP / signature per policy (M19-FR-03),
  delegated to `packages/fulfilment`; a missing or blank proof throws and the stop stays
  out-for-delivery.
- **The order of a stop is a state machine** — depart → deliver, or fail → reattempt /
  return-to-origin. Delivering before departing is refused.
- **COD is recorded to the paisa** and reconciled at end of shift by the tested COD engine:
  **short / over / uncollected / unexpected** each surface as a **valued exception** feeding
  finance (M23), and a **card method is refused** — COD is cash/UPI only (hard rule #3).
  `codHeld()` is the cash the driver should be carrying.
- **A failed delivery records a reason** and routes to reattempt or RTO — never quietly dropped.
- **A geofence mismatch is flagged, not blocked** — a driver may legitimately be a street away,
  so the delivery completes but the mismatch is **visible on sync**.
- **Contribution stop rules (D09) are surfaced, not buried** — when a stop's delivery cost
  exceeds the tenant's configured share of order value, the stop carries a plain-English flag
  (e.g. *"Delivery cost is 16.0% of order value (limit 10.0%)"*) and appears in
  `contributionFlags()`. The rule is **per-tenant configuration**, never hard-coded.
- **PII is minimised** — a stop carries the **order reference and a coarse area label**, never
  the customer's name, phone or email (tested).

## Status

Model complete and tested (15 tests). Remaining: the phone view layer (large targets for use in
a vehicle), navigation/geofence integration, and queueing proof/COD to the sync outbox — the
same `packages/sync` path the POS already uses.

Tested in `tests/unit/delivery-route.test.ts`. Part of the repository layout in `CLAUDE.md`.
