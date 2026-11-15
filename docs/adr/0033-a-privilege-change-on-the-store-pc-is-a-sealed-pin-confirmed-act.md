# ADR 0033 — A privilege change on the store PC is a sealed, PIN-confirmed act relayed by the box, never a token the box mints

- **Status:** Accepted (owner, 14 Nov 2026: OB-731 "A", OB-732 "B"); amended for step 4b-1 (OB-733 "A", OB-735 "A", OB-736 "A") and step 4b-2 (OB-734 "A", OB-735 "A", OB-739 "A"); amendment 3 for every office page (audit C-1, OB-773 "1 A", 15 Nov 2026)
- **Date:** 14 November 2026
- **Context:** CR-01 OI-06 asks for people and roles to be managed on the store PC's screens. OB-731 "A" decided how a
  person proves who they are there: staff ID + own till PIN, the PIN typed again to confirm each privilege change, on
  the store PC only. Today those screens cannot save a privilege change on a store PC without an identity server:
  - `POST /v1/identity/people`, `POST /v1/identity/grants` and `…/grants/:id/approve` demand a re-authentication within
    300 s carrying `mfa` (`services/identity/src/people.ts:128`, `index.ts:249,339`; enforced by
    `services/kernel/src/step-up.ts:57-92`), which only a head-office session (ADR-0029, `head-office-link.ts`) or a
    token minted from `IDP_SIGNING_KEY` supplies.
  - The office screens run inside the till's own low-privilege service, which holds `till.env` (with
    `PACK_SIGNING_KEY` and a store token, `scripts/install-till.mjs:167-169,349`) and never `IDP_SIGNING_KEY`.
  - ADR-0029 §1 says nothing on the box mints a token; the keyboard tools that do (`scripts/lib/operator-env.ts:68-73`)
    are separate programs the person starts, reading `.env.real`.
  - The project already has a tested way for head office to trust what the box verified: the ADR-0023 decision seal
    (`packages/identity/src/till-seal.ts:173-212`, sealed by `edge/store-edge/src/decision-seal.ts`, checked by
    `services/pos/src/store-seal.ts:63-89`), relayed under the box's store token as approval decisions are
    (`services/identity/src/approval-decisions.ts:191-204`).

## Decision

1. **The box never mints a token** (ADR-0029 §1 kept). Giving the till's service `IDP_SIGNING_KEY` would let a fault
   in the till sign in as anyone, for anything; it is refused.
