# Stage 15 gate evidence — pick to doorstep

**Gate:** roadmap Stage 15 — fulfilment and delivery. Modules M18-FR-03/04, M19-FR-02, D09.

**Executed:** 4 August 2026 against **PostgreSQL 16.13**, following **one order** from the
routing decision to the cash coming back. Automated as
`tests/integration/pick-to-doorstep.test.ts` (11 assertions), run in CI against a real
PostgreSQL service container, and **verified repeatable** (run twice, green twice).

The claim on trial: **what arrives at the door is what the customer agreed to, and the shop
knows what it cost.**

---

## One order, routed to delivered

| # | What happens | Control proven |
|---|---|---|
| 1 | A two-bag order for an address 2 km away | Routed to the **dark store** — nearest with the whole order in stock and room in the slot, and **the reason is recorded** rather than inferred later |
| 2 | The dark store's slot is full | **Falls through to the shop.** Capacity is real: a ninth van does not exist, and promising one is a customer waiting in for nothing |
| 3 | The same order as **express**, promised in 20 minutes | **Refused** — only the dark store can do 30, and *"an express price on a scheduled delivery is a promise the shop will break"*. The alternatives say *"offer this as scheduled instead"* |
| 4 | Two bags reserved | Available-to-promise drops 40 → **38**, projected from an append-only reservation ledger |
| 5 | A second order reserves five more, then cancels | **The cancellation returns every reservation to release, as part of the same result.** Available-to-promise goes back to 38 |
| 6 | *(why that matters)* | A cancellation that forgets the release makes stock invisible to the shop floor — it shows as unavailable to a walk-in standing in front of it, and nobody connects the two for weeks |
| 7 | The chicken is short; a thigh pack is offered | **No answer is not a yes.** Nothing is picked, nothing is charged, and the customer is told *"we have left it out rather than guess"* (A04) |
| 8 | She confirms the swap | Substituted — and because the thigh is **cheaper**, she is charged ₹210.00 and the ₹30.00 difference is **refunded**, not kept |
| 9 | *(the other direction)* | A **dearer** substitute is charged at the **original** price: the customer never pays more for the shop's failure to have the item |
| 10 | Frozen peas assigned to the same crate as the atta | **Refused** — *"that is a wet bag of atta."* Raw meat with ready-to-eat food is refused for the same kind of reason |
| 11 | The rest of the order | **Still packs.** One bad crate does not mean the customer gets nothing — the refusals are listed rather than quietly left out |
| 12 | 1.187 kg of chicken thigh packed | **Priced at what was actually packed**: 21,000 × 1187 ÷ 1000 = **₹249.27**, exact integer arithmetic. Not ₹210.00, and not a guess at the doorstep (D09) |
| 13 | A chilled line with **no temperature taken** | **Refused** — *"an unmeasured cold chain is an unproven one"*, the same rule the goods-in door applies |
| 14 | Dispatch with one crate unsealed | **Refused** — *"an unsealed crate cannot be shown to have arrived as it left"* |
| 15 | Dispatch while a short line is unresolved | **Refused** — *"the doorstep is the worst place to have that conversation"* |
| 16 | Dispatch, sealed and resolved | Manifest built **from what was packed**, never from what was ordered: 2 lines, 2 crates, **₹779.27** |
| 17 | The state machines | Order: confirmed → picking → packed → dispatched → delivered. Delivery: assigned → out-for-delivery → delivered. **Delivering before departing is refused**, as is delivering from `confirmed` |
| 18 | Cash on delivery | Reconciles **to the paisa**; a driver ₹79.27 short is a **valued exception**, not a rounding note |
| 19 | A ₹200 order driven 8.9 km | **Flagged, not blocked**: *"this drop loses ₹60 … take it if you want the customer, but take it knowingly"* (D09) |
| 20 | The delivered order, banked in PostgreSQL | Channel reconciled **both ways** — an order the channel has and we do not is *"a customer waiting for something nobody is picking"*; one we have and it does not is *"a phantom that will never be paid for"* |
| 21 | `DELETE` on the order events | **The database itself refuses** (migration 0004) |

---

## The three things this stage refuses to guess

**What the customer agreed to.** A picker swapping one product for another is making a
decision about someone else's dinner, their diet or their religion. So an unconfirmed
substitute is never picked, never charged and never delivered — the line is short instead,
which is the honest outcome. **Silence is not consent**, and the substitution people
remember is always the one they did not agree to.

**What the weighed line costs.** "About 1 kg" of chicken is 1.187 kg. If the final weight is
not priced at the moment it is packed, the shop is guessing at the doorstep — and every
guess is either a customer overcharged or margin given away. Priced from grams in exact
integer minor units, never a float.

**What the manifest contains.** It is derived from what was **packed**, not from what was
**ordered**. A manifest built from the order is a list of what the shop hoped to send, and
the driver is the one who discovers the difference at a stranger's door.

## Repeatability

Run-scoped prefix (`RUN = p<base36 timestamp>`) through every order, reservation and
manifest id, with reads filtered by it — the suite runs any number of times against the same
append-only database and asserts only on its own events.

## Verdict

**Stage 15 gate: PASSED.** An order routes to a place that can actually fulfil it, a
cancellation gives the stock back, a substitution needs a yes, a weighed line is priced at
its real weight, a crate cannot mix what must not travel together, the manifest describes
what is genuinely on the van, and the cash comes back reconciled to the paisa.

## What the owner should check in the store

1. **Cancel an online order and immediately check the shelf figure.** The stock must come
   straight back. If a cancelled order leaves stock reserved, your shelf lies to every
   walk-in customer until someone notices.
2. **Ask a picker what they do when an item is out and the customer does not answer.** The
   right answer is *"leave it out and don't charge for it"* — never *"send the closest
   thing"*.
3. **Weigh a chicken pack at the counter and compare it with the delivery invoice.** They
   must match to the paisa.
4. **Look in a delivery crate.** Frozen and dry goods should not be travelling together, and
   raw meat should not be above anything ready to eat.
5. **Ask what a ₹200 delivery 9 km away costs you.** The system will tell you it loses
   money. It will not stop you doing it — that is your call, and the point is that you make
   it knowingly.
