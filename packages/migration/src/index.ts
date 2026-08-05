// The migration pipeline — MG-01…MG-12 (§34, WF-19, QG-07, OD-05, OD-06).
//
// Ordered as the pipeline runs, so the barrel reads as the sequence: discover and preserve, map,
// clean, trial load, reconcile and sign, open the ledger, delta, parallel run, cut over or roll
// back, archive.

export {
  inventorySources, sealExtract, verifyExtract, simpleHasher,
  type LegacySource, type SourceKind, type VolumeBasis, type DiscoveryGap, type DiscoveryGapKind,
  type DiscoveryResult, type Hasher, type SealedExtract, type SealResult, type VerifyResult,
  type PreservationRefusal,
} from './discovery';

export {
  approveMapping, mapValue, assessCoverage,
  type MappingDomain, type MappingEntry, type MappingStatus, type MappingTable,
  type ApprovalRefusal, type ApprovalResult, type MapValueResult, type MappingCoverage,
  type CoverageReport,
} from './mapping';

export {
  detectExceptions, summariseCleaning, resolveException, buildMergeMap, outstandingExceptions,
  type ExceptionKind, type Confidence, type Severity, type MigrationException,
  type ResolutionAction, type ExceptionResolution, type CleaningReport, type ResolveRefusal,
  type ResolveResult, type MergeRecord, type OutstandingExceptions,
} from './cleaning';

export {
  assertNonProduction, runTrialLoad, applyDelta,
  type TargetKind, type LoadTarget, type NonProductionAssertion, type TrialRefusal,
  type TrialLoadPlan, type TrialLoadResult, type DeltaOperation, type DeltaChange,
  type DeltaOutcome, type DeltaLine, type DeltaResult,
} from './trial';

export {
  recordControlTotal, assessReconciliation, signControlTotal, buildOpeningEvents,
  type TotalKind, type TotalUnit, type ControlTotal, type TotalSignature, type TotalRefusal,
  type RecordTotalResult, type TotalStatus, type TotalAssessment, type ReconciliationReport,
  type SignRefusal, type SignResult, type OpeningKind, type OpeningEvent, type OpeningRefusal,
  type OpeningResult,
} from './reconcile';

export {
  proposeExclusion, approveExclusion, exclusionPosition, assessRetirement,
  type ExclusionScope, type ExclusionStatus, type HistoryExclusion, type ProposeRefusal,
  type ProposeResult, type ApproveExclusionRefusal, type ApproveExclusionResult,
  type ExclusionPosition, type LegacyArchive, type RetireBlocker, type RetirementAssessment,
} from './history';

export {
  compareParallelDay, ownDifference, parallelRunPosition, decideCutover, performRollback,
  type ComparisonArea, type DayComparison, type DifferenceStatus, type ParallelDifference,
  type ParallelDayResult, type OwnRefusal, type OwnResult, type ParallelRunPosition,
  type CutoverCheck, type CutoverChecklist, type CutoverDecision, type RollbackTrigger,
  type RollbackResult,
} from './cutover';

export {
  generateLegacyDataset, datasetChecksum,
  type FaultKind, type LegacyProduct, type LegacyStockRow, type LegacyCustomer,
  type LegacySupplier, type LegacyDocument, type LegacyDocumentLine, type LegacyDataset,
  type GeneratorOptions,
} from './synthetic';

export {
  assessRoute, planVerification, assessExtractionReadiness,
  METHOD_FIDELITY, VERIFIES, EXTERNAL_SOURCE_NOTE,
  type ExtractionMethod, type DataDomain, type ExtractionRoute, type RouteRisk,
  type RouteAssessment, type ExternalSource, type VerificationPlan, type PlanRefusal,
  type VerificationResult, type ReadinessBlocker, type ExtractionReadiness,
} from './extraction';

export {
  parseReportMoney, parseReportQuantity, classifyRow, parseReport, checkAgainstPrintedTotal,
  type ParsedMoney, type RowKind, type ClassifiedRow, type ParsedSubtotal,
  type ParsedReport, type ParseRefusal, type ParseResult, type ParseCheck,
} from './report-parser';

export {
  formatIndianMoney, renderStockReport, checkRoundTrip,
  type RenderOptions, type RoundTrip,
} from './render-report';

export {
  checkExportCompleteness, compareDoubleKeyed,
  type CompletenessSignal, type CompletenessVerdict, type SignalResult,
  type CompletenessCheck, type KeyingDifference, type DoubleKeyResult,
} from './completeness';

export {
  planCountSample, assessCountVerification,
  type StockLine, type Stratum, type CountLine, type CountPlan, type PlanResult,
  type CountedLine, type LineVariance, type CountVerification,
} from './count-verification';

export {
  reconcileSupplierStatement, supplierPosition, balanceOf, EFFECT_ON_WHAT_WE_OWE,
  type LedgerItem, type ItemStatus, type TimingPlausibility, type ReconciledItem,
  type SupplierReconciliation, type SupplierPosition,
} from './supplier-reconciliation';

export {
  verifySalesAgainstBank, acceptRouteTerms, expectedCredit, bpsOf,
  type TenderRoute, type TermsSource, type RouteTerms, type DailyTakings, type BankCredit,
  type TermsRefusal, type TermsAcceptance, type UnbankedDay, type RouteResult,
  type BankVerification,
} from './banking-verification';

export {
  acceptFiledReturn, reconcileTaxPeriod, taxPosition, taxOf, STATUTORY_SLABS_BPS,
  type ReturnKind, type TaxSlabLine, type FiledReturn, type ReturnRefusal,
  type ReturnAcceptance, type SlabStatus, type SlabComparison,
  type TaxPeriodReconciliation, type TaxPosition,
} from './tax-verification';

export {
  acceptSignedAccounts, reconcileOpeningBooks, looksLikeABalancingFigure, balanceOfLine,
  expectedSide, NATURAL_SIDE, ONLY_THE_CA_HAS,
  type AccountNature, type TrialBalanceLine, type SignedAccounts, type AccountsRefusal,
  type AccountsAcceptance, type LineStatus, type LineComparison, type WrongSideFlag,
  type OpeningBooksRefusal, type OpeningBooksReconciliation,
} from './books-verification';

export {
  planLoyaltySample, assessLoyaltyVerification,
  type LoyaltyBalance, type ConfirmationMethod, type CustomerConfirmation, type SampleSource,
  type SampleRefusal, type SampleLine, type LoyaltySamplePlan, type SamplePlanResult,
  type BalanceFinding, type BalanceCheck, type TierChange, type VerificationRefusal,
  type LoyaltyVerification,
} from './loyalty-verification';
