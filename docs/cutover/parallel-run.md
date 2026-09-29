# The parallel run — operating old and new side by side (MG-10)

**Who this is for:** the owner (who writes the terms) and the one named person who reconciles every day.
**What it is:** the period when the shop trades on the old ERP and the new system at the same time, and
somebody compares the two every evening until they agree for enough days in a row. It is the last proof
before the cutover decision, and the most common place a migration fails — not for technical reasons, but
because nobody was given the job (risk R-05).

> **Nothing here starts before the owner's written GO for the parallel run.** The tools below record
> what people do; they do not decide anything on their own.

---

## 1. Before day one — the owner writes the terms (once)

The system will not compare a single day until this exists. With the owner's login:

```
PUT /v1/migration/parallel-run/policy
{ "cutoverId": "cut-2026-11", "dailyReconcilerUserId": "<login of the ONE person who reconciles daily>",
  "requiredCleanDays": 3, "maxParallelDays": 14, "startedOn": "2026-11-03" }
```

| Term | What it means | Owner decision |
|---|---|---|
| `dailyReconcilerUserId` | The one person who compares both systems every evening. Only they (or the owner) can record a day; anyone else is refused **by name**. | **Name them** (R-05). |
| `requiredCleanDays` | How many days in a row must agree before a cutover may be decided (§34.1). A bad day resets the count. | 3 is the sensible start; a shop with a busy weekend may want its run to span one. |
| `maxParallelDays` | How long the run may last before it is escalated to you. Overrun is **reported on every read**, never hidden; it does not stop recording. | Pick a number of days, then decide at that point: cut over, roll back, or extend in writing. |
| `startedOn` | The first business date compared. Days before it are refused. | The day after the load and delta. |

A later PUT is a new, dated fact (the newest applies); the old terms stay in the ledger.

## 2. Every evening — the reconciler records the day

Read both systems' figures for the day into the six areas and send them; the **engine** decides what is a
difference (each area has its own tolerance — rounding differs between systems, fraud does not):

```
POST /v1/migration/parallel-run/days/2026-11-03
{ "comparisons": [
  { "area": "sales_value",    "legacyValue": 412000000, "newValue": 412000000, "toleranceMinor": 500 },
  { "area": "sales_count",    "legacyValue": 1840,      "newValue": 1840,      "toleranceMinor": 0 },
  { "area": "stock_movement", "legacyValue": 8120,      "newValue": 8120,      "toleranceMinor": 0 },
  { "area": "tax",            "legacyValue": 20600000,  "newValue": 20600400,  "toleranceMinor": 100 },
  { "area": "payments",       "legacyValue": 412000000, "newValue": 412000000, "toleranceMinor": 500 },
  { "area": "loyalty",        "legacyValue": 58200,     "newValue": 58200,     "toleranceMinor": 0 } ] }
```

Money is in paise. A clean day is one where every area is within tolerance — nobody can post "clean".
Every difference becomes an **open item with an id** (e.g. `PD-2026-11-03-001`) that needs an owner
*today*, because by day five nobody can tell a new fault from an old one.

## 3. Differences — a name first, then a real explanation

```
POST /v1/migration/parallel-run/differences/PD-2026-11-03-001/own
{ "explanation": "a cash refund was keyed twice at the old till by the evening cashier", "wrongSide": "legacy" }
```

Send it without an explanation to put your name on it now and explain later. **Refused:** "the new
system is probably right", "legacy is wrong", "took the newer figure" — that is last-write-wins wearing a
sentence (hard rule #10), and the stock error it hides surfaces at a count six weeks later. Say *why* the
two differ and which side was wrong (`legacy` / `new` / `both` / `neither`). A resolved difference stays
resolved; a second decision on it is refused.

## 4. Where the run stands, and the sheet to sign

- `GET /v1/migration/parallel-run` — days run, consecutive clean days, open and unowned differences, value
  still at stake, whether the run is **sufficient** for a cutover, and whether it is **overdue**.
- `GET /v1/migration/parallel-run/sheet` — the printable daily reconciliation sheet: one section per day
  with both systems' figures, every difference with its owner and explanation, and a line to sign.
  Print it, sign it, file it with the day's till reports.

## 5. If it has to stop — rollback

```
POST /v1/migration/cutover/rollback
{ "cutoverId": "cut-2026-11", "trigger": "owner_decision", "legacySystemAvailable": true }
```

Triggers: `control_total_failed`, `edge_cannot_trade`, `data_corruption`, `owner_decision`,
`time_window_exceeded`. The shop keeps trading either way (P-01); every piece of migration evidence is
retained (hard rule #6); and the recorded rollback is what the cutover checklist reads as "rollback
demonstrated" — a rollback that was only designed leaves that check failing, deliberately.

## 6. What the cutover decision now reads by itself

`POST /v1/migration/cutover/decision` takes the parallel-run position and the latest performed rollback
**from the ledger** when the caller does not supply them. Two of the eight checks that used to rest on
typed-in fields now rest on recorded facts. Absent is still never a pass.

## What is still the owner's to give (not the software's)

1. The **name** of the daily reconciler, and funded cover for them (R-05).
2. The **numbers**: required clean days and the maximum duration.
3. The **incident owner** for the run (gate G1).
4. The written **GO** for the parallel run itself, separate from the Option 2 GO for the data load.
