// Public surface of @sre/tally-export (WF-05 · M23-FR-04): balanced journals → one Tally-importable voucher file, and a
// stand-in for Tally's own import check. Shared by every lane that sends the books to Tally (payables now; the GL later).

export * from './tally-xml';
export * from './tally-validator';
