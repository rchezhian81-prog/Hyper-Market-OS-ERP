# Screen spec — CRM / Service (Stage 3)

- **Surface:** CRM/Service (§27) · **Modules:** M21, M16, M17, D07 · **Design bar:** no message goes out without consent; a complaint is tracked to resolution with an SLA; any compensation is approved, never a free hand.

> Built on `../design-system.md`.

## Screens & states (§27 CRM/Service row)
Campaign builder · Segment & consent check · Journeys (abandoned-cart / win-back) ·
Attribution · Complaint / case desk · Warranty · Compensation · SLA & escalation ·
Satisfaction. All handle the §27.1 states.

## Consent-safe marketing (M21 / D07 · PRV)
- Campaigns across WhatsApp/SMS/email/push reach **only** customers whose **consent and
  frequency rules** allow it — the builder shows the reachable count **after** consent
  filtering and **blocks** a send that would breach consent or a frequency cap.
- Abandoned-cart / win-back journeys and attribution (M21).

## Service desk (M21)
- Complaint / warranty / **compensation** case management with SLA, escalation and
  satisfaction capture.
- **Compensation is a financial action** → maker-checker approval and audit (§28,
  hard rule #5 spirit). An agent or AI may **draft** a response, but a human commits a
  goodwill credit.
- **Interaction budget (≤3):** open and reply to a case (≤3) · check a customer's consent
  state (≤2) · raise a compensation for approval (≤3).

## Offline / state (§31)
- CRM/service is online; consent state and case-history freshness are always visible.

## Acceptance (QG-02)
- A campaign cannot send to a non-consented customer or breach a frequency cap.
- A complaint follows its SLA with visible escalation.
- A compensation requires a separate approver.
- A consent withdrawal takes effect immediately.
