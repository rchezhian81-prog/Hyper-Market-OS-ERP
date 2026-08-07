import { describe, it, expect } from 'vitest';
import {
  checkDevice,
  registerAdapter,
  adapterHealth,
  integrationHealth,
  PERMITTED_PAYMENT_RETENTION,
  type CertifiedEntry,
  type AdapterConfig,
  type AdapterHeartbeat,
} from '../../packages/integration/src/adapters';

// M32-FR-04 acceptance: "the Tally adapter posts idempotently with a dead-letter; the payment
// adapter uses a verified RBI provider and stores no card data; an uncertified peripheral is
// blocked."

const MATRIX: readonly CertifiedEntry[] = [
  { entryId: 'hw-scan-1', category: 'hardware', deviceKind: 'barcode_scanner', vendor: 'Honeywell', model: 'Voyager 1250g', versions: [], certifiedOn: '2026-02-01', edgeOnly: true },
  { entryId: 'hw-scan-2', category: 'hardware', deviceKind: 'barcode_scanner', vendor: 'Zebra', model: 'DS2208', versions: ['1.4', '1.5'], certifiedOn: '2026-02-01', edgeOnly: true },
  { entryId: 'hw-scale-1', category: 'hardware', deviceKind: 'weighing_scale', vendor: 'Essae', model: 'DS-852', versions: [], certifiedOn: '2026-03-01', edgeOnly: true },
  { entryId: 'pay-1', category: 'payment', vendor: 'Razorpay', model: 'API', versions: ['v1'], certifiedOn: '2026-01-15', rbiAuthorised: true },
  { entryId: 'pay-2', category: 'payment', vendor: 'QuickPay', model: 'API', versions: ['v1'], certifiedOn: '2026-01-15', rbiAuthorised: false },
  { entryId: 'acc-1', category: 'accounting', vendor: 'Tally', model: 'Prime', versions: ['3.0'], certifiedOn: '2026-01-10' },
];

describe('an uncertified device is BLOCKED, and the refusal names an alternative', () => {
  it('allows a certified scanner', () => {
    const d = checkDevice({ vendor: 'Honeywell', model: 'Voyager 1250g', deviceKind: 'barcode_scanner', matrix: MATRIX });
    expect(d.allowed).toBe(true);
    expect(d.detail).toContain('no cloud in the path of a scan');
  });

  it('blocks the cheap Sunday printer and SAYS WHAT TO BUY', () => {
    const d = checkDevice({ vendor: 'NoName', model: 'TP-58', deviceKind: 'barcode_scanner', matrix: MATRIX });
    expect(d.allowed).toBe(false);
    expect(d.outcome).toBe('not_certified');
    // A refusal with no alternative is one somebody overrides on a Sunday.
    expect(d.alternatives).toEqual(['Honeywell Voyager 1250g', 'Zebra DS2208']);
  });

  it('blocks a certified model on uncertified firmware, and says to update rather than replace', () => {
    const d = checkDevice({ vendor: 'Zebra', model: 'DS2208', firmware: '1.2', deviceKind: 'barcode_scanner', matrix: MATRIX });
    expect(d.outcome).toBe('wrong_version');
    expect(d.detail).toContain('update it rather than replace it');
  });

  it('allows a certified model whose firmware is on the list', () => {
    expect(checkDevice({ vendor: 'Zebra', model: 'DS2208', firmware: '1.5', deviceKind: 'barcode_scanner', matrix: MATRIX }).allowed).toBe(true);
  });

  it('blocks a withdrawn model and keeps it out of the alternatives', () => {
    const d = checkDevice({
      vendor: 'Zebra', model: 'DS2208', deviceKind: 'barcode_scanner',
      matrix: MATRIX, withdrawn: ['hw-scan-2'],
    });
    expect(d.outcome).toBe('withdrawn');
    expect(d.alternatives).toEqual(['Honeywell Voyager 1250g']);
  });

  it('does not offer a scanner as an alternative to a scale', () => {
    const d = checkDevice({ vendor: 'NoName', model: 'X', deviceKind: 'weighing_scale', matrix: MATRIX });
    expect(d.alternatives).toEqual(['Essae DS-852']);
  });

  it('matches vendor and model case-insensitively', () => {
    expect(checkDevice({ vendor: 'honeywell', model: 'voyager 1250g', deviceKind: 'barcode_scanner', matrix: MATRIX }).allowed).toBe(true);
  });
});

