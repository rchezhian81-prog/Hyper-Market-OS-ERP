# `packages/finance/`

Finance / accounting bridge — **M23-FR-01** (ledger mapping → journals) and **M23-FR-02**
(GST posted as a mapped component). Make the money reconcile so a **CA can sign the control
totals** (QG-07).

- **`src/posting.ts`**
  - `postJournal(input, map)` — turns one operational transaction into a **balanced
    double-entry journal** using a configurable `PostingMap` (the chart of accounts — choose-able
    per tenant). Posting is **deterministic from the mapping**; legs post in rule order. GST is
    just a mapped `tax` component posted to the GST-output account.
  - Refuses anything wrong, **never silently unposted** (P-08): `UnmappedKindError` for an
    unmapped kind, `MissingComponentError` if a leg's amount was not supplied, and
    `UnbalancedJournalError` if the legs do not balance (debits ≠ credits). Zero-amount legs
    (e.g. tax on an exempt sale) are omitted.
  - `postBatch(inputs, map)` — posts many, returning the entries **and** the failures as
    **visible exceptions** (never dropped) for review.
  - Finance only **reads** operational data and posts — it never edits the immutable
    operational ledger (§28); corrections are new journals.

- **`src/gstr1.ts`** — the **GSTR-1 return** (roadmap v2.1 **A5**): `gstr1Table12` (the HSN-wise
  summary of outward supplies, B2B/B2C split), `gstr1Return` (B2B invoice-level + B2C rate-wise +
  the HSN summary), and `toGstnGstr1` (the GSTN portal JSON — paise→rupees, `YYYY-MM-DD`→`DD-MM-YYYY`).
  The HSN comes from a **closed master, never free text** (`validateOutwardLine` rejects a typed-in
  or malformed HSN), and tax facts are folded from stored outward-supply lines, not re-derived.
