# Consolidated running-cost forecast

**Prepared:** 7 August 2026. **Against:** **D3 = ₹15,000/month maximum post-go-live platform
runtime** (owner decision, 4 August 2026, superseding the ₹20,000 of 2 August).

The owner's instruction was explicit: *"If the platform cannot remain within ₹15,000/month, do
not stop development — record the forecast and present one consolidated cost decision at the
hosting/procurement gate."* This is that record. **Nothing here needs a decision today**; it
needs one at the procurement gate, and the purpose of writing it now is that the gate arrives
with a document rather than a scramble.

---

## What the ceiling covers, and what it does not

D3 covers **hosting, storage, backups, communication infrastructure, monitoring and normal AI
usage**. It explicitly does **not** cover:

| Outside the ceiling | Why | Shape |
| --- | --- | --- |
| External developer / support retainer | Owner: *"shown separately and never silently included"* | Monthly, if engaged |
| Store-edge hardware (mini-server, UPS, lanes, scanners, printers, scales) | Capex, bought once (EX-09) | One-off |
| Apple / Google developer accounts | Annual, per store, publication only (EX-11) | ~₹10,000/year combined |
| Independent penetration test (EX-13, QG-06) | One-off, before customer launch | One-off |
| Payment provider fees | A percentage of turnover, not a platform cost (EX-03) | Per transaction |

These are listed because leaving them out of a "monthly cost" is how a figure becomes misleading
without anybody lying.

---

## The finding: the designed shape does not fit at its upper bound

`docs/architecture/infrastructure.md` was sized to ₹20,000 and its range topped out at exactly
₹20,000. Against ₹15,000 that is a breach, not a rounding difference. Two shapes are therefore
costed here, because the honest answer depends on which one is bought.

### Shape A — all-managed services

Every component a managed service. The provider patches, backs up and fails over.

| Component | Indicative /month | Note |
| --- | --- | --- |
| Managed PostgreSQL (small, with backups) | ₹6,000–8,000 | The single largest line, and the one that does not shrink |
| Container compute (domain services + web/admin) | ₹4,000–6,000 | |
| Managed Redis | ₹1,500–2,000 | |
| Object storage + off-site backups | ₹1,000–2,000 | Documents, backups (M35) |
| Network / DNS / TLS / monitoring | ₹1,000–2,000 | |
| Messaging (WhatsApp/SMS/email) — see below | ₹300–2,000 | Volume-dependent |
| AI usage — see below | ₹165–2,500 | Capped; fails safe |
| **Total** | **₹14,000–24,500** | **Fits only at the very bottom of the range** |

### Shape B — one India-region VM, self-managed *(recommended)*

One reasonably-specified virtual machine running PostgreSQL, Redis and the application
containers; object storage and off-site backups stay managed, because a backup you also host is
not an off-site backup.

| Component | Indicative /month | Note |
| --- | --- | --- |
| VM (4 vCPU / 8–16 GB / SSD, India region) | ₹3,500–5,000 | Runs Postgres, Redis and the containers |
| Object storage + off-site backups | ₹1,000–2,000 | Deliberately **not** on the same machine (M35, SEC-08) |
| Network / DNS / TLS / monitoring | ₹1,000–2,000 | |
| Snapshots / second small VM for restore rehearsal | ₹500–1,000 | AID-10's quarterly rebuild has to run somewhere |
| Messaging | ₹300–2,000 | |
| AI usage | ₹165–2,500 | |
| **Total** | **₹6,465–12,500** | **Fits, with headroom for the AI ceiling in full** |

**What Shape B actually costs is not money.** Database patching, failover and restore rehearsal
move from the provider to us — which means to **D4, the second custodian (Mr Sivakumar)**, whose
quarterly rebuild (AID-10) stops being a drill and becomes the real recovery path. That is a
genuine operational trade and it belongs in the decision, not in a footnote. The recovery
runbooks and the proven restore (`docs/evidence/stage-5-recovery-proof.md`) exist precisely
because this was always the likely shape.

---

## The two metered lines, forecast from measured figures

### AI (Stage 17, D3)

The only line in this forecast with a **measured** basis rather than a vendor estimate. From the
Stage 17 gate: **120 calls across two agents cost ₹164.40** — 1.09% of the ceiling — at simulator
pricing calibrated to published rates.

