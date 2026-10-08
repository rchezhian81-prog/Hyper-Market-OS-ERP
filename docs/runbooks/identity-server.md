# The identity server (Keycloak) — how it is run, checked and proved

_ADR-0019 · OB-15 ("A 1") · M02-FR-01 · SEC-03. Part 1 (OB-15-a, 8 October 2026)._

The identity server signs people in. It holds the passwords, the second factors and the lockouts; the product holds
none of them and can sign nothing — head office only **checks** a sign-in, against the public keys the identity
server publishes. This page is for the administrator. Nothing here is done through a chat or a remote-support tool.

## What exists after part 1

- `infra/keycloak/realm-sre-store.json` — the store's realm, imported on every start:
  - the product's screens sign in with the browser flow and PKCE only;
  - passwords at least 12 characters, not the user name, not one of the last five;
  - five wrong passwords lock the account (one minute, rising to fifteen);
  - anyone holding `sre-privileged` must give a one-time code from an authenticator app after the password;
  - sign-ins carry the product's person (`sre_user_id`), the shop (`tenant_id`), our API's name and how the person proved
    it (`amr`);
  - it holds **no person and no secret**.
- `infra/compose/docker-compose.yml` service `idp` — **opt-in** (`--profile identity`): it does not start unless asked,
  so a server that has not been given its settings is unchanged.
- Head office (`IDP_OIDC_ISSUER`, `IDP_OIDC_JWKS_URL`) believes the identity server's sign-ins alongside the pilot
  sign-in while that retires.

**Part 2 (OB-15-b-1, 8 October 2026): the product's sign-in service** (`services/identity/src/sign-in.ts`, compose
service `sign-in`, opt-in with the identity server). The front door asks it "who is this?" for every screen:
- it sends the person to the identity server's own page, with PKCE, a one-time state and a nonce;
- it takes the code back at `/login/callback`;
- it believes the result only when head office's own checker does;
- it keeps the session on the server (the browser holds a random id in an HttpOnly, Secure, SameSite=Strict cookie);
- it answers `/login/verify` with the person (`X-Sre-User`) and a current token (`X-Sre-Bearer`), renewed before it runs
  out;
- it ends a session the identity server ended, and lasts a shift at most;
- it signs out at both ends.

Its program is built on the box with `pnpm run build:sign-in`. **A restart signs everybody out** (sessions are held in
memory); they sign in again.

**Part 3 (OB-15-b-2): the front door can ask it, and the sign-in page wears the owner's look.**
- `infra/compose/nginx.identity.conf` is the trial server's front door asking the product's sign-in service instead of
  the pilot sign-in. One setting chooses it (`SRE_FRONT_CONF`); the same setting switches back.
- Head-office calls from a signed-in screen carry the session's current token, added by the front door (the browser
  never holds a token).
- The identity server's page is the product's own (`infra/keycloak/themes/sre`), in English and Tamil.

**Part 4 (OB-15-c-1): head office gives named people their sign-ins, and ends a leaver's.**
- The platform administrator gives a **named** person a sign-in from the product (`POST /v1/identity/people`):
  - never a shared account — a name like "cashier2", "till-3" or "store" is refused;
  - never themselves;
  - never somebody who already holds a role. Their sign-in is made at the identity server, in that person's presence (the
    step below), because whoever sees a one-time password could otherwise act with that person's authority.
- Every sign-in made this way asks for a one-time code from the person's phone.
- The one-time password is shown **once**, to the administrator, to hand over in person. It is not kept in the ledger,
  the audit, a replay or a log. The person chooses their own password at first sign-in and sets up the phone code.
- **A leaver's sign-in is switched off** at the identity server, and their sessions there ended, before their access
  change is recorded. If the identity server cannot be reached, nothing changes and the screen says so.

**Part 5 (OB-15-c-2): the Sign-ins part of the Admin screen.** Admin → **Who can get in** → **Sign-ins**. The platform
administrator types the person's full name and their own sign-in name, presses **Give a sign-in**, and gets the
one-time password on screen, once, to hand over in person. **I have handed it over** takes it off the screen. The list
shows who has a sign-in, who gave it and when. A shared or job name, and their own name, are refused on the screen
before anything is sent; somebody without the administrator's authority sees no form, and a sentence why.

**Part 6 (OB-15-d-1, owner decision OB-19 "A"): a realm per shop.** Head office never creates a realm; it makes the
shop's realm file, and the administrator loads it (below). Head office believes each realm only for its own shop.

**Not yet (next parts):** the tenant console (creating the shop in the product and handing over its file); a sign-in
service and front door per shop's address (needs the domain name); giving people sign-ins in a further shop from the
product (head office's provisioner is the first shop's); resetting a forgotten password from the product.

## A new shop: its own realm (administrator, on the server)

Head office never holds a key that can create a realm (owner decision OB-19). The steps:

