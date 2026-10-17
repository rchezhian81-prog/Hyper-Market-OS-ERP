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

A limit that is missing any of the three is **pending**. A pending limit is **not checked**, and the
system says so. It never guesses a value or fills in a default.

Owner decision OB-155 (16 Oct 2026): while limits are pending, a roster **may be published**. The
publication, the roster that staff see and the statutory registers name exactly which limits were not
checked. A limit that is filled in is enforced. Under OB-152, a roster that breaks a filled limit is refused.

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

**The roster week is not a setting: it always runs Monday to Sunday** (owner decisions OB-179 "A" and OB-181 "A",
"Lock to Monday", 17 Oct 2026). Rosters are checked and published only for weeks starting on a Monday; any other
`weekStart` is refused with 400 `not_the_shops_roster_week`, which names the Monday to use. The weekly holiday and the
weekly hours cap are judged per Monday–Sunday week, and a shift is shown to staff only while its own week's
publication stands. The `roster-week-start` setting that existed briefly (between OB-179 and OB-181) is removed: a
request to change it is refused with 404 `no_such_working_time_setting` and saves nothing. A change recorded while it
existed stays on the record (nothing is deleted) and is never applied.

While `minRestIntervalMinutes` is pending (OB-155), the check treats shifts **less than 15 minutes apart** as one
stretch of work for the daily hours cap and the spread-over (verifier r2final L2). This is not a legal figure. It only
makes the check stricter until the real rest interval is filled in, and every publication made meanwhile says so.

## C18 leave types (all pending, OB-156)

Owner decision OB-156 (16 Oct 2026): casual, sick, festival and unpaid leave are added beside annual leave.
Each one is a setting with four parts:

1. **days a year**: the most days of that leave a person may take in a leave year;
2. **carry-over**: the most unused days that move into the next leave year (0 means none);
3. **the source**: the section of the Act;
4. **the confirmation**: who confirmed it and their reference.

The owner sets each type with `POST /v1/hr/compliance/working-time/settings/leave-<type>`, sending
`{ daysPerYear, carryOverMaxDays, source, confirmation }`.

| Setting key | Leave type | Days a year | Carry-over (most days) | Source (section of the Act) | Confirmed by |
|---|---|---|---|---|---|
| `leave-casual` | Casual leave | **pending** | **pending** | **pending** | **pending** |
| `leave-sick` | Sick leave | **pending** | **pending** | **pending** | **pending** |
| `leave-festival` | Festival leave | **pending** | **pending** | **pending** | **pending** |
| `leave-unpaid` | Unpaid leave | **pending** | **pending** | **pending** | **pending** |

Until a type is filled in, a day of that leave is still recorded, but it is shown as **not checked**. The
leave register lists every type that is not checked. Once a type is filled in, a day beyond the days a
year (plus any carry-over) is refused. A day can hold only one leave. To change the kind of leave on a
day, the first one is cancelled. The cancellation is a new record; the first record is kept.

## C18: what the software does with them

- **Publishing a roster** (`POST /v1/hr/compliance/roster-publications/:id`, for one branch and one week)
  checks every person on that week's roster against every limit that is filled in:
  - daily hours;
  - weekly hours;
  - spread-over;
  - continuous work before a rest interval;
  - days off in the week.

  A person's hours count every shift they hold that week, at any branch. A person marked inactive who
  still holds shifts is checked too.
- **Work is judged as one timeline, not day by day.**
  - Shifts that touch, or that have a gap shorter than the rest interval, are one stretch of work. This
    holds across midnight. A stretch is used for the rest-interval rule, for spread-over and for daily
    hours, and it is dated by the day it starts.
  - **Daily hours are judged per stretch of work, not per calendar day** (OB-168, owner, 16 Oct 2026). A
    stretch counts in full on the day it starts; it is not cut at midnight. A 10-hour night shift is 10 hours
    against the daily cap, not 5 hours on each day. All the stretches that start on one day are added
    together for that day (the same grouping spread-over uses), so a split day of 8:00–13:00 and 14:00–19:00
    is still 10 hours. A night stretch that started the day before the week is judged on that day.
  - Weekly hours still count the minutes worked inside the week, by calendar day in the store's time (IST),
    split at midnight.
  - A day counts as a weekly holiday only if no minute of work falls on it. The end of an overnight shift is
    work on the day it runs into. A shift from the previous week that runs into this week counts.
- **If the roster breaks a limit that is filled in**, it is **refused**. Every breach is named in words:
  the person, the day, what the roster says and what the limit is. C18 says "enforced", and the owner
  decided (OB-152) that a breach is refused, not approved.
- **Staff see only a published week** (OB-166). `GET /v1/hr/workforce/my-roster` shows a person only the
  shifts of a week that is published now. A week that is not published yet is held back. The screen says
  how many shifts are waiting.
- **Any edit after publishing returns the week to "needs publishing"** (OB-166). The publication records a
  fingerprint of the exact roster it checked: the branch's shifts that week, the people on them, their
  staff records, and every shift those people hold near that week at any branch. Any change to these
  makes the week "needs publishing". Examples: a shift moved, a shift added, a person added, or a person
  marked inactive. Staff stop seeing the week until it is checked and published again. If an edit is
  undone exactly, the roster is again the one that was checked, and the week shows as published.
  `GET /v1/hr/compliance/roster-publications` shows each week as published or needs publishing.
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
- **The register makes every complaint id and step id itself.** The ids are opaque codes such as
  `PC-…` and `PS-…`. A caller can never choose an id, so an id can never carry a name.
- **The general audit trail does not show the committee's activity.** The owner and the accountant can
  search and rebuild the shop's audit trail, but the committee's entries are left out. Rebuilding one
  is refused, and the evidence pack leaves them out. The check of the whole trail still covers every
  record. Only the committee sees its own entries, through its access log.
- **The words of a complaint are locked.** These are the summary, who complained, who it is about, and
  the committee's notes. They are encrypted under that complaint's own key before they are stored. The
  database and every backup hold only the locked form. The reply to the committee's form carries only
  the id and the status, and so does the copy of the reply the system keeps. A whole-shop export done by
  IT keeps them locked too. The committee reads them through its own screens.
- **Adding or removing a committee member** (owner decision OB-165): the owner does it, for the Internal
  Committee role only. A second person confirms through the approvals inbox. Today that person is the
  store manager. The change is on the audit trail. The owner can never hold the committee role, and a
  committee member is never given the owner role. This holds in every place a role can be given.
- The annual report carries **counts only**: no names, no references, no summaries. The owner can read the
  report and records it as filed with the District Officer.
- From 1 January until the report is recorded as filed, the owner sees a **due by 31 January**
  exception. After 31 January it shows as **overdue**. A year with no complaints still owes its report.
- **The owner's screen** (owner decision OB-154): "Committee annual report" in the head office web ERP
  shows each ended year as due, overdue or filed, with its counts only. The owner records the filing
  there, with the date and the District Officer's acknowledgement. It never shows a complaint.

## Still to be confirmed by the owner or the CA

1. Every C18 value in the tables above, with its section of the Act. This includes the four leave types.
   The software takes the leave year as the calendar year (January to December). This is to be confirmed.
2. The declared public and festival holiday list for each year.
3. The prescribed form numbers and layout for the attendance, leave and holiday registers under the Act's
   rules.
4. Which calendar year a 31 January POSH report covers. The software takes it as the year just ended.
5. The prescribed contents of the POSH annual report under Rule 14. The software reports complaints
   pending at the start of the year, received, disposed of (by outcome) and pending at the end of the year.
