// Public surface of @sre/stock — stock states and availability (M08-FR-02) and the
// stock-health metrics: ageing, turns, GMROI and stockouts (M08-FR-04). Positions
// are always projected from movements; nothing is stored to drift.

export * from './position';
export * from './metrics';
export * from './valuation';
export * from './ageing-source';