- **`src/outward-from-sales.ts`** — **GSTR-1 from the store's own banked till sales** (A5, M23·M12).
  A hypermarket's real outward supplies are the thousands of **B2C counter sales** the till already
  banks, and nobody re-keys each one as an outward-supply document. `salesToOutwardSupplies` turns
  banked sale lines **into** the return:
  - A banked sale line carries only what the till charged — the **MRP-inclusive line total** — not
    the HSN or the tax split. So the derivation needs a **product→{HSN, rate} table**. That table
    **defaults from the published catalogue** (the M03 master's persisted form — the snapshot now carries
    each product's `hsnCode` alongside its rate), so the return builds **with nothing to key by hand**; a
    caller-supplied table **overrides** it per product (an exception the filer is handling).
  - **Frozen-at-supply (mid-period rate change):** a sold line may carry its **own** `hsnCode`/`rateBps`
    — the tax facts captured **at the time of supply**. The offline till now **stamps them onto every sale
    line at commit** (read off the pack it priced from — a record only, never a control, so it adds no
    network call and can never refuse a sale, hard rule #1); an import of historical sales can set them too.
    When present, those win over the period table, so a product whose GST rate changed **mid-period** files
    each sale under the rate that actually applied when it sold (the two rates stay as separate HSN/rate
    rows, never blended). `frozenLineCount` reports how many lines used them.
  - From there it is the tested `extractInclusiveGst` primitive — the GST is pulled **back out** of
    each inclusive total (A9), split by place of supply (A8; a counter sale is intra-State CGST+SGST),
    and aggregated by `gstr1Table12`. A product that sold but is **not** in the table, or whose HSN is
    malformed, is returned in `unmapped` (aggregated per product) — **counted and named, never silently
    off the return** (P-08 / hard rule #10).
  - **Returns netted (CGST s.34)** — `netTable12(sales, returns)`: a GSTR-1 for B2C reports outward
    supplies **net of the credit notes** for returns issued in the period. A returned line is just an
    outward supply reversed, so `salesToOutwardSupplies` builds BOTH the sales and the returns Table-12
    (the returned lines reverse the tax at the rate they were **sold**, off the original sale's frozen
    facts), and this nets them per HSN/rate — `sales − returns` filed. A return whose original sale is not
    on file, or a line whose original carried no HSN, surfaces as `unmapped` on the returns side, never
    dropped. The route returns `table12` (sales), `returns`, and `net`.
  - **The GSTN portal file** — `toGstnB2cFromSales(net, {gstin, fp})`: serialises the netted B2C return
    into the **GSTN GSTR-1 JSON the government portal ingests** — `b2cs` (net rate-wise) and `hsn.data`
    (net HSN summary), money paise→rupees. Supplying `gstin`+`fp` on the route returns it as `gstn`; a net
    line may be negative where returns exceeded sales (the filer reviews it against the portal's amendment
    rules — the same owner check the document-path export carries). This turns the whole sales+returns fold
    into an **uploadable filing**, built from real store activity.
  - Pure and deterministic. Wired end-to-end (a read-only fold of the banked sales + returns streams —
    hard rule #1 untouched) at `POST /v1/finance/gstr1/from-sales/table-12`. Tested in
    `tests/unit/finance-outward-from-sales.test.ts` and `tests/integration/gstr1-from-sales.test.ts`.

## GSTR-1 submission safety (`src/gstr1-submission.ts`, WP4 inc1)

Producing the GSTR-1 JSON is one thing; **filing it to the government portal** is irreversible and
legally binding, so the act of submission is wrapped in a spine of controls. This module is the
deterministic, event-sourced **state machine** that governs that act — no clock, no I/O, no network (the
live portal call itself stays off-by-default and killable via `packages/e-invoice/src/portal-switch.ts`).

Lifecycle: **previewed → approved → submitting → filed**, plus **failed** and **unknown**.

- `foldGstr1Submission(period, events)` folds the append-only history to the current state, and is
  **replay-safe**: an event that does not fit the current state is ignored (a re-posted acknowledgement on
  a filed return, an approval before a preview), so a duplicate or out-of-order delivery cannot corrupt
  state.
- `evaluateGstr1SubmissionTransition(input)` enforces the safety controls before any step:
  - **maker ≠ checker** — the approver of the previewed figures must differ from the preparer (§28);
  - **duplicate-submission prevention** — a `filed` or in-flight `submitting` period refuses a new submit
    *or* preview (a return is never filed twice);
  - **preview-and-reconcile-before-commit** with a **digest match** — `submit` is refused unless the
    figures still equal the digest that was approved, so nothing changes silently between approval and
    filing; once approved the period is **locked** to that digest;
  - an **unknown** outcome (timeout/outage) routes to **reconciliation**, never straight to filed;
  - **reconcile needs evidence** — a stuck return is resolved to filed/failed by a recorded operator fact
    and note, never a silent rewrite.
- `classifyGstnError(code)` maps a raw portal code to a recovery class (`auth` / `validation` /
  `duplicate` / `rate_limit` / `timeout` / `portal_outage` / `unknown`) an operator runbook keys off —
  conservative, so an unrecognised code is `unknown` (investigate), never assumed retryable.

Pure and deterministic. **No live submission happens here** — this is the safety core. Tested in
`tests/unit/gstr1-submission.test.ts` (12).

### Wired durably + a sandbox portal (WP4 inc2)

The engine is now on the live surface. `services/api/src/adapters.ts` `gstr1SubmissionAdapter` appends each
lifecycle step to the shared append-only `event_ledger` (one stream per filing period) and folds it with
`foldGstr1Submission`, so a submission **survives a restart**. `services/finance/src/gstr1-submission-store.ts`
hosts the routes — `POST /v1/finance/gstr1/submission/:period/{preview,approve,submit,record-response}` and
`GET …/:period` — and every transition is checked against the **stored** state before the append, so
**maker ≠ checker, duplicate-prevention, digest-match and period-lock hold at the write boundary**.
Maker-checker is also **RBAC-separated**: preview needs `finance.gstr.generate` (a store manager can
prepare), approve needs the new `finance.gstr.approve`, submit the new `finance.gstr.submit` (owner-held).

The **live path stays off by default and killable**: a `live:true` submit calls
`requireGstPortalLive(controls, 'gst_return')` (a new portal-switch channel) → refused while
disabled/killed, and refused as not-yet-wired even when the gate is open (no certified connector exists).
Otherwise the deterministic **sandbox GSTN provider** (`src/gstn-sandbox.ts`) runs — a provider-neutral
`GstnReturnProvider` a real GSP will share, returning a `SANDBOX-`-prefixed, **non-fileable** ARN, with real
duplicate detection and forced failed/unknown outcomes for testing. The **async/webhook path** is covered
too (`submit {async:true}` → `submitting`, then `record-response` applies the portal's answer; an unknown
outcome routes to reconciliation, never straight to filed). Tested in `tests/unit/gstn-sandbox.test.ts` (3)
and `tests/integration/gstr1-submission.test.ts`. Live filing stays externally blocked pending CA/legal
sign-off, production credentials and owner GO.

### Reconciliation + the exception queue (WP4 inc3)

The submission can get stuck — a portal timeout leaves it `unknown`, a rejection leaves it `failed` — so
inc3 gives operators the tools to resolve those safely, plus a `cancelled` state to withdraw a return
before filing (a filed return is corrected by an amendment in a later period, never cancelled). The queue
vocabulary is `queueCategory(state)` → pending/processing/success/failed/cancelled/unknown, and
`isSubmissionException(state)` flags the two that need attention (failed + unknown). Routes:

- `POST …/:period/reconcile` — an operator resolves a stuck **unknown** to filed or failed **with
  evidence**: the resolution is a recorded `reconciled` fact (who, the note, the time), never a silent
  rewrite; refused unless the outcome is unknown, and refused without a note.
- `POST …/:period/poll` — re-queries the portal for a `submitting` or `unknown` submission and applies the
  answer, so a **lost acknowledgement is recovered** without manual entry. Safe to repeat — a terminal
  submission is a no-op.
- `POST …/:period/cancel` (gated `finance.gstr.approve`) — withdraw a not-yet-filed return with a reason.
- `GET /v1/finance/gstr1/submissions?state=` — the **exception queue**: every period's submission and its
  operator status, filterable by queue category or `exceptions` (failed + unknown). It folds a tenant-wide
  period index (`gstr1SubmissionAdapter` writes a `Gstr1SubmissionIndexed` fact on first preview) so the
  queue is cheap. Tenant-isolated, read-gated, and (like everything here) restart/replay-safe.

Tested in `tests/unit/gstr1-submission.test.ts` and `tests/integration/gstr1-submission.test.ts`. This
completes owner-directive **item 1** (GST return submission safety); live filing stays externally blocked
pending CA/legal sign-off, production credentials and owner GO.

> Example sale rule: Dr `cash` [total], Cr `sales_revenue` [net], Cr `gst_output` [tax] —
> `postJournal` checks it balances. Pure and deterministic; composes the `Money` primitive.
> Tested in `tests/unit/finance-posting.test.ts`. Part of the repository layout in `CLAUDE.md`.