const config = (over: Partial<AdapterConfig>): AdapterConfig => ({
  adapterId: 'adp-razorpay', tenantId: 't-sre', category: 'payment', vendor: 'Razorpay',
  environment: 'production', credentialRef: 'vault://payments/live#v4',
  retains: ['provider_token', 'last4'], enabled: true, queueOnOutage: true, ...over,
});

describe('a payment adapter stores a TOKEN or it is refused (hard rule #3)', () => {
  it('registers a tokenising, RBI-authorised provider', () => {
    const r = registerAdapter({ config: config({}), matrix: MATRIX, environment: 'production' });
    expect(r.registered).toBe(true);
  });

  it('REFUSES an adapter declaring it keeps the card number, with no override anywhere', () => {
    const r = registerAdapter({
      config: config({ retains: ['provider_token', 'full_card_digits'] }),
      matrix: MATRIX, environment: 'production',
    });
    expect(r.registered).toBe(false);
    expect(r.outcome).toBe('stores_card_data');
    expect(r.detail).toContain('no override anywhere');
  });

  it('is an ALLOWLIST, so it refuses anything nobody explicitly permitted', () => {
    // A blocklist only refuses the field names somebody thought to write down. This
    // refuses whatever a provider invents next year as well.
    for (const field of ['security_code', 'valid_thru', 'track2', 'anything_at_all']) {
      expect(registerAdapter({
        config: config({ retains: [field] }), matrix: MATRIX, environment: 'production',
      }).outcome).toBe('stores_card_data');
    }
  });

  it('accepts every permitted retention field', () => {
    expect(registerAdapter({
      config: config({ retains: [...PERMITTED_PAYMENT_RETENTION] }),
      matrix: MATRIX, environment: 'production',
    }).registered).toBe(true);
  });

  it('REFUSES a provider that is not RBI-authorised', () => {
    const r = registerAdapter({
      config: config({ vendor: 'QuickPay' }), matrix: MATRIX, environment: 'production',
    });
    expect(r.outcome).toBe('provider_not_authorised');
    expect(r.detail).toContain("somebody else's promise about card data");
  });

  it('refuses a payment provider not on the matrix at all', () => {
    expect(registerAdapter({
      config: config({ vendor: 'Mystery Payments' }), matrix: MATRIX, environment: 'production',
    }).outcome).toBe('not_certified');
  });
});

describe('a credential is a vault reference or it is refused (hard rule #4)', () => {
  it('REFUSES an inline credential typed into a configuration screen', () => {
    const r = registerAdapter({
      config: config({ credentialRef: 'rzp_live_ABC123XYZ' }), matrix: MATRIX, environment: 'production',
    });
    expect(r.outcome).toBe('credential_inline');
    // The repo scanner never sees what somebody types into a settings page.
    expect(r.detail).toContain('typed into a configuration screen');
  });

  it('refuses a sandbox credential on a production adapter', () => {
    const r = registerAdapter({
      config: config({ credentialRef: 'vault://payments/test#v1' }), matrix: MATRIX,
      environment: 'production', sandboxRefs: ['vault://payments/test#v1'],
    });
    expect(r.outcome).toBe('sandbox_credential_in_production');
  });

  it('registers a non-payment adapter that queues during an outage', () => {
    const r = registerAdapter({
      config: config({ adapterId: 'adp-tally', category: 'accounting', vendor: 'Tally', credentialRef: 'vault://accounting/live#v2' }),
      matrix: MATRIX, environment: 'production',
    });
    expect(r.registered).toBe(true);
    expect(r.detail).toContain('queueing during an outage rather than failing the caller');
  });
});

const beat = (at: string, ok: boolean): AdapterHeartbeat => ({ adapterId: 'adp-tally', at, ok });
const TALLY = config({ adapterId: 'adp-tally', category: 'accounting', vendor: 'Tally', credentialRef: 'vault://accounting/live#v2' });

