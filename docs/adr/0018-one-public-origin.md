# ADR 0018 — One public https origin: the customer app, the API and sign-in on one address; staff screens off it

- **Status:** Accepted (owner program directive, Stage F, 29 September 2026)
- **Date:** 29 September 2026
- **Context:** The customer app is relative by design — it POSTs `/v1/storefront/orders/:id` and `/auth/*` to
  the host that served the page, so the customer's short-lived token goes nowhere else (M20 slice 2, hard rule
  #4). That only works when one origin serves the page, the API and sign-in. Until now the compose stack had
  no front: `web` (nginx) served two static shells on 8080, the API on 8081, TLS was "an operator step"
  (`docs/pilot/SAFE-PILOT-ENVIRONMENT.md`) and the hosted demo put a hand-configured Caddy in front. The edge's
  screen server — the only thing that serves a shell WITH its data (`edge/store-edge/src/screen-server.ts`) —
  binds to loopback by design (`SCREEN_HOST`), because on a shop PC it carries the day's takings. The API keys
  its per-IP rate limit and sign-in lockout on the leftmost `X-Forwarded-For` entry (`services/kernel/src/http-server.ts`)
  and relies on the ingress to overwrite that header.

## Decision

1. **A `proxy` service (Caddy) is the one public origin.** It terminates TLS and routes:
   `/v1/*`, `/livez`, `/readyz` → `api`; `/auth/*` → customer sign-in; `/customer/*` → the edge's screen
   server; `/` → `/customer/`; **everything else → 404 by name.** Plain http redirects to https.
2. **Staff screens are not on the public origin.** Till, owner, manager and the other ERP screens stay on the
   store box's loopback screen server. They join a public origin only behind a sign-in gate (a later slice,
   or the production identity provider) — never by default. The proxy forwards ONE screen path.
3. **The edge may bind its screens beyond loopback only when told.** `EDGE_SCREEN_HOST` (new, optional)
   names the address; the default stays `127.0.0.1` and the guardrail still pins it. In compose the edge is
   told `0.0.0.0` on the private compose network, publishes no host port, and its boot log says in words
   that the screens are reachable beyond loopback. The edge image now carries `apps/` so it can serve them.
4. **The API's client address cannot be spoofed.** The proxy overwrites `X-Forwarded-For` from the
   connection (`header_up X-Forwarded-For {remote_host}`) on every route it forwards to the API.
5. **TLS by configuration, not by hand.** `SRE_PUBLIC_HOST` = a domain → automatic Let's Encrypt with
   `SRE_TLS` as the notice email; the box's public IP → the proxy's internal CA issues for that address
   (browsers warn once — a synthetic demo only; the operator lists it after `localhost, 127.0.0.1`); blank →
   `localhost, 127.0.0.1` (this machine only). Never a bare `:443`: it names nothing, so the internal issuer
   has nothing to issue for and the handshake fails — the first CI run proved it. A client that connects by
   bare IP sends no server name, and inside a container Caddy then looks up the connection's local address —
   the container's own IP — so `default_sni` names the certificate such clients get (`localhost`); the second
   CI run proved that one. `web`, `api` and `db` are bound to loopback; only the proxy publishes 443/80.
6. **Sign-in is a named gap until slice 3.** `/auth/*` answers 503 `sign_in_not_deployed` with the
   three-part error (snippet `auth-not-deployed`); switching `SRE_AUTH_ROUTE=auth-upstream` forwards to
   `SRE_AUTH_UPSTREAM` once the sign-in service exists.
7. **Proven in CI, every run.** The `deploy` job brings the whole stack up and asserts, over TLS: readiness
   through the proxy; `/v1` reaches the API and is refused without a token; the customer app is served;
   `/auth` answers 503 by name; five staff paths answer 404; http redirects; HSTS present; no `Server` header.

Not decided here: which identity provider issues customer sessions (slice 3), a staff sign-in gate for the
public origin, or an image registry (ADR-0017 reconsider-when).

## Consequences

- One address for customers, with the token confined to it. The hosted demo's hand-made proxy becomes a
  committed, tested part of the stack, and `release.sh` deploys it like everything else.
- The edge container serves screens on the compose network. It is unreachable from the host and the
  internet except through the proxy's one route; anything that widens that (a published port, a second
  route) is a change to this ADR. `tests/guardrails/the-public-origin-is-one-and-guarded.test.ts` pins it.
- Certificates live in the `caddy-data` volume; a rebuilt box fetches new ones. IP-only deployments carry
  the browser warning; the runbook says so.
- The customer app served through the proxy shows the edge's published catalogue and slots — the same
  pack the till trades on (P-02). With no pack on the edge it serves the shell and says it knows nothing yet.

## Amendment — the hosted demo's sign-in gate (3 October 2026, owner Option 3, OB-11)

§2 said a staff screen joins the public origin "only behind a sign-in gate (a later slice, or the production identity
provider) — never by default". The hosted demo already had such a gate, built on the box under ADR-0016 (the demo-only
sign-in, `infra/pilot/demo-login`) and in use since 28 September; merging it would otherwise have taken the owner's
browser-reachable staff screens away. So:

1. **The switch.** `SRE_STAFF_ROUTE` on the proxy: `staff-not-public` (the base default — the staff paths, `/login`,
   `/store` and `/store-lane` answer 404 by name, `staff_screens_not_public`) or `staff-demo-gate` (the pilot overlay's
   default). Never on anywhere else; the guardrail pins both defaults and both env templates.
2. **With the gate on** the proxy forwards those paths — and a `/v1` call that carries the demo session cookie and no
   `Authorization` header — to the DEMO FRONT (`web`, `infra/compose/nginx.pilot.conf`) on the private network, and to
   nothing else. The demo front lets a request through only after the demo sign-in says yes (`auth_request`): every
   staff shell, the demo store box's screens, and lane writes only for a role that may sell. It turns the cookie into a
   bearer token for `/v1` only; the API still verifies every token itself.
3. **Nothing about the public edge changes.** TLS, HSTS, the hidden `Server` header, http → https and the OVERWRITTEN
   client address stay the proxy's; the demo front reads the client address from that one header (realip) and forwards
   it from the socket, so the API's per-IP limits and the sign-in's own throttle still key on the real client. The one
   header exception: the sign-in's own pages keep `Referrer-Policy: same-origin` (under `no-referrer` a browser posts
   the form with `Origin: null`, which the sign-in refuses); every other response still gets `no-referrer` last.
4. **The demo front publishes nothing new** — the base's loopback port stays for `standup:check`, which follows the
   sign-in redirect; the demo sign-in and the relay publish no port; the relay reaches the edge's compose screen port.
5. **CI proves it with and without the gate** on every run (the `deploy` job brings the pilot overlay up).

Still true and unchanged: a store stack cannot run the demo sign-in (base compose has no such service); it refuses
any tenant but the synthetic demo tenant; `Reconsider-when` below applies to the gate too — a real identity provider
(OA-4) replaces it, and before any real data it is off.

## Reconsider-when

- A staff sign-in gate (production IdP or the demo sign-in) is ready: staff screens may then join the
  origin behind it — a new route per screen, each behind the gate, never a wildcard.
- A second store or a managed container platform: the proxy moves to the platform's ingress; the routing
  table and the header overwrite stay the contract.
- Customer volume that one Caddy on one VM cannot carry (ADR-0002 item 4).
