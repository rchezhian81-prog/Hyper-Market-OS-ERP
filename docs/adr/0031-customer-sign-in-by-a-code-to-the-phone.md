# ADR 0031 — Customers sign in by a code to their phone, through the product's own customer sign-in service; the SMS provider and the token's signer are ports, both empty until the owner decides

- **Status:** Proposed — built and tested; it ships switched off (no SMS provider, OB-222; no signer chosen — the open
  question below). Amends ADR-0018 (one public origin: `/auth/otp/*` gets its own switch) and ADR-0019 §6 (the customer
  login, which ADR-0019 left "not decided here").
- **Date:** 27 October 2026
- **Context:** M20-FR-01 asks for "OTP/account" in the customer app, and WF-13 ("Customer order") needs a signed-in
  customer to pay and place. The customer app has called `POST /auth/otp/begin` and `/auth/otp/verify` since slice 1f,
  and the shared OTP engine (`packages/identity/src/otp.ts`: the code stored only as a salted hash, single use, five
  tries, five minutes, tenant-scoped) has been tested since then — but only the browser tests' stand-in servers answered
  those calls. On the deployed public origin the proxy answered `/auth/*` with `503 sign_in_not_deployed`
  (`infra/compose/Caddyfile`). Three standing decisions bound the gap: OB-29 and OB-47 wait for an SMS/WhatsApp provider;
  OB-222 keeps SMS, WhatsApp and voice OFF in R4 — nothing is bought; and ADR-0019 says no product code mints a token
  (the `no-test-idp-in-production` guardrail).

## Decision

1. **A customer sign-in service of the product's own** (`services/identity/src/customer-sign-in.ts`, its process
   `customer-sign-in-main.ts`, built by `pnpm run build:customer-sign-in`) answers `/auth/otp/begin`, `/verify`,
   `/session`, `/check` and `/signout`, on the shared OTP engine. It is wired into the stack the way the staff sign-in
   service is: an opt-in compose service (`--profile customer-sign-in`), `node:22-alpine` running the built file read-only
   as an unprivileged user, no port published, no secret held, nothing written to disk.
2. **The session is the server's.** A verified code gives the browser a random id in a cookie
   (`sre_customer_session`, `HttpOnly; Secure; SameSite=Strict; Path=/auth/otp/`, twelve hours at most); the service keeps
   only the id's hash beside the customer's token. The page still holds the short-lived token in memory for its `/v1`
   calls (as before); `/session` hands it a current one after a reload; `/signout` ends the session at once, and the old
   cookie is then refused. A money change needs the app-based factor (`/check`, the existing step-up rule).
3. **Limits and lockout (SEC-04):** three codes back-to-back per number then one per ten minutes; ten per address then
   one per six minutes; thirty code checks per address then one per two minutes; five wrong codes lock the number (five
   minutes, doubling, at most a day — a locked number gets no new code either); ten wrong codes lock the address (a
   minute, doubling, at most an hour). The kernel's own token bucket and back-off lockout. A request from another site,
   a non-JSON body or a GET is refused before anything is read.
4. **Nothing personal in the logs.** Audit lines carry the event, the reason and the signed-in subject only — never the
   number, the code, the challenge id, the token or the session id. Limiter keys hold a hash of the number.
5. **The SMS send is a provider-neutral port** (`OtpSender`). The process is composed with NO sender: every request for
   a code is answered `503 sms_provider_not_configured` — "Sign-in by a code to your phone is switched off: no SMS
   provider is connected to this shop yet. No code was sent." — and the customer app says that in English and Tamil. Its
   start-up line says so too (P-08). No provider is named, chosen or bought (OB-222). Tests use the recording transport
   (`tests/support/otp-simulator.ts`).
6. **The token's signer is a port too** (`CustomerSessionSigner`): the service checks the code; something else signs the
   customer's token, because product code never mints one (ADR-0019). The process is composed with NO signer, and
   refuses (`customer_sign_in_not_switched_on`) before any code is sent. Tests use the local test identity provider
   (`tests/support/customer-sign-in-test-ports.ts`), which the guardrail keeps out of production.
7. **One public origin, its own switch.** The proxy routes `/auth/otp/*` by `SRE_CUSTOMER_SIGN_IN_ROUTE`:
   `customer-sign-in-not-deployed` (the default, still `503 sign_in_not_deployed`) or `customer-sign-in-upstream`
   (forwarded to `customer-sign-in:8093`, the client address overwritten from the connection). The identity server's
   `/auth/*` route (`SRE_AUTH_ROUTE`) and the staff sign-in are unchanged.

**Not decided here — an owner question:** who signs a customer's token once their code is right. Options: (A) the
self-hosted identity server (Keycloak, ADR-0019) signs it — a customer realm per shop and a narrowly-scoped exchange
client for this service; nothing bought; (B) an SMS-code sign-in inside the identity server itself (a Keycloak
extension), so this service only relays; more to build and maintain; (C) the API believes this service's sessions
directly (an introspection call), changing ADR-0019's "only signed tokens" rule. Until the owner answers, no signer is
composed and nobody can be signed in — which costs nothing today, because with no SMS provider (OB-222) no code can be
sent anyway.

## §19-substitution impact (an addition: the baseline names no customer sign-in service)

- **Offline:** none on a sale path. The till never calls it (hard rule #1). The customer app browses without it; with the
  service or the internet down, sign-in and online ordering wait and the page says so.
- **Support:** one more small container, opt-in. A restart signs every customer out and voids codes still waiting
  (they ask again) — said in its runbook (`docs/runbooks/customer-sign-in.md`). No backup item: it stores nothing.
- **Security:** the code is a credential and is never stored, logged or returned; sessions are server-side behind an
  HttpOnly + Secure + SameSite=Strict cookie scoped to its own path (never sent with `/v1`); cross-site requests refused;
  per-number and per-address rate limits and lockout; no token minted by product code; no card data anywhere near it.
  Known limit: a token handed to the page before sign-out stays valid at the API until it expires (the signer's short
  lifetime; ending it sooner needs the API to consult this service — part of the open question).
- **Cost:** nothing bought. An SMS provider, when the owner approves one, is a per-message cost decided then.
- **Portability:** both the SMS provider and the signer are ports; either is a composition change in
  `customer-sign-in-main.ts`. The engine and the session are standard (OTP hash, opaque cookie, bearer token).
- **Maintainability:** one handler (~300 lines) on the shared engine and the kernel's own limiters; unit, integration
  (the built program started for real) and browser tests; the four browser-test stand-ins it replaces are gone.

## Consequences

- The customer app's sign-in now talks to a real service on the real public origin; switched in, it refuses in plain
  words instead of a generic "not deployed".
- Turning customer sign-in ON needs two written owner decisions: an SMS provider (OB-29 / OB-47 / OB-222) and the signer
  (the question above).
- Memory-held limits reset on a restart — correct for one service instance on one box; a second instance would need a
  shared store for them (the kernel limiter's own note).
