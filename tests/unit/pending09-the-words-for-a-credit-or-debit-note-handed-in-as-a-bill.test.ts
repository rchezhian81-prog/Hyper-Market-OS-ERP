import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HAND_IN_WORDS, handInWords, createSupplierBillsSession } from '../../apps/web-erp/src/supplier-bills-session';

// OB-937 A (owner, 27 Nov 2026, in writing) · D-155: when head office refuses a supplier's credit note or debit note handed
// in on Supplier bills, the page says so in plain words — English and Tamil — that nothing was recorded and where it belongs.

const refused = (code: string) => ({ ok: false as const, unreachable: false as const, status: 422, code, whatHappened: 'head office words', nextSafeAction: '' });

describe('the words for a credit or debit note handed in as a bill (OB-937 A)', () => {
  it('a credit note: English and Tamil, nothing recorded, where to record it', () => {
    expect(handInWords('en', refused('einvoice_is_credit_note'))).toBe('This file is a supplier\'s credit note, not a bill. Nothing was recorded. Record it under Debit notes → Supplier accepted.');
    expect(handInWords('ta', refused('einvoice_is_credit_note'))).toBe('இந்தக் கோப்பு சப்ளையரின் வரவுக் குறிப்பு, பில் அல்ல. எதுவும் பதிவு செய்யப்படவில்லை. அதைப் பற்றுக் குறிப்புகள் → சப்ளையர் ஏற்றார் என்பதில் பதிவு செய்யுங்கள்.');
  });

  it('a debit note: English and Tamil, nothing recorded, ask the accountant', () => {
    expect(handInWords('en', refused('einvoice_is_debit_note'))).toBe('This file is a supplier\'s debit note, not a bill. Nothing was recorded. Ask the accountant how to record it.');
    expect(handInWords('ta', refused('einvoice_is_debit_note'))).toMatch(/^இந்தக் கோப்பு சப்ளையரின் பற்றுக் குறிப்பு, பில் அல்ல\. எதுவும் பதிவு செய்யப்படவில்லை\. .*கணக்காளரிடம் கேளுங்கள்\.$/);
  });

  it('every other answer keeps its own words (null here): a bill read, head office unreachable, another refusal', () => {
    expect(handInWords('en', { ok: true })).toBeNull();
    expect(handInWords('en', { ok: false, unreachable: true })).toBeNull();
    expect(handInWords('ta', refused('bill_already_received'))).toBeNull();
    expect(handInWords('en', refused('not_a_gst_e_invoice'))).toBeNull();
  });

  it('the Tamil list has every English word, and the session hands the words to the page', () => {
    expect(Object.keys(HAND_IN_WORDS.ta).sort()).toEqual(Object.keys(HAND_IN_WORDS.en).sort());
    const session = createSupplierBillsSession(() => Promise.resolve('unreachable'), { permissions: ['purchase.invoice.capture'] });
    expect(session.handInWords('en', refused('einvoice_is_credit_note'))).toBe(HAND_IN_WORDS.en['einvoice_is_credit_note']);
    // The page shows these words in place of head office's own when it has them.
    expect(readFileSync('apps/web-erp/web/supplier-bills.js', 'utf8')).toMatch(/session\.handInWords\(lang, answer\)/);
  });
});
