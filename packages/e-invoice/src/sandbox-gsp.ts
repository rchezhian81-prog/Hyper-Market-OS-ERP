// A deterministic SANDBOX GSP/IRP provider (owner continuation directive §2, 12 Aug 2026). The A20 engine
// already defines the `EInvoiceProvider` port and the never-fabricate handling of an IRP answer; what was
// missing was any in-repo implementation of that port, so the submit → register → apply loop could not be
// exercised end to end without a live, credentialed GSP. This closes that gap WITHOUT waiting on a GSP
// account: a provider-neutral simulator a dev/test environment plugs into the same port a real connector
// will, so the whole lifecycle can be driven, demonstrated and tested deterministically.
//
// Two disciplines this sandbox holds, because a fake that lies is worse than no fake:
//   • **Its output is unmistakably a sandbox.** The signed QR is prefixed `SANDBOX.` and the IRN is a hash
//     of the invoice's identity, not a value any government portal issued. It can NEVER be mistaken for a
//     real filing, and `applyIrpResult` downstream still refuses to treat a malformed answer as registered.
//   • **It is deterministic and pure.** The IRN is `sha256(idempotency basis)`, so the same invoice always
//     yields the same IRN (idempotency + duplicate detection are real), and there is no clock or randomness.
//
// This is a testing / bring-up tool. Production points the same `EInvoiceProvider` port at a certified GSP
// whose credentials come from a vault (hard rule #4); a real live filing additionally needs the e-invoicing
// feature switched on (a separate flag/kill-switch increment) and CA/legal confirmation.

import { createHash } from 'node:crypto';
import { applyIrpResult, type EInvoiceProvider, type IrnRequest, type IrpResult, type EInvoiceRecord } from './e-invoice';

export interface SandboxGspOptions {
  /**
   * Force every call to this outcome — for exercising the `unknown` (timeout) and `rejected` paths a real
   * IRP produces, in tests and demos. Omit for the natural behaviour (register, then duplicate on a repeat).
   */
  readonly forceOutcome?: 'registered' | 'unknown' | 'rejected';
  /** Errors returned when `forceOutcome === 'rejected'`. */
  readonly rejectReasons?: readonly string[];
  /** Reason surfaced when `forceOutcome === 'unknown'` (a simulated timeout). */
  readonly unknownReason?: string;
}

/**
 * The sandbox provider. It is the `EInvoiceProvider` port, narrowed to say what a real network connector
 * cannot promise: `register` is **synchronous and deterministic** — no clock, no I/O, no `Promise`. Callers
 * that hold a `SandboxGspProvider` can read the answer directly; callers that hold the wider port `await` it.
 */
export interface SandboxGspProvider extends EInvoiceProvider {
  register(request: IrnRequest): IrpResult;
}

/** The idempotency basis the IRP itself uses: supplier GSTIN + doc type + number + FY. */
export function sandboxIdempotencyKey(request: IrnRequest): string {
  return `${request.supplierGstin}|${request.documentType}|${request.documentNumber}|${request.financialYear}`;
}

/** The deterministic sandbox IRN for a request — `sha256(idempotency basis)`, 64 hex chars (never a real IRN). */
export function sandboxIrn(request: IrnRequest): string {
  return createHash('sha256').update(sandboxIdempotencyKey(request)).digest('hex');
}

/**
 * A provider-neutral sandbox GSP. `register` returns a deterministic `IrpResult`: the first registration of
 * an invoice is `registered` (with a hash-derived IRN, a `SANDBOX.`-prefixed signed QR, and a deterministic
 * ack number/date); a repeat of the SAME invoice is `duplicate` returning the same IRN (the IRP's real
 * idempotency); a non-positive taxable value is `rejected` even here. `forceOutcome` overrides everything to
 * exercise the timeout/rejection branches. Stateful only in remembering which invoices it has seen — which
 * is exactly what makes duplicate detection real. Never contacts a network.
 */
export function sandboxGspProvider(options: SandboxGspOptions = {}): SandboxGspProvider {
  const seen = new Set<string>();
  return {
    register(request: IrnRequest): IrpResult {
      if (options.forceOutcome === 'unknown') {
        return { status: 'unknown', reason: options.unknownReason ?? 'sandbox: simulated IRP timeout — the answer is UNKNOWN until reconciled' };
      }
      if (options.forceOutcome === 'rejected') {
        return { status: 'rejected', errors: options.rejectReasons ?? ['sandbox: simulated IRP rejection'] };
      }
      // A structural check even the sandbox enforces, so the rejected path is reachable from real data.
      if (!(typeof request.taxableMinor === 'number' && request.taxableMinor > 0)) {
        return { status: 'rejected', errors: ['sandbox: the taxable value must be a positive amount'] };
      }
      const key = sandboxIdempotencyKey(request);
      const irn = sandboxIrn(request);
      const ackNo = (BigInt('0x' + irn.slice(0, 15)) % 1_000_000_000_000_000n).toString().padStart(15, '0');
      const signedQr = `SANDBOX.${Buffer.from(`${irn}.${ackNo}`).toString('base64')}`;
      if (seen.has(key)) {
        // The IRP already holds this invoice — its real, idempotent answer is the existing IRN.
        return { status: 'duplicate', irn, signedQr };
      }
      seen.add(key);
      return { status: 'registered', irn, signedQr, ackNo, ackDate: request.documentDate };
    },
  };
}

/**
 * Close the loop in one step: call the provider and turn its answer into the record to store via the tested
 * `applyIrpResult`. Provider-neutral — pass the sandbox provider here, or a real GSP connector implementing
 * the same port, and the downstream handling (never fabricating a signature, `unknown` as its own state) is
 * identical. Async because a real connector's `register` is.
 */
export async function registerViaProvider(input: {
  readonly invoiceId: string;
  readonly request: IrnRequest;
  readonly provider: EInvoiceProvider;
}): Promise<{ readonly result: IrpResult; readonly record: EInvoiceRecord }> {
  const result = await input.provider.register(input.request);
  const record = applyIrpResult({ invoiceId: input.invoiceId, result });
  return { result, record };
}
