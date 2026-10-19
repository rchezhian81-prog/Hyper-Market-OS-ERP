// D-21 (R4, OB-217) — one view that puts together, for a product or a cashier and a period, the till exceptions (voids,
// no-sale opens, price overrides, refunds), the recorded waste and shrink, and the count differences — and PROPOSES a case.
//
// It proposes; it never opens. A person reads the view and decides whether to open a case (through the existing case
// route, naming an investigator), so nothing is opened, and nothing is blamed on anyone, by itself (P-05). The proposal
// names the facts, not a culprit: "these happened together", never "this person took it".
//
//   • For a PRODUCT: every till exception on that product, its write-offs, and its count differences.
//   • For a CASHIER: every till exception they rang, and the write-offs and count differences of the PRODUCTS those
//     exceptions touched — the join is by product, because waste and counts are not rung by a cashier.
//   • A case is proposed when a till exception and a loss (a write-off, or a count that came up short) fall in the same
//     view — the correlation the requirement asks for. One kind alone is said, and nothing is proposed.
//
// Pure and deterministic: no clock, no I/O.

export type TillExceptionKind = 'void' | 'no_sale' | 'price_override' | 'refund';

export interface TillExceptionFact {
  readonly ref: string;
  readonly kind: TillExceptionKind;
  readonly cashierId: string;
  /** The product, when the exception was on one line (a refund names every product it took back). */
  readonly productIds: readonly string[];
  readonly valueMinor: number;
  /** The shop's trading day (YYYY-MM-DD). */
  readonly day: string;
  readonly reason?: string;
}

export interface ShrinkFact {
  readonly ref: string;
  readonly productId: string;
  /** The write-off's loss type (wastage, damage, expiry, donation, destruction). */
  readonly lossType: string;
  readonly reasonCode: string;
  readonly quantityMinor: number;
  readonly valueMinor: number;
  readonly day: string;
}

export interface CountDifferenceFact {
  readonly ref: string;
  readonly productId: string;
  /** counted − expected: negative is a shortage. */
  readonly varianceMinor: number;
  readonly valueMinor: number;
  readonly day: string;
}

export type CorrelationSubject = { readonly kind: 'product'; readonly productId: string } | { readonly kind: 'cashier'; readonly cashierId: string };

export interface CaseProposal {
  /** True when the view holds a till exception AND a loss — a person may open a case from it. Nothing is opened here. */
  readonly propose: boolean;
  readonly because: string;
  /** What a case opened from this view is raised from — the view itself, so the case never "appears from nowhere". */
  readonly raisedFromRef: string;
  readonly subjectRef: string;
  /** Facts, never a finding about a person. */
  readonly summary: string;
  /** The loss in the view: write-offs plus count shortages, at their recorded values. */
  readonly valueMinor: number;
  /** The references a person may attach as evidence. */
  readonly evidenceRefs: readonly string[];
}

export interface CorrelationView {
  readonly subject: CorrelationSubject;
  readonly from: string;
  readonly to: string;
  readonly tillExceptions: readonly TillExceptionFact[];
  readonly shrink: readonly ShrinkFact[];
  readonly countDifferences: readonly CountDifferenceFact[];
  /** For a cashier view: the products their exceptions touched (the join for waste and counts). */
  readonly productsJoined: readonly string[];
  readonly totals: {
    readonly tillExceptions: Readonly<Record<TillExceptionKind, number>>;
    readonly tillExceptionValueMinor: number;
    readonly shrinkValueMinor: number;
    readonly countShortageValueMinor: number;
    readonly countOverValueMinor: number;
  };
  readonly proposal: CaseProposal;
  /** Always false: this view opens nothing and names no one as responsible. */
  readonly opened: false;
}

const inPeriod = (day: string, from: string, to: string): boolean => day >= from && day <= to;

