# Repair plan — the order of the work from 4 October 2026

**Owner's instruction (4 Oct 2026):** *"not satisfied. take a look the audit report as well. plan the work and
prioritize the sequence."* This is that plan. It is the one ordered list from here; `docs/STATUS.md` records what moved
and `docs/traceability.md` carries the proof, as before. Nothing here invents a requirement; every item names its
roadmap IDs and the audit's finding IDs.

## What this plan is built from

| Input | What it says |
|---|---|
| The owner's recording, 4 Oct 13:06 | The new look is live and the manager's page is fed (manager named, checklist 5, approvals 0). Every link in the left rail opened a page of raw error text (`not_on_the_public_origin`). Every page's badge said "Store computer not answering". The stock-counts page said no counts yet. |
| The independent repository audit, 4 Oct 2026 (`docs/audit/repository-audit-2026-10-04.html`, findings in `…-findings.tsv`) | Code snapshot `d05e4cf`. 104 controlling items, 144 functional requirements indexed. Weighted technical score 57.9 %; 19 of 36 modules labelled E2E; 0 staff UAT sessions; 0 production-verified. 74 findings: 3 critical, 45 high, 25 medium, 1 low. Verdict: substantial software is built; full store end-to-end completion is not yet proven; the repairs are buildable software, not hardware or decisions. It gives an eight-step repair order. |
| Today's merged work | #689 OB-13 records · #690 UX-1a the back-office look · #691 DF-2 the full demo pack · #692 RL-1 a release reaches the browser · RL-2 (this plan's PR) the demo front's lane path, status read and menu prefix · GT-10 the two timezone-dependent till tests. |
| Standing orders | OB-12 (DF-1 → DF-2 → DF-3), OB-13 ("A 1": light look everywhere; back office, then DF-2, then the till and handhelds), CLAUDE.md hard rules, synthetic data only, a named person runs every load, SP-10 UAT stays PENDING until performed. |

## Rules the whole plan keeps (from the audit and CLAUDE.md, in one place)

1. A repair is closed only by **proving its business effect** — a connected test on real PostgreSQL, a browser test
   where there is a screen, a device test where there is a device — never by a success response or a changed label.
2. **Reuse what exists**: the engines, the durable handheld queue, the floor-indent chain, the fixed F01–F17, the new
   look. Add the failing regression for the real boundary first; then the smallest change that makes it pass.
3. **One record**: the audit's finding IDs are added to the existing traceability rows as corrective evidence. No second
   baseline, no new ledger. Labels in the completion ledger move only when the proof exists.
4. **Synthetic data, named people, hard rules** throughout. Nothing is bought. No live provider. No production data.
5. **Each wave ends with something the owner can see on the demo**, so progress is never only in a test log.

## What the recording showed, and what was done about it today

