# ADR 0033 — The store PC's Office centre acts as the PIN-signed person on this PC's own API

- **Status:** Accepted (CR-01 step 4, 14 November 2026 — inside OB-707 "1A" and ADR-0032 / OB-708 "2A"; no new owner decision)
- **Date:** 14 November 2026
- **Context:** CR-01 OI-06 asks for Users & roles on screens on the store computer, "with staff ID + PIN"; OI-07 asks for the
  import & export centre inside the Office app. On the store PC the shop's own API runs beside the till as a Windows service
  (ADR-0032). The Office app is the till's screen server (loopback, office PIN sign-in, OB-259). Until now its office pages
  could reach an API only through the head-office internet sign-in (OB-388, Keycloak), which the store PC does not have, and
  the old-system import (OB-704) ran as a separate program from a desktop icon with its own PIN sign-in.

## Decision

1. **The till's screen server serves an Office centre** — `/people/` (Users & roles), `/import-export/` (exports, and the
   old-system import at `/import/`) — only when its settings say `EDGE_OFFICE_HEAD_OFFICE=this-pc` and the office PIN
   sign-in is on. The menu's existing "Users & roles" (`/users`) and "Import & export" (`/data-io`) open it.
2. **Every act asks the person's own PIN again**, checked by the till's own PIN register (same guess limits, OB-257). Only
   then is a five-minute token made for that person — the same bytes `buildPersonToken` makes for the import page and the
   owner setup commands (`sub`, `tenant_id`, `auth_time` = the moment the PIN was typed, `amr` pin + swk) — and the one call
   is carried to this PC's API. The API judges it exactly as it judges any call: permission, two-person rule (§28), OB-95,
   OB-615, step-up, audit. Reads use the office sign-in's own time; nothing pretends a PIN was typed when it was not.
3. **The API address must be this PC's loopback** (127.0.0.1 / localhost / ::1); anything else turns the centre off and the
   boot log says why. A person's token never leaves the PC.
4. **The till holds this copy's sign-in key** (`IDP_SIGNING_KEY`, `IDP_ISSUER`, `IDP_AUDIENCE` in `till.env`), written by
   the installer only on the shop's own copy (`.env.real`), only where the file has none (never rotated by a re-run).
5. **Every act and refusal is written first** to `office-centre.log` in the till's data folder (append-only, never deleted);
   a log that cannot be written stops the act. Never a PIN, never a token.
6. **The old-system import runs inside the till's service** with the office sign-in (`import-app.ts` `officeSession`); its
   rules (OB-704 … OB-706) are unchanged; its files stay in `<data>\imports`, which the till's service account may now
   write (one more `icacls` grant).

## Why the key may sit with the till

The till already holds `PACK_SIGNING_KEY`, which keys every till PIN verifier and signs the store setup (who holds which
role). Anyone who could read the till's settings could already write themselves a PIN and a role on this PC; the sign-in
key adds no reach that the pack key does not already give. The key stays on the PC, in the same locked data folder
(the G4 `icacls` check), in the same encrypted backup. The alternative — the API trusting a second, till-held key — would
change the API's token check for no gain in safety.

## What does not change

Hard rule #1 (nothing here is on the sale path); hard rule #5 (no AI can act here — every act needs a person's PIN typed on
the page); the two-person rule and OB-95 (the API's own, untouched); OB-388 (the head-office sign-in is still how a box
reaches a REMOTE head office); OB-259 (who may open office screens).

## Consequences

- The store PC's Users & roles and Import & export work offline from the internet, with the staff ID and PIN.
- A new person can set their own first till PIN on the Users & roles page (the till-pin command's own code). A PIN that
  already exists is never changed from the page — a reset could take over someone's access; it stays the command's.
- Other office pages on the store PC are unchanged by this ADR: they still need the head-office sign-in for `/v1` calls.

## Reconsider-when

The store PC is connected to a remote head office (the OB-388 sign-in becomes the way), or the production sign-in decision
(OB-251) replaces the store PC's PIN stand-in.
