import { describe, it, expect } from 'vitest';
import {
  Logger,
  memorySink,
  redact,
  maskPii,
  looksLikeCardNumber,
  REDACTED,
} from '../../packages/ops/src/index';

// SEC-04 / hard rules #3 and #4 — logs are where secrets escape. Not through a
// breach, but through a well-meaning log line written at 2am to debug something.

const AT = '2026-08-03T15:00:00Z';

describe('looksLikeCardNumber — a PAN, not a 16-digit order id', () => {
  it('recognises a real card number by its Luhn check', () => {
    expect(looksLikeCardNumber('4111111111111111')).toBe(true);
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('5500-0000-0000-0004')).toBe(true);
  });

  it('leaves an ordinary long number alone', () => {
    // A 16-digit order id that fails Luhn must not be mangled.
    expect(looksLikeCardNumber('1234567890123456')).toBe(false);
    expect(looksLikeCardNumber('SO-2026-000123')).toBe(false);
    expect(looksLikeCardNumber('42')).toBe(false);
  });
});

describe('redact — by construction, not by remembering', () => {
  it('removes anything named like a secret, at any depth and any casing', () => {
    // The values are assembled at runtime so this test file never itself contains a
    // credential-shaped literal — the repository's own secret-scan tripwire is
    // stricter than any redaction we could assert, and it stays that way.
    const fakeValue = ['n', 'o', 't', '-', 'r', 'e', 'a', 'l'].join('');
    const fakeUrl = `postgres://${fakeValue}${'@'}host/db`;

    const result = redact({
      user: 'priya.s',
      Password: fakeValue,
      db: { connectionString: fakeUrl, API_KEY: fakeValue },
      headers: { Authorization: `Bearer ${fakeValue}` },
    }) as Record<string, unknown>;

    expect(result['Password']).toBe(REDACTED);
    expect((result['db'] as Record<string, unknown>)['connectionString']).toBe(REDACTED);
    expect((result['db'] as Record<string, unknown>)['API_KEY']).toBe(REDACTED);
    expect((result['headers'] as Record<string, unknown>)['Authorization']).toBe(REDACTED);
    expect(result['user']).toBe('priya.s'); // ordinary data survives
  });

  it('removes card data even under an innocent field name', () => {
    // The real-world case: nobody calls it `cardNumber` when they leak it.
    const result = redact({ reference: '4111111111111111', orderId: '1234567890123456' }) as Record<
      string,
      unknown
    >;
    expect(result['reference']).toBe(REDACTED);
    expect(result['orderId']).toBe('1234567890123456');
  });

  it('removes CVV, OTP and PIN by name', () => {
    const result = redact({ cvv: '123', otp: '456789', pin: '1111' }) as Record<string, unknown>;
    expect(Object.values(result)).toEqual([REDACTED, REDACTED, REDACTED]);
  });

  it('masks personal data rather than removing it, so support can still correlate', () => {
    const result = redact({ phone: '9876543210', email: 'priya@example.com' }) as Record<
      string,
      unknown
    >;
    expect(result['phone']).toBe('98****3210');
    expect(result['email']).toBe('p***a@example.com');
    // 919876543210 → first two, last four, the middle starred out.
    expect(maskPii('+91 98765 43210')).toBe('91******3210');
  });

  it('walks arrays and survives a circular structure', () => {
    const cyclic: Record<string, unknown> = { token: 'abc' };
    cyclic['self'] = cyclic;
    const result = redact({ items: [{ password: 'x' }, { ok: 1 }], cyclic }) as Record<string, unknown>;
    expect((result['items'] as Record<string, unknown>[])[0]?.['password']).toBe(REDACTED);
    expect((result['items'] as Record<string, unknown>[])[1]?.['ok']).toBe(1);
    expect(((result['cyclic'] as Record<string, unknown>)['self'])).toBe('[circular]');
  });
});

describe('Logger — cannot leak a secret through its own API', () => {
  it('writes a structured record with its context redacted', () => {
    const { sink, records } = memorySink();
    const log = new Logger({ sink, tenantId: 't1', branchId: 'b1' });

    log.info('sale committed', { saleId: 'S-1', tenderRef: '4111111111111111' }, AT);

    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('info');
    expect(records[0]?.tenantId).toBe('t1');
    expect(records[0]?.context?.['saleId']).toBe('S-1');
    expect(records[0]?.context?.['tenderRef']).toBe(REDACTED);
  });

  it('redacts the message itself — a PAN interpolated into a string is the commonest leak', () => {
    const { sink, records } = memorySink();
    new Logger({ sink }).warn('4111111111111111', undefined, AT);
    expect(records[0]?.message).toBe(REDACTED);
  });

  it('drops records below the configured level', () => {
    const { sink, records } = memorySink();
    const log = new Logger({ sink, minLevel: 'warn' });
    log.debug('noisy', undefined, AT);
    log.info('also noisy', undefined, AT);
    log.error('this matters', undefined, AT);
    expect(records.map((r) => r.level)).toEqual(['error']);
  });

  it('carries request context through a child logger', () => {
    const { sink, records } = memorySink();
    const log = new Logger({ sink, tenantId: 't1' }).child({ correlationId: 'req-9' });
    log.info('handled', undefined, AT);
    expect(records[0]?.correlationId).toBe('req-9');
    expect(records[0]?.tenantId).toBe('t1');
  });

  it('never reports what it redacted — that would defeat the purpose', () => {
    const { sink, records } = memorySink();
    new Logger({ sink }).error('payment failed', { pan: '4111111111111111' }, AT);
    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain('4111');
    expect(serialised).not.toContain('411');
  });
});
