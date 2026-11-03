// THE OFFICE PAGES HEAD OFFICE ANSWERS, SERVED BY THE STORE COMPUTER — OB-380 (owner, 26 Oct 2026, in writing) · P-01 ·
// P-04 · P-07 · P-08.
//
// Before OB-380 these pages existed in `apps/web-erp/web` but no product component served them: the menu marked them
// `unserved` and left them out, so staff could not reach them in the shop. They are thin clients — every figure on them
// is head office's, read live under the signed-in person's own session, and every act is head office's to accept or
// refuse. So the store computer serves them EXACTLY as it serves its other head-office-backed pages (the Approvals page
// is the model, ADR-0024):
//
//   • the same front door and sign-in — on the store PC the office PIN (OB-259), behind the hosted front its sign-in;
//   • the same permission check — the screen's own menu item names the word the box checks before it serves the page;
//   • the same payload — only WHO is looking (their id and their permissions from this box's role register, filled in
//     by `asSignedInPerson`); the box puts no head-office figure of its own on these pages, so it can never serve a
//     stale copy as current (P-08);
//   • the same same-origin `/v1` reads and writes — answered by the front that carries head office's API on the same
//     origin. Where nothing does (a bare store computer), the box never answers `/v1` itself: the call fails as a lost
//     link (screen-server.ts), and each page says in its own words that head office cannot be reached — never a copy.
//
// The pilot holds stay where they are: payroll's approve, lock and bank file are refused by head office's hard switch
// (OB-228 · OB-209) whatever page asks, and the box's payroll page is a READ-ONLY view (no state change is offered).

/** One page: the box's screen name (its path segment), the file in `apps/web-erp/web`, and the global its bundle reads. */
export interface HeadOfficePage {
  readonly screen: string;
  readonly file: string;
  readonly global: string;
}

