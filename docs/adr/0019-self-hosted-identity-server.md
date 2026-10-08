# ADR 0019 — A self-hosted open-source identity server (Keycloak) signs people in; the product never holds a password

- **Status:** Accepted (owner decision OB-15, in writing: *"A 1"*, 4 October 2026)
- **Date:** 4 October 2026
- **Context:** M02-FR-01 requires unique named accounts, MFA/passkey readiness, a password policy and session
  management, provisioned by a Platform/Security Admin. The architecture settled early that the API trusts only a
  signed bearer token and never issues one (the demo sign-in's own header, `infra/pilot/demo-login/login.ts`; hard
  rule #4 in spirit — no shared logins, no secrets in code), and that identity is federated through a
  provider-neutral OIDC port (`packages/identity/src/oidc-port.ts`): a provider authenticates the person and asserts
  signed claims; the store binds its accounts from the claims and never from anything typed into a header. Which
  provider was the owner's open action **OA-4** since August 2026 (pilot posture: a test IdP, kept out of production
  by the `no-test-idp-in-production` guardrail). The hosted demo meanwhile signs people in with a pilot-only stand-in
  (`demo-login`), single factor, refused for the two step-up routes. The independent audit of 4 October (PF-02, PA-01,
  PA-02, PA-03) found typed identifiers accepted as identity and approval in several places — repairs that need a real
  credential to bind to. The owner then asked for *"a proper login page, super admin and tenant creation"* and chose,
  from three options put with their consequences, **A: a self-hosted open-source identity server inside our own
  stack** over B (a cloud provider, a subscription, their page) and C (the product's own password and MFA service, the
  biggest build and the biggest security burden).

## Decision

1. **Keycloak, self-hosted, is the identity provider** for staff, owner and platform-admin sign-in: one `idp`
   service in the compose stack (store and cloud alike), its own PostgreSQL schema, reached only through the
   proxy (ADR-0018) on a path of its own. It holds the credentials, enforces the password policy, enrols and
   requires MFA/passkeys for privileged and remote access (SEC-03), locks on failed logins and issues the signed
   tokens the API already verifies. Nothing in `services/`, `apps/`, `edge/` or `packages/` mints a token; the
   OIDC port is the only seam, and Keycloak is composed in at the root, the way the port was built for (P-06).
2. **The login page is ours in look, Keycloak's in function:** a Keycloak theme in the OB-13 foundation (light
   set, the shared tokens, English and Tamil, 14px floor, 48px targets), so the person sees one product.
3. **Users, roles and scope stay the product's:** Keycloak authenticates; the product's role catalogue, grants,
   branch/department/value scope, approvals and joiner/mover/leaver (M02-FR-02/03/04, `packages/rbac`,
   `services/api/src/roles.ts`) authorise. Provisioning a person creates the Keycloak account from the product's
   admin flow through Keycloak's admin API; the product remains the system of record for who may do what.
4. **Tenants map to Keycloak realms** (M36-FR-01, ADR-0003 hard isolation): creating a tenant creates its realm;
   a tenant's people never appear in another realm; the platform admin (SRE as the vendor) has its own realm.
5. **The demo sign-in retires** when the first store realm is live; until then it stays pilot-only, as guarded.
6. **Not decided here:** SSO federation to a customer's own directory (Keycloak brokers it when asked; a per-tenant
   setting, no code), and the customer and B2B portal login, which keep the existing OIDC adapter and may use the
   same server later.

## §19-substitution impact (an addition to the baseline: "AI — central model gateway" names no identity server; this adds one)

- **Offline:** the store keeps trading with no internet and no cloud (P-01). The till's offline operator identity is
  the limited cached identity M02-FR-01 already specifies: a short-lived, device-bound credential the box verifies
  locally, refreshed when the identity server is reachable. The identity server itself runs on the store box for the
  store's screens and in the cloud for head office; a store box that cannot reach the cloud still signs its own
  people in. Nothing on a sale path calls the identity server.
- **Support:** one more container to run, upgrade and back up (its schema joins the backup manifest, QG-08). Keycloak
  is widely deployed and documented; an upgrade is a tested image bump. Failure mode: nobody can start a NEW session
  on that box until it is back; existing sessions run to expiry; a sale in progress is unaffected.
