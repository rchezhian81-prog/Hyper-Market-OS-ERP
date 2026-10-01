# Screen spec — Delivery (Stage 3)

- **Surface:** Delivery (§27) · **Modules:** M19, M18, D09 · **Design bar:** a low-spec Android phone in a moving vehicle; assigned stops offline; proof and COD captured honestly; failures/RTO handled, not hidden.

> Built on `../design-system.md`. Runs on a **low-spec Android phone** — large targets,
> offline-first, minimal data on device.

## Screens & states (§27 Delivery row)
My route / stops · Navigation & geofence · Stop detail · Proof of delivery ·
COD collection · Failed / reattempt / RTO · End-of-shift settlement.
All handle the §27.1 states.

## Route → deliver → prove (M19 / D09)
- Assigned route with geofence and navigation; stop detail shows what the customer expects.
- **Proof of delivery**: photo/OTP/signature per policy; **COD** collection recorded to
  the paisa; a failed delivery records a reason and routes to reattempt or RTO.
- **Contribution stop rules** (D09): an unprofitable route/stop pattern is flagged per the
  rule — surfaced, never silently continued.
- **Interaction budget (≤3):** capture proof (≤3) · record COD collected (≤3) ·
  mark failed with reason (≤3).

## Offline / state (§31 delivery row)
- Assigned stops are **cached offline**; scans/proof/COD **queue** and sync;
  **location/PII minimized**; nothing stale is shown as delivered.

## Settlement
- End-of-shift COD and partner/fleet settlement reconciles cash collected vs orders and
  feeds finance reconciliation.

## Acceptance (QG-02)
- A driver completes a stop and captures proof with no network.
- COD reconciles at end of shift against the orders delivered.
- A failed delivery records a reason and routes to reattempt/RTO.
- A contribution-stop condition is visible, not buried.

## Measured (Stage G slice 4)
Counted in a real browser at a phone's size (`tests/e2e/the-handhelds-meet-the-spec.e2e.ts`), from the stop the
driver is at (the first unfinished stop is selected on their behalf and outlined): capture proof **2** (Delivered →
Photo or Signed) · record COD collected **2** (Cash or UPI → OK on the amount the order says, or type the actual
amount) · mark failed with reason **3** (Could not deliver → the reason → try again / back to the store).
**Listed exception:** proof by the customer's OTP costs one tap per digit plus OK — the digits are the customer's.

## Sync — where each piece of work is (SP-3c-ii, 1 Oct 2026)

On the shop wifi the phone is served by the store computer's **device socket** (ADR-0019): it enrols once with head
office's one-time code and is sent back to this screen. Every stop outcome, the end-of-shift settlement and the counted
cash handover are queued on the phone first, handed to the store computer after each accepted action and every ten
seconds (out on the road the hand-over simply fails and the queue waits), and relayed by it to head office's route
register (`/v1/delivery/routes/:routeId/stops/:stopId/synced`, `…/settled/synced`, `…/handover/synced`). Below the stops,
**Sent from this phone** lists each piece of work with one of the five shared state words — *saved here · retrying ·
with the store computer · posted · refused* (with the reason) — and the badge counts them by state. The phone's own
"saved" is never shown as "sent": only the store computer's word says head office has it (P-08). **End of shift** now
queues the COD settlement (M19-FR-04) before the counted handover. Head office re-verifies the driver, moves the order
through its own lifecycle for each stop (a step the order cannot take is written down and shown, never forced), compares
the settlement and the handover with the stops it holds, and flags a material cash difference for the cash office.
