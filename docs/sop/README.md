# `docs/sop/`

Standard operating procedures written for staff who are not computer users: one printable page each, in English and
Tamil. Every sheet below exists in both languages, with the same numbered steps
(`tests/guardrails/the-owner-guide-and-sheets-hold-together.test.ts`).

| Id | Sheet | English | Tamil | Source |
|---|---|---|---|---|
| SOP-01 | The PC is down or the new till has stopped: old till only | `sop-01-pc-down.en.md` | `sop-01-pc-down.ta.md` | OB-255 |
| SOP-02 | Mirror keying for the pilot department | `sop-02-mirror-keying.en.md` | `sop-02-mirror-keying.ta.md` | OB-248, OB-252, OB-256, OB-258, OB-264, OB-266 |
| SOP-03 | The owner's evening check (parallel-run day) | `sop-03-owner-evening-check.en.md` | `sop-03-owner-evening-check.ta.md` | OB-254, MG-10, OB-259, OB-256, OB-264, OB-265 |
| SOP-04 | When a cashier forgets their PIN | `sop-04-forgotten-pin.en.md` | `sop-04-forgotten-pin.ta.md` | hard rule 4, ADR-0020 |

**Status, 20 Oct 2026:** written, not yet used in the store. **The pilot prints the English sheets (OB-261).** The Tamil
sheets are kept, each marked at its top "not yet checked by a Tamil reader"; they are read by a Tamil-speaking member of
staff before the pilot grows beyond the first department. SOP-02 has the real "Paid on old system" steps, the old bill
number step and the refund and exchange steps (OB-256, OB-258, OB-264, OB-266); no placeholder is left in any sheet
(`tests/guardrails/the-owner-guide-and-sheets-hold-together.test.ts` fails on one). SOP-03 needs the parallel-run terms
written once (`store-computer parallel-policy`, owner guide Part 23).

The owner's set-up and daily routine are in `docs/runbooks/store-computer-owner-guide-windows.md` (Parts 12–30).
