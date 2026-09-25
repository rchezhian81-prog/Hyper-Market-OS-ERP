# Known-limitations register (pilot RC)

_Release candidate `pilot-rc-1` (commit `c45b948`). Non-production pilot only. Honest boundaries of what the
baseline does and does not do — none is trading-blocking for a test-mode pilot._

| # | Limitation | Impact in pilot | Gate to clear it |
|---|---|---|---|
| KL-01 | **Login uses the local/test IdP**, not a production identity provider | staff/portal login works with test credentials; not real SSO | OA-4 / EX-03 (select IdP, provision `IDP_*`) |
| KL-02 | **Tender is test-mode**; no real card/UPI money moves | receipts and reconciliation flow, but no real settlement | EX-03 payment provider (⏳ started) |
| KL-03 | **GST / e-invoice / e-way-bill are sandbox** | returns prepared and sandbox-approved; nothing filed with the government | EX-07 GST/GSP credentials + CA (⏳ started) |
| KL-04 | **Notifications (SMS/WhatsApp/email) are mocked** | messages queue + dead-letter against a mock transport; nothing sent to real customers | EX-04 / EX-05 providers |
| KL-05 | **Company-wide reports proven on synthetic multi-branch data** | the pilot is one store; cross-branch roll-up is real code on synthetic fixtures | UAT once a second branch exists |
| KL-06 | **"Delete my data" runs against a simulated PII holding**, and is **development-approved, not a compliance claim** | the full governed workflow works end-to-end in simulation | **legal confirmation** + register real domain-store erasure sources + real processor delivery |
| KL-07 | **AI agents advisory-only, live model deferred** | agents run against a deterministic simulator with a kill switch; no autonomous commits (hard rule #5) | EX-12 model gateway (post-pilot gate) |
| KL-08 | **Browser till commit needs the edge reachable on loopback** | the containerised `edge`'s private loopback does not yet serve a browser till on the same box; the cross-origin commit fix is proven (`till-commits-cross-origin.e2e.ts`) | the one-PC deployable edge packaging increment |
| KL-09 | **Real legacy-data migration not performed** | migration tooling + reconciliation proven on synthetic/rehearsal data only; `MIGRATION_TARGET_KIND=rehearsal` | owner cutover GO + EX-02 self-extraction evidence |
| KL-10 | **Store hardware not yet attached** | scanners/printers/scales/drawers behind ports; ESC/POS implemented and tested, not wired to physical devices | EX-09 hardware (⏳ started) |
| KL-11 | **Cloud hosting not provisioned** | everything runs on Docker Compose locally; DB behind a `SqlClient` port | EX-01 / OA-5 hosting + spend |
| KL-12 | **Delivery needs store map coordinates** to switch on | slot engine built + tested; delivery fail-safe OFF until lat/long given | OA-11 (owner provides coordinates) |
| KL-13 | **2 moderate dependency advisories** (below the `--audit-level=high` CI gate) | no high/critical vulnerabilities; audit gate passes | monitor; upgrade when a non-breaking fix ships |
| KL-14 | **Independent penetration test not yet done** | internal threat model, guardrails and security tests in place | EX-13 pen test (⏳ started) before customer launch |

## Not limitations (deliberate design)

- Offline-first is a **property**, not a gap: the store trades with no internet/cloud (P-01, hard rule #1).
- Provider-neutrality (ports/adapters) is deliberate: swapping any vendor is a config + adapter change,
  never a rewrite (OD-09, NFR-12).
- The pilot runs **in parallel** with the legacy system; the legacy system is **not** retired (rollback safety).
