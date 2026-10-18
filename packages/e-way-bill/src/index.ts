// Public surface of @sre/e-way-bill — GST e-way bills (A23, CGST Rules 2017 Rule 138): the threshold
// eligibility decision (inter-State ₹50k, intra-TN ₹1L), the canonical Part-A request build, validity by
// distance, the never-fabricate handling of the portal's answer (an unknown response is a first-class
// state), 24-hour cancellation, the lifecycle fold, and a deterministic sandbox portal provider.

export * from './e-way-bill';
export * from './sandbox-ewb';
// R3 · A23 remainder: the gate on a dispatch — above the threshold, only with a generated e-way bill.
export * from './dispatch-check';
