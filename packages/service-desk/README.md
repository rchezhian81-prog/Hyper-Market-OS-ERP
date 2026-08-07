# `packages/service-desk/`

CRM campaigns and the service desk — **M21** (all four requirements).

## `src/campaigns.ts` — campaigns, journeys, attribution (M21-FR-01/02)

A campaign is the one place a shop can do real damage at scale in a single click: one send
to the wrong list is thousands of people who did not consent, and it cannot be recalled.

- **Every recipient is checked individually, at the send.** A list "approved for marketing"
  is a property of a spreadsheet; consent is a property of a person, and it changes between
  the list being built and the message going out.
- **The excluded count is always reported.** A campaign that quietly drops 400 people looks
  like a campaign to 1,600 — and when the reach keeps shrinking, somebody "fixes" it by
  loosening the check. Naming the number keeps the check defensible.
- **Channel and purpose are separate permissions.** Consent to email is not consent to
  WhatsApp; consent to service messages is never consent to marketing.
- **A promotion inside a transactional message blocks the whole campaign.** "Your order is
  out for delivery" rides the contract rather than consent — which makes it the obvious
  route around the consent check, so that route is closed explicitly.
- `findJourneyCandidates` enforces a **quiet period**: an abandoned-cart message four
  minutes after someone put their phone down is not a nudge, it is surveillance, and it is
  the message people screenshot. It also skips customers who already completed the thing
  the journey is chasing.
- `measureCampaign` counts **only orders after the send, inside the window, by people who
  received it** — and reports the **control group's** conversion beside it. A win-back that
  "recovered" 18% when 15% of an untouched control came back anyway cost money to achieve
  3%; without the control it reads as a triumph.

## `src/service-cases.ts` — cases, compensation, SLA, CSAT (M21-FR-03/04)

- **Compensation is a financial action, so it needs a second person** (§28). Goodwill credit
  is real money leaving the business, handed out by the person the customer is currently
  shouting at. Above the agent's authority it needs a separate approver; **below it, a
  reason is still mandatory** — "goodwill" explains nothing three months later when the
  pattern is being investigated. A tenant ceiling refuses amounts nobody at the desk may
  grant, whoever approves.
- **AI drafts, a human sends** (hard rule #5). `approveDraft` is the only route to a
  sendable reply, it requires a **named** person, and there is deliberately no `sendDraft`
  anywhere in the module — a test asserts that absence. A draft citing no case evidence is
  refused, because there is nothing for the approver to check it against, and an **edit is
  recorded as an edit**, so the shop can see whether the model is helping or generating work.
- **Two SLA clocks, deliberately separate.** `assessSla` (resolution) **pauses while the
  shop is waiting on the customer** — otherwise every case where someone takes three days to
  send a photo reads as the shop's failure, the report fills with breaches nobody caused,
  and within a month nobody looks at it, which is the real damage. `assessFirstResponse`
  does **not** pause, because the shop has not yet said anything to wait on — and a desk
  that resolves everything on time while nobody replies for two days is failing in the way
  customers actually notice. A breach **escalates visibly** rather than turning amber in a
  queue.
- `serviceReport` reports CSAT **with its response rate**: 4.8 from six replies out of four
  hundred cases is not a satisfaction score, it is six people, and the six who reply are
  rarely the ones who left quietly.

> Nothing here sends anything — it decides who may be sent to, and what a human may then
> commit. Pure and deterministic. Tested in `tests/unit/service-desk-campaigns.test.ts` (16)
> and `tests/unit/service-desk-cases.test.ts` (24). Part of the repository layout in
> `CLAUDE.md`.
