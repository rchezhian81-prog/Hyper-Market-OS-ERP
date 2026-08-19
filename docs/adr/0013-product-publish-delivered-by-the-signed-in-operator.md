# ADR 0013 — Product publish is delivered by the signed-in operator, not a background service identity

- **Status:** Accepted
- **Date:** 18 August 2026
- **Context:** Authoring a product on the ERP catalogue screen queues a durable, deduplicated
  `ProductPublishRequested` command to an offline outbox (`apps/web-erp/src/catalogue-publish-command.ts`,
  `apps/web-erp/src/catalogue-session.ts` `requestPublish`, wired in `apps/web-erp/src/browser-entry.ts`).
  The final step — delivering that queued command to the cloud publish route
  `POST /v1/catalogue/products/:productId/publish` — meets a restriction: that route is gated
  `catalogue.pack.publish`, held **only by the owner role** (`services/api/src/roles.ts:30`). The edge sync
  transport (`edge/sync-agent/src/http-transport.ts` `EVENT_ROUTES`) relays queued events under a **store
  service token** whose catalogue-relevant grant is the narrow `pos.sale.sync`, and it **deliberately
  dead-letters authority/governance commands** (e.g. `GstReturnActionRequested`) that would otherwise be
  applied as the wrong actor, pending a security-reviewed delivery route. So an owner-level authoring command
  cannot simply be added to `EVENT_ROUTES`: doing so would either 403-dead-letter, or require handing a
  service identity owner-level publish authority — a least-privilege and audit-attribution problem (P-04).
  The owner was asked to choose the delivery-authorisation model.

## Decision

Queued product-publish commands are delivered by the **signed-in web application, acting as the
authenticated operator**, when connectivity returns — **not** by a background/service publishing identity.
Saving offline and publishing centrally are **separate actions**. We will NOT build a privileged
background service-publishing identity for this workflow; a trusted store-sync delivery channel may be
reconsidered later only if unattended synchronisation becomes a proven operational need and receives its
own security design review.

### Required controls (owner-approved, 18 Aug 2026)

1. Offline save and central publish are distinct actions.
2. Each queued item retains: tenant, creator, creation time, device, original payload (or digest), approval
   state, idempotency key. **No access/refresh tokens** are ever placed in the durable queue.
3. Before publishing, **revalidate the operator's CURRENT** authenticated session, tenant membership,
   product-publish permission, and approval/separation-of-duties status — **never trust permissions captured
   when the item was queued**.
4. Recent MFA/re-authentication is required for **bulk** publishing or **sensitive** product categories.
5. A clear, operator-visible review queue exposes each item's state: `pending`, `ready`, `validation_failed`,
   `approval_required`, `conflict`, `published`, `permanently_refused`.
6. Authorised users may **review** changes before publication; there is **no silent auto-publish** immediately
   after login.
7. Publication goes through an **idempotent** endpoint so retries cannot create duplicates.
8. **Append-only audit** evidence is preserved for creation, edits, approval, publication, refusal and retry.
9. The **central boundary re-checks** SKU/barcode uniqueness, tax, category policy, price/MRP, UOM,
   batch/expiry requirements and mandatory fields — not just the client.
10. If the creator has lost permission, changed tenant, been suspended or left, publication is **refused and
    routed for reassignment/approval**.
11. Conflicts enter an **operator-visible queue** — never silent last-write-wins (hard rule #10).
12. The queued data is kept **encrypted and tenant/device isolated**.
13. Browser E2E covers: offline create; reconnect; review; authorised publish; expired session; revoked
    permission; cross-tenant refusal; duplicate retry; validation conflict; approval-required product;
    successful audit attribution.

## Consequences

- **Attribution is correct by construction** — the publish is genuinely performed by the operator's session,
  so the append-only audit names the person, not a service (P-04, hard rule #4).
- **Least privilege is preserved** — no service identity gains owner-level publish authority.
- **Offline-tolerant, not offline-critical** — a product saved offline publishes the next time an authorised
  person opens the app online. This is acceptable because product authoring is a back-office action, not a
  shop-floor-critical one; the offline-first guarantee (P-01) that matters is the POS sale, which is untouched.
- **A review queue becomes the unit of work** — the delivery is not a blind drain but a reviewed, re-validated,
  state-machine-driven step, which is the honest shape for a restricted authority (P-03 control by exception,
  P-08 no silent failure).
- The GST-returns governance commands remain dead-lettered behind the same trusted-delivery boundary; this ADR
  does not build that channel, and explicitly declines to for this workflow.

## Reconsider-when

Unattended/headless synchronisation of authoring commands (no operator session available at delivery time)
becomes a proven operational requirement — at which point a dedicated, security-reviewed "apply a synced
authoring command" route that trusts the relayed `requestedBy` identity is designed and recorded as a new ADR.
