# Customer sign-in by a code to the phone — how it is run and checked

_ADR-0031 · M20-FR-01 · WF-13 · OB-29 · OB-47 · OB-222._

Customers sign in to the shop's app with a one-time code sent to their phone. The code is checked by the product's
**customer sign-in service** (`services/identity/src/customer-sign-in.ts`). This page is for the administrator.

## Where it stands in this build

- **It is switched off, on purpose.** No SMS provider is connected (owner decision OB-222: SMS, WhatsApp and voice stay
  off; nothing is bought), and nobody is chosen yet to sign a customer's sign-in (ADR-0031, an open owner question).
  So when a customer asks for a code, the service refuses and the app says, in English and Tamil:
  *"Sign-in by a code to your phone is switched off: no SMS provider is connected to this shop yet. No code was sent."*
- Customers can still browse the shop's app as guests.

## Starting it (optional — it only refuses until a provider is approved)

1. On the server: `pnpm run build:customer-sign-in` (writes `services/identity/dist/customer-sign-in.mjs`).
2. In `infra/compose/.env`: `SRE_WEB_ORIGIN=https://<the shop's address>` (https only) and
   `SRE_CUSTOMER_SIGN_IN_ROUTE=customer-sign-in-upstream`.
3. `docker compose --profile customer-sign-in up -d customer-sign-in proxy`.
4. Check its first log line (`docker compose logs customer-sign-in`): it must say
   `SMS: NO PROVIDER CONNECTED (OB-222): every request for a code is refused, nothing is sent`.

To take it out again: `SRE_CUSTOMER_SIGN_IN_ROUTE=customer-sign-in-not-deployed`, then restart `proxy`.

## What it does when switched on (after the owner approves a provider and a signer)

- Sends a code (six digits, five minutes, five tries, single use). The code is never stored — only a salted hash.
- Limits: three codes in a row to one number, then one every ten minutes; ten from one connection, then one every six
  minutes. Five wrong codes lock that number (five minutes, doubling, at most a day); ten wrong codes lock that
  connection (a minute, doubling, at most an hour).
- Keeps the session on the server for twelve hours at most; sign-out ends it at once.

## Things to know

- **A restart signs every customer out** and cancels codes still waiting; they ask again. Nothing is lost: the service
  stores nothing about a customer.
- **Its logs never carry a phone number or a code.** If you ever see one, stop the service and report it as a security
  incident.
- It publishes no port; only the proxy reaches it. It holds no password and no secret.
