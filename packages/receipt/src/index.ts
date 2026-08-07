// Public surface of @sre/receipt — the receipt document (M31-FR-02), its thermal
// text rendering, ESC/POS encoding and the printer port. Pure and synchronous, so a
// receipt builds and prints on an offline lane (hard rule #1) and a printer failure
// never costs the sale.

export * from './receipt';
export * from './escpos';