describe('health is WHEN IT LAST WORKED, not whether it is configured', () => {
  it('is healthy on a recent success', () => {
    const h = adapterHealth({
      config: TALLY, heartbeats: [beat('2026-08-04T08:55:00Z', true)], at: '2026-08-04T09:00:00Z',
    });
    expect(h.state).toBe('healthy');
    expect(h.minutesSinceLastSuccess).toBe(5);
  });

  it('calls an adapter SILENT when it has not worked for an hour, however green it looks', () => {
    const h = adapterHealth({
      config: TALLY, heartbeats: [beat('2026-08-04T05:00:00Z', true), beat('2026-08-04T08:59:00Z', false)],
      at: '2026-08-04T09:00:00Z',
    });
    expect(h.state).toBe('silent');
    expect(h.detail).toContain('green on any dashboard that reports configuration');
  });

  it('calls one that NEVER succeeded silent, not healthy', () => {
    const h = adapterHealth({ config: TALLY, heartbeats: [], at: '2026-08-04T09:00:00Z' });
    expect(h.state).toBe('silent');
    expect(h.minutesSinceLastSuccess).toBe('never');
    expect(h.detail).toContain('"configured" is not health');
  });

  it('distinguishes degraded from failing', () => {
    const degraded = adapterHealth({
      config: TALLY,
      heartbeats: [beat('2026-08-04T08:55:00Z', true), beat('2026-08-04T08:58:00Z', false)],
      at: '2026-08-04T09:00:00Z',
    });
    expect(degraded.state).toBe('degraded');

    const failing = adapterHealth({
      config: TALLY,
      heartbeats: [
        beat('2026-08-04T08:55:00Z', true),
        beat('2026-08-04T08:56:00Z', false),
        beat('2026-08-04T08:57:00Z', false),
        beat('2026-08-04T08:58:00Z', false),
      ],
      at: '2026-08-04T09:00:00Z',
    });
    expect(failing.state).toBe('failing');
    expect(failing.consecutiveFailures).toBe(3);
    expect(failing.detail).toContain('the shop keeps trading');
  });

  it('reports a switched-off adapter as disabled, not broken', () => {
    expect(adapterHealth({ config: { ...TALLY, enabled: false }, heartbeats: [], at: '2026-08-04T09:00:00Z' }).state)
      .toBe('disabled');
  });

  it('says the shop keeps trading whatever the adapter is doing (hard rule #1)', () => {
    const h = adapterHealth({ config: TALLY, heartbeats: [], at: '2026-08-04T09:00:00Z' });
    expect(h.shopKeepsTrading).toBe(true);
  });
});

describe('no integration failure may reach the till (P-01)', () => {
  it('types posUnaffected as literally true', () => {
    const report = integrationHealth({
      tenantId: 't-sre',
      configs: [TALLY, config({})],
      heartbeats: [],
      at: '2026-08-04T09:00:00Z',
    });
    expect(report.posUnaffected).toBe(true);
    expect(report.detail).toContain('the till is unaffected either way');
  });

  it('puts what is broken at the top', () => {
    const report = integrationHealth({
      tenantId: 't-sre',
      configs: [TALLY, config({ adapterId: 'adp-razorpay' })],
      heartbeats: [
        { adapterId: 'adp-razorpay', at: '2026-08-04T08:59:00Z', ok: true },
      ],
      at: '2026-08-04T09:00:00Z',
    });
    expect(report.adapters[0]?.adapterId).toBe('adp-tally');
    expect(report.adapters[0]?.state).toBe('silent');
    expect(report.adapters[1]?.state).toBe('healthy');
  });

  it('never reports another tenant\'s adapters', () => {
    const report = integrationHealth({
      tenantId: 't-sre',
      configs: [TALLY, config({ adapterId: 'adp-other', tenantId: 't-kumar' })],
      heartbeats: [], at: '2026-08-04T09:00:00Z',
    });
    expect(report.adapters.map((a) => a.adapterId)).toEqual(['adp-tally']);
  });
});
