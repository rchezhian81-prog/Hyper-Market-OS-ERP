# ADR 0019 — Handhelds reach the store box over the shop network through an authenticated DEVICE socket, enrolled once with a one-time code from head office

- **Status:** Accepted (owner program directive of 30 September 2026 — "store operations first": complete handheld
  synchronisation before declaring handheld picking, receiving, counting or adjustments E2E complete; one shared
  synchronisation mechanism for manager and handheld work; never a shared login)
- **Date:** 30 September 2026
- **Context:** The store box's lane socket binds to loopback and must (ADR-0004: any device on the shop LAN — a guest's
  phone on the shop wifi — could otherwise write to it; "a shared secret would be theatre" there). Its screens server
  binds to loopback too, because it carries the day's takings (ADR-0018 widens it only inside a private container
  network). The warehouse, picker and driver handhelds are therefore unreachable in a real shop: their shells are served
  on an address a phone cannot see and their write base is the box's loopback lane, so their durable device queues
  (`packages/sync/src/device-outbox.ts`) drain to nothing (audit finding F11, handheld half; S1). SP-2a built the ONE
  shared device → box → cloud mechanism (`packages/sync/src/device-relay.ts`, `device-drain.ts`; the box's
  `POST /lane/outbox` onto its sixth durable pipeline; cloud `/synced` routes that re-verify the actor) and SP-2b put
  the manager's receipts and counts on it. The handhelds need a door on the shop network that is not the lane socket.

## Decision

1. **A second, separate socket on the box — the DEVICE socket** (`edge/store-edge/src/device-server.ts`,
   `EDGE_DEVICE_PORT`). It serves ONLY the handheld shells (`/warehouse/`, `/picker/`, `/driver/`, with their served
   assignment injected) and the three device routes the shared drain already speaks — `POST /lane/outbox`,
   `GET /lane/outbox/status`, `GET /lane/sync-status` — on the SAME paths as the loopback lane socket, so
   `drainToBox`/`boxStatus` and the shells' badges work unchanged with `window.laneWriteBase = ''` (same origin). It
   never serves the till, the manager, the owner or any ERP screen, and never the day's takings: a request for any
   other screen is 404 by name.