| Seen | Cause | Fixed in |
|---|---|---|
| Rail links open raw error text | The store computer draws its menu with its own paths (`/counts/`); through the demo front it is mounted under `/store`, and nobody told it, so the browser was sent to `/counts/` on the public origin, which does not exist there. | RL-2: the relay sends `X-Forwarded-Prefix: /store`; the screen server prefixes every menu link; a malformed header is ignored; integration test + guardrail. |
| "Store computer not answering" on every page | Two faults. The front rewrote `/store-lane/lane/…` to `/lane/lane/…`, which no route answers — so **no sale, day close or status read ever reached the demo store box through the front**. And the status read sat behind the "may sell" gate, which a manager does not pass. | RL-2: the prefix comes off and nothing goes on; the status read is open to any signed-in person; guardrails pin both; the CI gate checks the status read is behind the sign-in. |
| Sign-in page in the old look | The sign-in service draws its own page and was never restyled. | RL-1 (#692): the OB-13 look; the store computer's screens listed first. |
| New look did not appear after the deploy | The browser kept the old shell under an unchanged cache name. | RL-1 (#692): the cache name is a digest of the shell; a reload strip announces a new version. |
| Stock counts empty | Honest: nobody has counted yet; the cloud holds no count records for the demo tenant. | Nothing to fix. Counts appear when a person counts (practice script row 2/4). |
| Two till tests depend on the host's time zone (audit GT-10) | The test fixture dated moments by the machine's clock. | GT-10: the fixture states its zone; a new test proves the same moment is the 5th in UTC and the 6th in Asia/Kolkata. |

## The sequence

**Execution order chosen by the owner (OB-14, 4 Oct 2026, Option C: "the look first"):** 0 → 1½ → 1¾ → 1 → 2 → 3 → 4 → 5
→ 6 → 7 → 8. The wave numbers keep the audit's step numbers so every finding stays traceable; the order above is the
order of work.

Sizes are relative (S half a session, M one to two sessions, L several sessions, XL a run of sessions), not dates.
Waves run in order; inside a wave the slices are independent unless marked. Every slice is a PR with the full gate.

### Wave 0 — today (done or in this PR)
RL-1, RL-2, GT-10 as above. DF-2 delivered and run by the owner.

### Wave 1 — make the release evidence dependable (audit step 1 · GT-01, GT-08, GT-09, PF-15) · size M
- **GT-01 — DONE 4 Oct 2026:** CI runs the browser suite (Chromium provisioned on the runner, 62 e2e files) and the
  performance suite on the exact merge SHA as **required, non-skipping** jobs; a run with a skipped browser suite
  fails (`scripts/assert-suite-ran.mjs`, `browser-required-in-ci.e2e.ts`); the release job needs them. Left for the
  owner/administrator: tick the two checks in GitHub branch protection.
- **GT-09 / GT-08 / PF-15 — DONE 5 Oct 2026:** `docs/evidence/TEST-SCOPE.md` v1 and the generated
  `docs/evidence/evidence-ledger.md` with separate columns for unit, integration, real-PostgreSQL, browser (stub),
  browser (connected), device and staff-UAT evidence per requirement; CI refuses a stale ledger or a label that
  outruns its proof. M11 and M30 re-rated on the rule (57.9 % → 57.7 %). **Wave 1 is closed.**
- Owner sees: the merged run's job list shows the browser and performance jobs green.

### Wave 1½ — the till and handhelds take the look (OB-13 UX-1b) · size S — FIRST after Wave 0 (OB-14)
Palette only, layouts and 56 px targets unchanged; the pins come off; a "new version" strip on each. The owner chose
this before Wave 1 (OB-14, Option C, 4 Oct 2026).

### Wave 1¾ — the page anatomy (OB-13 UX-1c) · size M — SECOND after Wave 0 (OB-14) — DONE 4 Oct 2026
Module landings and work pages in the owner's structure: purpose line, one primary action, summary panels, subpage
tiles, register + record drawer. Moved here from Wave 5 by the owner's choice (OB-14, Option C): he sees the finished
look first; the screens that waves 2–5 later prove keep the anatomy they get here. The cost, stated when he chose:
the critical fixes of Wave 2 start that much later, and a page may be touched twice (anatomy here, logic later).

### Wave 1⅞ — ONE application (OB-16 UX-2a, #699) and the Today command centre (UX-2b, #700) · size M — DONE 5 Oct 2026; Wave 2 next
The owner signed in to the hosted copy, landed on a list page of links, and refused to go on (5 Oct 2026, OB-16: *"i
don't want this type of UI … with out this done we don't want move further"*; *"continuously telling demo version and
only manager roll … please complete this as full product"*). Done: the sign-in lands in the store computer's workspace;
every old shell address redirects into it; the rail names the branch and the signed-in person and carries the devices
under *Devices*; the groups are his 16 workspaces in a fixed order; the header has the breadcrumb and the screen search;
the screens run as the person who signed in (the sign-in names them, the front copies it, the box trusts it only under
the hosted overlay); "demo" left the product's words. **UX-2b next:** `/manager/` becomes the *Today* command centre of
his composition — sales today, purchase orders open, indents, stock attention, purchase-to-shelf, needs-attention, cash
and close — every figure from a real read or said to be "Not known" (P-08). Wave 2 starts when the owner says the look
is right. Open to him: a written *"GO real data"* before the store trial runs on the shop's own products and prices.
**UX-2b done the same day:** the Today page in the RMC-PRO pattern the owner chose (OB-17) — a band of figures with
icons, *Needs attention*, *Purchase to shelf*, *Store today*, *Workspaces* — every figure computed on the store computer
or "Not known" with the reason; icons in the rail; the sign-in in the product's frame. **OB-17 also rules from here:**
software first (no hardware asks until the software is complete), English now (Tamil deferred to Wave 8), the owner
registers a domain and gives only its name. **UX-3 (OB-18, 5 Oct 2026, #706):** between Wave 2b-iii-a and 2b-iii-b the owner sent a
finished login design and asked for it before the next slice; the real sign-in now wears it (unit + browser-verified,
no sample state, honest connection line), the pack kept under `docs/design/reference/login-pack-2026-10-05/`.

### Wave 2 — close authority and competing-write gaps (audit step 2) · size L — the critical wave, now also the owner's "all in one" block (OB-15, "A 1")
The owner's direction of 4 Oct 2026 (OB-15) rides this wave because it is the same code: the command-centre home on
`/manager/` from real reads; the M02 create-and-assign screen flow (users, roles, scope, joiner/mover/leaver) on the
repaired identity code of PF-02 / PA-01 / PA-02 / PA-03; the login page through the OIDC port with the self-hosted
identity server (ADR-0019), the demo-login retiring; then, as Wave 2's tail, the platform-admin tenant console
(M36-FR-01: create tenant → plan → entitlements, cross-tenant isolation proven) on `packages/tenant` and M33 self-setup.
One shared primitive first: **conditional append with an expected version per key** on the SQL event store, with a
real-PostgreSQL concurrency test harness (two distinct requests, one must lose by name) — **DONE 5 Oct 2026 (#701):**
the write guard (`write_guards`, `guardVersion`, `ConcurrencyConflictError`), proven on PostgreSQL and in memory. Then, on it:
- **PF-01** refunds, gift value and loyalty: read-check-append atomic per sale / instrument / customer — **DONE 5 Oct 2026
  (#701)**; the loser is a named `concurrent_change` 409.
- **SF-04** two transfers cannot spend the same stock; **FUL-02** reservations cannot promise the last unit twice,
  duplicate lines refused; **PA-11** the audit chain cannot fork across two writers — **DONE 5 Oct 2026 (#702)**: the
  same guard keyed per source location, per location's promises and per tenant chain; proven on the API surface and
  on real PostgreSQL (the last-unit race on the database, as the audit asked). Wave 2a closed.
- **PF-02** the till operator is a verified, offline-capable credential; a manager approval is a separate
  authenticated, transaction-bound, one-use record; **PA-03** every "second person" field becomes an authenticated
  approval object — **DONE 5 Oct 2026 (#705 2b-iii-a, #707 2b-iii-b)**: role grants in two acts, template versions
  drafted and approved by two people, the decider's branch checked, a lender's scope the server's; a facilities check
  is completed by one signed-in person and verified by another with their own Verify, an incident is closed by the
  signed-in person and never by whoever recorded or reported a serious one; **PF-03** the age-restriction
  answer is kept in the basket and enforced at commit — **DONE 5 Oct 2026 (#708, 2b-iv)**: the till asks before a
  restricted item joins the bill, the answer is the signed-in cashier's, the commit checks again before the disk, the
  record carries the evidence, head office flags any restricted line without it CRITICAL. **PF-02, the till half — DONE
  6 Oct 2026 (#709, 2b-v-a, ADR-0020):** the cashier signs in with a staff ID and a six-digit till PIN the store
  computer verifies offline (keyed slow verifier, lockouts per person and per till, a shift session bound to the till,
  fsync'd sign-in log); every sale, refund, cash movement and till close is refused before the disk unless the person it
  names is the person signed in, and the box stamps who it verified. **PF-02, the manager half — DONE 6 Oct 2026 (#710,
  2b-v-b, ADR-0021):** a manager approves at the till with their own PIN; the store computer issues an approval bound to
  the kind, bill, amount, cashier and till, five minutes, and spends it once when the refund reaches the disk; a typed
  approver, a self-approval, a reused or mismatched approval are refused before the disk. **PF-02, head office's desk —
  DONE 6 Oct 2026 (2b-v-c, ADR-0022):** the audit's reproduction (a refund body naming a provisioned manager who never
  approved) is refused by name; a manager approves in their own session (`POST /v1/pos/refund-approvals`) for one kind,
  bill, amount and processor, fifteen minutes; the refund, exchange, no-receipt and out-of-window routes spend it once in
  the refund's own guarded batch (one lands under a race on real PostgreSQL); a leaver's approval no longer counts;
  head-office cash records the signed-in person and puts a till only in a known cashier's name. **Still open in PF-02:**
  the box's stamps signed and carried on synced sales and refunds, and head office flagging a synced fact without them
  (2b-v-d). **PF-02, the box's seal at head office — DONE 7 Oct 2026 (2b-v-d, ADR-0023):** the store computer seals who it
  verified (cashier; manager's approval) over the fact, record, till and amount; the stamps travel on sales, refunds,
  cash movements and till closes; head office flags — never refuses — a relayed fact with no seal
  (`cashier_not_verified_at_store`, `approval_not_verified_at_store`) or a seal that does not match
  (`cashier_seal_does_not_match` critical, `approval_seal_does_not_match`); who recorded a till cash movement is the
  person signed in. **PF-02 is closed** (staff UAT pending). **Found during 2b-v-c (same pattern, pricing — PA-03 family), scheduled as 2b-vi:** a below-cost price
  change (`approval.decidedBy`, `services/pricing/src/index.ts`) and a margin-losing promotion launch (`approvedBy`,
  `services/pricing/src/promotions.ts`) at head office still accept a typed approver's name checked only for authority;
  they get the same approval object (the approver's own act, bound, one use).
- **PA-03 REOPENED 7 Oct 2026 — the 2b-vi triage.** Reading every head-office route that takes a second person from a
  body found **26** that accept a typed name as that person's act, not the 2 recorded above. That earlier note
  understated it. All 26 are listed in `docs/registers/second-person-sites-2026-10-07.md`, with the slice that fixes
  each. Head office's maker-checker engine (ADR-0024, M02-FR-03) is the one fix. The maker asks for the exact details;
  a different person with the authority approves or rejects with a reason, in their own session. The action uses the
  approval once; the store enforces one decision and one use, and the second of two at the same moment is told.
  - **2b-vi-a — DONE 7 Oct 2026:** the engine, its inbox and its screen, and the three severe sites: supplier bank
    details, the bulk import commit (bound to the file's content) and pay-run steps (actor = the signed-in person).
  - **2b-vi-b — next:** the 15 money and price sites, each with its screen.
  - **2b-vi-c — after:** the 8 low-severity and record-only names, plus the store seal on the remaining box-relayed
    decisions.
  - **The pay-run route's gate** is `payroll.statutory.read` even for approve and lock. This is recorded, not changed:
    payroll is under the pilot hold, and no permission is invented.
- **PA-01 / EA-03** branch and resource scope derived on the server from the person's grants — **DONE 5 Oct 2026 (#704)**:
  `ctx.scope` from the grants on every request, the kernel's `narrowScope` / `assertBranchInScope`, applied to the
  consolidation, drill-through and roster routes the audit executed (the other fifteen branch-keyed route files
  follow family by family); **PA-02** a leaver's
  revocation takes effect on the existing session — **PA-02 DONE 5 Oct 2026 (#703)**: `RoleRevoked` on the ledger, one
  grants-minus-revocations fold under every reader, the lifecycle route a durable command that cuts the live session;
  proven in memory and on real PostgreSQL.
- Owner sees: on the demo, a second refund of the same sale is refused by name; a manager approval needs the
  manager's own sign-in; the owner's report cannot be widened to another branch by editing the address.

### Wave 3 — finish the stock path from delivery to shelf (audit step 3) · size L
- **SF-02** each receipt judged against the remaining order quantity; **SF-03** transfer availability from one
  batch-, state- and reservation-aware projection; **SF-05** loss value from stored cost, never from the caller;
  **SF-07 / PA-07** receiving takes the cold-chain rule from the product master, requires temperature evidence, and a
  breach creates the quality hold; **SF-08** open recalls and holds reach the executable block set and the offline
  till; **PF-14** return disposition carries the lot through sale and receipt.
- The floor-indent chain stays as it is (keep).
- Owner sees: receive 60 then 60 against an order of 100 — the second is refused; a recalled lot cannot be scanned
  at the till with the network cut.

### Wave 4 — connect saved changes to actual trading (audit step 4) · size L
- **SF-01** the price and promotion screens write the operative registers, and one test follows screen → pack → sale.
- **PA-06 = DF-3** head office builds and delivers the store pack to every box: authenticated, tenant- and
  branch-bound sections with signed version and expiry, atomic activation and rollback, freshness and revocation;
  every served screen bound to a person. The demo-only pack builder retires. **The quantity scale across pack sections
  is settled here** (found in DF-2).
- **SF-06** the import console binds templates to real domain commands with a checker decision.
- **PF-04** receipt-number cursor durable on the box; **PF-05** a held bill survives a reload; **PF-06** electronic
  tenders keep provider evidence and recover; **PF-07** void and override evidence is durable and feeds the exception
  rules.
- Owner sees: change a price in the office, publish, and the till on the demo sells at the new price; hold a bill,
  reload, recall it.

### Wave 5 — reconcile the full core store day (audit step 5) · size L
- **PF-08** an open shift blocks the day close; nobody can type a zero variance; **PF-09** a sale earns and a return
  reverses loyalty and value durably; **PF-13** a concession decision blocks a counter before money; **PF-12** the
  finance close joins imported independent evidence (code side; connectors stay gates).
- **EA-01** every owner figure says the last complete source sync, not the read time; **EA-02** split tenders report
  by tender; **EA-04** the company report page and export use the production route; **EA-05 / EA-06** drill-through
  from governed records; the store-core report producers first.
- Then **one connected proof on the real stack**: purchase → receipt → put-away → indent → independent floor receipt →
  sale → return → cash → day book → owner report, with a restart and a network cut in the middle.
- **UX-1c** (the page anatomy) was done in Wave 1¾ by the owner's choice (OB-14); a screen proven here keeps it.
- Owner sees: the whole day on the demo, start to finish, in the final look.

### Wave 6 — finish enabled departments and channels (audit step 6) · size XL, staged by what is switched on
Loyalty, delivery and concession are the enabled entitlements, so: **FUL-05** one fulfilment command advances the
order from pack and door outcomes and posts stock and money once; **FUL-04** desk packing takes its rules from the
master; **FUL-03 / FUL-07** checkout is server-authoritative on price, slot, serviceability and payment; **FUL-14**
substitution from stored truth; **FUL-01 / FUL-08 / FUL-13** production moves ordinary stock, recipes version, the
staff pages exist; **FUL-06 / FUL-12 / FUL-10** privacy and customer records durable; **FUL-09** one B2B vertical
slice; **PF-10 / PF-11 / PA-08** campaigns, compensation and notifications become durable, consent-checked work;
**PA-04 / PA-05 / PA-09 / SF-09 / SF-10 / SF-11 / EA-07 / EA-08 / EA-09 / EA-10** as listed in the audit, each closed
by its own connected proof. Owner sees: an online order from the customer app to the doorstep on the demo, with the
stock and the money moving once.

### Wave 7 — close migration and recovery before any cutover (audit step 7) · size L
**GT-02** a rollback is performed and persisted before it says so; **GT-03** no caller boolean overrides server
evidence; **GT-04 / GT-05 / GT-06** delta, opening and supplier loads produce real domain effects with read-back;
**GT-07** backup dump and manifest from one snapshot; **PA-10** support sessions control real access; **PA-12**
off-site immutable recovery rehearsed on a spare machine. Owner provides: the off-site destination and custodians,
lawful access to legacy data, migration witnesses.

### Wave 8 — staff and device acceptance, then live-provider checks (audit step 8) · SP-10, SF-12
Named buyer, receiver, back-store worker, floor receiver, cashier and manager run the existing SP-10 script on the
real store PC, scanner, printer and phones with synthetic data; names, version, device, observed quantities and amounts,
retests recorded. Only then: provider credentials and certification (PF-06, PF-12, PA-08 transports), production
identity, hardware, hosted recovery evidence. **PA-13** (commercial platform, R8) stays in its release; its stale
"owner-blocked" wording is corrected in the ledger now (OA-12 is decided).

## Where today's open items sit

| Item | Wave |
|---|---|
| DF-3 head-office pack delivery | 4 (as PA-06), not before 2 — delivery must bind served operations to a person |
| UX-1b till and handhelds look | 1½ — done 4 Oct 2026 (#694) |
| UX-1c page anatomy | 1¾ — done 4 Oct 2026 |
| UX-2a one application (OB-16) | 1⅞ — done 5 Oct 2026 (#699) |
| UX-2b the *Today* command centre, rail icons, sign-in frame (OB-15/OB-16/OB-17) | 1⅞ — done 5 Oct 2026 (#700) |
| UX-3 the sign-in page in the owner's approved design (OB-18) | between 2b-iii-a and 2b-iii-b, at the owner's word — done 5 Oct 2026 (#706) |
| Wave 2a write guards — PF-01 refunds/gift/points; SF-04 transfers; FUL-02 promises; PA-11 audit chain | 2 — done 5 Oct 2026 (#701, #702) |
| Wave 2b identity criticals — PA-02 leaver; PA-01/EA-03 scope; PA-03 second person; PF-03 age check; PF-02 till credential | 2 — PA-02 done 5 Oct 2026 (#703); PA-01/EA-03 done 5 Oct 2026 (#704); PA-03 done 5 Oct 2026 (#705 grants/templates/decisions/delegations, #707 facilities); PF-03 done 5 Oct 2026 (#708); PF-02 till half done 6 Oct 2026 (#709); PF-02 manager approval at the till done 6 Oct 2026 (#710); PF-02 head-office desk approval objects done 6 Oct 2026 (2b-v-c); signed store stamps and synced-fact flags done 7 Oct 2026 (2b-v-d) — PF-02 closed; PA-03 reopened 7 Oct 2026 by the 2b-vi triage (26 typed-approver sites, register `second-person-sites-2026-10-07.md`): maker-checker engine + 3 severe sites done 7 Oct 2026 (2b-vi-a, ADR-0024); 15 money/price sites (2b-vi-b) next; 8 low/record-only + relayed-decision seals (2b-vi-c) after |
| Handheld enrolment on the hosted demo | 1½ (a demo device code for the practice phones) |
| Quantity scale across pack sections | 4, with DF-3 |
| SP-10 register | 8 |

## What the owner decides or provides, and when

- **Now — DECIDED (OB-14, 4 Oct 2026):** the owner answered *"c"* to the three options (A confirm · B look later ·
  C look first): the look first, then the audit's order. No commercial decision is needed to start waves 1–6 (the
  audit says the same).
- **Before wave 7:** off-site backup destination and custodians; lawful legacy data access; migration witnesses.
- **Before wave 8:** staff time, the store PC, scanner, printer and phones, a date.
- **Separately, at their own gates:** providers, certificates, a real domain, production identity.

## How progress is reported

Every merged PR names its wave and finding IDs in `docs/STATUS.md` and adds the IDs to the traceability row it proves.
The audit's eight steps are closed one by one in this file, with the commit that closed each. The completion ledger's
labels and the SP-10 register move only on proof.
