// The transport that actually reaches the cloud — §31, §31.1, P-01, P-08, hard rules #1 #6 #10.
//
// `SyncTransport` has been a port with no implementation: "a thin adapter at deployment". Until
// this file, the store edge committed sales durably, queued them honestly, reported its unsent
// count truthfully — and had **nowhere to send them**. This is the wire.
//
// ── An event goes to the endpoint that would have handled it anyway ─────────
//
// There is deliberately **no generic ingest endpoint**. A sale posted to `/v1/ingest` would skip
// everything `POST /v1/sales` does — the price check against the published pack, the receipt-number
// clash, the future-dated commit, the whole exception path — and arrive in the ledger having been
// examined by nothing. A sale that syncs late is still a sale that needs looking at, so it goes
// through the same door as one that syncs immediately, and gets the same answers.
//
// An event type with no route is **rejected by name**, which sends it to the dead-letter queue for
// a person (hard rule #6). It is not dropped, and it is not posted somewhere generic in the hope
// that something downstream copes.
//
// ── The outcome mapping is the whole of the risk ────────────────────────────
//
// `retryable` and `rejected` look similar in code and could not be more different in the shop. An
// unsent sale wrongly marked `rejected` is dead-lettered — it stops being retried, and the money in
// the drawer has no record in the cloud until somebody works the queue. So:
//
//   • **A timeout is retryable, and it is the common case.** A shop on a rural line times out
//     several times a day. Nothing about a slow link says the sale was bad.
//   • **An ambiguous outcome is retryable, never accepted.** If we do not know whether it landed,
//     we send it again; the receiver dedupes on the idempotency key, so a duplicate delivery is
//     one effect (§31.1). Guessing "accepted" loses the sale silently, which is the one outcome
//     with no way back.
//   • **A 5xx is retryable** — the cloud is having a bad minute, not judging the payload.
//   • **A 4xx is permanent**, because retrying a malformed payload forever buries everything
//     queued behind it — with two exceptions below that are not what they look like.
//   • **408 and 429 are retryable.** They are 4xx by number and transient by meaning.
//   • **401 is retryable, 403 is rejected.** An expired token is renewed by the next deployment
//     restart or token refresh, so the sale should still be waiting when it is. A permission the
//     till does not hold will not appear by itself, and that needs a person.
//   • **409 is TWO different answers, and only the body tells them apart (F12, 30 Sep 2026).** A route
//     answering 409 because the record is *already on file* (a count already reconciled, a tag already
//     recorded) is a duplicate delivery — accepted, that is what idempotency is for. The KERNEL answering
//     `409 idempotency_key_reused` / `wasItSaved: not_saved` means a DIFFERENT payload was sent under a key
//     it already holds: nothing was saved, and the two cannot both be right. That is a CONFLICT — rejected
//     to the visible dead-letter queue with its reason (hard rule #10, never last-write-wins; hard rule #6,
//     never dropped), and never acknowledged as delivered. A 409 whose body cannot be read is ambiguous,
//     and an ambiguous outcome is retryable, never accepted; the attempt budget bounds it.
//
// ── Two things this must never do ───────────────────────────────────────────
//
//   • **Never put the token in a message.** The reason string reaches the dead-letter queue, the
//     logs, and eventually a screenshot in a support thread (hard rule #4).
//   • **Never generate its own idempotency key.** The key is the event's, minted when the sale was
//     committed at the lane. A key minted per attempt makes every retry a new sale, and the server
//     doing everything right banks all of them.

import type { DomainEvent } from '../../../packages/contracts/src/event';
import type { SendOutcome, SyncTransport } from './transport';

/** A route is either a fixed template with `:name` segments, or a resolver that reads the payload. */
export type EventRoute = string | ((payload: Record<string, unknown>) => string | undefined);

/**
 * Where each drained portal-action command goes. Its target route depends on TWO payload fields — the
 * document (e-invoice vs e-way-bill picks the URL base) and the action (poll vs verify picks the suffix) —
 * which a single `:name` template cannot express, so it is a resolver.
 *
 * ONLY the two portal-touching, idempotent, non-governance actions are routed here — poll (acknowledgement
 * recovery) and verify (mismatch detection). They carry no maker≠checker decision, so the store's own service
 * identity may safely relay the operator's request; the route re-authorizes on `finance.einvoice.generate`.
 * An unrecognised action or document has NO route and is therefore rejected by name → dead-lettered for a
 * person (hard rule #6), never posted somewhere in hope.
 */
