// D-13 (R4, OB-219) — the image-recognition LINK for shelf photos, built switched off.
//
// The owner chose a photo on shelf checks plus a switched-off recognition link: nothing is bought, and staff counts remain
// the measure. So this is the port a recognition service would sit behind, and two implementations of it:
//
//   • `SWITCHED_OFF_SHELF_RECOGNITION` — the one the running system composes. It says it is off, and it SENDS NOTHING: its
//     `recognise` refuses before touching the photo, so no photo can leave the shop through it.
//   • `testStandInShelfRecognition` — a deterministic stand-in for tests only (it answers from a table it is given and
//     reaches nothing outside the process). It is never composed by the running system (a guardrail pins that).
//
// Whatever a recognition link answers is a SUGGESTION shown beside the staff count; it never changes the score.

export interface ShelfPhotoForRecognition {
  readonly photoId: string;
  readonly mediaType: string;
  readonly contentBase64: string;
}

export interface RecognisedFacing {
  readonly productId: string;
  readonly facingsSeen: number;
}

export interface ShelfImageRecognition {
  readonly state: 'switched_off' | 'test_stand_in';
  /** Words for the screen. */
  readonly detail: string;
  recognise(photo: ShelfPhotoForRecognition): Promise<readonly RecognisedFacing[]>;
}

export class RecognitionSwitchedOffError extends Error {
  constructor() {
    super('image recognition is switched off — no photo is sent anywhere');
    this.name = 'RecognitionSwitchedOffError';
  }
}

export const SWITCHED_OFF_SHELF_RECOGNITION: ShelfImageRecognition = Object.freeze({
  state: 'switched_off' as const,
  detail: 'Image recognition is switched off: no photo leaves the shop, and the score is the staff count.',
  recognise: async (): Promise<readonly RecognisedFacing[]> => { throw new RecognitionSwitchedOffError(); },
});

/** TESTS ONLY: answers from `table` (photo id → what it "saw"), and records what it was asked. Sends nothing anywhere. */
export function testStandInShelfRecognition(table: Readonly<Record<string, readonly RecognisedFacing[]>>): ShelfImageRecognition & { readonly asked: readonly string[] } {
  const asked: string[] = [];
  return {
    state: 'test_stand_in',
    detail: 'A test stand-in for image recognition — its answer is a suggestion beside the staff count, never the score.',
    asked,
    recognise: async (photo) => { asked.push(photo.photoId); return table[photo.photoId] ?? []; },
  };
}