| Usage level | Calls/month | Indicative /month | Share of ₹15,000 |
| --- | --- | --- | --- |
| Owner brief + operations only (R2 launch) | ~1,200 | **₹165** | 1.1% |
| Adding drafted replies and reorder suggestions | ~6,000 | **₹820** | 5.5% |
| All ten agents, customer-facing included (R7) | ~18,000 | **₹2,470** | 16.5% |

Three properties make this line safe rather than open-ended, and all three are already built:

- **Every agent has its own configurable monthly ceiling.** The total cannot exceed the sum, and
  the sum is a setting.
- **Pre-admission, not metering.** The estimate is checked *before* the call. Metering afterwards
  tells you what you already owe, which is a report, not a control — and *"no unexpected
  overage"* is a property only if the check happens first.
- **Fail-safe: the AI stops and the shop does not.** `shopKeepsTrading` is typed as the literal
  `true`; no future edit can make an AI bill stop a till.

**The real per-token cost is a live-provider question** (UAT-49, EX-12, pre-pilot gate). The
figures above are the arithmetic; the rate is not yet contracted.

### Messaging (EX-04, EX-05)

| Level | Indicative /month | Note |
| --- | --- | --- |
| Transactional only (order and delivery updates) | ₹300–800 | Utility-category templates |
| Adding consented marketing | ₹1,200–2,000 | Marketing-category rates are several times utility |

Consent is enforced in code (`packages/customer/src/consent.ts`), so this line cannot grow by
sending to people who did not agree — which is the usual way a messaging bill surprises somebody.

---

## Forecast summary against D3

| | Low | High |
| --- | --- | --- |
| **Shape A (all-managed)** | ₹14,000 | **₹24,500 — breaches** |
| **Shape B (single VM) — recommended** | ₹6,465 | ₹12,500 |
| **Ceiling (D3)** | ₹15,000 | ₹15,000 |

**Shape B fits with headroom, including AI at full R7 usage.** Shape A fits only if every line
lands at the bottom of its range, which is not a plan.

---

## What the owner will be asked at the procurement gate

Per the binding instruction, **one** consolidated recommendation, with a backup, verified current
prices, contract and lock-in risk, data-residency implications, and the exact action required.
Not now — at the gate. What is recorded here is the forecast and the shape of the decision:

1. **Recommended:** Shape B, one India-region VM, self-managed data services, managed off-site
   backups. Fits ₹15,000 with room.
2. **Backup:** Shape A with managed PostgreSQL only and self-hosted Redis — around ₹11,000–15,000,
   fits at the top only just, and buys back the database operations burden.
3. **The trade to accept or reject:** Shape B moves patching, failover and restore rehearsal to
   the second custodian. If that is not acceptable, the answer is option 2 and a tighter AI
   ceiling.
4. **Data residency:** India region either way (DPDP Act 2023, ADR-0003). Not negotiable, and it
   narrows the vendor list before price does.

## Assumptions this forecast rests on

Recorded so they can be checked rather than inherited:

- **One store, one tenant.** A second tenant on the same platform changes compute, not the shape.
  The product is multi-tenant (OB-01 / ADR-0003), so the marginal tenant is cheap — but this
  figure is for SRE alone.
- **300–600 online SKUs at launch (D6)**, and the audited volumes at **AVR-04** — not yet
  measured, which is the largest single uncertainty in the compute line.
- **Indicative prices, not quotes.** No vendor has been contacted, no account opened, nothing
  procured (owner instruction, 4 August 2026).
- **AI at simulator pricing.** Calibrated to published rates; the contracted rate is EX-12.

## What the owner should check

1. **Ask what this costs per month, and expect two numbers**: the platform, and anything you pay
   a person. If they arrive as one number, ask again — that is the instruction you gave.
2. **Ask what happens if the AI bill runs over.** The answer must be *"it cannot — each assistant
   stops at its own limit and the shop carries on."*
3. **Ask who patches the database on the recommended option.** The honest answer is *"we do"* —
   and that is the actual cost of the cheaper shape.
4. **Ask where the data sits.** India. If any vendor answer is anything else, that vendor is out
   before the price is discussed.
