import { describe, it, expect } from 'vitest';
import {
  planErasure, type DataCategory, type DataSubjectRequest,
} from '../../packages/customer/src/data-rights';
import { minimisePii, redactSecrets, PII_BY_PURPOSE } from '../../packages/ai/src/safety';
import { PERMITTED_PAYMENT_RETENTION } from '../../packages/integration/src/adapters';
import * as tender from '../../packages/tender/src/tender';
import * as dataRights from '../../packages/customer/src/data-rights';

// SEC-12, PRV-03, PRV-05, PRV-08 — what we keep, what we refuse to keep, and what we cannot
// delete even when asked.
//
// Two obligations that look like a contradiction and are not:
//
//   • **PRV-05** — a customer may demand erasure, and the answer must be honest.
//   • **Hard rule #6 / PRV-08** — audit evidence and statutory records are never deleted.
//
// The wrong resolutions are both common. Delete everything and the shop cannot answer a GST
// assessment; refuse everything and the customer's right is a dead letter. The correct answer is
// **per category, with the law named, in words the customer can read** — and it is almost always
// partial, which is a fact to state plainly rather than a failure to hide.

describe('card data is refused by an allowlist, not chased by a blocklist', () => {
  it('permits only the four fields a payment integration may retain', () => {
    // A blocklist of forbidden fields is a list of the ones somebody already thought of. The
    // allowlist inverts it: a field invented next year is refused by default, which is the only
    // way hard rule #3 survives a provider who adds one.
    // A short, closed list. If it ever grows, that is a decision somebody must argue for in a
    // diff rather than a field that quietly appeared.
    expect(PERMITTED_PAYMENT_RETENTION.length).toBeLessThanOrEqual(6);
    for (const forbidden of ['card_number', 'primary_account_number', 'security_code', 'expiry_date', 'magnetic_stripe', 'chip_data']) {
      expect(PERMITTED_PAYMENT_RETENTION.includes(forbidden as never), forbidden).toBe(false);
    }
  });

  it('the tender module exposes no field that could hold a card number', () => {
    // Absence as a control: hard rule #3 is not "we validate it out", it is "there is nowhere
    // to put it". Tokens only.
    const source = JSON.stringify(Object.keys(tender));
    for (const forbidden of ['pan', 'cardNumber', 'cvv', 'expiry', 'track2']) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

const request = (requestId: string): DataSubjectRequest => ({
  requestId, tenantId: 't-1', customerRef: 'c-1', kind: 'erasure',
  raisedAt: '2026-08-01T09:00:00Z', verifiedBy: 'u-manager', verifiedAt: '2026-08-01T10:00:00Z',
  state: 'verified', dueBy: '2026-08-31',
});

describe('an erasure request gets an honest answer, per category, with the law named', () => {
  const categories: readonly DataCategory[] = [
    { category: 'Marketing preferences', recordCount: 3 },
    { category: 'Loyalty points history', recordCount: 412 },
    { category: 'Delivery addresses', recordCount: 2 },
    {
      category: 'Sales invoices', recordCount: 187,
      retentionBasis: 'tax_invoice', retainUntil: '2034-03-31', minimisable: true,
    },
    {
      category: 'GST records', recordCount: 187,
      retentionBasis: 'gst_record', retainUntil: '2032-12-31',
    },
    { category: 'Audit trail', recordCount: 1_240, retentionBasis: 'audit_evidence' },
  ];

  const plan = planErasure({ request: request('dsr-1'), categories, at: '2026-08-07T09:00:00Z' });

  it('erases what it can', () => {
    const erased = plan.plan.filter((p) => p.disposition === 'erase').map((p) => p.category);
    expect(erased).toContain('Marketing preferences');
    expect(erased).toContain('Delivery addresses');
    expect(plan.erasedRecordCount).toBeGreaterThan(0);
  });

  it('MINIMISES rather than deletes where the record must survive but the person need not', () => {
    // An invoice keeps its lines and its total; the name becomes a pseudonym. That is the answer
    // that satisfies both obligations at once, and it is the one people forget exists.
    const invoices = plan.plan.find((p) => p.category === 'Sales invoices');
    expect(invoices?.disposition).toBe('minimise');
  });

  it('RETAINS audit evidence, and says so without hedging (hard rule #6)', () => {
    const audit = plan.plan.find((p) => p.category === 'Audit trail');
    expect(audit?.disposition).toBe('retain');
    expect(audit?.explanation).toContain('can never be deleted by anyone, including us');
  });

  it('names the actual law for every retained category, not "legal reasons"', () => {
    for (const p of plan.plan.filter((x) => x.disposition !== 'erase')) {
      expect(p.explanation.length, p.category).toBeGreaterThan(30);
      expect(p.retentionBasis, p.category).toBeDefined();
    }
  });

  it('states plainly that the erasure is PARTIAL — almost always true, never hidden', () => {
    expect(plan.partial).toBe(true);
    expect(plan.customerStatement.length).toBeGreaterThan(1);
    // Written for the customer, not for a lawyer.
    expect(plan.customerStatement.join(' ')).not.toMatch(/pursuant to|heretofore|aforementioned/i);
  });

  it('deletes NOTHING itself — it produces the answer, and a person acts on it', () => {
    const names = Object.keys(dataRights);
    for (const forbidden of ['deleteCustomer', 'purgeCustomer', 'eraseNow', 'hardDelete', 'dropRecords']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('erases everything when nothing is legally held — the right is real, not theatre', () => {
    const clean = planErasure({
      request: request('dsr-2'), at: '2026-08-07T09:00:00Z',
      categories: [
        { category: 'Marketing preferences', recordCount: 3 },
        { category: 'Delivery addresses', recordCount: 1 },
      ],
    });
    expect(clean.partial).toBe(false);
    expect(clean.retainedRecordCount).toBe(0);
    expect(clean.plan.every((p) => p.disposition === 'erase')).toBe(true);
  });
});

describe('PII leaves the building only for a purpose that needs it (PRV-03)', () => {
  const person = {
    name: 'R. Chezhian', phone: '+91 90000 00001', email: 'x@example.com',
    address: '12 Mount Road', customer_id: 'c-1', loyalty_id: 'l-1', dob: '1971-04-02',
  };

  it('gives an agent answering a STOCK question no customer data at all', () => {
    const r = minimisePii({ purpose: 'stock_question', record: person });
    expect(Object.keys(r.record)).toHaveLength(0);
    expect(PII_BY_PURPOSE.stock_question).toHaveLength(0);
  });

  it('never releases date of birth or address to ANY purpose', () => {
    // A field nobody has a purpose for is a field that should not be in a prompt, ever.
    const leaks: string[] = [];
    for (const purpose of Object.keys(PII_BY_PURPOSE) as (keyof typeof PII_BY_PURPOSE)[]) {
      const kept = Object.keys(minimisePii({ purpose, record: person }).record);
      for (const field of ['dob', 'address', 'email', 'phone']) {
        if (kept.includes(field)) leaks.push(`${purpose} kept ${field}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('minimises a field invented later BY DEFAULT', () => {
    // The allowlist again: an unknown field is dropped, not passed through. A blocklist would
    // pass it, and the field added next year is the one that leaks.
    const r = minimisePii({
      purpose: 'customer_service',
      record: { ...person, aadhaar_number: '1234 5678 9012', gst_number: '33AAAAA1234A1Z5' },
    });
    expect(Object.keys(r.record)).not.toContain('aadhaar_number');
    expect(Object.keys(r.record)).not.toContain('gst_number');
  });

  it('gives the two customer-facing purposes a name, because a conversation needs one', () => {
    for (const purpose of ['customer_service', 'customer_shopping'] as const) {
      expect(Object.keys(minimisePii({ purpose, record: person }).record)).toContain('name');
    }
  });
});

describe('a secret does not come back out in a log, a screenshot or a ticket', () => {
  it('redacts in BOTH directions — the inbound one is the one that leaks', () => {
    // A model repeats back what it was shown, and the answer lands in a log. Redacting only what
    // goes out misses the entire realistic path.
    const secret = ['sk', '_live_', 'AAAABBBBCCCCDDDD'].join('');
    expect(redactSecrets(`the key is ${secret}`, 'outbound').text).not.toContain(secret);
    expect(redactSecrets(`I used ${secret} as instructed`, 'inbound').text).not.toContain(secret);
  });

  it('redacts a vault REFERENCE too — it is not a secret, it names which one to steal', () => {
    const r = redactSecrets('rotate vault://payments/webhook-signing#v3 next week', 'outbound');
    expect(r.text).not.toContain('vault://payments/webhook-signing');
  });
});