export function gstPortalActionRoute(payload: Record<string, unknown>): string | undefined {
  const id = payload['id'];
  const action = payload['action'];
  const documentType = payload['documentType'];
  if (typeof id !== 'string' || id === '') return undefined;
  if (action !== 'poll' && action !== 'verify') return undefined;
  const base = documentType === 'e_invoice' ? `/v1/finance/e-invoice/invoices/${encodeURIComponent(id)}`
    : documentType === 'e_way_bill' ? `/v1/finance/e-way-bill/movements/${encodeURIComponent(id)}`
      : undefined;
  return base === undefined ? undefined : `${base}/${action}`;
}

/**
 * Where an offline RETURN goes when it reconciles on sync (M13-FR-01). The path carries the bill it is
 * against, and the payload key is `originalSaleId` (not `saleId`), so a `:saleId` template cannot express
 * it — hence a resolver. A **no-receipt** return has `originalSaleId: null` and `noReceipt: true`, and goes to
 * its OWN record-and-flag route `POST /v1/returns/no-receipt/synced` (M13-FR-01, CH-01 un-parked) — the cloud
 * re-checks the owner's cap and the approver there. A record with neither a bill nor the flag is dead-lettered
 * by name (hard rule #6), never posted in hope.
 *
 * Unlike the governance commands below, this IS routed: its target is the dedicated record-and-flag route
 * `POST /v1/sales/:saleId/returns/synced`, which trusts the lane-relayed operator identity (as the synced
 * SALE route trusts the lane's cashier) and RE-VERIFIES the §28 approver on the cloud — a breach becomes a
 * visible exception, never a silent apply-as-the-wrong-actor. So relaying it under the store token is safe.
 */
export function returnAcceptedRoute(payload: Record<string, unknown>): string | undefined {
  // A controlled no-receipt return (M13-FR-01) is against NO bill — `commitReturn` stamps `noReceipt: true`
  // and `originalSaleId: null`. It has its own synced route (record-and-flag: the cloud re-checks the cap and
  // the approver), so it is relayed there, never squeezed into a bill's path. A record with NO bill and NO
  // no-receipt flag is ambiguous and stays dead-lettered by name for a person (hard rule #6).
  if (payload['noReceipt'] === true) return '/v1/returns/no-receipt/synced';
  const originalSaleId = payload['originalSaleId'];
  if (typeof originalSaleId !== 'string' || originalSaleId === '') return undefined;
  return `/v1/sales/${encodeURIComponent(originalSaleId)}/returns/synced`;
}

/**
 * Where each event type goes. Explicit, and small on purpose.
 *
 * The alternative — deriving a path from the type name — is a rule nobody can read and a silent
 * 404 the first time a type is renamed.
 *
 * NOT here on purpose: the GOVERNANCE commands `GstReturnActionRequested` (approve/submit) and the warehouse
 * decisions. Their internal routes decide maker ≠ checker from the AUTHENTICATED principal (`ctx.userId`), so
 * relaying them under the store's own service token would file/approve as the store, not the operator who
 * clicked — breaking §28. They need a dedicated "apply a synced governance command" route that trusts the
 * relayed operator identity, which is a separate, security-reviewed increment. Until then they dead-letter
 * (visible, hard rule #6), which is the honest state — never silently applied as the wrong actor.
 *
 * `ReturnAccepted` is the FIRST such synced-governance route to land (M13-FR-01): its record-and-flag cloud
 * route re-verifies the approver, so it is safe to relay. `commitReturn` at the edge enqueues it (Slice 2b).
 */
