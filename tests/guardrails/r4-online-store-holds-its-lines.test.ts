import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPT_SENDING } from '../../packages/receipt/src/digital-copy';
import { SIGNUP_SMS_CODE_SWITCHED_ON } from '../../services/customer/src/signup-sms-code';
import { VOICE_SEARCH_SWITCHED_ON } from '../../apps/customer-app/src/voice-search';
import { noProviderRefundProcessor } from '../../services/orders/src/storefront-online-returns';

/**
 * **Guardrail — R4 Lane 2's "no override exists" claims, held in the code (B23 · A26 · WF-16 · D-28 · D08 · M16-FR-01).**
 *
 *   • No listing, store publish or return check reads an override, a force or a skip: a missing duty (the grievance
 *     officer included, OB-223), another seller's goods (OB-211), a closed window, a non-returnable item and a line
 *     refunded once are refused, full stop.
 *   • A return refund goes to the ORDER's own payment token — never one in the request — and only the online-return route
 *     records the `return` basis; the desk's generic refund route cannot.
 *   • With no provider connected the product's refund processor answers "unknown": the refund WAITS (never shown done).
 *   • SMS and WhatsApp are switched off (OB-222): no sender is wired and the receipt-sending route refuses
 *     unconditionally. Voice is ON through the phone's built-in recogniser only (OB-322, which replaces OB-222 for voice),
 *     with the customer's own switch; the camera is opened only by the barcode screen and no picture is sent anywhere.
 *   • Nothing here deletes a record, and no AI agent is reached from these paths (hard rules #2, #5, #6).
 */

const code = (path: string): string => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const LANE_FILES = [
  'packages/storefront/src/listing-duties.ts', 'packages/storefront/src/online-returns.ts', 'packages/storefront/src/ratings.ts',
  'packages/receipt/src/digital-copy.ts', 'packages/product/src/images.ts',
  'services/orders/src/storefront-online-store.ts', 'services/orders/src/storefront-online-returns.ts', 'services/orders/src/storefront-ratings.ts',
  'services/customer/src/digital-receipts.ts', 'services/customer/src/signup-sms-code.ts', 'services/catalogue/src/product-content-images.ts',
  'services/api/src/r4-online-adapters.ts',
];

describe('guardrail: the online store holds its lines (R4 Lane 2)', () => {
  it('no gate reads an override, a force or a skip', () => {
    for (const f of ['services/orders/src/storefront-online-store.ts', 'services/orders/src/storefront-online-returns.ts', 'packages/storefront/src/listing-duties.ts', 'packages/storefront/src/online-returns.ts']) {
      expect(code(f), f).not.toMatch(/\b(override|force|skip|bypass)\w*\b/i);
    }
  });

  it('a return refund goes to the order\'s own token, and only the online-return route records the `return` basis', () => {
    const returns = code('services/orders/src/storefront-online-returns.ts');
    expect(returns).toMatch(/providerRef: payment\.providerRef!/);
    expect(returns).not.toMatch(/b\['providerRef'\]/);
    const desk = code('services/orders/src/payments.ts');
    const bases = /const BASES: readonly RefundBasis\[\] = \[([^\]]*)\]/.exec(desk)?.[1] ?? '';
    expect(bases).not.toContain("'return'");
  });

  it('with no provider connected, a refund waits — never shown as done', async () => {
    expect((await noProviderRefundProcessor().refund({ refundId: 'r', providerRef: 'tok', amountMinor: 1, currency: 'INR' })).result).toBe('unknown');
    // The wiring uses it unless a provider is handed in explicitly.
    expect(code('services/api/src/r4-online-adapters.ts')).toMatch(/refundProcessor: input\.refundProcessor \?\? noProviderRefundProcessor\(\)/);
    expect(code('services/api/src/main.ts')).toMatch(/\.\.\.r4OnlineRoutes\(\{ store, now, signer, memberKey: loyaltyKey, /);
    expect(code('services/api/src/main.ts')).not.toMatch(/r4OnlineRoutes\(\{[^}]*refundProcessor/);
  });

  it('SMS and WhatsApp are switched off: nothing can be sent; voice is the phone\'s own recogniser only (OB-322)', () => {
    expect([RECEIPT_SENDING.switchedOn, SIGNUP_SMS_CODE_SWITCHED_ON]).toEqual([false, false]);
    expect(VOICE_SEARCH_SWITCHED_ON).toBe(true); // OB-322 (owner, 23 Oct 2026)
    // No sender is wired to the sign-up code; the receipt send route has no path that sends.
    expect(code('services/api/src/r4-online-adapters.ts')).toMatch(/\.\.\.signupSmsCodeRoutes\(\{ now \}\)/);
    const receipts = code('services/customer/src/digital-receipts.ts');
    const send = receipts.slice(receipts.indexOf("path: '/v1/me/receipts/:receiptNumber/send'"), receipts.indexOf("path: '/v1/loyalty/members/app-link'"));
    expect(send).toMatch(/handler: async \(\) => \{\s*throw apiError\(409, \{ code: 'sending_switched_off'/);
    // OB-322: the only speech engine is the phone's own recogniser — picked in the bundle's entry, driven in voice-search.ts;
    // no other file names it. The camera is asked for only by the barcode screen, which sends nothing anywhere.
    const SPEECH_OK = ['apps/customer-app/src/voice-search.ts', 'apps/customer-app/src/browser-entry.ts'];
    // OB-350: scan-and-go is the second barcode screen — it reads the code on the phone and sends only ids and counts.
    const CAMERA_OK = ['apps/customer-app/web/customer-commerce.js', 'apps/customer-app/web/scan-and-go.js', 'apps/customer-app/src/barcode-scan.ts', 'apps/customer-app/src/browser-entry.ts'];
    const files = readdirSync('apps/customer-app/src').map((x) => join('apps/customer-app/src', x)).concat(readdirSync('apps/customer-app/web').filter((x) => x.endsWith('.js') && !x.endsWith('.bundle.js')).map((x) => join('apps/customer-app/web', x))); // the bundle is built from src
    for (const f of files) {
      if (!SPEECH_OK.includes(f)) expect(code(f), f).not.toMatch(/SpeechRecognition/);
      if (!CAMERA_OK.includes(f)) expect(code(f), f).not.toMatch(/getUserMedia/);
    }
    expect(code('apps/customer-app/src/voice-search.ts')).not.toMatch(/\bfetch\(|https?:\/\//);
    expect(code('apps/customer-app/src/barcode-scan.ts')).not.toMatch(/\bfetch\(|https?:\/\//);
    // None of the lane's files makes a network call of its own.
    for (const f of LANE_FILES) expect(code(f), f).not.toMatch(/\bfetch\(|https?:\/\//);
  });

  it('nothing deletes a record, and no AI agent is reached from these paths', () => {
    for (const f of LANE_FILES) {
      expect(code(f), f).not.toMatch(/\.delete\(|\bDELETE\b|removeStream|truncate/i);
      expect(code(f), f).not.toMatch(/from '\.\.\/\.\.\/ai\/|services\/ai\//);
    }
  });
});
