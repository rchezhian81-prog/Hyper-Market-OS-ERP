# ADR 0034 — What a role may do is changed on screens by two people, as recorded adjustments to the built-in roles

- **Status:** Accepted (owner, 15 Nov 2026: OB-740 "B", OB-741 "A", OB-742 "A"); not built until CR-01 step 4b-2
  (PR #926) is merged
- **Date:** 15 November 2026
- **Context:** CR-01 OI-06 asks that "the owner or an administrator … changes what a role may do on screens; a privilege
  change still needs a second person (§28 maker-checker, hard rule 5) and is audited". The owner decided OB-730 "A"
  (14 Nov 2026): switch individual permissions on or off for a role, **from the existing list only**, each change
  approved by a second person and recorded, with a list of permissions that can **never** be switched on from a screen
  (anything letting an AI agent commit a price, payment, refund, purchase, stock or privilege change — hard rule 5 — and
  anything weakening a two-person approval); the built-in roles stay the starting point; every change can be undone the
  same way. The code as it stands:
  - **The roles are fixed in the program.** `services/api/src/roles.ts` holds 24 roles and 469 distinct permissions
    (`ROLE_CATALOGUE`, line 1345) and says "a role is configuration, not tenant data". Twelve non-test files read it
    directly — for example `adapters.ts:3546` (who may approve a return), `w2-assigned-work.ts:74`,
    `ob676-settings-adapters.ts:29`, `p1-identity-adapters.ts:75,100,386`.
  - **Permissions are worked out on every request, not carried in a sign-in token** (`packages/rbac/src/rbac.ts:64`,
    `AccessControl`). A change at head office therefore applies to the next request.
  - **The store PC gets the roles in its store pack** (`store-pack-builder.ts:275` puts `ROLE_CATALOGUE` in the pack;
    `edge/store-edge/src/screen-navigation.ts:101,189` and `screen-directory.ts:52` read it on the box). The tills and
    office screens decide what to show from that copy, even with no internet.
  - **Only the owner may approve a role today.** `identity.role.grant` is held by the owner alone; the store manager and
    the owner hold `identity.role.request`; the approval engine joins them as maker and checker and never lets one person
    be both (`services/identity/src/approval-requests.ts:236-243`).
  - **105 permissions are held by the owner and nobody else** — among them approving price changes, role grants, the AI
    kill switch, AI agents' budgets, the GST filing, period close and every migration decision.
  - **Existing rules that already limit roles:** the IT function and the shop's business are never held by one person
    (OB-91, OB-95, `services/identity/src/separation-of-duties.ts`); the machine identities hold only the routes they
    call (OB-36, `tests/unit/the-store-computer-role-covers-what-the-box-sends`); the Internal Committee alone reads POSH
    complaints (R2 C20); the security reviewer may do "nothing else" (OB-406); the auto-approve limits can never be set
    for a permission change (OI-12).
  - **ADR-0033 already names the store-PC act** `role_permission_change` (§2) for this step.

## Decision

1. **The built-in roles stay in the program as the starting point.** A shop's change is an **adjustment**: an
   append-only event `role.permission.adjusted` — role, permission, `add` or `remove`, the request id, who asked, who
   approved, the reason, when. A role's effective permissions are the built-in ones with the adjustments applied in
   order. **Undo is another adjustment** the opposite way; "back to the built-in role" is the set of opposite
   adjustments, shown before it is approved. Nothing is overwritten or deleted (hard rule 2).
2. **One effective list, read everywhere.** Every place that reads `ROLE_CATALOGUE` for a decision reads
   `effectiveRoles(tenant)` instead — head office, the approval engine, the separation-of-duties check and the store pack.
   A guardrail test fails if any new file reads `ROLE_CATALOGUE` directly for an access decision, so a forgotten place
   cannot silently keep the old rule.
3. **Only from the existing list.** A permission can be switched on only if it is already in the product's list (one of
   the 469). No new roles, no new permissions, no renaming — OB-730 "A" is adjustments only.