/** The screen names, as a tuple so `SCREENS` (screen-data.ts) keeps one literal type per screen. */
export const HEAD_OFFICE_PAGE_SCREENS = Object.freeze([
  'requisitions', 'supplier-scorecard', 'supplier-bills', 'supplier-submissions', 'floor-heat-map', 'planogram-compliance',
  'count-plans', 'transfers', 'finance-close', 'tally-files', 'concessions', 'payroll', 'my-payslip', 'organisation',
  'delegation', 'incidents', 'store-computers', 'rollout', 'scales', 'food-safety', 'price-integrity', 'store-tasks',
  'my-tasks', 'waste-analytics', 'schedule', 'customers', 'loyalty', 'campaigns', 'basket-affinity', 'demand-events',
  'morning-brief', 'owner-alerts', 'setup', 'b2b', 'dispatch', 'order-refunds', 'gates', 'access-review', 'approval-rules',
  'adoption', 'appointment-letters', 'related-parties', 'posh-report', 'itc-review', 'epr', 'online-store',
  'product-content',
  // QG-02 lane 1 R4: the four new head-office pages, served the same way.
  'dock-diary', 'blanket-orders', 'promotion-funding', 'switches',
  // OB-391 (owner, 26 Oct 2026): the company report, now that it reads head office's own branches and company.
  'company-report',
  // QG-02 · OB-404 (owner, 27 Oct 2026): Supplier rebates — the schemes, the claims and the money, served the same way.
  'rebates',
  // Round 6 (OB-380: the store computer serves every office page head office answers): Scrap and recycling (M28-FR-02),
  // Packaging and crates (M28-FR-03) and Compare side by side (M29-FR-02 · §27 Owner "branch comparison").
  'scrap', 'packaging', 'branch-compare',
  // Round 7 (R7-C · OB-380): Shelf tags (OB-505 · B3) and Quotations (OB-506 · M12-FR-02).
  'shelf-tags', 'quotations',
  // Round 8 (R8-C · OB-522 · OB-380): Staff certificates.
  'certificates',
  // OB-609 (owner, 29 Oct 2026): Bill findings and attendance flags.
  'findings',
  // Round 4a (M03-FR-01..04 · M05-FR-01 · WF-01): the product-master and price-list pages.
  'product-details', 'product-categories', 'product-merges', 'tax-rates', 'price-lists', 'offer-results',
  // Round 4c (people and administration): Users & roles, Audit log, Staff list and shifts, Settings and their history.
  'users', 'audit-log', 'staff', 'settings', 'posh-committee', 'branches', 'do-not-contact', 'cert-in',
  // Wave 2 · Round 4a part 2: shelf and floor setup, supplier display space, store groups and seasons, product checks.
  'space-setup', 'display-contracts', 'range-clusters', 'product-checks',
  // Round 4d (money, facilities and production): the accounts set-up (posting map and Tally names), the facilities set-up.
  'posting-map', 'facilities-setup', 'production-recipes',
  // W3 (customers): data requests (M16-FR-03), customer value (D07-FR-05), the message queue (M31-FR-04), compensation limits
  // (M21-FR-03) and gift cards (D07-FR-04).
  'data-requests', 'customer-value', 'message-queue', 'compensation-limits', 'gift-cards',
  // Wave 3 (security, people and operations): emergency access, safety incidents, operational alerts, document retention,
  // sales commission.
  'emergency-access', 'safety-incidents', 'ops-alerts', 'document-retention', 'sales-commission',
  // W4 (M35-FR-03): Failed jobs — the background jobs that failed, and send one round again.
  'failed-jobs',
  // Wave 3 (OB-675 · QG-02): Training checks — the scored check per role.
  'training-checks',
  // W3 (money): Card, UPI and bank — settlement files, bank statements, cash deposits, cases and payment disputes.
  'settlement',
  // W3 (M18 · D05-FR-03): the online-orders desk and the delivery area and slots.
  'online-orders', 'delivery-area',
  // Wave 3 (D14-FR-05/06 · M36-FR-02/04): partner webhooks, partners and sandboxes, the developer guide, the floor devices
  // (shelf labels, RFID, cameras) and the shop's own name and colours — head-office pages over their own routes.
  'partner-webhooks', 'partners', 'developer-docs', 'floor-devices', 'branding',
  // W3 (migration controls): Old system checks — MG-01/03/07/08/09/11/12 head-office routes that had no screen.
  'old-system',
  // W4 (M11-FR-02): Production costs — Finance reviews what each production run's output cost.
  'production-costs',
] as const);
export type HeadOfficePageScreen = (typeof HEAD_OFFICE_PAGE_SCREENS)[number];

/** Where a page's file differs from its screen name. */
const FILE_OF: Readonly<Partial<Record<HeadOfficePageScreen, string>>> = Object.freeze({
  'my-payslip': 'payroll-payslip.html',
});

