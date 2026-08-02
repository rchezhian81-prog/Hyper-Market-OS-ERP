# `packages/calendar/`

The business calendar — starting with the **trading-day rule (M01-FR-02)**: the trading day
runs from a configured cut-off to the next cut-off, applied consistently to day-close, shift
reports and GST periods (closes audit finding A-13).

- **`src/trading-day.ts`** — `tradingDate(localDateTime, rule)` returns the trading date a
  local wall-clock moment belongs to (a moment before the cut-off is dated to the previous
  day); `makeTradingDayRule("02:00")` builds a rule from an "HH:MM" cut-off. Pure and
  deterministic (the caller passes the moment; no reliance on "now"). Tested in
  `tests/unit/trading-day.test.ts`.

> The actual cut-off time is a store fact (questionnaire A1); this engine is ready for it —
> the store answer just configures the rule. Part of the repository layout in `CLAUDE.md`.
