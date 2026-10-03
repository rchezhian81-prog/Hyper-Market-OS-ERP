# ADR 0016 — A demo store edge on the hosted demo server (synthetic data only; never production)

- **Merged into `main` 3 Oct 2026 — behind the ADR-0018 proxy (owner Option 3, OB-11).** What this ADR decided stands:
  the unchanged edge as a demo store box, the relay in its network namespace, the demo sign-in as the gate, the
  demo-build till, the person-published price list. What changed on merge: the demo front (`nginx.pilot.conf`) no
  longer terminates TLS or publishes a port — the public proxy (ADR-0018) does, and forwards the staff shells,
  `/login`, `/store` and `/store-lane` to the demo front only when `SRE_STAFF_ROUTE=staff-demo-gate` (the pilot
  overlay's default; the base default is `staff-not-public`, 404 by name). The staff shells themselves are now behind
  the sign-in too (ADR-0018 §2), not only their data. The relay reaches the edge's compose screen port (8091) instead
  of a second loopback port. Guardrails: `pilot-host-exposes-only-https`, `demo-login-is-pilot-only`,
  `the-public-origin-is-one-and-guarded`; CI brings the overlay up and proves the gate from the outside.
- **Status:** Accepted — DEMO ONLY (owner-directed, 28 Sep 2026: "I want to see the full shop floor on this
  demo server")
- **Date:** 28 September 2026
- **Context:** The hosted demo (MilesWeb VM3, `docs/pilot/HOSTED-DEMO-RESULTS.md`) serves the shells from the
  cloud front. Every screen is designed to be served by the **store edge** (ADR-0004): the edge's screen
  server injects each screen's data at `<!--SCREEN-DATA-->`, and the till writes each sale to the edge's lane
  socket. Both bind `127.0.0.1` on the store box, and that bind address is the whole security control
  (`edge/store-edge/src/screen-server.ts:1-26`, `lane-server.ts`). The demo identity bridge (H-11) made 19
  live-API pages work; the till, the manager's day screen and the other edge-fed screens still show sample
  data, and a till in a remote browser cannot sell at all: it posts to `http://127.0.0.1:8090` — the tester's
  own laptop (`apps/pos/src/browser-entry.ts:74-125`, `DEFAULT_LANE_PORT`). The owner wants to ring a fake sale
  in a browser and watch it reach the stock and manager screens.

## Decision

Run the **unchanged** store edge on the demo server as a *demo store box*, and reach its two loopback
sockets through a **demo-only relay** behind the demo sign-in. Concretely:

1. **Edge unchanged.** The edge image and code are not modified. The pilot overlay only turns on settings the
   edge already has: `EDGE_LANE_PORT` (already set, 8095) and `EDGE_SCREEN_PORT` (8097), with the app shells
   mounted read-only at `EDGE_APPS_DIR`. Both sockets still bind `127.0.0.1` inside the edge container.
2. **Demo relay (`edge-relay`).** A small nginx container that **shares the edge container's network
   namespace** (`network_mode: service:edge`), so it can reach the edge's loopback without the edge binding
   anything wider. It listens on 8096 inside that namespace, publishes **no** host port, and forwards
   `/store/…` → screen server and `/lane/…` → lane socket. It exists only in the pilot overlay.
3. **Behind the demo sign-in.** The HTTPS front forwards `https://<demo>/store/…` and `https://<demo>/store-lane/…`
   to the relay **only** after an `auth_request` to the demo sign-in: a valid demo session for screens; a
   session whose API permissions include `pos.sale.sync` for lane writes. No session → 401 / sign-in. The
   session cookie is `SameSite=Strict`, so another site cannot make a browser post a sale.
4. **The till, demo build only.** The POS gets a **build-time** constant `PILOT_DEMO_LANE_BASE` (esbuild
   `define`, exactly like `PILOT_DEMO_BANNER`). The hosted-demo build sets it to `/store-lane`, so the till in
   a remote browser writes to the demo box through the front. The production build leaves it empty, which
   compiles to the existing `http://127.0.0.1:<port>` path — **production behaviour is unchanged**, and a
   test builds both bundles to prove it.
5. **Price list published by a person.** The till can only price a scan from a signed, **published** catalogue
   pack. Publishing it (`POST /v1/catalogue/pack`, the existing route; not the disabled bulk product publish)
   commits the approved prices to the lanes, so — hard rule #5 — the **owner runs it** with a demo command;
   the AI does not.

**Not done, and not allowed by this ADR:** any change to how a real store edge binds, authenticates or is
reached; any real product/price data (Option 2 is unapproved); enabling payroll bank-file release or bulk /
sensitive-category product publish; running this relay or setting `PILOT_DEMO_LANE_BASE` in any production
build or stack.

## §19-substitution impact

This is a demo-topology decision, not a baseline substitution, but the six axes are recorded because it
reaches an edge socket from the network for the first time:

- **Offline:** unchanged for a store. On the demo, the edge still commits locally and syncs later (proven by
  the §9.4 drill); a remote browser till is, by construction, online to the demo server — offline selling is
  demonstrated by the drill, not by a laptop browser (and the self-signed certificate already blocks the
  service worker, H-10).
- **Support:** one extra demo container (nginx relay) and one sign-in check endpoint; no store impact.
- **Security:** the edge's screens (which show takings) and its lane (which records sales) become reachable
  from the internet — but only through HTTPS, only with a valid personal demo login, lane writes only for a
  role that may sell, and only for **synthetic** data. The lane socket itself stays unauthenticated by design;
  the relay is the gate. Guardrails assert the relay is pilot-only, publishes no port, and sits behind
  `auth_request`, and that the base (store) compose file has no relay.
- **Cost:** none beyond the existing VM3.
- **Portability:** none — standard nginx, no vendor feature.
- **Maintainability:** the demo-only code is isolated (overlay, `infra/pilot/…`, one build-time constant in the
  POS, compiled out of production).

## Consequences

- The owner can ring a fake sale at `https://<demo>/store/pos/` and watch it land at the edge, sync to the
  cloud ledger and show on the cloud-read screens.
- **Identity on edge-served screens is the store box's, not the signed-in person's.** The edge shows each
  screen for the identity its pack names, and the till records `cashierId: 'cashier'` (the shell does not
  carry a person). The demo sign-in gates access; it does not personalise the edge screens.
- **Stock on hand does not move with a sale** (found while writing this ADR): a banked sale records
  `SaleCommitted` + `ReceiptNumberIssued` only; on-hand quantity folds `InventoryMoved` only
  (`services/api/src/adapters.ts`, `bankSale`). Sales-derived figures (turns, days of cover, GMROI, sales
  history) do move. Recorded as defect **H-13** for an owner decision; not changed here.
- The demo now runs two ways to reach the same screens (`/erp/…` static + identity bridge, `/store/…` via the
  demo edge). Both are demo-only.

## Reconsider-when

- Before any real data (Option 2): this relay and `PILOT_DEMO_LANE_BASE` must be **off**, or re-decided with the
  store's real network design.
- A real identity provider (OA-4) replaces the demo sign-in.
- The product gains a supported remote-till mode (then it must be designed for the store, with its own ADR).
