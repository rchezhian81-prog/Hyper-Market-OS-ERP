// Accessibility — NFR-07 (WCAG 2.2 AA), NFR-13 (interaction budget), §10, §27.1.
//
// One implementation of the WCAG maths for the whole product, and the enforcement of the
// design-system rules that were previously only sentences in a document.

export {
  parseHex, relativeLuminance, contrastRatio, checkContrast, checkPalette, WCAG,
  type ContrastHundredths, type Rgb, type TextSize, type ContrastCheck,
  type PalettePair, type PaletteReport,
} from './contrast';

export {
  presentSyncBadge, presentStatus, checkTouchTarget, checkInteractionBudget, checkFocusOrder,
  WCAG_MINIMUM_TARGET_PX, DESIGN_SYSTEM_TARGET_PX,
  type Tone, type StatusPresentation, type ConnectionTone, type TargetCheck,
  type TaskBudget, type BudgetCheck, type FocusableItem, type FocusIssueKind, type FocusIssue,
  type FocusOrderReport,
} from './signals';