/** The global each page's bundle reads at boot (apps/web-erp/src/browser-entry.ts and its wiring files). */
const GLOBAL_OF: Readonly<Record<HeadOfficePageScreen, string>> = Object.freeze({
  requisitions: 'requisitionsData',
  'supplier-scorecard': 'supplierScorecardData',
  'supplier-bills': 'supplierBillsData',
  'supplier-submissions': 'supplierSubmissionsData',
  'floor-heat-map': 'floorHeatMapData',
  'planogram-compliance': 'planogramBaysData',
  'count-plans': 'countPlansData',
  transfers: 'transfersData',
  'finance-close': 'financeCloseData',
  'tally-files': 'tallyFilesData',
  concessions: 'concessionsData',
  payroll: 'payrollData',
  'my-payslip': 'payrollEssData',
  organisation: 'organisationData',
  delegation: 'delegationData',
  incidents: 'incidentsData',
  'store-computers': 'storeComputersData',
  rollout: 'rolloutData',
  scales: 'scalesData',
  // The five store-operations pages share one tested session (store-ops-session.ts) and so one global.
  'food-safety': 'storeOpsData',
  'price-integrity': 'storeOpsData',
  'store-tasks': 'storeOpsData',
  'my-tasks': 'storeOpsData',
  'waste-analytics': 'storeOpsData',
  schedule: 'scheduleData',
  customers: 'customersData',
  loyalty: 'loyaltyDeskData',
  campaigns: 'campaignsData',
  'basket-affinity': 'basketAffinityData',
  'demand-events': 'demandEventsData',
  'morning-brief': 'morningBriefData',
  'owner-alerts': 'ownerAlertsData',
  setup: 'setupData',
  b2b: 'b2bDeskData',
  dispatch: 'dispatchData',
  'order-refunds': 'orderRefundsData',
  gates: 'gatesData',
  'access-review': 'accessReviewData',
  'approval-rules': 'approvalRulesData',
  adoption: 'adoptionData',
  'appointment-letters': 'appointmentLettersData',
  'related-parties': 'relatedPartiesData',
  'posh-report': 'poshReportData',
  'itc-review': 'itcReviewData',
  epr: 'eprData',
  'online-store': 'onlineStoreData',
  'product-content': 'productContentData',
  'dock-diary': 'dockDiaryData',
  'blanket-orders': 'blanketOrdersData',
  'promotion-funding': 'promotionFundingData',
  switches: 'switchesData',
  'company-report': 'companyReportData',
  rebates: 'rebatesData',
  scrap: 'scrapData',
  packaging: 'packagingData',
  'branch-compare': 'branchCompareData',
  'shelf-tags': 'shelfTagsData',
  quotations: 'quotationsData',
  certificates: 'certificatesData',
  findings: 'findingsData',
  'product-details': 'productDetailsData',
  'product-categories': 'productCategoriesData',
  'product-merges': 'productMergesData',
  'tax-rates': 'taxRatesData',
  'price-lists': 'priceListsData',
  'offer-results': 'offerResultsData',
  users: 'usersData',
  'audit-log': 'auditLogData',
  staff: 'staffData',
  settings: 'settingsData',
  'posh-committee': 'poshCommitteeData',
  branches: 'branchesData',
  'do-not-contact': 'doNotContactData',
  'cert-in': 'certInData',
  'space-setup': 'spaceSetupData',
  'display-contracts': 'displayContractsData',
  'range-clusters': 'rangeClustersData',
  'product-checks': 'productChecksData',
  'posting-map': 'postingMapData',
  settlement: 'settlementBankData',
  'facilities-setup': 'facilitiesSetupData',
  'production-recipes': 'productionRecipesData',
  'data-requests': 'dataRequestsData',
  'customer-value': 'customerValueData',
  'message-queue': 'messageQueueData',
  'compensation-limits': 'compensationLimitsData',
  'gift-cards': 'giftCardsData',
  'emergency-access': 'emergencyAccessData',
  'safety-incidents': 'safetyIncidentsData',
  'ops-alerts': 'opsAlertsData',
  'failed-jobs': 'failedJobsData',
  'document-retention': 'documentRetentionData',
  'sales-commission': 'salesCommissionData',
  'training-checks': 'trainingChecksData',
  'online-orders': 'onlineOrdersData',
  'delivery-area': 'deliveryAreaData',
  'partner-webhooks': 'partnerWebhooksData',
  partners: 'partnersData',
  'developer-docs': 'developerDocsData',
  'floor-devices': 'floorDevicesData',
  branding: 'brandingData',
  'old-system': 'oldSystemData',
  'production-costs': 'productionCostsData',
});

export const HEAD_OFFICE_PAGES: readonly HeadOfficePage[] = Object.freeze(HEAD_OFFICE_PAGE_SCREENS.map((screen) => Object.freeze({
  screen, file: FILE_OF[screen] ?? `${screen}.html`, global: GLOBAL_OF[screen],
})));

