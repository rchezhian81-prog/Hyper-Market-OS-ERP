# `packages/identity/`

Named accounts, sessions and the access lifecycle — **M02-FR-01 / M02-FR-04 / SEC-03 /
SEC-11 / hard rule #4**. With `rbac` (authorisation) and `approvals` (maker-checker), this
completes **M02**.

## It holds no credentials, by design

There is no password field here, no hash, no token. Credential storage belongs to the
identity provider chosen at deployment — and **a password that never enters this codebase
can never be logged by it** (SEC-04, hard rule #4). What lives here is the *policy*: who
exists, what state they are in, and when a session must end.

## A generic account cannot be created (`src/account.ts`)

Shared logins are the top audit finding in retail (A-17), and they never arrive as a
decision. They arrive as a convenience: one account for the evening shift, one for the new
starter until IT gets round to it, one called "manager" that nobody wants to be the one to
remove. So it is refused at creation, not discouraged:

- an account must name a **real person** with **their own** contact;
- usernames that are job titles — `cashier`, `manager`, `admin`, `till2`, `temp` — are
  refused with the reason (a tenant can add its own);
- **two accounts cannot share one contact** — that is a shared login wearing two names.

A **privileged account cannot go active without a second factor** (SEC-03). Sessions expire
on **inactivity** and again on an **absolute limit**, are **bound to their terminal** where
the tenant requires it (§28), and a session established from a **cached offline identity**
is trusted only for a bounded window — which is what keeps the lane trading with the cable
out (§31) without leaving a permanent hole.

The **access review** flags the two things that actually get exploited: **privileged
accounts with no second factor**, and **dormant accounts** nobody has closed.

## Access must track employment reality (`src/lifecycle.ts`)

Two failures cause most access fraud, and both are rules here rather than reminders:

| Failure | The rule |
|---|---|
| **The mover who accumulates.** Someone transfers from the Fresh counter to the cash office and keeps both. Six months later they can raise a stock adjustment *and* settle the till it hides in — a combination nobody granted; it assembled itself. | A move **replaces** scope, never adds to it, and closes their sessions so the new scope applies at once rather than whenever they happen to log out. |
| **The leaver who lingers.** The account is disabled "later", sessions stay open, and the items they owned belong to nobody. | Revocation and session closure are **one act**, and it is **blocked until owned open items are reassigned** — naming them. An unapproved purchase order owned by nobody never gets approved. |

Revocation is a **priority sync item**: an ex-employee's access must not wait behind a
queue of sales to reach the store (§31).

**Emergency access** is real and necessary, and it is the one that quietly becomes
permanent. So it is **time-bound at the moment it is granted**, expires by itself with
nobody needing to remember, needs a specific reason (the review has to mean something) and
an approver who is not the requester. It **cannot be extended in place** — an extension is
a new grant with a new approval, which is exactly what stops "temporary" access becoming
permanent through a series of quiet nudges (SEC-11: no perpetual support access).

## Letting outside people in — the OIDC/OAuth port (`src/oidc-port.ts`)

Staff accounts above are for people the store employs. But the store must also let **outside**
people in — a B2B customer checking their account (M22), a retail customer managing their own
data (M20) — and it must do so **without ever holding their password** (hard rule #4). That is
federated identity: a provider authenticates the person and asserts a few **trusted claims**;
the store believes the claims because they are signed, and binds its own accounts from them —
never from anything the caller typed into a header or a path (OB-01).

- **`IdentityProviderPort`** is provider-neutral. A real OIDC/OAuth provider maps its ID-token
  claims onto `IdentityClaims` (`subject`, `tenantId`, optional `email`/`phoneNumber`/`amr`/
  `branchId`); the local/test IdP mints them directly. Everything downstream depends on the
  **port**, so choosing the production provider is a composition-root swap, not a rewrite (P-06).
  Selecting that provider and holding its credentials is the only externally-gated part.
- **`createLocalTestIdp`** (in `tests/support/local-idp.ts`, **never production**) is a real,
  deterministic IdP for development and E2E — not a mock. It issues the exact compact **HS256 JWS**
  that `services/identity/token.ts` `verifyToken` already verifies, signing with a secret from
  configuration. Point it at the API's own `secret`/`issuer`/`audience` and the two interlock: a
  token it mints is accepted, and a token signed with any other key, issued for anyone else, or left
  to expire is refused by the **same verifier that guards production** — which is what the unit tests
  prove, round trip and every forgery path. It lives under `tests/support` because **production must
  never be able to mint a token** — a module that can mint is a token factory (hard rule #4) — a
  property the `no-test-idp-in-production` guardrail enforces (now across `packages/` too). The
  **port** here holds no minting code: it is the contract a real provider implements at the edge by
  verifying its upstream token and re-issuing a short-lived internal one.

### Customer mobile OTP (`src/otp.ts`)

A retail customer has no laptop and no password manager; their honest second factor is a code to the
phone they already hold. `beginOtpChallenge` mints a short numeric code, stores **only its salted
hash** (the code is a credential — never written to the challenge, a log or the database, hard rule
#4), and hands the plaintext to the sender. `verifyOtp` accepts it **within a time window**, on a
**small attempt budget**, **single-use** (a verified code cannot be replayed) and **tenant-scoped**
(the right digits for the wrong tenant are refused — OB-01), and returns the challenge's new state so
nothing is lost silently. On success the portal mints a token stamped `amr:['otp']`, so a later
sensitive action knows how the person proved themselves. Delivery is the provider-neutral **`OtpSender`**
port — a real SMS/WhatsApp provider implements it (externally gated); the code-revealing **simulator**
lives in `tests/support` (never production, for the same reason the IdP does).

### Organization invitation & membership (`src/org-membership.ts`)

A B2B customer is a business with several people, each needing their **own** login into the same
account — never a shared one (hard rule #4, A-17). So people join by **invitation**: `inviteToOrg`
mints a one-time token, storing **only its hash** (a capability, like a password-reset link), and
returns the plaintext once to be delivered. `acceptInvite` binds the **subject from trusted claims**
(slice 1a) to the org with a role — single-use, time-boxed, revocable (`pending → accepted / expired
/ revoked`), and **tenant- and org-scoped**: an invite from one tenant cannot be accepted into
another (OB-01), and refusals are ordered so a wrong tenant / spent / revoked / expired invite is
refused before the token is even compared. `roleOf` / `activeMemberships` answer who is in an org,
never across the tenant/org boundary or after removal (`removeMember` marks, never deletes).
Delivery of the invite is the same provider-neutral gated sender the OTP flow uses.

Pure and deterministic — the timestamp is injected, there is no clock, no I/O. Tested in
`tests/unit/identity-account.test.ts` (18), `tests/unit/identity-lifecycle.test.ts` (16),
`tests/unit/identity-test-idp.test.ts` (10 — the IdP↔verifier interlock and its refusals),
`tests/unit/identity-otp.test.ts` (10 — OTP lifecycle + the OTP→token composition) and
`tests/unit/identity-org-membership.test.ts` (10 — the invite lifecycle + tenant/org-scoped binding). Part
of the repository layout in `CLAUDE.md`.
