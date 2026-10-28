# ADR 0031 — Customers sign in by a code to their phone, through the product's own customer sign-in service; the SMS provider and the token's signer are ports, both empty until the owner decides

- **Status:** Proposed — built and tested; it ships switched off (no SMS provider, OB-222). Amended 28 October 2026 by
  owner decision OB-510: the signer is our self-hosted identity server, a customer realm per shop (below). Amends ADR-0018 (one public origin: `/auth/otp/*` gets its own switch) and ADR-0019 §6 (the customer
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

**Was an owner question — now decided (OB-510, 28 October 2026, option A; see the amendment below):** who signs a
customer's token once their code is right. The options were (A) the self-hosted identity server (Keycloak, ADR-0019)
signs it — a customer realm per shop and a narrowly-scoped client for this service; nothing bought; (B) an SMS-code
sign-in inside the identity server itself (a Keycloak extension); (C) the API believes this service's sessions directly.
The owner chose (A).

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
- Turning customer sign-in ON needed two written owner decisions: an SMS provider (OB-29 / OB-47 / OB-222 — still open,
  so it stays OFF) and the signer (decided: OB-510, below).
- Memory-held limits reset on a restart — correct for one service instance on one box; a second instance would need a
  shared store for them (the kernel limiter's own note).

## Amendment — the signer is our identity server's customer realm, one per shop (OB-510, 28 October 2026)

**Decision (owner, in writing):** the customer's token is signed by the self-hosted identity server (Keycloak, ADR-0019),
in a **customer realm of each shop's own** (`sre-<shop>-customers`, the first shop's `sre-store-customers`). Customer
sign-in stays OFF until an SMS provider is approved (OB-222).

1. **The realm.** `infra/keycloak/realm-sre-store-customers.json`, imported beside the staff realm (never inside it). It
   holds one confidential client, `sre-customer-sign-in` (service account with `manage-users`/`view-users`/`query-users`
   in THIS realm only; no browser flow; the password grant is allowed for this client alone), mappers for our API's
   audience, the shop's `tenant_id`, the customer's `sre_user_id` and `amr: ["otp"]`; no person; no secret (the client
   credential is generated by the identity server when the realm is loaded). A new shop's customer realm file is written
   by `realm-for-shop` / `shop:new` (`customerRealmFile`) beside its staff realm file and loaded the same way (OB-19:
   head office never creates a realm).
2. **The signer** (`services/identity/src/keycloak-customer-signer.ts`, composed in `customer-sign-in-main.ts` when
   `CUSTOMER_SIGN_IN_SIGNER=keycloak`): once the code is right it (a) takes a service token for its client;
   (b) finds — or makes, once — the customer's account under a product id derived from the shop and the number
   (`customer-<sha-256>`): **the identity server never holds the phone number**; (c) sets a fresh random one-time
   credential (32 random bytes) on that account and exchanges it at once for the customer's token (the password grant);
   the credential is held in memory for those two calls only, never logged or stored, and the next sign-in replaces it;
   (d) believes the token only after head office's own `verifyToken` accepts it (RS256 against the realm's published keys,
   the issuer, our audience, the shop pinned, the customer's id). **Product code still mints nothing** (ADR-0019).
3. **Head office** believes a customer realm only when told it in `IDP_OIDC_CUSTOMER_REALMS` (`realm=tenant`), pinned to
   that shop, and only for subjects beginning `customer-` (`TokenPolicy.subjectPrefix`, refusal
   `subject_not_this_issuers`): a customer realm can never sign a member of staff in, and a staff realm is unchanged.
4. **Why not token exchange (impersonation)?** Keycloak 26.0's impersonating token exchange is a *preview* feature that
   needs the fine-grained admin permissions preview too — not supported for production. The one-time-credential exchange
   uses only supported, default features; its power (making a customer's token) is exactly what an exchange client would
   hold, and it is confined to the customer realm.

### §19-substitution impact of the amendment

- **Offline:** none on a sale path; the till never calls it (hard rule #1). With the identity server down, a customer
  cannot sign in and the app says so; browsing is unaffected.
- **Support:** one more realm per shop, loaded with the staff realm; one credential file per shop for the sign-in service
  (runbook: customer sign-in). The real-server proof runs in the automatic build (`keycloak-customer-realm`).
- **Security:** the phone number never reaches the identity server; the client's power is confined to the customer
  realm; the one-time credential is random, never seen, never kept; head office pins the realm to its shop and to
  customer ids; the client credential lives in a file given at deploy time, never in code, config, images or logs (hard
  rule #4). Known limit (unchanged): a token handed out stays valid until it expires (15 minutes) after sign-out.
- **Cost:** nothing bought — the identity server is already ours.
- **Portability:** standard OpenID Connect tokens; the signer stays a port, so another identity server is a composition
  change.
- **Maintainability:** one file (~150 lines) on the identity server's documented admin and token endpoints; unit tests
  against a stand-in realm, and the real-Keycloak suite.