export const EVENT_ROUTES: Readonly<Record<string, EventRoute>> = {
  SaleCommitted: '/v1/sales',
  InventoryMoved: '/v1/inventory/movements',
  DeliveryAttempted: '/v1/delivery/attempts',
  ConsentRecorded: '/v1/customers/:customerId/consent',
  GstPortalActionRequested: gstPortalActionRoute,
  ReturnAccepted: returnAcceptedRoute,
  // Offline opening/closing checklist + daily-task completions (M25-FR-02, §31/P-01). The store box holds a
  // completion made with the cable out and the sync agent relays it to the dedicated SYNCED route under the
  // store token — the SAME door the online write goes through, which records the box-relayed signer and re-checks
  // it (as the synced-return route does). The id is a plain payload field matching the path param, so a template
  // fills it (and an empty/absent id yields no path → dead-lettered by name, hard rule #6), no resolver needed.
  ChecklistCompleted: '/v1/hr/workforce/checklists/:checklistId/synced',
  TaskCompleted: '/v1/hr/workforce/tasks/:taskId/complete/synced',
  // Store/day close + controlled reopen (M14-FR-04, §31/P-01). The store LOCKS its trading day at the
  // edge — the close decision and its "no unsent items" gate can only be evaluated where the outbox
  // lives — and the sync agent relays that fact to the dedicated SYNCED route under the store token.
  // The synced route records the locked day (it trusts what the store decided, as the synced sale/return
  // routes do) and, for the reopen, RE-VERIFIES the §28 approver on the cloud and record-and-flags a
  // breach (never silently applies it). `dayCloseId` is a plain payload field matching the path param,
  // so a template fills it (an empty/absent id yields no path → dead-lettered by name, hard rule #6).
  StoreDayClosed: '/v1/pos/day-close/:dayCloseId/synced',
  StoreDayReopened: '/v1/pos/day-close/:dayCloseId/reopen/synced',
  // The migration screen's decisions (MG-04 / MG-06, §31 — Stage C3a). Made at the store box on the night,
  // committed to its outbox, relayed HERE under the store token to the dedicated synced routes, which
  // re-check the DECIDER's own authority (never the relay's) and re-run the engine; a decision the cloud
  // cannot accept is recorded as REFUSED and acknowledged, never silently applied and never dropped. The
  // ids are plain payload fields matching the path params.
  // A concession docket line the till recorded offline (M27-FR-03 · Item 3, §31). The box holds it durably and
  // relays it to the dedicated SYNCED route under the store token; the cloud resolves the partner's contract in
  // force, snapshots the scheme there and records the RELAYED cashier as the author. A line with no contract in
  // force is 422 → dead-lettered here by name for a person (hard rule #6); one already on the record is 409 →
  // counted delivered.
  ConcessionTagCaptured: '/v1/concession/tags/synced',
  // An approval DECIDED on the manager's screen (SP-2a · F11 · M02-FR-03 · §28). Written to the screen's durable
  // device queue, handed to the box over `/lane/outbox`, held on the box's fsync'd device-events log, and relayed
  // HERE under the store token to the synced decisions register — which re-verifies the DECIDER's own authority
  // (never the relay's) and record-and-flags a breach; a DIFFERENT decision for a request already on file is 422
  // → dead-lettered here by name for a person (hard rule #10); the same decision again is 200 → delivered once.
  // `id` is the decided request's own id — a plain payload field matching the path param.
  ApprovalDecided: '/v1/approvals/decisions/:id/synced',
  // The till's cash, as the STORE BOX recorded it (SP-4c · F10 · M14-FR-01/02 · §31). A float, loan, pickup or safe drop
  // and a shift close are durable on the box's own till-cash log and relayed HERE under the store token to the synced
  // routes, which re-verify the custodian / cashier from their own grants, re-run the same guard and record-and-flag —
  // never refuse money that already moved. `tillId` / `shiftId` are plain top-level payload fields matching the params.
  CashMovement: '/v1/tills/:tillId/cash-movements/synced',
  TillClosed: '/v1/shifts/:shiftId/close/synced',
  // The warehouse handheld's work, relayed by the box from its authenticated device socket (SP-3a · ADR-0019 · S1).
  // A put-away or pick re-runs the tested bin engine at head office with the MOVER re-verified; a receiving scan
  // becomes a `received` movement at the store with the RECEIVER re-verified. Both idempotent on the handheld's own
  // command id (a plain top-level payload field); a refusal is 422 → dead-lettered here by name for a person.
  WarehouseMovementApplied: '/v1/warehouse/movements/:commandId/synced',
  ReceivingScanned: '/v1/inventory/receiving-scans/:commandId/synced',
  // SP-6b: the delivery declared complete on the handheld → head office assembles ONE GRN from the scans on ITS register
  // (never the body), against the issued order, appending no second stock movement. Idempotent on the GRN id.
  ReceivingCompleted: '/v1/inventory/goods-receipt/:grnId/assembled',
  // SP-3b (W3): an adjustment request raised on the warehouse handheld, recorded at head office pending approval.
  AdjustmentRequested: '/v1/inventory/adjustment-requests/:requestId/synced',
  // SP-3c-i (F11's picker half · M19-FR-01/02 · D09): the PICKER handheld's work, relayed by the box from its device socket.
  // A line's outcome lands on head office's wave register with the PICKER re-verified and record-and-flagged; the wave's
  // pack is checked against the line outcomes already on that register (count and value) and any disagreement is SAID
  // on the record, never silently accepted. Idempotent on the handheld's own keys: a re-sent outcome or pack is 200,
  // one record. `waveId` / `lineId` are plain top-level payload fields matching the params; a payload head office
  // cannot read is 400 → dead-lettered here by name for a person (hard rule #6). Nothing on these routes moves stock.
  PickLineResolved: '/v1/fulfilment/waves/:waveId/lines/:lineId/synced',
  WavePacked: '/v1/fulfilment/waves/:waveId/packed/synced',
  // SP-3c-ii (F11's driver half · M19-FR-03/04 · M23): the DRIVER handheld's work, relayed by the box from its device socket.
  // A stop's outcome lands on head office's route register with the DRIVER re-verified and is mapped onto the ORDER's
  // delivery lifecycle through the same state machine the direct route runs (a step the order cannot take from where head
  // office has it is recorded and SAID, never applied blindly); the settlement and the counted cash handover are compared
  // with the stops head office holds and every disagreement is said; a material handover variance is flagged for the cash
  // office. Idempotent on the handheld's own keys. `routeId` / `stopId` are plain top-level payload fields matching the
  // params; a payload head office cannot read is 400 → dead-lettered here by name for a person (hard rule #6).
  DeliveryStopUpdated: '/v1/delivery/routes/:routeId/stops/:stopId/synced',
  RouteSettled: '/v1/delivery/routes/:routeId/settled/synced',
  DriverCashHandedOver: '/v1/delivery/routes/:routeId/handover/synced',
  // A delivery booked in and a blind count captured on the manager's screen (SP-2b · F11 · M07-FR-01 · M09-FR-04).
  // Same path as the decision: device queue → box → here under the store token → a synced route that re-verifies the
  // RECEIVER / COUNTER and owns every judgement the device must not make (rules, cost, expected quantity, threshold).
  // `grnId` / `countId` are plain payload fields matching the path params.
  GoodsReceived: '/v1/inventory/goods-receipt/:grnId/synced',
  StockCounted: '/v1/inventory/counts/:countId/synced',
  // SP-7a (F02 · F04): a supplier invoice captured on the buyer's screen — the invoice's OWN lines, who captured it and
  // who checked it. The synced route re-verifies both from their grants and records the invoice; the match joins it to
  // the stored order and receipts later. `invoiceId` is a plain payload field matching the path param.
  SupplierInvoiceCaptured: '/v1/purchase/invoices/:invoiceId/synced',
  // SP-8b (F08): the floor's indent and its independent receipt from the served Indents screen. The synced routes
  // re-verify the REQUESTER / RECEIVER from their own grants (record-and-flag) and run the same indent engine; a
  // refusal (unknown place, wrong item, the issuer receiving their own issue) is 422 → dead-lettered here by name.
  // `indentId` / `issueId` are plain top-level payload fields matching the path params.
  FloorIndentRequested: '/v1/floor/indents/:indentId/synced',
  FloorIndentReceived: '/v1/floor/indents/:indentId/issues/:issueId/receipt/synced',
  FloorIndentIssued: '/v1/floor/indents/:indentId/issues/:issueId/synced',
  // SP-8c-ii (F08): the shelf count taken on the merchandising screen — `countId` is a plain top-level payload field. The
  // synced route re-verifies the COUNTER from their grants and judges the shelf against head office's own map; a count
  // against a shelf head office does not have is 422 → dead-lettered here by name for a person.
  ShelfCounted: '/v1/merchandising/shelf-counts/:countId/synced',
  MigrationExceptionResolved: '/v1/migration/exceptions/:exceptionId/resolution/synced',
  MigrationTotalSigned: '/v1/migration/control-totals/:totalId/signature/synced',
};