1. **Pin the first shop**, once: in `.env.pilot`, `IDP_OIDC_TENANT_ID=<the first shop's tenant id>`. Release. Head
   office's log says `… — signs for shop <id> only`.
2. **Make the new shop's file** on the server:
   `pnpm run realm:for-shop -- --realm sre-<shop> --tenant <the new shop's tenant id> --name "<Shop name>" --origin https://<the shop's address>`
   It refuses a name, id or address it cannot use, by name, and changes nothing anywhere; the file holds no person and
   no secret.
3. **Load it:** `/auth/admin` → the realm list (top left) → **Create realm** → Browse → choose the file → **Create**.
4. **Tell head office:** in `.env.pilot`, `IDP_OIDC_SHOP_REALMS=sre-<shop>=<its tenant id>` (comma-separate further
   shops). Release. Head office's log names each realm and the one shop it signs for. A realm named without its shop,
   or a shop given two realms, stops head office starting and says why.
5. **Its people** are given sign-ins at that realm by hand for now (Users → Add user, as for the owner below, with
   `sre_user_id`); the product's Sign-ins screen serves the first shop.
6. **Its address and front door** come with the domain name (still open). Until then it can be tried on a test
   address only.

The proof suite `tests/integration/keycloak-shop-realms.test.ts` loads a shop's file exactly this way and proves each
shop's person is believed in their own shop only, and that a realm pinned to the wrong shop is refused.

## Connecting head office to the identity server, so people's sign-ins are given from the product

1. Sign in at `/auth/admin` (see "Turning it on"). Realm `sre-store` → Clients → `sre-provisioner` → Credentials. Copy
   the **Client secret**. The identity server generated it; nobody makes it up.
   - **If `sre-provisioner` is not listed**, your realm was first imported before 8 October 2026; an existing realm is
     not imported again. Add it once: Realm settings → Action (top right) → Partial import → choose
     `infra/keycloak/realm-sre-store.json` → tick Clients and Users → "If a resource exists: Skip" → Import. Then
     copy the secret as above.
2. In `.env.pilot` on the server: `IDP_PROVISIONER_SECRET=<the secret>`. Release as usual. Head office's log says
   `identity server: people's sign-ins are given from the product (realm sre-store)`.
3. **The platform administrator's own sign-in** is made by hand at the identity server, as for the owner (step 1 of
   the switch-over below), with `sre_user_id` = their id in the product (on the demo: `pilot-platform-admin`) and
   role `sre-privileged`.
4. **Their first sign-in sets up the phone code.** The identity server records that first sign-in as "password only",
   so head office asks them to sign in once more, with the code, before they can give anybody a sign-in.
5. To change the secret: Credentials → Regenerate, then update `.env.pilot` and release. The old one stops working at
   once.

## Switching the trial server's front door to the identity server (administrator, on the server)

Do this only after "Turning it on" below is done and you have signed in at `/auth/admin` yourself. Nothing here is done
from a chat or a remote-support tool, and no value below is ever written anywhere but the server's own `.env.pilot`.

1. **Give the owner a person in the identity server.** In the admin console, realm `sre-store` → Users → Add user:
   - user name: the owner's own (never shared);
   - after saving: Attributes → `sre_user_id` = the owner's id in the product (on the demo: `pilot-owner`);
   - Credentials → set a password (temporary: on — they choose their own at first sign-in);
   - Role mapping → `sre-privileged` (they will be asked to set up an authenticator app at first sign-in).
   Repeat for each staff member who must sign in, with their own product id. Never give two people one user.
2. **In `.env.pilot`** add:
   - `COMPOSE_PROFILES=identity`
   - `SRE_BUILD_TOOLS="demo-login sign-in"` (the release builds the sign-in program every time)
   - `SRE_FRONT_CONF=nginx.identity.conf`
   - `SRE_AUTH_ROUTE=auth-upstream` and `SRE_AUTH_UPSTREAM=idp:8080` (if not already set)
   - the values listed under "The self-hosted identity server" in `infra/compose/.env.example`, if not already set.
3. **Release as usual** (`infra/deploy/release.sh`). It builds the sign-in program, starts it and restarts the front.
4. **Check, from your own phone, in a private window:**
   - `https://<your address>/store/manager/` → the product's sign-in page (the owner's look, English / தமிழ்);
   - sign in → the manager screen opens;
   - Sign out → the sign-in page again; the back button does not reopen the screen.
   The proof suite below (`identity-front-door.test.ts`) proves the same path on a test machine with every change.
5. **Switching back** (if anything is wrong): remove `SRE_FRONT_CONF` from `.env.pilot` (the pilot sign-in is the
   default) and release again, or `docker compose … up -d --force-recreate web`. Nothing is lost: the pilot sign-in
   was never turned off, and the identity server keeps its people for the next try.

