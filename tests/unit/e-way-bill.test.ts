import { describe, it, expect } from 'vitest';
import {
  assessEwayBillRequirement,
  ewayBillValidity,
  buildEwayBillRequest,
  applyEwbResult,
  assessEwbCancellation,
  foldEwayBill,
  sandboxEwbProvider,
  sandboxEwbNumber,
  generateViaProvider,
  InvalidEwayBillInput,
  EWB_INTER_STATE_THRESHOLD_MINOR,
  EWB_INTRA_STATE_THRESHOLD_MINOR,
  type EwayBillRequest,
  type EwbEligibilityResult,
} from '../../packages/e-way-bill/src/index';

const REQUEST_FIELDS = {
  supplierGstin: '33ABCDE1234F1Z5',
  recipientGstin: '29ZZZZZ9999Z1Z5',
  documentType: 'INV' as const,
  documentNumber: 'INV/2627/000001',
  documentDate: '2026-08-12',
  hsnCode: '100610',
  consignmentValueMinor: 6_000_000, // ₹60,000
  supplyRoute: 'inter_state' as const,
  movementReason: 'supply' as const,
  fromPincode: '600001',
  toPincode: '560001',
};
const requiredInter: EwbEligibilityResult = { required: true, reason: 'required', thresholdMinor: EWB_INTER_STATE_THRESHOLD_MINOR, detail: '' };
const EWB12 = /^\d{12}$/;

describe('assessEwayBillRequirement — two thresholds that are NOT the same', () => {
  it('requires a bill above ₹50,000 inter-State', () => {
    expect(assessEwayBillRequirement({ consignmentValueMinor: EWB_INTER_STATE_THRESHOLD_MINOR + 1, supplyRoute: 'inter_state' }).required).toBe(true);
    expect(assessEwayBillRequirement({ consignmentValueMinor: EWB_INTER_STATE_THRESHOLD_MINOR, supplyRoute: 'inter_state' }).required).toBe(false);
  });

  it('requires a bill only above ₹1,00,000 intra-State (the TN floor)', () => {
    // ₹60,000 needs a bill inter-State but NOT intra-State.
    expect(assessEwayBillRequirement({ consignmentValueMinor: 6_000_000, supplyRoute: 'intra_state' }).required).toBe(false);
    expect(assessEwayBillRequirement({ consignmentValueMinor: EWB_INTRA_STATE_THRESHOLD_MINOR + 1, supplyRoute: 'intra_state' }).required).toBe(true);
  });

  it('exempt goods need no bill, and an unreadable value fails loud', () => {
    expect(assessEwayBillRequirement({ consignmentValueMinor: 9_999_999, supplyRoute: 'inter_state', exemptGoods: true }).reason).toBe('exempt_goods');
    expect(assessEwayBillRequirement({ consignmentValueMinor: -1, supplyRoute: 'inter_state' }).reason).toBe('unreadable_value');
  });
});

describe('ewayBillValidity — one day per 200 km (Rule 138(10))', () => {
  it('gives one day up to 200 km and adds a day per further 200 km', () => {
    expect(ewayBillValidity({ distanceKm: 100, generatedOn: '2026-08-12' }).validityDays).toBe(1);
    expect(ewayBillValidity({ distanceKm: 200, generatedOn: '2026-08-12' }).validityDays).toBe(1);
    expect(ewayBillValidity({ distanceKm: 201, generatedOn: '2026-08-12' }).validityDays).toBe(2);
    expect(ewayBillValidity({ distanceKm: 450, generatedOn: '2026-08-12' }).validityDays).toBe(3);
  });

  it('uses a 20 km slab for over-dimensional cargo', () => {
    expect(ewayBillValidity({ distanceKm: 20, generatedOn: '2026-08-12', overDimensional: true }).validityDays).toBe(1);
    expect(ewayBillValidity({ distanceKm: 21, generatedOn: '2026-08-12', overDimensional: true }).validityDays).toBe(2);
  });

  it('computes validUpto as the last valid day and rejects bad input', () => {
    expect(ewayBillValidity({ distanceKm: 100, generatedOn: '2026-08-12' }).validUpto).toBe('2026-08-12'); // 1 day
    expect(ewayBillValidity({ distanceKm: 300, generatedOn: '2026-08-12' }).validUpto).toBe('2026-08-13'); // 2 days
    expect(() => ewayBillValidity({ distanceKm: -5, generatedOn: '2026-08-12' })).toThrow(InvalidEwayBillInput);
    expect(() => ewayBillValidity({ distanceKm: 100, generatedOn: 'nope' })).toThrow(InvalidEwayBillInput);
  });
});

describe('buildEwayBillRequest', () => {
  it('builds a valid Part-A request with the FY and idempotency key', () => {
    const built = buildEwayBillRequest({ request: REQUEST_FIELDS, eligibility: requiredInter });
    expect(built.built).toBe(true);
    expect(built.request?.financialYear).toBe('2026-27');
    expect(built.idempotencyKey).toBe('33ABCDE1234F1Z5|INV|INV/2627/000001|2026-27');
  });

  it('does not build when a bill is not required', () => {
    const built = buildEwayBillRequest({ request: REQUEST_FIELDS, eligibility: { required: false, reason: 'below_threshold', thresholdMinor: EWB_INTER_STATE_THRESHOLD_MINOR, detail: 'x' } });
    expect(built.outcome).toBe('not_required');
  });

  it('refuses a malformed request, naming every problem', () => {
    const bad = buildEwayBillRequest({ request: { ...REQUEST_FIELDS, supplierGstin: 'nope', fromPincode: '12', hsnCode: 'ABC' }, eligibility: requiredInter });
    expect(bad.outcome).toBe('invalid_request');
    expect(bad.detail).toMatch(/GSTIN/);
    expect(bad.detail).toMatch(/pincode/);
    expect(bad.detail).toMatch(/HSN/);
  });
});