4. **The never-from-a-screen list.** Head office **refuses** these, whoever asks — the page does not merely hide them:
   - **a. The machine roles** (store computer, message relay, backup job, floor-device gateway, findings push, release
     evidence) — OB-36: they hold exactly the routes they call.
   - **b. Outside parties' roles** (customer, supplier, business customer, concessionaire) — they are not staff.
   - **c. The POSH Internal Committee's permissions** (`posh.complaint.*`, `posh.report.*`) — never added to another role
     and never taken from the committee (R2 C20, the POSH Act's confidentiality).
   - **d. The security reviewer role** — OB-406 "nothing else".
   - **e. IT and business kept apart** — no `platform.*` permission into a business role and no business permission into
     the platform administrator (OB-91, OB-95); the separation-of-duties check is run again on every person holding the
     role, and a change that would put one person on both sides is refused.
   - **f. Who controls roles, approvals and AI** — `identity.role.*`, `identity.ca.grant.request`, `approvals.*`,
     `ai.agent.enable`, `ai.killswitch.set`, `ai.budget.set`, `ai.model.approve`: these decide who may approve, what an
     AI agent may do on its own and how it is stopped. Moving them would weaken a two-person approval or the human
     control of AI (hard rule 5, OB-730 "A", OI-12).
   - **g. The owner's reserved powers (OB-741 "A")** — a permission that only the owner holds in the **built-in** roles
     (105 today) is never added to another role from a screen, and **the owner's own role is never reduced** from a
     screen, so nobody can lock the owner out by mistake. The list is worked out from the built-in roles, not the adjusted
     ones, so it cannot drift. Changing either needs a written decision and a programmer, as today.

   **Hard rule 5 itself is not changed by any adjustment:** AI agents are not roles. What an agent may draft is limited in
   the AI gateway's own scoped tools; no role adjustment can let an agent write to the database or commit a price,
   payment, refund, purchase, stock or privilege change. Item f stops a screen from changing who controls the agents.
5. **Two people, never the same person, the owner always one of them (OB-740 "B")** — the approval engine's kind
   `role_permission_change`, valid 24 hours. Either the owner or a store manager asks; the other approves: a store
   manager's ask is approved only by the owner, the owner's ask only by a store manager. Both act under a new permission,
   `identity.role.adjust`, held by the owner and the store manager in the built-in roles (and itself on the never list,
   item f). The platform administrator (IT) takes no part (OB-91, OB-95). The checker sees exactly what changes and **who it affects**:
   every person holding the role, by name. The ask, the approval and a rejection are recorded by the approval engine in
   each person's own name; the applied change is audited as `role.permission.adjust` in the asker's name with the approver
   named. The owner is alerted when a change is applied (P-03) — he is always one of the two, so every ask already reaches
   him in his own approvals list or comes from him (implementation note 1).
6. **On the store PC** the act is sealed after the person's PIN is typed again and relayed exactly as ADR-0033 decides for
   giving a role (`role_permission_request`, `role_permission_approval`, `role_permission_rejection`; the dedicated
   privilege-seal key; refused when the seal is missing, wrong, older than 300 s or reused). With the head-office link off,
   the store PC's own office API holds the shop's records, so the change applies there the same minute.
7. **When it takes effect — and it is shown (P-08).** At head office: the next request. On the store PC and the tills: when
   the next store pack arrives, which already carries the roles. Until the box reports that pack, the page says "Approved
   — not yet on the tills" in English and Tamil, never "done".
8. **The screen.** On the Users & roles page, "What a role may do": choose a role, see its permissions grouped by area,
   each with a plain name in English and Tamil (OI-09), the ones changed from the built-in role marked, and those on the
   never list shown as locked with the reason. Each permission that can be changed needs a plain English and Tamil name;
   none exists today, so writing them is part of the build.

7a. **Delivered in two parts (OB-742 "A")**, each tested and merged on its own: **4c-1** the rules at head office
   (decisions 1–5 and 7: the adjustments, the never list, two people, every reader on the adjusted list, the store
   pack); **4c-2** the screen on the store PC (decisions 6 and 8: the page, the English and Tamil names, the PIN seal).

## Consequences

- The owner can tailor what a cashier, accountant or warehouse user may do without a programmer, with two people, the
  owner alerted, and every change undoable and on record.
- `roles.ts`'s rule "a role is configuration, not tenant data" is amended for these adjustments only (OB-730 "A"); the
  built-in roles and the roles awaiting the owner (OB-615) are unchanged.
- **Risk — one change affects many people at once.** Switching a permission on for "cashier" gives it to every cashier.
  The checker sees the list of names before approving, and the owner is alerted.
- **Risk — a forgotten reader keeps the old rule.** Countered by decision 2's guardrail test and by tests that change a
  role and check each of the twelve readers.
- **Risk — the tills lag head office.** Shown on the page until the pack arrives (P-08); a sale never waits for it (P-01).
- **Cost:** the readers move to the effective list; the labels for the changeable permissions are written in English and
  Tamil, and the Tamil must be checked by a Tamil reader at the store.
- **Tests (when built):** add and remove a permission with two people and see it applied at head office and in the next
  store pack; each never-list group refused at head office even when the request is crafted by hand; maker = checker
  refused; separation-of-duties refused; undo restores the built-in role exactly; the audit events and owner alerts
  written; on the store PC, a missing, wrong, stale or reused seal refused (ADR-0033); the page says "not yet on the
  tills" until the box reports the pack.

## Implementation notes (4c-1, built 15 November 2026)

1. **The owner's alert is raised when a change is applied**, not also when it is asked: under OB-740 "B" the owner is
   always one of the two people, so an ask either comes from him or waits in his own approvals list.
2. **Decision 4a also covers a machine's relay permissions.** The owner holds nearly every permission, so "held only by
   locked roles" is judged leaving the owner out: the 21 relay permissions only the store computer and the owner hold
   (`identity.grants.sync` and the like) are the machine's and are refused for a person's role. The owner's reserved list
   (OB-741) is unchanged — 105 permissions only the owner holds.
3. **Neither person gives what they do not hold** (the grant route's §28 rule): adding a permission is refused when the
   asker or the approver does not hold it.
4. **Both people are judged again when the change is applied**, on the roles they hold at that moment, before the
   approval is spent; the apply route also asks for a recent MFA re-authentication, as giving a role does. The store PC's
   PIN route (decision 6, 4c-2) replaces that re-authentication as ADR-0033 does.
5. **Where the built-in list is still read**, and why each is safe, is pinned by
   `tests/guardrails/cr01-step4c1-every-access-decision-reads-the-adjusted-roles.test.ts`: role ids and names; the fold
   itself; the first owner laid down at setup; whether a role is the IT function (an adjustment can never flip it); and
   OB-676's starting suggestion of which roles a delivery-exception queue may name (narrower is safe — the work itself is
   judged on the adjusted roles).
6. **CR-01 step 6b's auto-approve permissions (`ai.autoapprove.*`) are on the never list** (item f: they decide what an AI
   agent's draft may commit on its own). Step 6b also added one permission only the owner holds
   (`ai.autoapprove.propose`), so the owner's reserved list, worked out from the built-in roles, is now 106.
7. **Decision 7's "not yet on the tills"** is said in words by the apply route in 4c-1; the page that shows it until the
   store PC reports the new pack is part of 4c-2.

## Reconsider-when

- The owner wants roles with new names, or permissions that do not exist yet (needs a new decision; OB-730 "A" excludes it).
- More than one store needs different rules for the same role (this design applies a role the same way in every store).