**Note.** A restart of the sign-in service signs everybody out (sessions are held in memory). They sign in again.

## Turning it on (when the next part asks for it)

1. In `.env`, set the values `infra/compose/.env.example` lists under "The self-hosted identity server" — each generated
   on the server (`openssl rand -base64 48`), never copied from anywhere else.
2. **An existing database** (it was initialised before this file existed) does not run the first-boot script. Create
   the login and schema once, as the database administrator, using the three statements in
   `infra/compose/db-init/02-keycloak-role.sh`.
3. `docker compose --profile identity up -d idp`, then set `SRE_AUTH_ROUTE=auth-upstream` and
   `SRE_AUTH_UPSTREAM=idp:8080` and restart the proxy. `https://<your address>/auth/realms/sre-store` now answers.
   `/auth/admin` answers **404 by name** — the admin console is not on the internet.
4. Administer it from the server itself:
   `ssh -L 8180:<the idp container's private address>:8080 <server>`
   then open `http://127.0.0.1:8180/auth/admin` on your own computer. Sign in with the first administrator, create your
   own named administrator with a one-time code, then **disable the first administrator**.
5. Set `IDP_OIDC_ISSUER` and `IDP_OIDC_JWKS_URL` for the API and restart it. Its log says
   `identity server: 1 signing key(s) held for …`.

## The proof against a real Keycloak (opt-in suite)

`tests/integration/keycloak-real.test.ts` runs against a real Keycloak with this realm imported. It is not part of the
automatic checks (they have no Keycloak); it is run, and its result recorded, with every change that touches identity.

1. Start Keycloak 26 (container `quay.io/keycloak/keycloak:26.0.7`, or the release archive with Java 21) with this realm
   in its import folder. Set:
   - `SRE_WEB_ORIGIN=http://127.0.0.1:8099`;
   - `SRE_TENANT_ID=<a test tenant>`;
   - `KC_BOOTSTRAP_ADMIN_USERNAME` and `KC_BOOTSTRAP_ADMIN_PASSWORD`, with the password generated, written to a file
     only you can read, and with no trailing newline.

   Then run `start-dev --http-port 8180 --import-realm`.
2. Run:
   `KEYCLOAK_PROOF_BASE=http://127.0.0.1:8180 KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE=<file> KEYCLOAK_PROOF_TENANT=<tenant> KEYCLOAK_PROOF_DATABASE_URL=<a migrated test database> pnpm exec vitest run tests/integration/keycloak-real.test.ts`
   Give each suite a **freshly migrated** test database: the person it signs in becomes the shop's first owner only
   where the shop has none yet (on a reused one, head office answers 403 and the check fails, correctly).
3. It proves, on the real server:
   - the password grant is off;
   - a person signs in by code + PKCE, and head office's verifier accepts the token and refuses it altered;
   - a privileged person is stopped for a second factor;
   - five wrong passwords lock the account;
   - the **real head-office service**, configured with the identity server, lets that person in and refuses no token or an
     altered one;
   - **through the product's own sign-in service:** `/login/` → the identity server's page → `/login/callback`. The front
     door gets the person and a token head office believes. Sign-out ends the session here and points the browser to the
     identity server's own sign-out.

**The front door, end to end** (`tests/integration/identity-front-door.test.ts`, same settings, nginx installed on the
test machine): runs the repository's own `nginx.identity.conf` (only the private addresses pointed at the test machine,
listening on 127.0.0.1:8099), the sign-in service, the real head-office service and the real Keycloak. It proves: a screen
with no session → the sign-in → the identity server's page → back; the store computer hears the signed-in person and a
visitor's own `X-Sre-User` is overwritten; a head-office call through the front door is let in on the session's token
and refused without it; sign-out ends it.

**People's sign-ins** (`tests/integration/keycloak-provisioning.test.ts`, same settings, a freshly migrated
database). It proves on the real server:
- the provisioner may manage people and nothing else (no client, no secret, no realm change, no administrator role);
- the platform administrator, signed in with password and phone code, gives a named person a sign-in through the real
  head-office service: the password is returned once, `no-store`, never in a replay, the ledger, the idempotency store
  or the audit; a shared name and a role-holder are refused; a sign-in without the code is refused;
- the person's first sign-in forces their own password and the phone code;
- ending the sign-in switches it off.
It takes about a minute: it waits for fresh phone codes, as the server refuses one used twice.

**Recorded:** 8 October 2026, Keycloak 26.0.7:
- 3 of 3 passed for a second shop's own realm (part 6);
- 4 of 4 passed for people's sign-ins (part 4);
- 1 of 1 passed through the front door (part 3);
- 5 of 5 passed (part 1);
- 6 of 6 passed with the sign-in service (part 2).

The built program was also started against it: it refuses to start without its settings, sends a visitor to the identity
server's page, and answers `/login/verify` with 401 for no session.
