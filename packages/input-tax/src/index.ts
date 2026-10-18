// Public surface of @sre/input-tax — input tax credit through GSTR-2B and the Invoice Management System (R3 · A17): the
// portal's 2B JSON read line by line, the match against the shop's three-way-matched supplier invoices, each line's
// accept / reject / pending as a named person's act, the reversals as compensating records, and the month's claim for
// GSTR-3B Table 4 (`makeItcForPeriod`, the port the GST returns read).

export * from './gstr2b';
