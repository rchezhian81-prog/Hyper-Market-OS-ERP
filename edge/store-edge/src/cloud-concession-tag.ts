// The till's concession docket line, translated for the cloud (M27-FR-03 · Item 3 · §31).
//
// A cashier at a partner counter's till records a docket line — which sale, which line, which product,
// how much — for the concession partner the counter belongs to. The box writes it durably first and queues
// it; this translates the disk record into the cloud's SYNCED contract (`POST /v1/concession/tags/synced`),
// which resolves the partner's active contract on the server, snapshots the commission scheme there, and
// records the tag under the CASHIER's relayed identity (as the synced return relays `processedBy`). Pure;
// the record is untrusted JSON off the disk, so every field is read defensively and nothing is invented.

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

export type CloudConcessionTagKind = 'sale' | 'return' | 'cancellation';
export type CloudConcessionActorRole = 'cashier' | 'supervisor' | 'store_manager';

/** What the cloud's synced route reads. The partner is named; the CONTRACT is resolved on the server. */
export interface CloudConcessionTag {
  readonly tagId: string;
  readonly kind: CloudConcessionTagKind;
  readonly saleId: string;
  readonly lineId: string;
  readonly productId: string;
  readonly concessionaireId: string;
  /** When the till knows the contract it may name it; otherwise the cloud finds the partner's active one. */
  readonly contractId?: string;
  readonly counterId: string;
  readonly tillId: string;
  readonly shiftId: string;
  readonly qty: number;
  readonly grossMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  /** The cashier who recorded it at the till, and their role — relayed, re-recorded by the cloud as such. */
  readonly capturedBy: string;
  readonly byRole: CloudConcessionActorRole;
  /** The approved source the cashier read the line from (docket / app reference). */
  readonly source: string;
  readonly at: string;
  readonly correctsTagId?: string;
}

const KINDS: readonly CloudConcessionTagKind[] = ['sale', 'return', 'cancellation'];
const ROLES: readonly CloudConcessionActorRole[] = ['cashier', 'supervisor', 'store_manager'];

export function toCloudConcessionTag(record: unknown): CloudConcessionTag {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  const kind = str(r['kind']);
  const role = str(r['byRole']);
  const contractId = str(r['contractId']);
  const correctsTagId = str(r['correctsTagId']);
  return {
    tagId: str(r['tagId']) ?? str(r['id']) ?? '',
    kind: KINDS.includes(kind as CloudConcessionTagKind) ? (kind as CloudConcessionTagKind) : 'sale',
    saleId: str(r['saleId']) ?? '',
    lineId: str(r['lineId']) ?? '',
    productId: str(r['productId']) ?? '',
    concessionaireId: str(r['concessionaireId']) ?? '',
    ...(contractId === undefined ? {} : { contractId }),
    counterId: str(r['counterId']) ?? '',
    tillId: str(r['tillId']) ?? '',
    shiftId: str(r['shiftId']) ?? '',
    qty: int(r['qty']) ?? 0,
    grossMinor: int(r['grossMinor']) ?? 0,
    discountMinor: int(r['discountMinor']) ?? 0,
    taxMinor: int(r['taxMinor']) ?? 0,
    capturedBy: str(r['capturedBy']) ?? '',
    // A role the till did not name, or one the engine does not know, is the NARROWEST — a cashier may
    // capture but never correct (§28); the cloud re-checks against the relayed identity anyway.
    byRole: ROLES.includes(role as CloudConcessionActorRole) ? (role as CloudConcessionActorRole) : 'cashier',
    source: str(r['source']) ?? '',
    at: str(r['at']) ?? '',
    ...(correctsTagId === undefined ? {} : { correctsTagId }),
  };
}

/** The tag's identity as written to the disk record — `tagId`, tolerating a bare `id`. */
export function concessionTagIdOf(record: unknown): string | undefined {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  return str(r['tagId']) ?? str(r['id']);
}
