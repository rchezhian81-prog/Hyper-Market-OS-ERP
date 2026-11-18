# ADR 0035 — Remote head-office access: a small relay server in India; the store computer dials out

- **Status:** Accepted (owner, 18 November 2026, decision OB-840, in writing: "1A, 2A, 3A, 4A, 5A")
- **Date:** 18 November 2026
- **Context:** Head office runs ON the store computer (ADR-0032): `services/api` and the store edge are Windows services,
  and the office pages are served on the PC's own loopback (`http://127.0.0.1:8091`, `edge/store-edge/src/screen-server.ts`),
  behind the staff ID + PIN front door (`office-sign-in.ts`). The owner asked to see the shop and decide approvals when he
  is away from it. Nothing on the store PC may be opened to the internet (ADR-0018: staff screens are never public by
  default; ADR-0030: the shop-network door is encrypted), selling must never depend on a network call (hard rule #1,
  P-01), and the owner already rents a DEMO server that must not carry real data (hard rule #7). The pieces to sign a
  person in with a second factor already exist and are tested against a real Keycloak in CI (ADR-0019:
  `infra/keycloak/realm-sre-store.json`, `services/identity/src/sign-in.ts`, `infra/compose/nginx.identity.conf`).

## Decision

The owner chose, in writing (18 Nov 2026):

- **1A — a small rented server in India (the RELAY) holds only the public sign-in page and the far end of an encrypted
  line; the store computer DIALS OUT to it.** A new Windows service on the store PC, `SRE-RemoteLink` (its own virtual
  account, no password), runs Windows' own OpenSSH client with ONE reverse forward: the relay's `127.0.0.1:18095` →
  the store PC's new **remote door** on `127.0.0.1:8095` (loopback only; never the ordinary screen door 8091, never the
  shop network). The relay's sshd accepts only the store PC's public key, with
  `restrict,port-forwarding,permitlisten="127.0.0.1:18095"`, no shell, no agent, no X11, no password
  (`infra/remote-access/sshd/sshd_config`). Sales data stays on the store PC; the relay stores none.
  Remote access is down whenever the shop's internet or the store PC is off; selling is never affected.
- **2A — the owner buys a domain and names it**; Caddy fetches and renews the certificate automatically (Let's Encrypt),
  with HSTS and no Server header (`infra/remote-access/Caddyfile`), as ADR-0018's proxy already does.
- **3A — a free authenticator app (TOTP) is REQUIRED for everyone who signs in remotely; no SMS.** The relay runs the
  store's own realm (password + one-time code for `sre-privileged`); its one user is created holding that role with
  "set up the authenticator" required at first sign-in; and the store PC's door independently refuses any token whose
  `amr` does not show the one-time code.
- **4A — only the owner may sign in remotely, for now.** The remote-allowed list is a setting in the pinned file
  (`allowed`), whose default is `role:owner`; the relay's `sre-relay add-owner` makes one person only.
- **5A — from outside: sales, reports and approvals; approve or reject.** The door lets through Today (`/manager/`), the
  reports (`/reporting/`), the approvals inbox (`/approvals/`), their own files, and the head-office calls those three
  pages make (reads; and `POST /v1/approvals/requests/:id/decide`). Nothing else: no till pages, no software update, no
  users/roles/privilege screens or acts, no device setup, no price publishing, no PIN sign-in. An approval whose kind
  changes a person's access or role, or trusts a device, is refused at the door and stays for the store PC.

How a request is believed (the store PC decides, not the relay): the relay's front asks the product's sign-in service
(`/login/verify`, as `nginx.identity.conf` does) and sends the person's current access token down the line in
`Authorization`, with no cookie. The remote door (`edge/store-edge/src/remote-door.ts`) verifies it against the identity
server's public key **pinned at setup** (RS256 only, the relay realm's issuer, our API's audience, this shop's tenant,
not expired, a one-hour lifetime ceiling, `amr` with `otp`/`mfa`), checks the person is on the remote-allowed list, and
checks the path. Only then does the ordinary screen handler run, as that person — the same pages and per-screen
permissions as in the store. Each office call is sealed by the store PC exactly as an in-store call (ADR-0033 amendment
3), plus a signed mark `via: 'remote'` and the token's `amr`; head office records an approval decision in the person's
own name **exactly as in the store, plus `via: 'remote'`** (`decidedVia` in the inbox). The door also keeps its own
append-only log (`remote-access.log`): who, what, the answer, the trace id — never a token.