- **Security:** passwords and MFA secrets live in one hardened component built for them, not in product code; the
  attack surface is Keycloak's, patched upstream, exposed only through the proxy on its own path, admin console on
  loopback only. The product's hard rule stands: no token is minted by product code. Least privilege: the product
  holds one admin credential for provisioning, scoped to user management, stored as a secret (hard rule #4).
- **Cost:** no licence and nothing to buy (open source). Engineering: the compose service, the theme, the provisioning
  adapter and the realm-per-tenant automation — the same order of work as integrating any provider, less than
  building credential handling ourselves. Running cost: one small container per stack.
- **Portability:** OIDC is the standard; the product depends only on the port. Swapping to a cloud provider later is
  a composition-root change (the reason the port exists). Users, roles and grants are exportable from the product;
  Keycloak realms export to JSON.
- **Maintainability:** credentials, MFA, lockout and sessions are not our code to maintain; the theme and the
  provisioning adapter are small and tested. A guardrail keeps token minting out of product code; another keeps the
  admin console off the public origin.

## Consequences

- The "proper login page" the owner asked for is the Keycloak theme in the OB-13 look; the product gets a sign-in
  that is MFA-capable from the first day.
- The Wave 2 identity repairs (PF-02 a verified offline-capable till credential; PA-03 approval objects bound to an
  authenticated second person; PA-02 revocation on a live session) bind to Keycloak-issued identity.
- The create-and-assign flow on `/admin/?tab=people` provisions through the adapter; a tenant's creation (M36-FR-01)
  creates its realm.
- The stack gains a service, a schema and a backup item; the runbooks gain its restore step.

## Implementation notes — part 1 (OB-15-a, 8 October 2026)

- **Head office checks, never signs.** The API believes the identity server's RS256 tokens against the public keys the
  server publishes (`services/identity/src/jwks.ts`; a rotated key is fetched when a token names it, at most once per
  30 s), with the issuer, the audience and the lifetime ceiling pinned as before. The header's `alg` only chooses between
  the policies configured (the pilot sign-in's HS256, the identity server's RS256); a key carried in the token is never
  used.
- **The product's person is a claim the product sets.** Keycloak's own `sub` is its internal id. The product's user id
  travels as `sre_user_id`, a user attribute only an administrator (the product's provisioning) can set.
- **The realm is code.** `infra/keycloak/realm-sre-store.json` is imported on every start:
  - the browser flow with PKCE; no password grant;
  - password policy and lockout;
  - a one-time code for `sre-privileged`;
  - the `tenant_id`, `sre_user_id`, audience and `amr` mappers;
  - a declared user profile.

  A guardrail pins all of this.
- **Opt-in in the stack** (`--profile identity`) until the screens use it. Its admin console is refused at the public
  proxy and is reached over an SSH tunnel.
- **Proved against a real Keycloak 26.0.7** (`tests/integration/keycloak-real.test.ts`, opt-in, recorded in the runbook):
  - sign-in by code + PKCE;
  - the real head-office service believing the result;
  - the second-factor stop;
  - the lockout.

## Implementation notes — part 2 (OB-15-b-1, 8 October 2026)

- **The product's sign-in service** (`services/identity/src/sign-in.ts`) is the front door's "who is this?". It is an
  OIDC relying party for the public client:
  - authorisation code with PKCE (S256), a one-time state (ten minutes) and a nonce checked against the ID token;
  - the code is exchanged on the private network;
  - the access token is believed only through `verifyToken` (RS256, the published keys).
- **Session handling:**
  - the session is held on the server, keyed by a hash of a random 256-bit id in an HttpOnly, Secure, SameSite=Strict
    cookie;
  - the front door gets `X-Sre-User` and `X-Sre-Bearer`, renewed with the refresh token in the token's last minute;
  - a refusal at renewal ends the session;
  - a session lasts ten hours at most;
  - sign-out ends it at once and sends the browser to the identity server's end-session.
- **What the service holds:** no client secret, no password, no signing key.
- **Limit:** sessions are in memory — a restart signs people out. A shared store is the reconsider-when for more than one
  instance.
- **The return address is `/login/callback`**, not `/auth/…` — the proxy forwards `/auth/` to the identity server itself.

**Part 3 (OB-15-b-2) — the front door.**
- `infra/compose/nginx.identity.conf` is the trial front door gated by the sign-in service (`/login/verify`,
  `/login/verify-sell`). The pilot front door stays the default; `SRE_FRONT_CONF` chooses between them, one setting
  each way.
- **Head-office calls carry the session's token.** `/v1/` asks `/login/verify-optional`, which always answers 204 and
  adds the person and a current token when there is a session. The front door then uses the caller's own
  `Authorization` header when one is sent, and the session's token otherwise. The browser never holds a token.
- The public proxy forwards a request carrying either session cookie (`sre_demo_session` or `sre_session`).
- **The sign-in page is the product's own Keycloak theme** (`infra/keycloak/themes/sre`, the OB-18 design, English
  and Tamil), selected by the realm's `loginTheme`.

**Part 4 (OB-15-c-1) — people's sign-ins from the product.**
- **The provisioner.** The realm's confidential `sre-provisioner` client has a service account holding
  `realm-management` `manage-users`, `view-users` and `query-users`, and nothing else.
  - Its secret is generated by the identity server and copied to head office's environment (`IDP_PROVISIONER_SECRET`).
    The realm file holds none. A realm placeholder could resolve to a known value if the variable were unset.
  - Proved on the real server: it cannot read a client or its secret, change the realm or hand out an administrator
    role. It can list clients, and is shown none.
- **The route.** `POST /v1/identity/people` (`platform.person.provision`, platform administrator only, recent second
  factor) refuses a shared or generic name, the caller, and anybody already holding a role.
  - It records the attempt before touching the identity server, so a lost reply is finished, never duplicated.
  - The person is created **disabled**, given a temporary password and `sre-privileged`, and only then enabled.
- **The kernel's `shownOnce`.** A route may name reply fields shown once. They are replaced before the reply is kept for
  replay, and the reply is `cache-control: no-store`. The one-time password exists only in that one reply.
- **Two factors.** Head office counts `amr` with something known (`pwd`) and something held (`otp`) as `mfa`
  (RFC 8176). Before this, a sign-in through the identity server could never pass a sensitive route's step-up check.
  - The identity server records the sign-in on which the code is first **set up** as `pwd` only, so a second sign-in
    with the code is needed before a sensitive action.
- **A leaver's sign-in** is switched off (and its sessions ended) before the lifecycle change is recorded. An
  unreachable identity server refuses the change (503), and the approval stays unspent.

**Part 6 (OB-15-d-1) — a realm per shop, owner decision OB-19 "A".**
- **Head office never creates a realm.** `pnpm run realm:for-shop` (`services/identity/src/shop-realm-file.ts`) makes the
  shop's file from the repository's realm.
  - Every value the realm reads from the environment is written in — a realm loaded by hand fills in no placeholder:
    its name, the one shop (`tenant_id` claim), the shop's address, our audience.
  - No person and no secret; the provisioner's secret is generated by the server on load.
  - The administrator loads it ("Create realm").
- **Each realm is pinned to its shop.** A policy may carry `tenantId`; a token naming another shop is refused
  (`tenant_not_this_issuers`).
  - With several realms, the token's issuer only *chooses* among configured policies.
  - Settings: `IDP_OIDC_TENANT_ID` pins the first realm; `IDP_OIDC_SHOP_REALMS` lists `realm=tenant`.
  - With more than one realm, every realm must be pinned, or head office does not start.
- **The provisioner stays in its shop.** Head office's provisioner is the first realm's. A people request or a leaver
  from another shop is answered "not connected" — never a person made in another shop's realm.

## Reconsider-when

- A tenant requires its own cloud directory for all staff (then Keycloak brokers it; if brokering proves
  insufficient, option B for that tenant).
- Keycloak's resource footprint proves too heavy for the smallest store box (then the cloud realm signs the store's
  people in with the cached identity carrying them through outages, and the on-box instance is dropped).
- The platform grows past one operator team running many stacks (then a managed Keycloak or option B at the
  platform tier, with the product unchanged).