2. **A privilege change made on the store PC's office screens is a decision record the box seals** — new
   `DecisionKind`s `person_provision`, `role_request`, `role_grant_approval` (and `role_permission_change` for OI-06's
   role adjustments, OB-730, step 4c). Before sealing, the box checks the acting person's PIN **again** with
   `verifyPerson` (the till's PIN register and guess limits), holding **the route's own permission** as the authority
   — never only "signed in". The seal is made with a **dedicated privilege-seal key** (OB-732 "B"): made at setup,
   held only in `till.env` and the office API's settings, never equal to `PACK_SIGNING_KEY`, `IDP_SIGNING_KEY` or
   `BOX_HISTORY_SEAL_KEY` (the API refuses to start otherwise), replaceable on its own. The sealed record carries the exact request body, a fresh request id and `confirmedAt`;
   the existing whole-record digest covers them.
3. **The box relays it** to new box-relay identity routes under its store token (`identity.*.sync` permissions, the
   `storeComputerBinding` check), as it relays approval decisions today. These routes **refuse** — never merely flag —
   a missing or non-matching seal, a `confirmedAt` older than 300 s by the API's own clock, and a request id already
   used. They then run **the same checks as the person's own routes**: the acting person's authority at head office,
   §28 two people (the approver is never the requester and already holds what is granted), and the audit events
   (`role.grant.request`, `role.grant`, people provisioned) in the person's name with `via: office_pin`.
4. **Only on the store PC itself.** The relay is accepted only from the box bound to this store, and the office
   screens serve only on 127.0.0.1 (ADR-0029); nothing on the shop network can make a privilege change.
5. **Every privilege change made this way raises an owner alert** (P-03): who, what, when, approved by whom — so a
   change the owner did not expect is seen the same day.
6. With an identity server configured (head-office link ON), the person's own head-office session is used instead,
   unchanged.

## Consequences

- Office pages can add a person, request and approve a role, and (4c) change a role, on a store PC with no identity
  server, with the PIN typed again for each act and two people for each privilege change.
- The till still cannot sign in as anyone; it can only vouch, by seal, for a person it has just verified by PIN, for
  one named act, within 300 s, once.
- **Residual risk (stated, not hidden):** the privilege-seal key is in `till.env`. A leak of the pack key alone no
  longer lets anyone forge a privilege change (OB-732 "B"), but whoever can read the till's settings file — an administrator of the store PC, or malware running
  as one — could forge seals for any person, including both people of a two-person approval. Mitigations: `till.env`
  is readable only by the till's own account and administrators (OB-284 lock); every such change is audited and raises
  an owner alert; it works only on the store PC. The owner accepted this with a dedicated key (OB-732 "B").
- Tests: the box seals only after a fresh PIN check with the route's permission; the API refuses a missing seal, a
  wrong seal, a stale `confirmedAt`, a reused request id, a requester approving their own request, an approver lacking
  what is granted; the audit event and the owner alert are written.

## Amendment 1 — CR-01 step 4b-1 (14 November 2026: OB-733 "A", OB-735 "A", OB-736 "A")

1. **Adding a person on the store PC records a STORE-PC PERSON** (OB-733 "A"), not a sign-in: a name and a staff id on head
   office's people register (`PersonRecordedForStorePc`, state `store_pc`), with **no sign-in made anywhere** — no office or
   phone login, no one-time password. They work only on the store PC and its tills, by their till PIN. The name alone gives
   no authority, so **one person** adds it — the maker's word, `identity.role.request` (the owner, the store manager; never
   `platform.person.provision`, which stays the IT administrator's for identity-server sign-ins, OB-95) — by PIN, audited
   (`person.store_pc.record`, `via: office_pin`) and the owner alerted. Refused by code: a sign-in name, PIN or password in
   the body; a job or shared name; oneself; somebody already on the register or already holding a role. A later sign-in at
   the identity server upgrades the same record. The access review shows such a person as "store PC only" and flags a
   privileged role held without a second factor.
2. **Rejecting a pending request** is a new sealed kind, `role_grant_rejection`, with the checker's word
   (`identity.role.grant`) and a reason (≤ 300 characters); head office runs the person's own reject handler as them and
   audits `role.grant.reject` with `via: office_pin`. A rejection changes nobody's access, so it raises no owner alert.
3. **The Users & roles page's lists are read through the box** (`GET /v1/identity/box/users-view?for=<person>`, under the
   store token, store computers only): head office judges **the named person's own authority** with the same gates as the
   person's own reads (roles and who holds what with `identity.role.request`; what waits with `identity.role.read`) and
   answers for **the box's own store only** (grants and requests naming that store, or every store). A read asks for no PIN
   and changes nothing; a read the box cannot make is said, never shown as an empty list.
   **Residual risk (stated):** whoever holds the store token can read who holds which role at that store, and the names on
   the register — the same reach the box's signed pack already gives it (OB-54 binding to one store).
4. **Not yet on the store PC (OB-736 "A", step 4b-2):** taking a role back and "they have left" (two people, OB-735 "A"),
   and setting or cancelling a till PIN on screens (OB-734 "A"). The page says so in both languages and does not offer them;
   limiting a role still needs the head-office link.

## Amendment 2 — CR-01 step 4b-2 (14 November 2026: OB-734 "A", OB-735 "A", OB-739 "A")

1. **Taking a role back, and "they have left", by two people** (OB-735 "A" — "the same as giving one"). The maker asks by
   PIN (`access_change_request`, `identity.role.request`): head office runs the person's own approval route (kind
   `access_change`, exactly the lifecycle change). The checker approves or rejects by PIN (`access_change_decision`,
   `identity.role.grant`, a reason): head office runs the person's own decide route (§28: never the maker), and, approved,
   applies **the very change the maker asked for** at once through the lifecycle route **as the maker** — the maker's PIN
   sealed the ask, the checker's PIN the approval: two people, two PINs, as for a grant (on the office pages the maker
   still presses "Apply now"). A leaver loses every role, their store-PC record is ended, and the box cancels their till
   PIN once head office answers. The owner is alerted when it is asked and when it is done.
