# Customer sign-in by a code to the phone — how it is run and checked

_ADR-0031 (amended by OB-510) · M20-FR-01 · WF-13 · OB-29 · OB-47 · OB-222 · OB-510._

Customers sign in to the shop's app with a one-time code sent to their phone. The code is checked by the product's
**customer sign-in service** (`services/identity/src/customer-sign-in.ts`). The customer's token is signed by **our own
identity server** (Keycloak), in the shop's **customer realm** (`sre-store-customers` for the first shop; owner decision
OB-510). This page is for the administrator.

## Where it stands in this build

- **It is switched off, on purpose.** No SMS provider is connected (owner decision OB-222: SMS, WhatsApp and voice stay
  off; nothing is bought). So when a customer asks for a code, the service refuses and the app says, in English and Tamil:
  *"Sign-in by a code to your phone is switched off: no SMS provider is connected to this shop yet. No code was sent."*
- The signer is decided (OB-510): the shop's customer realm. It can be set up now; it changes nothing for customers until
  an SMS provider is approved.
- Customers can still browse the shop's app as guests.

## Starting it (optional — it only refuses until a provider is approved)

1. On the server: `pnpm run build:customer-sign-in` (writes `services/identity/dist/customer-sign-in.mjs`).
2. In `infra/compose/.env`: `SRE_WEB_ORIGIN=https://<the shop's address>` (https only) and
   `SRE_CUSTOMER_SIGN_IN_ROUTE=customer-sign-in-upstream`.
3. `docker compose --profile customer-sign-in up -d customer-sign-in proxy`.
4. Check its first log line (`docker compose logs customer-sign-in`): it must say
   `SMS: NO PROVIDER CONNECTED (OB-222): every request for a code is refused, nothing is sent`.

To take it out again: `SRE_CUSTOMER_SIGN_IN_ROUTE=customer-sign-in-not-deployed`, then restart `proxy`.

## Connecting the signer — the shop's customer realm (OB-510)

The customer realm is imported with the staff realm when the identity server starts
(`infra/keycloak/realm-sre-store-customers.json`; a new shop's file is written by `pnpm run shop:new` or
`pnpm run realm:for-shop` beside its staff realm file, and loaded the same way: Create realm → choose the file). It holds
no customer and no secret. Then:

1. Identity server admin (over the SSH tunnel) → realm `sre-store-customers` → Clients → `sre-customer-sign-in` →
   Credentials → copy the client secret.
2. Put it in a file only the server's administrator can read (one line, nothing else), outside the repository — for
   example `/srv/sre/secrets/customer-realm-client`. Never paste it into `.env`, a chat, or a ticket.
3. In `infra/compose/.env`:
   - `CUSTOMER_SIGN_IN_SIGNER=keycloak`
   - `CUSTOMER_REALM_ISSUER=https://<the shop's address>/auth/realms/sre-store-customers` (as the tokens name it)
   - `CUSTOMER_REALM_CLIENT_FILE=/srv/sre/secrets/customer-realm-client` (mounted read-only into the service)
4. Head office: add `IDP_OIDC_CUSTOMER_REALMS=sre-store-customers=<the shop's tenant id>` to its settings and release.
   Head office then believes a customer realm token only for that shop and only when it names a customer
   (`customer-…`) — never a member of staff.
5. Restart `customer-sign-in`. Its first line must now say `signer: the self-hosted identity server's customer realm
   (sre-store-customers)` — and still `SMS: NO PROVIDER CONNECTED`.

If the file is empty or missing, the service refuses to start and says so. To take the signer out: remove
`CUSTOMER_SIGN_IN_SIGNER` and restart.

What the customer realm holds: one account per customer under a product id made from the shop and the number
(`customer-<hash>`) — **never the phone number**, no name, no email. Each sign-in sets a fresh random one-time credential
on that account and spends it at once for the token; nobody ever sees it, it is never logged, and the next sign-in
replaces it. The service's client may manage the CUSTOMER realm's users only — it has no power in the staff realm.

## What it does when switched on (after the owner approves an SMS provider)

- Sends a code (six digits, five minutes, five tries, single use). The code is never stored — only a salted hash.
- Limits: three codes in a row to one number, then one every ten minutes; ten from one connection, then one every six
  minutes. Five wrong codes lock that number (five minutes, doubling, at most a day); ten wrong codes lock that
  connection (a minute, doubling, at most an hour).
- Keeps the session on the server for twelve hours at most; sign-out ends it at once.

## Things to know

- **A restart signs every customer out** and cancels codes still waiting; they ask again. Nothing is lost: the service
  stores nothing about a customer.
- **Its logs never carry a phone number, a code, a token or a credential.** If you ever see one, stop the service and
  report it as a security incident.
- It publishes no port; only the proxy reaches it. It holds no password; its one secret is the customer realm's client
  credential, read from the file above.
- The proof against a real identity server is `tests/integration/keycloak-customer-realm.test.ts` (runbook: identity
  server); it runs in the automatic build's identity job.