/** Screen → global, for screen-data.ts `GLOBAL_FOR`. */
export const HEAD_OFFICE_PAGE_GLOBALS: Readonly<Record<HeadOfficePageScreen, string>> = GLOBAL_OF;
/** Screen → shell, for screen-server.ts `APP_SHELL`. */
export const HEAD_OFFICE_PAGE_SHELLS = Object.freeze(Object.fromEntries(HEAD_OFFICE_PAGES.map((p) => [p.screen, Object.freeze({ dir: 'web-erp', file: p.file })]))) as Readonly<Record<HeadOfficePageScreen, { readonly dir: string; readonly file: string }>>;

export function isHeadOfficePage(screen: string): screen is HeadOfficePageScreen {
  return (HEAD_OFFICE_PAGE_SCREENS as readonly string[]).includes(screen);
}

/**
 * A head-office page's payload: only that the box served it and that WHO is looking is to be filled in. `permissions: []`
 * is the shape `asSignedInPerson` readdresses to the signed-in person's own words; nobody signed in → no id, and each page
 * says nobody is named and offers nothing. `servedBy` tells the page its figures are head office's live answer, never a
 * copy this box holds — the payroll page uses it to show its read-only view (OB-228).
 */
export function headOfficePagePayload(): Record<string, unknown> {
  return { permissions: [], servedBy: 'store_computer' };
}

/** The part of the store pack a page's own store is read from (its branch, as head office names it). */
interface PackBranchSource { readonly pack: { readonly policies: { readonly known: boolean; readonly value?: { readonly branchId?: string | null } } } }

/**
 * OB-612 (owner, 30 Oct 2026): the Bill findings page on the store PC asks head office for THIS store's findings — the
 * branch the box's signed pack names (head office still narrows to what the person may see, and refuses a store they may
 * not, by name). A box whose pack names no branch asks for none, and head office answers with the person's own scope.
 */
export function findingsPagePayload(input: PackBranchSource): Record<string, unknown> {
  const branchId = input.pack.policies.known ? input.pack.policies.value?.branchId : undefined;
  return { ...headOfficePagePayload(), ...(typeof branchId === 'string' && branchId.trim() !== '' ? { storeId: branchId.trim() } : {}) };
}

/** Screen → payload builder, for screen-data.ts `BUILDERS`. Every page gets the same identity-only payload (the Bill
 *  findings page its store too, OB-612). */
export const HEAD_OFFICE_PAGE_BUILDERS = Object.freeze({
  ...Object.fromEntries(HEAD_OFFICE_PAGE_SCREENS.map((s) => [s, headOfficePagePayload])),
  findings: findingsPagePayload,
  // Round 4c: the Staff list fills its store boxes with the box's own store (head office still keeps each write to the
  // stores the person holds).
  staff: findingsPagePayload,
  // Wave 2: the shelf pages start on the box's own store (head office still answers only what the person may see).
  'space-setup': findingsPagePayload,
  'floor-heat-map': findingsPagePayload,
  'planogram-compliance': findingsPagePayload,
  'display-contracts': findingsPagePayload,
  // Round 4d: the facilities set-up reads and writes the box's own store (head office keeps each to the stores the person holds).
  'facilities-setup': findingsPagePayload,
  // Wave 3: the safety incidents page starts on the box's own store (head office keeps each to the stores the person holds).
  'safety-incidents': findingsPagePayload,
  // W3: the online-orders desk starts its store boxes (stock held, the app's buffer) on the box's own store.
  'online-orders': findingsPagePayload,
  // Wave 3 (D14-FR-05): the floor devices of the box's own store (head office still keeps each read to the person's stores).
  'floor-devices': findingsPagePayload,
}) as Readonly<Record<HeadOfficePageScreen, (input: PackBranchSource) => Record<string, unknown>>>;

/** A same-origin call meant for head office's API (`/v1/…`), which the store computer itself never answers. */
export function isHeadOfficeCall(path: string | undefined): boolean {
  return path === '/v1' || (path ?? '').startsWith('/v1/');
}