2. **Nothing without a per-device credential; never a shared login (hard rule #4).** Head office issues a **one-time
   enrolment code** for a REGISTERED handheld (`POST /v1/platform/devices/:deviceId/enrolment`, permission
   `platform.device.manage`; kinds `handheld`/`mobile` only; status `registered` only), returns it ONCE to the admin and
   keeps only its SHA-256 hash with an expiry (a day by default) on the fleet register; the pack's `devices` register
   carries the same hash. The person setting the handheld up types the code into the box's enrolment page
   (`GET /device/enrol` → `POST /device/enrol`); the box compares hashes (constant time), refuses a code that is wrong,
   expired, already used, or issued to a till, a blocked or an unknown device, bounds guessing (five wrong codes per
   device per fifteen minutes), and mints the device a **session token** (32 random bytes) delivered as an
   `HttpOnly; SameSite=Strict` cookie. The box keeps only the token's hash, on an append-only fsync'd
   `device-enrolments.log` (`edge/store-edge/src/device-enrolments.ts`) folded at start — an enrolment survives a
   restart and a revocation is never forgotten (hard rule #6).
3. **Revocation is head office's, at the next request.** Every request — the shell itself included — is checked against
   the box's register AND the pack's fleet register: a device the pack now says is `blocked` or `retired`, or no longer
   lists, is refused with the reason and sent back to the enrolment page. A box whose pack carries no `devices`
   register serves nothing and enrols nothing. The box can also withdraw an enrolment itself (a lost handheld).
4. **A handheld speaks as a handheld.** The batch's `source` must be a handheld surface (`warehouse`, `picker`,
   `driver` — `HANDHELD_SOURCES`); `manager` is refused before the box is asked, so a warehouse device cannot slip an
   approval decision, a whole receipt or a manager's count through under its own credential. The per-surface allow-list
   (`RELAYABLE_DEVICE_EVENTS`) still applies on top: `WarehouseMovementApplied` and `ReceivingScanned` for `warehouse`.
5. **Loopback by default; the shop names its address.** `DEVICE_HOST = '127.0.0.1'`; a deployment sets
   `EDGE_DEVICE_HOST` to the box's shop-network address and the boot log says in words that enrolled handhelds on the
   shop network can reach it. The lane socket and the screens server keep their loopback binds — this decision widens
   nothing that exists.
6. **Head office still re-verifies the worker, never the relay.** The cloud's synced routes for the handheld's work
   (`POST /v1/warehouse/movements/:commandId/synced`, `POST /v1/inventory/receiving-scans/:commandId/synced`) re-run the
   tested engines against head office's own bins and ledger, re-verify the mover / receiver from their grants and flag a
   breach on the record (never a silent apply), and are idempotent on the handheld's own command id — a re-sent scan is
   one movement.

## What this decision does NOT do

- **No TLS on the shop-network leg yet.** The device socket speaks plain HTTP on the LAN, so the cookie and the
  assignment are readable by a device that can already read the shop's wifi traffic. Until TLS is added at the device
  socket (Stage E follow-up), the handhelds must be on a staff-only WPA2/WPA3 network, separate from any guest wifi — an
  operator control recorded in the owner action register. The lane socket's and the screens server's loopback binds do
  not depend on this.
- **The pack's `devices` register is file-fed today** (as `approvals` and `warehouse` are). The cloud registry holds the
  hashes; the cloud → pack section feed is the SP-9 pack work. Until then the operator carries the fleet register into
  the pack file — never a code, only its hash.
- **The picker handheld** rides the socket end to end since SP-3c-i (1 Oct 2026): `PickLineResolved` / `WavePacked` → the cloud wave register (`services/fulfilment/src/waves.ts`), and enrolment lands a device on the handheld screen it asked for (`?next=/picker/`). **The driver handheld** rides it end to end since SP-3c-ii (1 Oct 2026): `DeliveryStopUpdated` / `RouteSettled` / `DriverCashHandedOver` → the cloud route register (`services/fulfilment/src/driver-runs.ts`), each stop stepping the order's own lifecycle;
  W2 (blind count) and W3 (adjustment request) on the warehouse handheld are SP-3b.

## Amendment — the person holding the phone (Wave 4 · PA-06 = DF-3-c-3a · OB-30 "A", 10 Oct 2026)

The device credential says WHICH phone; it never said WHO holds it — every record named the one person the store setup
gave the job. Now each person signs in on the enrolled phone with their staff ID and the same PIN as the till
(`POST /device/sign-in?screen=warehouse|picker|driver`, `POST /device/sign-out`), checked by the box's till-PIN register
(ADR-0020) — offline, same verifiers, guess limits and fsync'd log. The session rides a second HttpOnly, SameSite=Strict
cookie (`sre_operator`, twelve hours); the box keeps only its hash. The phone screen is served only to a person holding
that job's permission in the current store setup (the one head office re-checks) and is readdressed to them. One person
per phone at a time. Every record a phone hands over must name a person who held that phone this shift — judged on the
box's log and clock, never the phone's — or it is refused by name; with nobody signed in the box takes nothing (401) and
the phone keeps its work. The device socket's surface grows by these two routes, both behind the device credential.

## §19-substitution impact

Not a §19 substitution: the same Node process, the same containers, the same file-log durability.

## Consequences

- A handheld that leaves the shop, or whose credential leaks, is stopped by one status change at head office; a lost
  code is invalidated by issuing a new one; nothing on the box or in the pack can be replayed into an enrolment.
- Every batch the box takes from a handheld names the device in the box's own log, and every record it relays names
  the worker, who is re-verified at head office — traceable end to end (P-04).
- The device socket is one more listening port on the shop network; its whole surface is three routes and three
  static shells, all behind the credential, all body-capped, JSON-only where they write.

## Reconsider-when

- TLS is added at the box (per-box certificate the handhelds trust at enrolment) — the plaintext caveat above falls away.
- The cloud delivers the pack's `devices` section itself (SP-9) — enrolment codes then reach the box with no operator
  step.
- A second store shares handhelds between boxes — a device would need a credential per box, or a cloud-issued one.