/** Fill `:name` segments from the payload, or run a resolver, so a route can address a thing. */
/** The cloud path an event travels to, from `EVENT_ROUTES` and the event's own payload; undefined = no route (dead-lettered by name). */
export function pathFor(event: DomainEvent): string | undefined {
  const route = EVENT_ROUTES[event.type];
  if (route === undefined) return undefined;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (typeof route === 'function') return route(payload);
  let path = route;
  for (const match of route.matchAll(/:(\w+)/g)) {
    const value = payload[match[1]!];
    if (typeof value !== 'string' || value === '') return undefined;
    path = path.replace(match[0], encodeURIComponent(value));
  }
  return path;
}

/** Statuses that are 4xx by number and transient by meaning. */
const TRANSIENT_4XX = new Set([401, 408, 425, 429]);

/** The kernel's own code for "a different request under a key I already hold" (`services/kernel/src/errors.ts`). */
export const IDEMPOTENCY_CONFLICT_CODE = 'idempotency_key_reused';

/**
 * Read the error code out of a refusal body — the ONE field the transport reads from any response. The body
 * of a 409 decides duplicate-versus-conflict; nothing else of it is kept (a body can echo the request, and the
 * request carries the header this file must never write down, hard rule #4).
 */
export function errorCodeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/**
 * Classify a response. `errorCode` is the refusal body's code and matters for ONE status: a 409 is
 * accepted when the receiver says the record is already on file under some business code, REJECTED as a
 * conflict when the kernel says a different payload reused the key (`idempotency_key_reused` — nothing
 * saved), and retryable when no code could be read (ambiguous, so never assumed delivered).
 */
