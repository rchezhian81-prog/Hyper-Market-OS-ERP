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
