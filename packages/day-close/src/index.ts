// Public surface of @sre/day-close — the store/day close and controlled reopen
// (M14-FR-04): lock the day only once the trading-day cut-off has passed and the
// day is fully reconciled (no open exceptions, no unsent items); reopen needs a
// separate approver. Grows one reviewed, tested unit at a time.

export * from './day-close';
