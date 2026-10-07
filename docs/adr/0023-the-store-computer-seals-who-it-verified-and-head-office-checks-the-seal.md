# ADR 0023 — The store computer seals who it verified; head office checks the seal and flags what it cannot confirm

- **Status:** Accepted (owner program directive — the audit's Wave 2 critical findings are repaired in order; the last
  part of PF-02, named "2b-v-d" by ADR-0022)
- **Date:** 7 October 2026
- **Context:** ADR-0020 made the store computer verify, offline, that the person a sale, refund, cash movement or till
  close names is the person signed in at that till; ADR-0021 made a manager's approval at the till the manager's own
  PIN, issued and spent by the box. Both checks happen on the box, and the box stamps what it verified
  (`operatorVerified`, `approvalVerified`). But the stamps stopped there: the sync agent did not carry them, and head
  office could not tell a record that passed through a till from one that never did. A body naming any cashier or any
  approving manager, posted by anyone holding the sync permission (every cashier's role holds `pos.sale.sync`), read
  exactly the same as a real one. The audit's smallest next action: *"Keep later sync flags for facts already
  committed."* The money has moved by the time head office hears of a till's fact, so head office cannot refuse it
  (hard rule #1; hard rule #10: a conflict becomes a visible exception).

## Decision

1. **The box seals what it verified.** At its till gate, once it has verified the person, the store computer signs a
   seal over: the fact (sale, refund, cash movement, till close, or a manager's approval), the shop (tenant), the
   record's own id, the till, the person, how they proved it (`pin`, or `verified_sign_in` on the hosted copy), and the
   money the fact moved (sale total, refund, cash amount, counted cash); an approval's seal also covers the approval id.
   The seal is HMAC-SHA256 under a key derived from the pack signing key both sides already hold, under the seal's own
   label (`packages/identity/src/till-seal.ts`) — never the pack key itself, never the till-PIN key. No clock in it, so
   a record re-sent after a lost reply seals the same.
2. **The stamp carries the seal to head office.** The stamps are written on the record on the box's disk (sales,
   refunds, cash movements, till closes) and the sync translators carry them exactly as written; a record the box did
   not verify carries none — the box invents nothing.
3. **Who recorded a till cash movement is the person signed in at the till**, never a body value (the same rule as
   ADR-0020 §5, applied to `performedBy`).
4. **Head office checks every relayed fact and flags, never refuses** (`services/pos/src/store-seal.ts`):
   - no seal → `cashier_not_verified_at_store` (a sale exception, **material**; a flag on a relayed refund, cash
     movement or till close) and, where a refund names an approving manager, `approval_not_verified_at_store`;
   - a seal that does not match the fact — another record, another amount, another shop, another person named, or a
     forgery → `cashier_seal_does_not_match` (a sale exception, **critical**) / `approval_seal_does_not_match`.
   The flags appear where a person already looks: the sale exceptions, the refund governance exceptions (with English
   and Tamil labels on the back-office screen), the till's flagged cash movements and the close's flags.
5. **Nothing is claimed when nobody looked.** A composition without the key, and a sale banked at head office's own
   desk (an exchange's replacement), raise no seal finding.

## Consequences

- PF-02 is closed end to end: the till verifies the cashier (ADR-0020) and the manager (ADR-0021); head office's desk
  approvals are the approver's own act (ADR-0022); and head office can now tell, for every relayed money fact, whether a
  store computer vouched for the people on it.
- A store computer that has not been updated sends unsealed records, and each is flagged "not verified at the store"
  until it is; records already queued on a box when this release lands are flagged once on arrival. That is the honest
  answer, not a fault.
- Tests that stand in for the store computer and post relayed facts straight to head office now seal them the way a
  current box does (`tests/support/store-seal.ts`); tests that run a real box beside head office give both the same key,
  as a real store and its head office have.
- **Limit (recorded):** the key is shared — the same pack signing key every box already holds to verify price packs. A
  person who copies a box's settings could forge a seal, as they could forge a pack. A per-box key (device enrolment)
  would narrow this to one box; that is the reconsider-when below.

## Reconsider-when

Each store computer is enrolled with its own key (device identity, ADR-0019's identity server or a per-box certificate):
the seal then names which box vouched, and a stolen settings file vouches for one box only.