describe('applyEwbResult — never fabricate the portal number', () => {
  it('stores a generated bill with a 12-digit number', () => {
    const rec = applyEwbResult({ movementId: 'm1', result: { status: 'generated', ewbNo: '123456789012', ewbDate: '2026-08-12', validUpto: '2026-08-12' } });
    expect(rec.state).toBe('generated');
    expect(rec.ewbNo).toBe('123456789012');
  });

  it('refuses a malformed number as a provider_error, and keeps unknown as its own state', () => {
    expect(applyEwbResult({ movementId: 'm2', result: { status: 'generated', ewbNo: 'short', ewbDate: 'x', validUpto: 'x' } }).state).toBe('provider_error');
    expect(applyEwbResult({ movementId: 'm3', result: { status: 'unknown', reason: 'timeout' } }).state).toBe('pending_unknown');
    expect(applyEwbResult({ movementId: 'm4', result: { status: 'rejected', errors: ['bad'] } }).state).toBe('rejected');
  });
});

describe('assessEwbCancellation + foldEwayBill', () => {
  it('allows cancellation within 24h, and refuses it late or after in-transit verification', () => {
    expect(assessEwbCancellation({ generatedAt: '2026-08-12T09:00:00Z', at: '2026-08-12T20:00:00Z' }).cancellable).toBe(true);
    expect(assessEwbCancellation({ generatedAt: '2026-08-12T09:00:00Z', at: '2026-08-13T20:00:00Z' }).cancellable).toBe(false);
    expect(assessEwbCancellation({ generatedAt: '2026-08-12T09:00:00Z', at: '2026-08-12T10:00:00Z', verifiedInTransit: true }).cancellable).toBe(false);
  });

  it('folds submitted → generated (final) → cancelled', () => {
    const req = buildEwayBillRequest({ request: REQUEST_FIELDS, eligibility: requiredInter }).request as EwayBillRequest;
    const generated = applyEwbResult({ movementId: 'm5', result: { status: 'generated', ewbNo: '123456789012', ewbDate: '2026-08-12', validUpto: '2026-08-12' } });
    const agg = foldEwayBill('m5', [
      { kind: 'submitted', request: req, at: '2026-08-12T09:00:00Z' },
      { kind: 'response', record: generated, at: '2026-08-12T09:01:00Z' },
      { kind: 'response', record: applyEwbResult({ movementId: 'm5', result: { status: 'rejected', errors: ['late'] } }), at: '2026-08-12T09:02:00Z' }, // ignored — generated is final
      { kind: 'cancelled', reason: 'wrong vehicle', at: '2026-08-12T09:30:00Z' },
    ]);
    expect(agg?.state).toBe('cancelled');
    expect(agg?.ewbNo).toBe('123456789012');
  });

  it('ignores a response with no prior submission', () => {
    expect(foldEwayBill('m6', [{ kind: 'response', record: applyEwbResult({ movementId: 'm6', result: { status: 'unknown', reason: 'x' } }), at: 't' }])).toBeUndefined();
  });
});

describe('sandbox e-way-bill portal', () => {
  const req = buildEwayBillRequest({ request: REQUEST_FIELDS, eligibility: requiredInter }).request as EwayBillRequest;

  it('generates a deterministic 12-digit number and marks a repeat a duplicate', () => {
    expect(sandboxEwbNumber(req)).toMatch(EWB12);
    const p = sandboxEwbProvider();
    const first = p.generate(req);
    expect(first.status).toBe('generated');
    if (first.status !== 'generated') throw new Error('unreachable');
    expect(first.ewbNo).toMatch(EWB12);
    expect(first.validUpto).toBe('2026-08-12');
    const again = p.generate(req);
    expect(again.status).toBe('duplicate');
    if (again.status !== 'duplicate') throw new Error('unreachable');
    expect(again.ewbNo).toBe(first.ewbNo);
  });

  it('forces the unknown/rejected paths and rejects a non-positive value', () => {
    expect(sandboxEwbProvider({ forceOutcome: 'unknown' }).generate(req).status).toBe('unknown');
    expect(sandboxEwbProvider({ forceOutcome: 'rejected' }).generate(req).status).toBe('rejected');
    expect(sandboxEwbProvider().generate({ ...req, consignmentValueMinor: 0 }).status).toBe('rejected');
  });

  it('generateViaProvider closes generate → apply', async () => {
    const { record } = await generateViaProvider({ movementId: 'm7', request: req, provider: sandboxEwbProvider({ distanceKm: 300 }) });
    expect(record.state).toBe('generated');
    expect(record.ewbNo).toMatch(EWB12);
    expect(record.validUpto).toBe('2026-08-13'); // 300 km → 2 days
  });
});
