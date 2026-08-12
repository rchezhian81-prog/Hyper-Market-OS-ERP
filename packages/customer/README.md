# `packages/customer/`

Customer 360 — one customer truth (**M16**). Find duplicates safely and never misuse personal
data.

- **`src/matching.ts`** — `detectDuplicateCustomers(customers)`: proposes duplicate pairs. A
  shared **verified** phone/email is a **high-confidence merge candidate**; a shared unverified
  contact or a matching name only is **low-confidence → review**. Nothing is ever **auto-merged**
  — an uncertain match is a **review exception** (P-08); a merge is a governed, reversible,
  audited act (§28, M16-FR-01). Compares normalized values only.
- **`src/consent.ts`** — `hasConsent(state, purpose, channel)` and `canSend(input)`: a message
  may be sent **only** with consent for that purpose+channel that hasn't been withdrawn, and
  within the frequency cap. A breaching send is **blocked, not warned** (`no_consent` /
  `withdrawn` / `frequency_cap`); withdrawal takes effect immediately (M16-FR-02).

- **`src/data-rights.ts`** (M16-FR-03) — the module where two laws point in opposite
  directions. A customer has a right to erasure; income-tax, GST and company law require the
  shop to keep its invoices for years. Both are true. Systems handle this three ways and two
  are wrong: delete everything (illegal), or delete nothing and say nothing (the worse
  betrayal, because the customer stops worrying about it). This one **erases what can be
  erased, keeps what must be kept, and tells the customer exactly which is which and why** —
  `planErasure` names the statute and the release date for every retained category. **Audit
  evidence is never deleted** (hard rule #6): the person becomes a pseudonym and the trail
  survives. `fulfilRequest` checks **verification first, always** — an unverified erasure
  deletes someone else's account and an unverified access request hands over their shopping
  history. `overdueRequests` calls out requests that are late *and still unverified*, because
  that queue is entirely the shop's and has simply not been worked.
- **`src/segments.ts`** (M16-FR-04) — segments and lifetime value are **derived opinions about
  a person**, not facts, and acting on them changes how the shop treats someone. So: **no
  profiling without a lawful basis** — a non-consenting customer comes back as `not_profiled`
  *with the reason*, present in the output so a campaign's reach is honest and nobody "fixes"
  the missing numbers. **Service is not marketing**: the desk can still look someone up to
  answer their own complaint, because that is performance of the contract. **Value is margin,
  not revenue** — a ₹50,000 cigarette customer at 4% is worth less than a ₹20,000 fresh
  customer at 30%, and `rankByValue` states both so the difference is visible — and it is
  **historic only**, because a projected lifetime value is a guess dressed as a figure.
  `buildAudience` always reports **who it could not reach**, and requires marketing consent as
  well as profiling consent: agreeing to be analysed is not agreeing to be messaged.
- **`src/retention-clock.ts`** (C3 / **DPDP Act 2023 s.8(7)**) — the automated retention clock.
  `assessRetention` runs over the categories held for a person: each one whose **purpose is served** or whose
  **consent is withdrawn** (the clock starts at the earlier) moves toward erasure — through a **pre-erasure
  notice window** first (`notice` → then `erase` once the window elapses) — unless the law requires it kept,
  in which case it is **minimised** (identity stripped, record kept) or **retained in full** for audit
  evidence / a legal hold (hard rule #6, never erased). It honours the same statutes `planErasure` does, and
  emits the customer-facing pre-erasure notice. Pure — the clock is injected; nothing is deleted here.
- **`src/consent-notice.ts`** (C1 / **DPDP Act 2023 s.5–6**) — is a consent notice complete?
  `checkConsentNotice` validates that a notice **itemises each data category with its purpose** (data with
  no stated *why* is a defect) and carries, in the notice, the three ways out the Act requires — **withdraw**,
  **grievance** redressal, and complaining to the **Data Protection Board** — with **withdrawal no harder
  than giving** (s.6(6), the commonest dark pattern, checked as `withdrawSteps ≤ giveSteps`). Every gap is a
  named defect and it reports **all** at once, not just the first. Pure — it validates the notice it is handed.
- **`src/breach-notification.ts`** (C2 / **DPDP Act 2023 s.8(6)**) — a personal-data breach becomes the
  notification **workflow** the law requires. `assessBreachNotification` turns a breach event into three
  obligations: the Data Protection Board's **immediate intimation**, its **72-hour detailed report** (deadline
  = `discoveredAt` + 72 h, marked `overdue` once past), and the notice to **every affected person** — each
  with the prescribed content still missing (the field lists are named constants: a legal fact). It **drafts
  and tracks; a person sends** — every plan is `advisoryOnly: true` and there is no function that transmits a
  notice. Pure: the deadline comes from discovery, "now" is supplied. `InvalidBreachInputError` on bad input.
- **`src/child-data-guard.ts`** (C4 / **DPDP Act 2023 s.9**) — a **child** is anyone under 18.
  `assessChildDataProcessing` is a pure overlay on the consent regime: a child's data may be
  enrolled / marketed / profiled **only with the verifiable consent of a parent or guardian**
  (s.9(1)), and **behavioural tracking and advertising targeted at a child are prohibited
  outright** — parental consent **cannot cure** them (s.9(3)). Transactional / service messages
  are unrestricted (a child is still owed the message about what they bought). It **never guesses
  an adult**: with the age unproven a child-restricted activity is refused (`age_unverified`).
  `ageInYears` turns a date of birth into whole years (18 on the birthday, not the day before),
  returning "unknown" for a malformed date rather than a silent zero.

> Pure and deterministic. PII is minimized and compared via normalized values only. Tested in
> `tests/unit/customer.test.ts` (9), `tests/unit/customer-data-rights.test.ts` (12) and
> `tests/unit/customer-segments.test.ts` (15). Part of the repository layout in `CLAUDE.md`.
