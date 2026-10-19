# `packages/epr/`

Extended producer responsibility — roadmap gaps **B20, B21, B22** (R4), owner decision OB-212 ("not sure, build the
registers"). Pure and deterministic. **Registers and yearly figures only: nothing is filed on the CPCB portal** — what to
register or file is the CA's or an EPR consultant's answer.

- `plasticReturn` (B20) — a financial year's plastic put on the market by the shop's own brand, per packaging category
  (I–IV), to the gram, from the units received and produced; a sortable CSV for manual upload. An own-brand product
  without a packaging declaration is an exception ("packaging declaration missing"), never counted as zero.
- `eprSettingStatuses` — the plastic EPR registration number and any exemption, and the e-waste / battery brand-owner
  answers: each "not confirmed" until it has an answer and who confirmed it.
- `registeredRecycler` (B21/B22) — a handover goes only to a recycler with a recorded registration number ("recycler not
  registered").
- `assertTakeBackLeavesOnlyToARecycler` — take-back stock is never saleable ("not saleable: take-back stock").
- `takeBackStock` / `takeBackStockExceptions` — taken back less handed over; a count that differs is an exception.
- `disposedAssetExceptions` — a disposed fixed asset with no e-waste handover is an exception.

The register's routes are `services/compliance/src/epr-store.ts`; the page is `apps/web-erp/web/epr.html`.
