# ADR 0020 — The till operator is verified by the store computer: a personal till PIN checked offline, a shift session, and every money write bound to it

- **Status:** Accepted (owner program directive — the audit's Wave 2 critical findings are repaired in order, recorded as
  OB-14/OB-15; the offline identity shape is the one ADR-0019 already decided)
- **Date:** 6 October 2026
- **Context:** The independent audit of 4 October found **PF-02 (CRITICAL)**: *"a typed staff or manager identifier is
  treated as identity/approval"*. The till took any staff code the cashier typed (`apps/pos/src/session.ts` `signIn`,
  `apps/pos/web/app.js` `toggleSignIn`), wrote it on every sale as the cashier, and the store computer committed the
  record without asking who sent it (`edge/store-edge/src/lane-server.ts`, the `/lane/sales` route). Head office
  re-checks that the NAME holds till authority (SP-4b, `cashier_unknown` / `cashier_lacks_authority`), but a name that
  holds authority is not a person who signed in. M02-FR-01 requires *"a limited cached identity for authorized
  offline operators … cached credentials are minimized and time-bound … an offline lane authenticates an authorized
  cashier with the network cable out"*; ADR-0019 (identity server) decided the shape: *"a short-lived, device-bound
  credential the box verifies locally … Nothing on a sale path calls the identity server."* The identity server
  itself is not built yet (the OB-15 block). The handhelds already prove a person/device to the box with a one-time
  code whose hash the box compares, with guess limits and an append-only register (ADR-0019, device socket).

## Decision

1. **A personal till PIN, six digits, per person.** It is never stored: the box keeps a **verifier** — scrypt of the PIN
   with a random 16-byte salt (N = 2^14, r = 8, p = 1, 32 bytes), then HMAC-SHA256 under a key derived from the
   box's existing pack signing key (`PACK_SIGNING_KEY`, label `sre-till-pin-v1`). A copied credentials file is
   therefore not enough to work PINs out offline; the secret that is also needed never leaves the box's settings.
   The PIN is never logged, never in a URL, never in browser storage (`packages/identity/src/till-pin.ts`).
2. **Issued by an administrator ON the box**, printed once to their own terminal — `till-pin --user <id> --by
   "<name>"` (and `--revoke`) — appending the verifier to the box's credentials file
   (`EDGE_TILL_CREDENTIALS_FILE`, owner-only). Reissuing replaces the PIN; revoking ends it. This is the same pattern
   as the hosted sign-in's `add` command. Head-office issuing from the people screen (the OB-15 M02 flow, with the
   identity server) replaces the command later with the same verifier format.
3. **Signing in at the till asks two things:** the staff ID (scanned or keyed) and the PIN (keyed, masked). The box
   decides: the person must be known to its store pack and hold till authority (`pos.sale.sync`) in the pack's role
   register; a credential must exist, not revoked; the PIN must match (constant time). A wrong ID and a wrong PIN get
   the SAME answer. Five wrong PINs for one staff ID in fifteen minutes lock that ID for fifteen minutes; twenty
   refusals on one lane in fifteen minutes lock the lane's sign-in. A box whose pack carries no role register signs
   nobody in (fail closed).
4. **A shift session, bound to the lane.** Success mints 32 random bytes; the till keeps them for its tab (memory and
   the tab's own session storage, so a reload keeps the cashier; a closed browser signs them out); the box keeps only
   the hash, bound to the lane, ending after twelve hours or at sign-out. Every sign-in, refusal, lock and sign-out is
   appended to an fsync'd operator log (`till-operators.log`, hard rule #6) and folded at start, so a box restart does
   not sign anybody out and an audit can read every attempt. Neither the PIN nor the token is ever written to it.
5. **Every money write is bound to the session.** A sale, a refund, a cash movement and a till close each carry the
   session; the box refuses the write **before the disk** unless the session is live, on this
   lane, for a person who still holds till authority in the current pack, and the person the record names (cashier,
   processor, custodian) IS the session's person. The box stamps the record with who it verified and how
   (`operatorVerified: { userId, via }`) before writing. The stamp carries no clock reading on purpose: a till re-sending
   the same sale after a lost reply must produce the same record, or the box's replay protection would call it a
   different sale. A typed name can no longer be the cashier.
6. **The hosted copy.** Behind the hosted sign-in (ADR-0016/0018) the person has already proved themselves with a
   password; the front passes their id to the box from the sign-in's own answer (`X-Sre-User`, overwritten, never
   passed through). Only with `EDGE_LANE_TRUST_FORWARDED_USER=1` — set by the pilot overlay alone, held by a guardrail
   — does the box open a till session for that verified person without a PIN (`via: verified_sign_in`). A store box
   never sets it.

**Not in this decision (the next slices of Wave 2b-v):** the manager's approval at the till as a separate one-use,
transaction-bound act with the manager's own PIN (refund amount and id, expiry, consumed once); head office's own
desk refund route treating a named approver as an approval object; head office flagging a synced sale that carries
no box verification (the stamp stays on the box's own record until then); the partner-counter (concession) line,
which is recorded by its own page and is not yet bound to the till session.

## Consequences

- PF-02's till half is closed: the cashier on a sale is a person the box verified, offline, with the cable out.
- Every till needs each cashier's PIN issued before they can trade; the runbook says how. A forgotten PIN is reissued.
- A six-digit PIN is a short secret. What bounds it: the lockouts, the box-held key in the verifier, the loopback-only
  socket, the twelve-hour session. It is a large step from a typed name and a bridge to the identity server, not the
  final strength of the product's sign-in (MFA/passkeys stay with ADR-0019).
- Tests that ring sales through a real box now sign in first, with credentials written at runtime (no PIN in the repo).

## Reconsider-when

The identity server (ADR-0019) is live on the store box: the till then signs in through it online and keeps this
verifier only as the offline fallback, refreshed on sync.
