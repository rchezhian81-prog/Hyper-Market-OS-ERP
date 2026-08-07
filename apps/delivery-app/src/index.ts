// Public surface of the delivery app (M19 / M18 / D09) — the driver's route
// session: assigned stops cached offline, proof-gated delivery, COD to the paisa
// with end-of-shift settlement, failures routed to reattempt/RTO, and contribution
// stop rules surfaced. Synchronous and local, so it works with no signal.

export * from './route-session';
