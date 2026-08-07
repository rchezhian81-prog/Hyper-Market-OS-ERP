# `packages/notifications/`

Notifications — **M31-FR-03** (consent-safe routing) and **M31-FR-04** (retry / dead-letter /
suppression / template approval). The shared send engine for email/SMS/WhatsApp/push.

- **`src/guard.ts`** — `canNotify(input)`: **consent-safe by construction**. Every gate must
  pass, in order — **approved template** (§28) → **suppression / do-not-contact** (absolute) →
  **consent + frequency** (reusing `packages/customer` `canSend`, M16-FR-02) → **messaging
  budget**. A breach **blocks** the send (never warned-and-sent), returning the reason
  (`unapproved_template` / `suppressed` / `no_consent` / `withdrawn` / `frequency_cap` /
  `over_budget`).
- **`src/queue.ts`** — `NotificationQueue`: enqueue (idempotent), `markDelivered`,
  `recordFailure` (retry; **auto dead-letters after `maxAttempts`**), and a **visible
  dead-letter** queue that is **never dropped** (hard rule #6) — the same discipline as the sync
  outbox and the Tally connector.

> Composes the customer consent engine. Provider connectors (M32) and delivery-status callbacks
> wire in at the integration layer. Tested in `tests/unit/notifications.test.ts`. Part of the
> repository layout in `CLAUDE.md`.
