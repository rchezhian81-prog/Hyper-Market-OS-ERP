// Statutory label character heights (roadmap v2.1 B24 — Legal Metrology / Packaged Commodities Rules,
// Rule 9). Mandatory declarations on a pack must be printed no smaller than a minimum height, set by
// the size of the principal display panel, so they are actually legible: a declaration printed too
// small is a non-compliant label even though every required word is present. This gives the minimum
// height for a panel and validates a self-printed template's character height against it — a too-small
// render FAILS rather than being quietly accepted.
//
// The height bands are Rule 9 (as amended): the minimum height of any letter or numeral rises with the
// area of the principal display panel. They are stated as named constants (a legal fact, not a guess),
// so a rule change is a one-line edit with a failing test, never a silent drift. Pure and deterministic.

/** Rule 9 minimum character-height bands: [maxPanelAreaCm2 (inclusive), minHeightMm]. Last band is open-ended. */
export const LABEL_HEIGHT_BANDS: readonly (readonly [number, number])[] = [
  [100, 1],   // panel ≤ 100 cm²  → ≥ 1 mm
  [500, 2],   // ≤ 500 cm²        → ≥ 2 mm
  [2500, 4],  // ≤ 2500 cm²       → ≥ 4 mm
];
/** Above the largest band, the minimum height is 6 mm. */
export const LABEL_HEIGHT_LARGE_PANEL_MM = 6;

export class InvalidLabelHeightInput extends Error {
  constructor(detail: string) {
    super(`Cannot assess the label height: ${detail}`);
    this.name = 'InvalidLabelHeightInput';
  }
}

const isPosNum = (n: number): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * The minimum character height (mm) a declaration must be printed at, for a principal display panel of
 * the given area (Rule 9). Rises by band with the panel size.
 *
 * @throws InvalidLabelHeightInput if the area is not a positive, finite number of square centimetres.
 */
export function minLabelHeightMm(principalPanelAreaCm2: number): number {
  if (!isPosNum(principalPanelAreaCm2)) {
    throw new InvalidLabelHeightInput('the principal display panel area must be a positive number of square centimetres');
  }
  for (const [maxArea, minHeight] of LABEL_HEIGHT_BANDS) {
    if (principalPanelAreaCm2 <= maxArea) return minHeight;
  }
  return LABEL_HEIGHT_LARGE_PANEL_MM;
}

export interface LabelHeightCheck {
  readonly principalPanelAreaCm2: number;
  readonly minHeightMm: number;
  readonly declaredHeightMm: number;
  readonly valid: boolean;
  readonly detail: string;
}

/**
 * Validate a self-printed template's character height against the Rule 9 minimum for its panel (B24).
 * A height below the minimum FAILS — a too-small declaration is a non-compliant label.
 *
 * @throws InvalidLabelHeightInput on a non-positive area or declared height.
 */
export function validateLabelHeight(input: {
  readonly principalPanelAreaCm2: number;
  readonly declaredHeightMm: number;
}): LabelHeightCheck {
  const minHeightMm = minLabelHeightMm(input.principalPanelAreaCm2); // validates the area
  if (!isPosNum(input.declaredHeightMm)) {
    throw new InvalidLabelHeightInput('the declared character height must be a positive number of millimetres');
  }
  const valid = input.declaredHeightMm >= minHeightMm;
  return {
    principalPanelAreaCm2: input.principalPanelAreaCm2,
    minHeightMm,
    declaredHeightMm: input.declaredHeightMm,
    valid,
    detail: valid
      ? `${input.declaredHeightMm} mm meets the ${minHeightMm} mm minimum for a ${input.principalPanelAreaCm2} cm² panel`
      : `${input.declaredHeightMm} mm is below the ${minHeightMm} mm minimum for a ${input.principalPanelAreaCm2} cm² panel — the label would be non-compliant`,
  };
}
