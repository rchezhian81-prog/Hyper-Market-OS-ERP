# ADR 0029 — On the store PC, each person signs in to head office with their own login and second step, and the store computer carries THAT person's session for the office pages

- **Status:** Accepted (owner decision OB-388, in writing, 26 October 2026: *"staff sign in with their own head-office login
  (password + second step) on the store PC; the store computer carries their own token; no shared machine credential;
  ADR"*)
- **Date:** 26 October 2026
- **Context:** OB-380 put the 52 office pages head office answers (Month-end, Supplier bills, the company report, …) on
  the store computer. They are thin pages: every figure is head office's, read over `/v1` on the same origin. Behind the
  hosted front, the front door adds the signed-in person's token to each `/v1` call (ADR-0019 part 3). On a bare store PC
  nothing did, so the box dropped every `/v1` call (`edge/store-edge/src/screen-server.ts`), and in the shop each page
  said "head office cannot be reached" even with the line up (FG-2 finding D-1). Three ways out were put to the owner:
  a shared machine credential for the store PC (one login for many people — refused by hard rule #4), upgrading the office
  PIN to a head-office identity (a six-digit PIN, checked offline, would become a remote credential — refused), or each
  person's own head-office sign-in. He chose the last.

## Decision

1. **The store computer runs the product's own sign-in service** (`services/identity/src/sign-in.ts`, ADR-0019 part 2) in
   its own process, as an OIDC relying party of head office's identity server: authorisation code with PKCE (S256), a
   one-time state (ten minutes) and a nonce, the code exchanged by the box, the access token believed only through head
   office's own checker (`verifyToken`, RS256 against the identity server's published keys), pinned to **this shop's
   tenant** (`EDGE_TENANT_ID`) — a sign-in naming another shop is refused. Nothing on the box mints a token.
2. **The password and the second step, every time.** The store PC is shared, so the box asks the identity server to
   ask again on every sign-in (`prompt=login`); the next person never inherits the last one's sign-in. A sign-in whose
   token does not show a factor the person knows AND one they hold (`amr` → `mfa`, RFC 8176) is refused and ended at once.
3. **The session lives on the box, in memory.** The browser holds only a random id in an HttpOnly, Secure, SameSite=Strict
   cookie (`sre_session`); the box keeps a hash of it beside the tokens. The access token is renewed with the refresh
   token in its last minute; a renewal the identity server refuses (signed out elsewhere, switched off as a leaver,
   locked) ends the session; ten hours at most; Sign out ends it, and the office PIN sign-out ends it too. Because the
   cookie is strict and the browser returns from the identity server's own site, the box answers the callback with a page
   that moves on from itself, so the cookie travels.
4. **Each `/v1` call is carried with that person's own token**, to head office's API (`CLOUD_API_URL`), with the page's
   own headers (accept, content type, idempotency key, conditional headers) and nothing else — never a cookie, never a
   who-is-this header, never the store computer's machine credential (`CLOUD_API_TOKEN`, which stays with the sync agent),
   never a PIN. Head office answers as anywhere else: its permission, branch scope and step-up checks. A 401 from head
   office (a revoked token — a leaver, "sign me out everywhere") ends the session on the box too.
5. **The box refuses, in head office's own error shape and in English and Tamil:** no head-office session (401); the
   office PIN sign-in, where it is on, ended (401) or naming another person (403); a person the store's setup does not
   name at this store (403); a write that did not come from a page this box served (403). An office page opens only for a
   person signed in to head office — the same person as the PIN sign-in.
6. **Down is said, never faked (P-08).** Head office or the line down: the call fails as a lost link (the socket is
   closed), and each page says in its own tested words that head office cannot be reached. The identity server down: the
   box's sign-in page says so plainly, in both languages, before sending anybody anywhere.
7. **Settings.** On only when the box is given `EDGE_HEAD_OFFICE_SIGN_IN_ISSUER` (the realm's https address) and
   `CLOUD_API_URL`; optional `EDGE_HEAD_OFFICE_SIGN_IN_CLIENT_ID` (default `sre-web`) and `EDGE_HEAD_OFFICE_AUDIENCE`
   (default `sre-retail-os-api`). Plain http is refused except this PC's own loopback. The realm's `sre-web` client also
   allows the store PC's loopback callback, `http://127.0.0.1:8091/login/callback` (the installer's screen port). The boot
   log says whether the link is on, and never prints an address.
8. **Not decided here:** a store PC on a port other than 8091 (the realm would need its callback, or Keycloak's loopback
   port rule); signing in with a passkey instead of a one-time code (Keycloak supports it; a realm change).

## §19-substitution impact (no baseline component is replaced; this records how the store edge uses the identity server ADR-0019 added)

- **Offline:** the till's sale path never touches this (hard rule #1): the lane socket does not import it, and a sale
  commits on the box's disk with head office and the identity server both down (proved). The office pages need head
  office by nature; when it is down they say so (P-08) and the box's own screens (Today, the day close, counts) keep
  working offline on the PIN as before. A head-office session survives a short line drop (the token is renewed when the
  line is back, within the token's life); a box restart signs people out of head office (they sign in again).
- **Support:** no new service and no new container: the sign-in code already shipped for the hosted front runs inside the
  box's process. Three settings, written by the installer. Failure modes are said on screen: identity server unreachable,
  sign-in not confirmed for this shop, second step missing, link expired. The runbook gains the store-PC proof.
- **Security:** least privilege — every call is the person's own, under head office's own permission and branch checks;
  no shared login, no machine credential and no PIN reaches head office from a page (hard rule #4). Tokens are never in
  the browser, never on the box's disk, never in its log (the log names the event and the person only). PKCE, state and
  nonce bind each sign-in; the tenant pin refuses another shop; `prompt=login` stops one person landing in another's
  session on a shared PC; a revoked token or a refused renewal ends the session; writes must come from the box's own
  pages (Fetch Metadata) and the cookie is SameSite=Strict. The loopback callback is reachable only from that PC.
- **Cost:** nothing to buy; no new infrastructure. Engineering: one edge module, the screen-socket wiring, a realm line,
  and the tests.
- **Portability:** standard OIDC (code + PKCE, refresh, `amr`), the same port the hosted front uses; another identity
  provider is a settings change. The box speaks to head office's versioned `/v1` API exactly as the hosted front does.
- **Maintainability:** one sign-in implementation for both the hosted front and the store PC (no second copy); the link
  is one small module (`edge/store-edge/src/head-office-link.ts`) with unit, integration (real box), browser and
  real-Keycloak proofs, and a guardrail (`tests/guardrails/the-store-computer-carries-only-the-persons-own-head-office-session.test.ts`)
  that fails if the machine credential, a cookie or a PIN ever reaches head office from a page.

## Consequences

- In the shop, the owner, the manager and the accountant open Month-end, the company report and the other office pages on
  the store PC, with their own head-office login and second step; each page shows head office's answer to them.
- Each person needs a head-office sign-in with a one-time code set up (provisioning already gives every staff sign-in
  `sre-privileged`, ADR-0019 part 4); the store PC needs the three settings and port 8091.
- Head-office sessions on the box are in memory: a restart signs people out of head office (not out of the till).

## Reconsider-when

- More than one store PC per shop serves office pages on different ports (then a loopback-port rule at the identity
  server, or one callback per PC).
- Sessions must survive a box restart (then an encrypted session store on the box — never the tokens in plain text).
- A shop's people sign in through their own directory (Keycloak brokers it; nothing changes here).
