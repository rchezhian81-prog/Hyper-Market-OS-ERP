# Architecture Decision Records

Every significant architecture decision, its reasoning and its consequences. Part of the repository
layout defined in `CLAUDE.md`. New ADRs use the plain `NNNN-title.md` filename and follow
[`template.md`](./template.md).

CLAUDE.md (Technology baseline, roadmap §19) requires: **"Any substitution requires an ADR in
`docs/adr/` covering offline, support, security, cost, portability and maintainability impact."** The
0007–0012 records below discharge that obligation for the deliberate §19 substitutions the pilot ships.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-baseline-decisions.md) | Baseline decisions and the rules the machine enforces | Accepted |
| [0002](./0002-hosting-and-deployment.md) | Hosting and deployment approach | Proposed (owner decision OA-5 / OB-02) |
| [0003](./0003-multi-tenant-configurable-product.md) | Multi-tenant, configuration-driven product | Accepted |
| [0004](./ADR-0004-the-disk-lives-on-the-lane.md) | The durable write lives on the lane | Accepted |
| [0005](./ADR-0005-projection-snapshots.md) | Projection snapshots | Accepted |
| [0006](./ADR-0006-batch-on-sale-attribution.md) | Batch-on-sale attribution | Accepted |
| [0007](./0007-erp-no-framework-shell.md) | Web ERP as a no-framework static/PWA shell (§19 substitution) | Accepted (pilot); production framework deferred |
| [0008](./0008-messaging-postgres-outbox.md) | Durable messaging via a Postgres outbox, not a broker (§19 substitution) | Accepted |
| [0009](./0009-redis-deferred-single-instance.md) | Redis deferred for the single-instance pilot (§19 substitution) | Accepted |
| [0010](./0010-documents-as-events-not-object-storage.md) | Documents stored as append-only events, not object storage (§19 substitution) | Accepted |
| [0011](./0011-edge-durability-file-log.md) | Edge durability via an append-only file-log, not a local relational DB (§19 substitution) | Accepted |
| [0012](./0012-modular-monolith-cloud-topology.md) | Modular-monolith cloud topology | Accepted |
| [0013](./0013-product-publish-delivered-by-the-signed-in-operator.md) | Product publish delivered by the signed-in operator, not a background service identity (owner decision, 18 Aug 2026) | Accepted |
| [0014](./0014-recurring-billing-provider-and-mandates.md) | Recurring subscription billing: Razorpay via the connector SDK, mandates not card data (WP5, §19 substitution) | Accepted (owner-directed; provider substitutable) |
| [0015](./0015-persist-batch-expiry-on-the-cloud-ledger.md) | Persist batch expiry on the cloud stock ledger, cloud-only (unblocks A03 near-expiry markdown; ADR-0006 offline path unchanged) | Accepted (owner-directed, 14 Sep 2026) |
| [0016](./0016-demo-store-edge-on-the-hosted-demo.md) | A demo store edge on the hosted demo server, reached through a demo-only relay behind the demo sign-in (synthetic data only; production edge unchanged) | Accepted — DEMO ONLY (owner-directed, 28 Sep 2026) |
| [0017](./0017-automatic-deployment-of-merged-releases.md) | Automatic deployment of merged releases to the single box — push over a forced-command SSH key, proven rollback, environments carry the trust (Stage F) | Accepted (owner program directive, 29 Sep 2026) |
| [0018](./0018-one-public-origin.md) | One public https origin: the customer app, the API and sign-in on one address; staff screens off it until a sign-in gate exists (Stage F) | Accepted (owner program directive, 29 Sep 2026) |
| [0019](./0019-self-hosted-identity-server.md) | A self-hosted open-source identity server (Keycloak) signs people in; the product never holds a password; tenants map to realms; the login page is ours in look | Accepted (owner decision OB-15 "A 1", 4 Oct 2026) |
| [0019](./0019-handhelds-reach-the-box-through-an-authenticated-device-socket.md) | Handhelds reach the store box over the shop network through an authenticated DEVICE socket — enrolled once with a one-time code from head office, per-device credential, loopback by default, handheld screens only (SP-3a) | Accepted (owner program directive, 30 Sep 2026) |
| [0020](./0020-the-till-operator-is-verified-by-the-store-computer.md) | The till operator is verified by the store computer: a personal till PIN checked offline (salted scrypt verifier keyed by the box), a lane-bound shift session, every sale, refund and till-cash write bound to it before the disk; the hosted copy uses its verified sign-in (Wave 2b-v · audit PF-02) | Accepted (owner program directive; ADR-0019's offline identity shape) |
| [0021](./0021-a-manager-approval-at-the-till-is-the-managers-own-one-use-act.md) | A manager's approval at the till is the manager's own act: their till PIN checked by the store computer, bound to the kind, bill, amount, cashier and till, five minutes, used once before the disk; a typed approver is refused (Wave 2b-v-b · audit PF-02) | Accepted (owner program directive; ADR-0020's credential) |
| [0022](./0022-a-refund-approval-at-head-office-is-an-approval-object-the-approver-gives.md) | A refund approval at head office is an approval object the approver gives in their own session — one kind, bill, amount and processor, fifteen minutes, spent once in the refund's own guarded batch; a named approver with no approval is refused; head-office cash records who did it (Wave 2b-v-c · audit PF-02) | Accepted (owner program directive) |
| [0023](./0023-the-store-computer-seals-who-it-verified-and-head-office-checks-the-seal.md) | The store computer seals who it verified (cashier, manager's approval) over the fact, record, till and amount; the stamps travel to head office, which flags — never refuses — a sale, refund, cash movement or till close with no seal or a seal that does not match (Wave 2b-v-d · audit PF-02) | Accepted (owner program directive) |
| [0024](./0024-head-office-maker-checker-engine-an-approval-is-the-checkers-own-act.md) | Head office's maker-checker engine: the maker asks for exact details (fingerprinted), a different person with the authority approves or rejects with a reason in their own session, the action uses the approval once — one decision and one use enforced by the store; supplier bank details, bulk import and pay-run steps move first (Wave 2b-vi-a · audit PA-03 · M02-FR-03) | Accepted (owner program directive) |
| [0026](./0026-canary-stage-and-incident-record.md) | A canary stage before the full rollout (a watched bake that rolls back on lost readiness or new server errors), a backup before every release, and an incident record closed only by a named person after its post-mortem (WF-20 · AID-08 · M35-FR-04) | Accepted |
| [0027](./0027-the-till-prints-its-bill-through-the-browser-and-the-printers-windows-driver.md) | The till prints its bill through the browser's own print and the printer's Windows driver: an 80 mm (or 58 mm) HTML tax invoice built from one tested row model, every Rule 46 field checked on the render, Tamil in the computer's own fonts, a reprint marked DUPLICATE, a failed print never costing the sale (OB-271 · audit A5/A6) | Accepted (off during the mirror pilot) |
| [0025](./0025-erasure-is-crypto-shredding-of-per-customer-data-keys.md) | Erasure is crypto-shredding: a customer's personal text is sealed in the ledger under a per-customer, per-category data key (wrapped under a configured key-encryption key, outside the ledger); erasure destroys the key — an audited, append-only fact — and the shredded-key list wins over any restored backup (audit FUL-12 · M16-FR-03 · M20-FR-04) | Proposed (development-approved; owner and legal confirmation before real data) |
| [0028](./0028-the-queue-till-reaches-the-store-computer-through-the-device-socket.md) | The queue till (mobile POS, D04-FR-05) reaches the store computer through the device socket's own door: its own sign-in for selling, the till's own model and lane pipeline (card/UPI only — cash not decided), a hand-over by four-digit code otherwise, behind two OFF-until-set switches (OB-316) | Proposed (switches off; the money switch needs the owner's approval) |
| [0030](./0030-the-store-computers-shop-network-door-is-encrypted-by-its-own-authority.md) | The store computer's shop-network door (the device socket: handhelds, the queue till) speaks TLS only, under a signing authority the store computer makes for itself at install — name-constrained to the shop's private addresses, its key never leaving the box — which each device trusts once at enrolment; the door's certificate is renewed by the box; plain http is refused; the PC's loopback stays plain (OB-422); a new handheld gets the seal from the PC's own screen by QR code, with the code compared by eye (OB-424); self-checkout and the price kiosk stay on their own PC (OB-425) | Accepted |
| [0029](./0029-the-store-pc-carries-each-persons-own-head-office-session.md) | On the store PC each person signs in to head office with their own login and second step (the product's own sign-in, code + PKCE, `prompt=login`, run in the store computer), and the store computer carries THAT person's session for the office pages' `/v1` calls — never a machine credential, never a PIN; a revoked token or a refused renewal ends it; down is said (OB-388) | Accepted |
| [0031](./0031-customer-sign-in-by-a-code-to-the-phone.md) | Customers sign in by a code to their phone through the product's own customer sign-in service on the shared OTP engine (`/auth/otp/*`, its own proxy switch): a server-side session behind an HttpOnly, Secure, SameSite=Strict cookie, rate limits and lockout per number and per address, no number or code in any log; the SMS provider and the token's signer are ports, both empty — it refuses in plain words (OB-222); who signs a customer's token is an open owner question | Proposed (switched off) |

Further de-facto and proposed decisions (transaction boundaries, Postgres RLS, SHA-256 audit chain,
observability exporters, OpenAPI, DSR API, hosting/IaC/CD) are catalogued as recommendations in
[`../audit/ARCHITECTURE_DECISION_REGISTER.md`](../audit/ARCHITECTURE_DECISION_REGISTER.md); they are
implementation work for later phases, not architecture-baseline substitutions, and are promoted here
individually as they are decided.

## Filename note

Records 0001–0003 use `NNNN-title.md`; 0004–0006 use `ADR-NNNN-title.md`. Both styles are kept as-is to
avoid breaking cross-references; **new records use `NNNN-title.md`** per `template.md`. The number, not
the filename, is the identity.
