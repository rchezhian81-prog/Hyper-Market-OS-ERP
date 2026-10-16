// Public surface of @sre/restricted-sales — the till-side "cannot-sell" gates. Age-restricted goods
// (B14 / COTPA 2003): a hard age-18 gate and a block on loose single-stick tobacco sales. Single-use
// plastic (B19 / Plastic Waste Management Rules): the banned-SUP block, the 120 µm carry-bag minimum,
// and the separate-priced-line rule.

export * from './restricted-sales';
export * from './single-use-plastic';
// The same rules on one till line, from the signed packs — the scan, the commit and the store computer (B6 · B14 · B19).
export * from './till-gate';
