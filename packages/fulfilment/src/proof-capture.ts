// Delivery proof that is CAPTURED, not typed (M19-FR-03 · WF-15 · D09-FR-05 · OB-294 · §31 · hard rules #6/#10).
//
// Three proofs, each decided here so the phone and head office run the same rule:
//
//   • THE DELIVERY CODE (OB-294, owner, 23 Oct 2026). Head office issues a 4-digit code per delivery order; the customer's
//     app shows it; the customer reads it out to the driver at the door. No SMS. The phone takes the four digits at
//     capture (anything else is refused there) and never holds the order's code or anything it could be worked out from —
//     a four-digit code behind any hint on the phone can be found by trying all 10,000. Head office checks the typed code
//     when the stop reaches it; a code it cannot match is an exception on the dispatcher's board, never a quiet delivery.
//   • THE PHOTO (or the customer's signature) is a real capture — the phone camera, or a finger on the screen — kept as a
//     document at head office with its SHA-256, never a reference somebody typed.
//   • THE PROOF LOCATION (D09-FR-05). The phone's own location at the moment of proof is compared at head office with the
//     stop's stored address coordinates. Only the RESULT is kept (inside / outside, and how far) — never the coordinates.
//     The radius is the owner's number: until he enters it the check says "radius not set" and decides nothing.
//
// Pure and deterministic. The random source and the clock are the caller's.

import { metresBetween } from '../../orders/src/fulfilment-plan';

/** OB-294: the delivery code is four digits. */
export const DELIVERY_CODE_DIGITS = 4;
const CODE = /^\d{4}$/;

export const isDeliveryCode = (v: unknown): v is string => typeof v === 'string' && CODE.test(v);

/** A new code from a uniform random integer source in [0, max) — the caller passes `crypto.randomInt`. */
export function newDeliveryCode(randomInt: (max: number) => number): string {
  const n = randomInt(10 ** DELIVERY_CODE_DIGITS);
  if (!Number.isInteger(n) || n < 0 || n >= 10 ** DELIVERY_CODE_DIGITS) throw new RangeError('the random source gave a number outside 0–9999');
  return String(n).padStart(DELIVERY_CODE_DIGITS, '0');
}

/** Compare two strings without stopping at the first difference. */
function equalText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type CodeVerdict =
  /** The code the driver typed is the one head office issued for the order. */
  | 'matched'
  /** A code was typed and it is not the order's — an exception for the dispatcher, never a quiet delivery. */
  | 'wrong'
  /** Head office never issued a code for this order, so a typed code proves nothing. */
  | 'not_issued'
  /** The proof was not a code (a photo or a signature). */
  | 'not_given';

/** Head office's check of the code the phone sent — the one that counts. */
export function judgeCode(issued: string | undefined, given: string | undefined): CodeVerdict {
  if (given === undefined) return 'not_given';
  if (issued === undefined) return 'not_issued';
  return isDeliveryCode(given) && equalText(issued, given) ? 'matched' : 'wrong';
}

// ── The proof location (D09-FR-05) ──────────────────────────────────────────────────────────────────────────────

export interface DeviceFix {
  readonly lat: number;
  readonly lon: number;
  /** How sure the phone says it is, in metres — kept beside the result, never used to stretch the radius. */
  readonly accuracyMetres?: number;
}

export type FenceVerdict =
  | { readonly result: 'inside'; readonly distanceMetres: number; readonly radiusMetres: number; readonly accuracyMetres?: number }
  | { readonly result: 'outside'; readonly distanceMetres: number; readonly radiusMetres: number; readonly accuracyMetres?: number }
  /** The owner has not entered the radius yet: the distance is said, nothing is decided. */
  | { readonly result: 'radius_not_set'; readonly distanceMetres: number; readonly accuracyMetres?: number }
  /** The phone gave no location (no permission, no fix in time). Recorded, never a block on the delivery. */
  | { readonly result: 'no_device_location' }
  /** Head office holds no coordinates for the stop's address, so there is nothing to compare with. */
  | { readonly result: 'no_address_location' };

export const isFix = (v: unknown): v is DeviceFix => {
  if (v === null || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  const lat = f['lat']; const lon = f['lon']; const acc = f['accuracyMetres'];
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    && (acc === undefined || (typeof acc === 'number' && Number.isFinite(acc) && acc >= 0));
};

/** Compare where the phone was at the proof with the stop's stored address. The coordinates are not part of the answer. */
export function judgeProofLocation(input: {
  readonly device: DeviceFix | undefined;
  readonly address: { readonly lat: number; readonly lon: number } | undefined;
  /** The owner's radius in whole metres; undefined while he has not entered it. */
  readonly radiusMetres: number | undefined;
}): FenceVerdict {
  if (input.address === undefined) return { result: 'no_address_location' };
  if (input.device === undefined) return { result: 'no_device_location' };
  const distanceMetres = metresBetween(input.device, input.address);
  const acc = input.device.accuracyMetres === undefined ? {} : { accuracyMetres: Math.round(input.device.accuracyMetres) };
  if (input.radiusMetres === undefined) return { result: 'radius_not_set', distanceMetres, ...acc };
  return { result: distanceMetres <= input.radiusMetres ? 'inside' : 'outside', distanceMetres, radiusMetres: input.radiusMetres, ...acc };
}

// ── The captured image (photo at the door, or the customer's signature) ────────────────────────────────────────

/** The proof kinds a driver may give. A card is not proof and not a payment here (hard rule #3). */
export const PROOF_KINDS = Object.freeze(['photo', 'otp', 'signature'] as const);
/** The kinds that are an image the phone captured. */
export const IMAGE_PROOF_KINDS: ReadonlySet<string> = new Set(['photo', 'signature']);

/** The largest proof image the phone keeps and sends, in base64 characters — small enough for a cheap phone's storage and
 *  for the store computer's device batch, large enough to see a parcel on a doorstep. */
export const PROOF_IMAGE_MAX_BASE64 = 60_000;

/** The reference a captured proof is known by everywhere: its kind and its fingerprint. Never typed by a person. */
export function proofRefOf(kind: string, sha256OrCode: string): string {
  return kind === 'otp' ? 'otp:code-entered' : `${kind}:sha256:${sha256OrCode}`;
}
