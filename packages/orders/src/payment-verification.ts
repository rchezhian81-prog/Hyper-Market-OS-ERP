// Who may say an online payment is paid — Wave 6 · FUL-03 (M20-FR-03, M18-FR-04, §31 "no fake approval", hard rule #3).
//
// The audit ran the storefront with a made-up token and an amount of one paisa; the order came back "authorised" and
// staff could confirm it. The customer's app is not a witness to its own payment: whatever it sends is a CLAIM. The
// order's payment is pending until the PAYMENT PROVIDER says it captured that token for the amount the SHOP quoted.
//
// The provider is a port. No live provider is connected (EX-03 is an external gate), so the only implementation in this
// repository is the TEST-MODE one: a register of captures a test (or a demo operator) puts there by hand — never
// produced by the app's request — and it says so in every answer (`test_mode`). A production composition that has no
// provider leaves every online payment pending, honestly, until someone records the bank's answer.

export type VerifiedPaymentResult = 'authorised' | 'declined' | 'unknown';

export interface PaymentVerification {
  readonly result: VerifiedPaymentResult;
  /** What the answer rests on — the provider's capture reference. Absent when it did not answer. */
  readonly evidenceRef?: string;
  /** The amount the provider captured, when it says. */
  readonly capturedMinor?: number;
  readonly provider: string;
  readonly detail: string;
}

export interface PaymentVerifier {
  readonly provider: string;
  verify(input: { readonly orderId: string; readonly providerRef: string; readonly amountMinor: number }): Promise<PaymentVerification>;
}

/** The test-mode provider: captures are registered out of band; an unregistered token is UNKNOWN, never authorised. */
export interface TestModePaymentProvider extends PaymentVerifier {
  /** The provider captured `amountMinor` against this token (a test, or a demo operator standing in for the bank). */
  capture(providerRef: string, amountMinor: number): void;
  /** The provider declined this token. */
  decline(providerRef: string): void;
}

export function testModePaymentProvider(): TestModePaymentProvider {
  const captured = new Map<string, number>();
  const declined = new Set<string>();
  return {
    provider: 'test_mode',
    capture: (ref, amount) => { captured.set(ref, amount); },
    decline: (ref) => { declined.add(ref); },
    verify: async ({ providerRef, amountMinor }) => {
      if (declined.has(providerRef)) return { result: 'declined', provider: 'test_mode', evidenceRef: `test-decline-${providerRef}`, detail: 'test-mode provider: this token was declined' };
      const got = captured.get(providerRef);
      if (got === undefined) return { result: 'unknown', provider: 'test_mode', detail: 'test-mode provider: no capture for this token yet' };
      if (got !== amountMinor) {
        return { result: 'unknown', provider: 'test_mode', capturedMinor: got, evidenceRef: `test-capture-${providerRef}`, detail: `test-mode provider: captured ${got}, not the ${amountMinor} the shop quoted — a person must look` };
      }
      return { result: 'authorised', provider: 'test_mode', capturedMinor: got, evidenceRef: `test-capture-${providerRef}`, detail: `test-mode provider: captured ${got}` };
    },
  };
}

/** The shop's own price for an order: each line's quantity × the store's published unit price. Pure. */
export function quoteOrder(input: {
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly priceOf: (productId: string) => number | undefined;
}): { readonly ok: true; readonly itemsMinor: number; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly unitPriceMinor: number; readonly lineMinor: number }[] } | { readonly ok: false; readonly unpriced: readonly string[] } {
  const unpriced = input.lines.filter((l) => input.priceOf(l.productId) === undefined).map((l) => l.productId);
  if (unpriced.length > 0) return { ok: false, unpriced };
  const lines = input.lines.filter((l) => l.quantityMinor > 0).map((l) => {
    const unitPriceMinor = input.priceOf(l.productId)!;
    return { productId: l.productId, quantityMinor: l.quantityMinor, unitPriceMinor, lineMinor: unitPriceMinor * l.quantityMinor };
  });
  return { ok: true, itemsMinor: lines.reduce((n, l) => n + l.lineMinor, 0), lines };
}