How the pins are trusted: the relay's setup prints a **link code** — a fingerprint of the relay's ssh host key and the
identity server's signing key(s). The owner types it at the store PC (`store-computer remote-access setup --host <domain>
--code <link code>`), which fetches both over the relay's https address and pins them only if they give that code. The
store PC makes its own key with Windows' `ssh-keygen` (the private part never leaves it); its public half is queued at
the relay and used only after the owner approves it there (`sudo sre-relay approve-link`) by typing the **pairing code**
the store PC shows. No secret is typed, pasted or sent anywhere: the relay's own passwords are generated on the relay and
never printed; the owner's one-time first password is shown once on his own server console.

OFF by default: `setup`/`install-services` never install the link, and the till never opens the door unless
`remote-access setup` wrote `EDGE_REMOTE_DOOR_PORT` and the pins file. `remote-access off` stops and disables the link.
Today's last-sync line says the link's state in plain words: connected / not connected since <time> / turned off (P-08).

What this ADR does **not** do: it does not use the DEMO server (setup refuses a server with `/opt/sre`); it does not
put any shop data in the cloud; it does not change how the store's own pages, the till or the PIN sign-in work.

## §19-substitution impact

The baseline already allows "containers, infrastructure as code" and a central identity; the relay is a new small
deployment, so the six axes are recorded:

- **Offline:** no effect on trading. The till does not know the link exists; a sale commits locally first (hard rule
  #1). With the internet or the relay down, the store keeps trading and the office pages keep working on the PC; only
  remote access stops, and Today says so. Proven: `tests/integration/ob840-…` sells with the door on and no line.
- **Support:** one more small server to keep (Ubuntu updates; `sudo sre-relay update`; the certificate renews itself).
  Failure modes are visible: the relay shows "the store computer cannot be reached" in words; Today shows "not connected
  since …"; `store-computer remote-access status` and `sudo sre-relay status` say it on each side.
- **Security:** nothing on the store PC listens on the internet; the shop router opens no port. Two independent gates:
  the relay's sign-in (password + TOTP, lockout) and the store PC's own token check against a pinned key. The relay can
  reach only one loopback door, which serves only three screens and their calls. A stolen relay cannot sign tokens the
  store PC believes unless it also holds the realm's private key — which lives on the relay: so the relay is a security
  boundary and is kept minimal (admin console and master realm never proxied; sshd forwarding-only; only 80/443/2222
  open). Every remote act is in the person's name with the remote mark, and on the door's own log.
- **Cost:** a 2 GB VM in an Indian region (DigitalOcean Bangalore or AWS Lightsail Mumbai, about US$12/month ≈ ₹1,000)
  plus a domain (about ₹800–1,500/year). Well inside D3 (₹15,000/month, `docs/registers/cost-forecast.md`). Prices are to
  be checked by the owner on the provider's own page.
- **Portability:** plain OpenSSH, Caddy, nginx, Keycloak and PostgreSQL in Docker Compose on stock Ubuntu; any provider
  works. The realm file and the sign-in service are the same ones the product already ships.
- **Maintainability:** the relay reuses the tested realm, sign-in service and front patterns; its config is checked in CI
  by the real programs (`caddy validate`, `nginx -t`, `sshd -t`/`-T`, `docker compose config`) and pinned by a guardrail.

## Consequences

- The owner can see Today, reports and approvals and approve/reject from his phone, with his own password and his
  authenticator code. Every decision is his, in his name, marked remote.
- Remote access is only as available as the shop's internet and the store PC.
- The relay holds the identity server for remote sign-ins; if the relay's realm key changes (a rebuilt server), the
  store PC refuses every remote sign-in until `remote-access setup` is run again with the new link code.
- One store computer per relay: approving a new one replaces the old one's key.

## Reconsider-when

- A second person must work remotely (4A is "for now"); a second store; the owner wants remote access when the store PC
  is off (that needs shop data in the cloud — a different decision); or head office moves to the cloud.
