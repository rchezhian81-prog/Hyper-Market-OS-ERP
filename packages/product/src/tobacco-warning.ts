// Tobacco pack health warning (roadmap v2.1 B16 · COTPA 2003 s.7 and the Packaging & Labelling Rules · OB-140 "A").
//
// Every tobacco pack must carry the pictorial + text health warning covering 85% of its main face, in the picture the
// government has NOTIFIED for the period. The till cannot see the pack. So, as the owner decided (OB-140 "A", 16 Oct
// 2026): **a named person confirms each tobacco product once — when it is listed, and again each time the government
// notifies a new picture.** A product with no confirmation for the picture in force cannot be sold.
//
// This module is the one rule, pure and clockless ("today" is passed in):
//
//   • the REGISTER of notified pictures — each with the day it takes effect;
//   • the picture IN FORCE on a day — the latest one whose effective day has come;
//   • a product's STANDING on a day — confirmed for the picture in force, or not (never confirmed, or confirmed only for
//     an earlier picture: the confirmation has EXPIRED), or no picture notified at all (nothing can be confirmed yet);
//   • the last day a confirmation stays good — the day before the next notified picture takes effect — which the signed
//     pack carries so a till with no network stops selling it on that day by its own clock.
//
// There is no override and no "confirm all": each confirmation names one product, one picture and one person.

/** One picture the government has notified (a G.S.R. notification under the Packaging & Labelling Rules). */
export interface WarningImage {
  readonly imageId: string;
  /** The day packs must carry this picture (YYYY-MM-DD). */
  readonly effectiveFrom: string;
  /** The day it was notified (YYYY-MM-DD). */
  readonly notifiedOn: string;
  /** The notification's number, as printed (e.g. "G.S.R. 458(E)"). */
  readonly reference: string;
  /** Where the notification itself is kept (a document reference). */
  readonly evidenceRef: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** A named person's confirmation that a product's packs carry a picture's warning. */
export interface WarningConfirmation {
  readonly imageId: string;
  /** The person (their sign-in id) — never a shared login (hard rule #4). */
  readonly confirmedBy: string;
  /** Their name as head office holds it, for the record. */
  readonly confirmedByName: string;
  readonly confirmedAt: string;
  /** What they looked at — a photograph of the pack, a delivery note (a document reference). */
  readonly evidenceRef: string;
}

/** What a tobacco product's record carries about its warning: the pictures known when it was last stamped, and its confirmations. */
export interface TobaccoWarningRecord {
  readonly images: readonly WarningImage[];
  readonly confirmations: readonly WarningConfirmation[];
}

export type WarningStanding =
  | { readonly sellable: true; readonly reason: 'confirmed'; readonly image: WarningImage; readonly confirmation: WarningConfirmation; readonly goodUntil?: string }
  | { readonly sellable: false; readonly reason: 'no_picture_notified' | 'never_confirmed' | 'confirmation_expired'; readonly image?: WarningImage; readonly detail: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The day before a YYYY-MM-DD date. */
function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The picture in force on `day`: the latest whose effective day has come (ties: the later-recorded wins). */
export function pictureInForce(images: readonly WarningImage[], day: string): WarningImage | undefined {
  return [...images]
    .filter((i) => DATE.test(i.effectiveFrom) && i.effectiveFrom <= day)
    .sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? (a.recordedAt < b.recordedAt ? -1 : 1) : a.effectiveFrom < b.effectiveFrom ? -1 : 1))
    .at(-1);
}

/** The next picture after the one in force on `day`, if one is already notified. */
export function nextPicture(images: readonly WarningImage[], day: string): WarningImage | undefined {
  return [...images].filter((i) => DATE.test(i.effectiveFrom) && i.effectiveFrom > day).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0];
}

/**
 * May this tobacco product be sold on `day` (YYYY-MM-DD)? Only with a named person's confirmation for the picture in
 * force that day. A confirmation for an earlier picture has EXPIRED; none at all is never confirmed; no picture notified
 * means nothing can be confirmed, so it is not sellable either (P-08: said, never assumed).
 */
export function warningStanding(record: TobaccoWarningRecord | undefined, day: string): WarningStanding {
  const images = record?.images ?? [];
  const image = pictureInForce(images, day);
  if (image === undefined) {
    return { sellable: false, reason: 'no_picture_notified', detail: 'no government health-warning picture is on record for this date, so nobody can confirm the packs carry it' };
  }
  const confirmation = (record?.confirmations ?? []).filter((c) => c.imageId === image.imageId).at(-1);
  if (confirmation === undefined) {
    const earlier = (record?.confirmations ?? []).length > 0;
    return {
      sellable: false, reason: earlier ? 'confirmation_expired' : 'never_confirmed', image,
      detail: earlier
        ? `its warning was confirmed for an earlier picture; picture ${image.imageId} (${image.reference}) is in force from ${image.effectiveFrom} and nobody has confirmed the packs carry it`
        : `nobody has confirmed its packs carry the warning picture ${image.imageId} (${image.reference}) in force from ${image.effectiveFrom}`,
    };
  }
  const next = nextPicture(images, day);
  return { sellable: true, reason: 'confirmed', image, confirmation, ...(next === undefined ? {} : { goodUntil: dayBefore(next.effectiveFrom) }) };
}

/** True when a product master record is a tobacco product (the one fact B14 and B16 both read). */
export function isTobacco(record: { readonly safety?: { readonly tobacco?: boolean } }): boolean {
  return record.safety?.tobacco === true;
}