export function classify(status: number, errorCode?: string): SendOutcome['status'] {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 409) {
    if (errorCode === IDEMPOTENCY_CONFLICT_CODE) return 'rejected';
    if (errorCode !== undefined) return 'accepted';
    return 'retryable';
  }
  if (status >= 500) return 'retryable';
  if (TRANSIENT_4XX.has(status)) return 'retryable';
  if (status >= 400) return 'rejected';
  // 1xx and 3xx: nothing here follows a redirect, and neither is an answer.
  return 'retryable';
}

export interface HttpTransportOptions {
  /** The cloud API's base URL, e.g. `https://api.example.test`. */
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  /** How long to wait before giving up on one send. A hung socket must not stall the drain. */
  readonly timeoutMs?: number;
  /** Injected so the agent stays testable without a network. */
  readonly fetch: typeof globalThis.fetch;
}

export function httpTransport(options: HttpTransportOptions): SyncTransport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  return {
    send: async (event: DomainEvent): Promise<SendOutcome> => {
      const path = pathFor(event);
      if (path === undefined) {
        return {
          status: 'rejected',
          reason: `no cloud endpoint is defined for a "${event.type}" event, so it cannot be delivered. It is kept for a person rather than dropped`,
        };
      }

      // Bounded, and cancelled rather than left hanging: an abandoned request holding a socket is
      // how one slow endpoint becomes a queue that never drains.
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

      try {
        const response = await options.fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.token}`,
            // The EVENT's key, minted when the sale was committed at the lane. A key minted per
            // attempt makes every retry a new sale.
            'idempotency-key': event.idempotencyKey,
          },
          body: JSON.stringify(event.payload),
          signal: controller.signal,
        });

        // An error answer has its body read for ONE field — the error CODE (see `errorCodeOf`): it decides a 409 and it
        // names every other refusal for the person who reads the dead-letter (`decision_conflicts_with_record` says
        // what to compare; a bare 422 does not). Never the body itself.
        const errorCode = response.status >= 400 ? errorCodeOf(await response.json().catch(() => undefined)) : undefined;
        const outcome = classify(response.status, errorCode);
        if (outcome === 'accepted') return { status: 'accepted' };
        if (response.status === 409 && errorCode === IDEMPOTENCY_CONFLICT_CODE) {
          return {
            status: 'rejected',
            // A conflict, named as one: the cloud already holds a DIFFERENT record under this key and saved
            // nothing. The item is kept for a person to compare and resolve — never acknowledged, never
            // silently replaced (hard rules #6, #10). The code, not the body.
            reason: `conflict: head office already holds a different record under this key for ${event.type} (${IDEMPOTENCY_CONFLICT_CODE}, nothing saved) — kept for a person to compare and resolve`,
          };
        }
        return {
          status: outcome,
          // The status, not the body. A body can echo the request, and the request carries the
          // header we must never write down.
          reason: response.status === 409
            ? `the cloud answered 409 for ${event.type} with no readable reason — not assumed delivered; it will be sent again`
            : `the cloud answered ${response.status} for ${event.type}${errorCode === undefined ? '' : ` (${errorCode})`}`,
        };
      } catch (e) {
        // Everything that lands here — timeout, DNS failure, refused connection, TLS problem — is
        // the link, not the payload. Retryable, always. This is the branch that decides whether a
        // shop on a rural line keeps its sales.
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          status: 'retryable',
          reason: aborted
            ? `no answer within ${timeoutMs}ms — the sale is still queued and will be sent again`
            : 'could not reach the cloud — the sale is still queued and will be sent again',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
