# HR compliance settings: working time (C18) and the Internal Committee register (C20)

Requirement IDs: **C18** and **C20** in `docs/roadmap/roadmap-v2.1-addendum.md` (section 1.3).

## Where the figures come from

The repository's requirements name the laws but give **no figures**:

| Item | What the repository says | Where |
|---|---|---|
| C18 | "TN Shops & Establishments pack: registration, weekly-holiday, spread-over cap, annual leave accrual, statutory registers". The law is the Tamil Nadu Shops and Establishments Act 1947. | `docs/requirements/WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md`, row C18; `docs/roadmap/roadmap-v2.1-addendum.md`, row C18 |
| C20 | "POSH: Internal Committee (>10 staff), confidential complaints register, annual report to District Officer by 31 Jan". The law is the POSH Act 2013, s.4, s.21 + Rule 14, s.26. | `docs/requirements/WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md`, row C20; `docs/roadmap/roadmap-v2.1-addendum.md`, row C20 |

So the software does **not** contain any legal number for C18. Every limit is a setting with three parts:

1. **the value**,
2. **the source**: the section of the Act it comes from,
3. **the confirmation**: who confirmed it (the owner or the CA) and their reference.

A limit that is missing any of the three is **pending**. While any roster limit is pending, a roster
**cannot be published**. The system says which limit is missing and what it still needs. It never guesses
a value or fills in a default.

## C18 working-time settings (all pending)

Set with `POST /v1/hr/compliance/working-time/settings/:key` (owner only). Read with
`GET /v1/hr/compliance/working-time/settings`.

| Setting key | What it means | Unit | Value | Source (section of the Act) | Confirmed by |
|---|---|---|---|---|---|
| `weeklyHolidayMinDays` | Whole days off each person must have in every week | days | **pending** | **pending** | **pending** |
| `maxDailyWorkMinutes` | Most a person may be rostered to work in one day | minutes | **pending** | **pending** | **pending** |
| `maxWeeklyWorkMinutes` | Most a person may be rostered to work in one week | minutes | **pending** | **pending** | **pending** |
| `maxSpreadOverMinutes` | Longest span from a person's first start to last finish in one day | minutes | **pending** | **pending** | **pending** |
| `maxContinuousWorkMinutes` | Longest a person may work before a rest interval | minutes | **pending** | **pending** | **pending** |
| `minRestIntervalMinutes` | Shortest break that counts as a rest interval | minutes | **pending** | **pending** | **pending** |
| `annualLeaveDaysWorkedPerDayEarned` | Days worked that earn one day of annual leave | days worked | **pending** | **pending** | **pending** |
| `public-holidays` | The declared public and festival holidays the holiday register reports against | list of dates | **pending** | **pending** | **pending** |
| `utc-offset` | The store's clock offset from UTC. This is a fact about the clock, not a legal limit. | minutes | 330 (India Standard Time) | not a legal figure | not needed |

## C18: what the software does with them

- **Publishing a roster** (`POST /v1/hr/compliance/roster-publications/:id`, for one branch and one week)
  checks every person on that week's roster against every limit:
  - daily hours;
  - weekly hours;
  - spread-over;
  - continuous work before a rest interval;
  - days off in the week.

  A person's hours count every shift they hold that week, at any branch.
- **If the roster breaks a limit**, it is **refused**. Every breach is named in words: the person, the day,
  what the roster says and what the limit is. C18 says "enforced" and names no approver, so no breach can
  be signed off.
- **A dry run** (`GET /v1/hr/compliance/roster-check`) shows what publishing would find, without changing
  anything.
- **Annual leave**: leave is earned from days worked (a day with hours recorded). Taking leave beyond the
  earned balance is refused once the accrual rate is in force. A cancellation is a new, compensating
  record; the earlier record is kept.
- **The statutory registers are produced** from the stored roster, attendance and leave records:
  - attendance: `GET /v1/hr/compliance/registers/attendance`;
  - leave: `GET /v1/hr/compliance/registers/leave`;
  - holidays: `GET /v1/hr/compliance/registers/holidays`.

  A rostered day with no attendance recorded shows as "not recorded". It is never assumed.

## C20: what the software does

- The complaints register is readable and writable **only** by the `internal_committee` role. The owner,
  store managers and IT cannot read it.
- **Every read and every write is sealed into the tamper-evident audit trail before the answer is given.**
  `GET /v1/hr/posh/access-log` shows the committee who looked at the register and when.
- Records are append-only. A complaint is received once, and each later stage is a new step. Nothing can
  be edited or deleted.
- The annual report carries **counts only**: no names, no references, no summaries. The owner can read the
  report and records it as filed with the District Officer.
- From 1 January until the report is recorded as filed, the owner sees a **due by 31 January**
  exception. After 31 January it shows as **overdue**. A year with no complaints still owes its report.

## Still to be confirmed by the owner or the CA

1. Every C18 value in the table above, with its section of the Act.
2. The declared public and festival holiday list for each year.
3. The prescribed form numbers and layout for the attendance, leave and holiday registers under the Act's
   rules.
4. Which calendar year a 31 January POSH report covers. The software takes it as the year just ended.
5. The prescribed contents of the POSH annual report under Rule 14. The software reports complaints
   pending at the start of the year, received, disposed of (by outcome) and pending at the end of the year.
