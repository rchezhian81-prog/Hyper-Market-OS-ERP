// Public surface of @sre/merchandising — M04: per-store assortment and range review
// (FR-01), shelf mapping that sequences the picker's route (FR-02), planogram
// compliance and replenishment tasks (FR-03), and display-space contracts with
// space productivity (FR-04).

export * from './assortment';
export * from './shelf';
export * from './shelf-count';
export * from './space';
// OB-288 P2: the floor plan and its heat map (M04-FR-04 · OB-308), store clusters and season plans (D02-FR-02 · OB-318),
// and range gaps with private-label margin (D02-FR-04 · OB-319).
export * from './floor-plan';
export * from './clusters';
export * from './range-gaps';
