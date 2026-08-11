# Product recall runbook

**M10-FR-03/04 · B11 · WF-09.** Written to be followed by a store manager, not a
programmer, on the day a supplier or a regulator says "stop selling this batch." If any
step here does not work exactly as written, that is a defect in this runbook — report it,
do not improvise.

> **The rule this whole document exists for:** a recall is not finished when you take the
> stock off the shelf. It is finished when you can show, on paper, where every unit of the
> batch came from and where every unit went — and that the ones you could not reach are
> named, not forgotten.

---

## Part 0 — Before anything: what you need in your hand

1. **The batch/lot number** being recalled (from the supplier notice, the FSSAI notice, or
   your own quality hold).
2. **The product** it belongs to.
3. **Who told you** (supplier / FSSAI / your own cold-chain breach) and **when** — write it
   down now; the recall record needs it and memory is not evidence.

If you only have a product and not a batch, treat **every batch of that product in the store**
as recalled until the supplier narrows it. It is cheaper to quarantine too much than to sell
one bad unit.

---

## Part 1 — Stop the bleeding (do this first, within minutes)

The point of sale must refuse the batch **before** you finish the paperwork.

1. On the ERP, open the batch and set **recall block** on it (Compliance or Owner role).
2. Confirm the block reached the tills: the recall flag rides the **priority sync** and the
   lane honours it **even with the internet cable out** (this is tested — see
   `tests/guardrails/a-recalled-tin-cannot-be-sold.test.ts`). If a lane is offline, it still
   refuses the batch from its cached block.
3. Physically pull the stock you can see into a **quarantine area**, clearly marked
   "DO NOT SELL — RECALL." Do not throw anything away yet — disposal is evidenced later.

At the end of Part 1: **no till in the store can sell the batch**, online or offline.

---

## Part 2 — Trace the batch (the two lists)

Run the **lot-trace export** — this is the document the whole recall hangs on. It gives you
**one step back** and **one step forward** for the batch, reconciled.

- On the ERP: **Quality → Lot trace → Export**, enter the batch and product.
  (API: `POST /v1/quality/lot-trace/export`; permission `quality.lottrace.read`, held by the
  owner and the store manager.)
- The export shows:
  - **Inbound (one step back):** which **supplier** the batch came from and on which
    **goods-receipt note**, and the date and quantity received.
  - **Outbound (one step forward):** every **sale** of the batch, the date, the quantity, and
    the **customer where one was identified** (a loyalty member, an order). A **walk-in sale
    with no named customer is still listed** — you cannot phone that person, but you must know
    those units left the store.
  - **Reconciliation:** received, dispatched, and **remaining on hand**. If the export says
    **`reconciled: false`** (more sold than received), STOP — your batch data has a gap; call
    whoever keeps the goods-inward records before you trust the customer list.

Print or save the export. It is now part of the recall record and **must never be deleted**
(hard rule #6).

---

## Part 3 — Reach the people

1. From the export's **identified customers**, contact each per their **consent** (M16 — do
   not message a customer who opted out of contact; phone them instead).
2. For the **anonymous count**, post the recall notice at the store entrance and at the shelf
   the product came from, and on any channel the store uses. You are telling the people you
   cannot name.
3. Log every contact attempt against the recall record.

---

## Part 4 — Account for every unit and close

A recall closes **only with evidence** (this is enforced — a recall cannot be closed with
stock unaccounted for).

1. Reconcile the three numbers: **received = sold + returned + quarantined + disposed.** If
   they do not add up, the recall is not closed — find the missing units.
2. **Dispose** of the quarantined and returned stock per the supplier/regulator instruction,
   and **photograph or document** the disposal (M28 waste evidence).
3. Record **closure evidence** on the recall: the disposal proof, the contact log, and the
   final reconciled counts.
4. Inform the owner. The full recall record — the trace export, the contact log, the disposal
   evidence — is **retained, never deleted** (hard rule #6), for the statutory period (A28).

---

## If you are stuck

- **The till still sold a recalled unit.** Treat it as a live safety event: block the batch
  again, check the lane's sync age on its screen, and call support. A sold recalled unit is a
  customer to contact, not a number to bury.
- **The trace export won't reconcile.** Do not guess. The goods-inward and sales records for
  the batch disagree; the people who keep those records must fix the source data — the export
  only ever reports what it is given.
- **You don't have a batch number, only a product.** Recall the whole product. Narrow later.