2. **Till PINs on screens** (OB-734 "A"): `till_pin_change` is sealed as `{ userId, action }` **only** — the new PIN never
   leaves the box. The owner or store manager sets or cancels somebody else's (their own PIN, `identity.role.request`;
   the person then types the new PIN twice, hidden); anyone changes their own with their **current** PIN
   (`identity.self.read`). Head office records it first (`till_pin.set` / `till_pin.cancel` / `till_pin.change_own`, via
   `office_pin`; the owner alerted when it is somebody else's PIN); the box then appends the PIN's fingerprint, or a
   cancellation, to the same till-credentials file the tills and the office sign-in read (append-only, hard rule #2). A
   box that cannot write it says so; it never says done.
3. **No reaching above yourself** (OB-739 "A"): setting or cancelling somebody else's PIN is refused when they hold any
   permission the acting person does not — a store manager for cashiers and warehouse staff, never the owner; a forgotten
   owner PIN is reset at the store PC's keyboard with the existing `till-pin` command. **Relay permissions are not
   authority:** a `*.sync` hop (the box passing on what a person did, each "granting no authority of its own") and the
   till's read of the published templates are left out of the comparison — otherwise every cashier would "hold more" than
   the store manager.
4. A cashier does not sign in to the office screens (not an office role), so a cashier's PIN is set or changed by the
   manager; office roles change their own.

## Amendment 3 — every office page on the store PC (15 November 2026: audit C-1 / D-1, OB-795; OB-773 "1 A")

The owner chose (OB-773 "1 A") that the store PC's office pages reach the office API by extending this ADR to every page.
Before this, with the office PIN sign-in on and no head-office link, the box dropped every `/v1` call a page made, so no
item, price, buying, approval, report or settlement page could read or save on the store PC (the owner's "most features do
not work").

1. **One sealed call per request.** For the person signed in by their own PIN (OB-259), the box seals each page call —
   method, path, query, body digest, idempotency key, the shop, the person, this store, when their PIN sign-in began, the
   moment and a fresh nonce — and carries it to the office API on the same PC (`CLOUD_API_URL`) as the bearer credential
   (`packages/identity/src/office-call-seal.ts`). The box still mints no token: a seal is good for that one request only.
2. **Its own key, derived.** The seal key is derived from the privilege-seal key under its own label (`sre-office-call-v1`),
   so an office-call seal can never be read as a privilege record or a till seal, nor the other way round. It adds no power
   the box did not already hold (the same key already seals role grants).
3. **The API checks it, then runs every ordinary check.** `withOfficeCalls` (services/identity/src/office-call-authenticator.ts)
   refuses a seal made with another key or edited, made for a different request (any of method, path, query, body or
   idempotency key), older than 60 s or dated ahead, or used before; a person whose sign-ins were revoked is refused. Then
   the call runs as that person: their own roles, branch scope, entitlements, idempotency and audit. Their sign-in evidence
   is `amr: ["pin"]`, so a route that demands a second step (MFA) still refuses — privilege changes keep §1–§3's
   PIN-typed-again path. With no privilege-seal key the API believes no office-call seal.
4. **The box refuses first** a write not from a page it served, nobody signed in, or a person with no role at this store.
   With no privilege-seal key, or the office API not answering, a call fails as a lost link (P-08), as before.
5. **Found while proving it:** OB-773 3 B gave the store manager `catalogue.change.propose`, which the owner does not hold, so
   OB-739 "A"'s "no reaching above yourself" refused the owner the store manager's PIN. A proposal changes nothing until the
   owner approves it, so — like a relay permission — it is left out of that comparison (`isProposalOnlyPermission`).

## Reconsider-when

- The store PC gets a hardware-held key (TPM) or a per-box key head office issues: seal with it instead.
- An identity server runs on every store PC: retire the relay and use the person's own session only.
