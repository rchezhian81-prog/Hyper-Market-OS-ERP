// A deterministic SANDBOX e-way-bill portal provider — the transport twin of the e-invoice sandbox GSP
// (owner directive §2 / A23). It implements the `EwayBillProvider` port with no credentials and no network,
// so the whole build → generate → apply loop can be driven and tested without a live portal account.
//
// Same disciplines: the EWB number is a deterministic 12-digit number derived from the movement's identity
// (so the same movement always yields the same number and a repeat is a genuine `duplicate`), there is no
// clock or randomness, and the output is unmistakably a sandbox — never a number any portal issued and
// never valid to travel with real goods. `applyEwbResult` downstream still refuses to store a malformed
// answer as generated.

import { createHash } from 'node:crypto';
import {
  applyEwbResult, ewayBillValidity,
  type EwayBillProvider, type EwayBillRequest, type EwbResult, type EwbRecord,
} from './e-way-bill';

export interface SandboxEwbOptions {
  /** Force every call to this outcome — for exercising the timeout/rejection branches in tests and demos. */
  readonly forceOutcome?: 'generated' | 'unknown' | 'rejected';
  readonly rejectReasons?: readonly string[];
  readonly unknownReason?: string;
  /** Road distance (km) used to compute validity on a generated bill. Defaults to 100 km (a 1-day bill). */
  readonly distanceKm?: number;
}

/** The sandbox provider narrows the port: `generate` is synchronous and deterministic (no clock, no I/O). */
export interface SandboxEwbProvider extends EwayBillProvider {
  generate(request: EwayBillRequest): EwbResult;
}

/** The idempotency basis the portal uses: consignor GSTIN + doc type + number + FY. */
export function sandboxEwbIdempotencyKey(request: EwayBillRequest): string {
  return `${request.supplierGstin}|${request.documentType}|${request.documentNumber}|${request.financialYear}`;
}

/** The deterministic sandbox 12-digit EWB number for a request (never a real portal number). */
export function sandboxEwbNumber(request: EwayBillRequest): string {
  const hash = createHash('sha256').update(sandboxEwbIdempotencyKey(request)).digest('hex');
  return (BigInt('0x' + hash.slice(0, 16)) % 1_000_000_000_000n).toString().padStart(12, '0');
}

/**
 * A provider-neutral sandbox e-way-bill portal. `generate` returns a deterministic `EwbResult`: the first
 * generation of a movement is `generated` (with a hash-derived 12-digit number, an ack date taken from the
 * document date, and a validity computed by distance); a repeat of the SAME movement is `duplicate` with
 * the same number; a non-positive consignment value is `rejected` even here. `forceOutcome` overrides
 * everything to exercise the timeout/rejection branches. Never contacts a network.
 */
export function sandboxEwbProvider(options: SandboxEwbOptions = {}): SandboxEwbProvider {
  const seen = new Set<string>();
  const distanceKm = options.distanceKm ?? 100;
  return {
    generate(request: EwayBillRequest): EwbResult {
      if (options.forceOutcome === 'unknown') {
        return { status: 'unknown', reason: options.unknownReason ?? 'sandbox: simulated portal timeout — the answer is UNKNOWN until reconciled' };
      }
      if (options.forceOutcome === 'rejected') {
        return { status: 'rejected', errors: options.rejectReasons ?? ['sandbox: simulated portal rejection'] };
      }
      if (!(typeof request.consignmentValueMinor === 'number' && request.consignmentValueMinor > 0)) {
        return { status: 'rejected', errors: ['sandbox: the consignment value must be a positive amount'] };
      }
      const key = sandboxEwbIdempotencyKey(request);
      const ewbNo = sandboxEwbNumber(request);
      const validUpto = ewayBillValidity({ distanceKm, generatedOn: request.documentDate }).validUpto;
      if (seen.has(key)) {
        return { status: 'duplicate', ewbNo, validUpto };
      }
      seen.add(key);
      return { status: 'generated', ewbNo, ewbDate: request.documentDate, validUpto };
    },
  };
}

/**
 * Close the loop in one step: call the provider and turn its answer into the record to store via the tested
 * `applyEwbResult`. Provider-neutral — pass the sandbox here, or a real portal connector on the same port,
 * and the downstream handling (never fabricating a number, `unknown` as its own state) is identical.
 */
export async function generateViaProvider(input: {
  readonly movementId: string;
  readonly request: EwayBillRequest;
  readonly provider: EwayBillProvider;
}): Promise<{ readonly result: EwbResult; readonly record: EwbRecord }> {
  const result = await input.provider.generate(input.request);
  const record = applyEwbResult({ movementId: input.movementId, result });
  return { result, record };
}