export function correlateLosses(input: {
  readonly subject: CorrelationSubject;
  readonly from: string;
  readonly to: string;
  readonly tillExceptions: readonly TillExceptionFact[];
  readonly shrink: readonly ShrinkFact[];
  readonly countDifferences: readonly CountDifferenceFact[];
}): CorrelationView {
  const { subject, from, to } = input;
  const byRef = <T extends { ref: string; day: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => a.day.localeCompare(b.day) || a.ref.localeCompare(b.ref));
  const till = byRef(input.tillExceptions.filter((t) => inPeriod(t.day, from, to)
    && (subject.kind === 'product' ? t.productIds.includes(subject.productId) : t.cashierId === subject.cashierId)));
  const products = subject.kind === 'product' ? [subject.productId] : [...new Set(till.flatMap((t) => t.productIds))].sort();
  const productSet = new Set(products);
  const shrink = byRef(input.shrink.filter((s) => inPeriod(s.day, from, to) && productSet.has(s.productId)));
  const counts = byRef(input.countDifferences.filter((c) => inPeriod(c.day, from, to) && productSet.has(c.productId) && c.varianceMinor !== 0));

  const kinds: Record<TillExceptionKind, number> = { void: 0, no_sale: 0, price_override: 0, refund: 0 };
  for (const t of till) kinds[t.kind] += 1;
  const shortage = counts.filter((c) => c.varianceMinor < 0);
  const totals = {
    tillExceptions: kinds,
    tillExceptionValueMinor: till.reduce((s, t) => s + t.valueMinor, 0),
    shrinkValueMinor: shrink.reduce((s, x) => s + x.valueMinor, 0),
    countShortageValueMinor: shortage.reduce((s, c) => s + Math.abs(c.valueMinor), 0),
    countOverValueMinor: counts.filter((c) => c.varianceMinor > 0).reduce((s, c) => s + Math.abs(c.valueMinor), 0),
  };
  const subjectRef = subject.kind === 'product' ? `product:${subject.productId}` : `cashier:${subject.cashierId}`;
  const lossCount = shrink.length + shortage.length;
  const propose = till.length > 0 && lossCount > 0;
  const words = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const facts = `${words(till.length, 'till exception')}, ${words(shrink.length, 'write-off')} and ${words(shortage.length, 'count shortage')} for ${subjectRef} between ${from} and ${to}`;
  const because = propose
    ? `${facts} fall in the same period — worth a person's look; a case is opened only if a person decides to`
    : till.length === 0 && lossCount === 0
      ? `nothing recorded for ${subjectRef} between ${from} and ${to} — nothing to propose`
      : till.length === 0
        ? `${facts}: losses with no till exception beside them — nothing to correlate, so no case is proposed`
        : `${facts}: till exceptions with no loss beside them — nothing to correlate, so no case is proposed`;
  return {
    subject, from, to, tillExceptions: till, shrink, countDifferences: counts, productsJoined: products, totals,
    proposal: {
      propose, because,
      raisedFromRef: `lp-correlation:${subjectRef}:${from}:${to}`,
      subjectRef,
      summary: `Seen together: ${facts}. Recorded facts only — no finding about anyone.`,
      valueMinor: totals.shrinkValueMinor + totals.countShortageValueMinor,
      evidenceRefs: [...till.map((t) => t.ref), ...shrink.map((s) => s.ref), ...shortage.map((c) => c.ref)],
    },
    opened: false,
  };
}

// ── CCTV as a reference only (OB-217) ───────────────────────────────────────────────────────────────────────────────

/** A CCTV clip, as the shop records it: which camera, from when to when, and who collected it. No video, ever. */
export interface CctvReference {
  readonly cameraId: string;
  readonly from: string;
  readonly to: string;
  readonly collectedBy: string;
}

/** Field names that would carry video or a link to it — refused by name, because no video is stored or analysed. */
export const CCTV_VIDEO_FIELDS = Object.freeze(['video', 'clip', 'file', 'content', 'contentBase64', 'data', 'url', 'link', 'frames', 'image', 'stream'] as const);

export type CctvRefusal = 'video_not_stored' | 'not_readable_as_a_cctv_reference' | 'cctv_period_backwards';

/** Check a CCTV reference body: camera, from, to (ISO times, from before to) and who collected it — and nothing else. */
export function readCctvReference(body: Readonly<Record<string, unknown>>): { readonly ok: true; readonly ref: CctvReference } | { readonly ok: false; readonly refusal: CctvRefusal; readonly detail: string } {
  const video = CCTV_VIDEO_FIELDS.filter((f) => body[f] !== undefined);
  if (video.length > 0) {
    return { ok: false, refusal: 'video_not_stored', detail: `a CCTV clip is recorded only as a reference (camera, time from and to, who collected it) — no video is stored or analysed, so ${video.join(', ')} is not accepted` };
  }
  const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 80;
  const iso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
  if (!str(body['cameraId']) || !iso(body['from']) || !iso(body['to']) || !str(body['collectedBy'])) {
    return { ok: false, refusal: 'not_readable_as_a_cctv_reference', detail: 'a CCTV reference needs { cameraId, from, to (times), collectedBy }' };
  }
  if (Date.parse(body['from'] as string) >= Date.parse(body['to'] as string)) {
    return { ok: false, refusal: 'cctv_period_backwards', detail: 'the clip\'s "from" time must be before its "to" time' };
  }
  return { ok: true, ref: { cameraId: (body['cameraId'] as string).trim(), from: new Date(body['from'] as string).toISOString(), to: new Date(body['to'] as string).toISOString(), collectedBy: (body['collectedBy'] as string).trim() } };
}

/** The evidence reference string a CCTV reference is kept as on the case — the reference, never the material. */
export const cctvEvidenceRef = (r: CctvReference): string => `cctv:camera=${r.cameraId};from=${r.from};to=${r.to}`;
