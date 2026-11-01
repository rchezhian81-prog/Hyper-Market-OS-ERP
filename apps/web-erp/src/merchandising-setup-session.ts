// MERCHANDISING SETUP — the head-office half of the Shelves and space page (re-audit 30 Oct 2026 M04-FR-04 · R8-8 · screen
// gap audit 31 Oct 2026 Round D "shelf map, planogram, floor plan" · P-07 · P-08).
//
// Every rule here was already head office's and tested; no screen reached it, so a display contract, a cluster's range, a
// season, the shelf map, the planogram and the floor plan could be set only by a programmer — and the Shelves and space,
// Floor heat map and Shelf compliance pages stayed dead ends ("this store has no shelf map"). This is a THIN client over the
// existing routes, each with its own permission, unchanged:
//
//   • a supplier DISPLAY CONTRACT (`POST /v1/merchandising/display-contracts/:contractId`, `merchandising.display.manage`).
//     Finance approves the funding (D02-FR-06 · ADR-0024): the recorder ASKS (`POST /v1/approvals/requests`, kind
//     `display_contract`, with exactly the body that will be sent), a different person who may approve suppliers decides
//     on the Approvals page, and the recorder then records naming THAT approved request — found in their own asks, never a
//     typed name. Recorded without an approval it is kept as "not approved by Finance", which the review flags (the route's
//     own rule, unchanged);
//   • CLUSTERS (OB-318: the cluster IS the price-zone register): each cluster and its stores (`GET /v1/merchandising/clusters`),
//     list or drop a product for every store in one (`POST …/clusters/:zoneId/:productId/list|drop`, `merchandising.range.manage`)
//     — a drop reads each store's stock at head office, so stock on the shelf goes to clearance; a store's range as head office
//     holds it (`GET /v1/merchandising/assortment/:storeId`). Zones are only READ here: who is in which zone is set on the
//     pricing side;
//   • SEASON PLANS (`GET|POST /v1/merchandising/season-plans…`, `…/sweep`);
//   • the SHELF MAP, the PLANOGRAM and the FLOOR PLAN (`/v1/merchandising/stores/:storeId/shelf-map|planograms/:id|floor-plan`,
//     `planogram.publish`): each publish is a NEW VERSION of the whole thing, never an edit, so the screen loads the version in
//     force and sends back the whole list.
//
// The session refuses only the cheap things before a request (nobody named, a role that cannot, a blank field); everything
// else — a plan on a shelf the store has not mapped, an overlapping floor area, a store head office does not know — is head
// office's, shown in its own words. No answer is no answer: "nothing was saved", never a success it did not get.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { outcomeOf, paiseOf, type HttpAnswer, type Outcome } from './finance-close-session';

export type { Lang };

export interface MerchSetupHttp {
  get(path: string): Promise<HttpAnswer>;
  send(method: 'POST' | 'PUT', path: string, body: unknown): Promise<HttpAnswer>;
}

export interface MerchSetupViewer { readonly userId?: string; readonly permissions: readonly string[] }

/** The permission each route checks — the screen offers an action only to a viewer who holds it; head office re-checks. */
export const MERCH_SETUP_PERMISSIONS = Object.freeze({
  displayManage: 'merchandising.display.manage',
  rangeRead: 'merchandising.range.read',
  rangeManage: 'merchandising.range.manage',
  publish: 'planogram.publish',
  planRead: 'planogram.compliance.read',
  spaceRead: 'merchandising.space.read',
});

/** The drop reasons head office's cluster route accepts (services/inventory/src/season-plans.ts). */
export const CLUSTER_DROP_REASONS = Object.freeze(['poor_sales', 'poor_margin', 'supplier_discontinued', 'quality_issue', 'range_rationalisation', 'seasonal_end', 'replaced_by_alternative'] as const);
export type ClusterDropReason = (typeof CLUSTER_DROP_REASONS)[number];
/** The shelf zones head office's shelf map accepts (services/inventory/src/planograms.ts). */
export const SHELF_ZONES = Object.freeze(['ambient', 'chilled', 'frozen', 'secure'] as const);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const seg = encodeURIComponent;
const clean = (s: string | undefined): string => (s ?? '').trim();
/** A list typed as "A1, A2 A3" — split on commas and spaces, blanks and repeats dropped, order kept. */
export const listOf = (text: string | undefined): readonly string[] => [...new Set(clean(text).split(/[\s,]+/).filter((x) => x !== ''))];

// ── Head office's answers ─────────────────────────────────────────────────────────────────────────────────────────

export interface ContractAsk {
  readonly requestId: string; readonly kind: string; readonly subjectRef: string; readonly status: string;
  readonly details: Record<string, unknown>; readonly valueMinor: number | null; readonly summary: string;
  readonly decidedBy?: string; readonly decisionReason?: string;
}
export interface ClusterRow { readonly zoneId: string; readonly stores: readonly string[] }
export interface SeasonPlanRow {
  readonly planId: string; readonly zoneId?: string; readonly storeId?: string; readonly storeIds: readonly string[];
  readonly productIds: readonly string[]; readonly listFrom: string; readonly listTo: string; readonly reason: string;
  readonly setBy: string; readonly standing: 'upcoming' | 'in_season' | 'due_to_end' | 'ended';
}
export interface ShelfPlace { readonly locationId: string; readonly aisle: number; readonly rack: number; readonly bay: number; readonly shelf: number; readonly position: number; readonly zone?: string; readonly label?: string }
export interface StoredShelfMapView { readonly storeId: string; readonly version: number; readonly locations: readonly ShelfPlace[]; readonly publishedBy: string; readonly publishedAt: string }
export interface PlanFacing { readonly productId: string; readonly locationId: string; readonly capacityMinor: number; readonly primary: boolean }
export interface PlanogramView { readonly planogramId: string; readonly version: number; readonly effectiveFrom: string; readonly assignments: readonly PlanFacing[]; readonly createdBy: string; readonly shelfMapVersion: number; readonly versions?: number }
export interface PlanogramsView { readonly storeId: string; readonly inForce: PlanogramView | null; readonly plans: readonly PlanogramView[]; readonly shelfMapVersion: number | null; readonly staleAgainstShelfMap: readonly string[] }
export interface FloorAreaView { readonly areaId: string; readonly name: string; readonly nameTa?: string; readonly x: number; readonly y: number; readonly width: number; readonly depth: number; readonly squareFeet: number; readonly locationIds: readonly string[] }
export interface FloorPlanView { readonly storeId: string; readonly version: number; readonly widthFt: number; readonly depthFt: number; readonly areas: readonly FloorAreaView[]; readonly publishedBy: string; readonly publishedAt: string }

// ── What the person types ─────────────────────────────────────────────────────────────────────────────────────────

export interface ContractForm {
  readonly contractId: string; readonly storeId: string; readonly supplierId: string; readonly description: string;
  readonly fundingRupees: string; readonly startsOn: string; readonly endsOn: string; readonly places: string; readonly areaId?: string;
}
export interface SeasonForm {
  readonly planId: string; readonly scope: 'zone' | 'store'; readonly scopeId: string; readonly products: string;
  readonly listFrom: string; readonly listTo: string; readonly reason: string;
}
export interface ShelfRow { readonly locationId: string; readonly aisle: string; readonly rack: string; readonly bay: string; readonly shelf: string; readonly position: string; readonly zone?: string; readonly label?: string }
export interface PlanRow { readonly productId: string; readonly locationId: string; readonly capacity: string; readonly primary: boolean }
export interface AreaRow { readonly areaId: string; readonly name: string; readonly nameTa?: string; readonly x: string; readonly y: string; readonly width: string; readonly depth: string; readonly squareFeet?: string; readonly places: string }

/** A line the screen cannot send, named: which line (from 1) and which box. */
export type RowProblem = { readonly ok: false; readonly line: number; readonly field: string };
type Rows<T> = { readonly ok: true; readonly value: readonly T[] } | RowProblem | { readonly ok: false; readonly line: 0; readonly field: 'none' };

const num = (s: string): number | undefined => (NUMBER.test(clean(s)) ? Number(clean(s)) : undefined);

/** The contract's body exactly as head office's route reads it — the SAME body is asked about and then sent. Pure. */
export function contractBody(form: ContractForm): { readonly contractId: string; readonly body: Record<string, unknown> } | undefined {
  const minor = paiseOf(form.fundingRupees);
  const places = listOf(form.places);
  if ([form.contractId, form.storeId, form.supplierId, form.description].some((s) => clean(s) === '') || minor === null
    || !DAY.test(clean(form.startsOn)) || !DAY.test(clean(form.endsOn))) return undefined;
  return {
    contractId: clean(form.contractId),
    body: {
      storeId: clean(form.storeId), supplierId: clean(form.supplierId), description: clean(form.description),
      fundingAmount: { minor, currency: 'INR' }, startsOn: clean(form.startsOn), endsOn: clean(form.endsOn), locationIds: places,
      ...(clean(form.areaId) === '' ? {} : { areaId: clean(form.areaId) }),
    },
  };
}

/** Shelf-map lines as head office's `locations[]`. Pure. */
export function shelfMapFromRows(rows: readonly ShelfRow[]): Rows<ShelfPlace> {
  const used = rows.filter((r) => Object.values(r).some((v) => typeof v === 'string' && v.trim() !== ''));
  if (used.length === 0) return { ok: false, line: 0, field: 'none' };
  const out: ShelfPlace[] = [];
  for (const [i, r] of rows.entries()) {
    if (!used.includes(r)) continue;
    const line = i + 1;
    if (clean(r.locationId) === '') return { ok: false, line, field: 'locationId' };
    const n: Record<string, number> = {};
    for (const f of ['aisle', 'rack', 'bay', 'shelf', 'position'] as const) {
      const v = num(r[f]);
      if (v === undefined) return { ok: false, line, field: f };
      n[f] = v;
    }
    const zone = clean(r.zone);
    if (zone !== '' && !(SHELF_ZONES as readonly string[]).includes(zone)) return { ok: false, line, field: 'zone' };
    out.push({ locationId: clean(r.locationId), aisle: n['aisle']!, rack: n['rack']!, bay: n['bay']!, shelf: n['shelf']!, position: n['position']!, ...(zone === '' ? {} : { zone }), ...(clean(r.label) === '' ? {} : { label: clean(r.label) }) });
  }
  return { ok: true, value: out };
}

/** Planogram lines as head office's `assignments[]`. Pure. */
export function planogramFromRows(rows: readonly PlanRow[]): Rows<PlanFacing> {
  const used = rows.filter((r) => [r.productId, r.locationId, r.capacity].some((v) => clean(v) !== ''));
  if (used.length === 0) return { ok: false, line: 0, field: 'none' };
  const out: PlanFacing[] = [];
  for (const [i, r] of rows.entries()) {
    if (!used.includes(r)) continue;
    const line = i + 1;
    if (clean(r.productId) === '') return { ok: false, line, field: 'productId' };
    if (clean(r.locationId) === '') return { ok: false, line, field: 'locationId' };
    const capacity = num(r.capacity);
    if (capacity === undefined) return { ok: false, line, field: 'capacity' };
    out.push({ productId: clean(r.productId), locationId: clean(r.locationId), capacityMinor: capacity, primary: r.primary === true });
  }
  return { ok: true, value: out };
}

/** Floor-plan lines as head office's `areas[]` (head office checks they fit the floor, do not overlap, and name mapped shelves). Pure. */
export function floorAreasFromRows(rows: readonly AreaRow[]): Rows<Record<string, unknown>> {
  const used = rows.filter((r) => Object.values(r).some((v) => typeof v === 'string' && v.trim() !== ''));
  if (used.length === 0) return { ok: false, line: 0, field: 'none' };
  const out: Record<string, unknown>[] = [];
  for (const [i, r] of rows.entries()) {
    if (!used.includes(r)) continue;
    const line = i + 1;
    if (clean(r.areaId) === '') return { ok: false, line, field: 'areaId' };
    if (clean(r.name) === '') return { ok: false, line, field: 'name' };
    const n: Record<string, number> = {};
    for (const f of ['x', 'y', 'width', 'depth'] as const) {
      const v = num(r[f]);
      if (v === undefined) return { ok: false, line, field: f };
      n[f] = v;
    }
    const sq = clean(r.squareFeet);
    if (sq !== '' && num(sq) === undefined) return { ok: false, line, field: 'squareFeet' };
    out.push({
      areaId: clean(r.areaId), name: clean(r.name), ...(clean(r.nameTa) === '' ? {} : { nameTa: clean(r.nameTa) }),
      x: n['x'], y: n['y'], width: n['width'], depth: n['depth'], ...(sq === '' ? {} : { squareFeet: Number(sq) }), locationIds: listOf(r.places),
    });
  }
  return { ok: true, value: out };
}

/** The lines the screen shows for a map / plan / floor plan head office holds — so a change starts from the version in force. Pure. */
export const shelfRowsOf = (m: StoredShelfMapView | null): readonly ShelfRow[] => (m?.locations ?? []).map((l) => ({
  locationId: l.locationId, aisle: String(l.aisle), rack: String(l.rack), bay: String(l.bay), shelf: String(l.shelf), position: String(l.position), zone: l.zone ?? '', label: l.label ?? '',
}));
export const planRowsOf = (p: PlanogramView | null): readonly PlanRow[] => (p?.assignments ?? []).map((a) => ({ productId: a.productId, locationId: a.locationId, capacity: String(a.capacityMinor), primary: a.primary }));
export const areaRowsOf = (f: FloorPlanView | null): readonly AreaRow[] => (f?.areas ?? []).map((a) => ({
  areaId: a.areaId, name: a.name, nameTa: a.nameTa ?? '', x: String(a.x), y: String(a.y), width: String(a.width), depth: String(a.depth), squareFeet: String(a.squareFeet), places: a.locationIds.join(', '),
}));

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MerchSetupCopyKey =
  | 'clustersTab' | 'layoutTab'
  | 'contractH' | 'contractLead' | 'contractId' | 'contractStore' | 'supplier' | 'description' | 'funding' | 'startsOn' | 'endsOn' | 'places' | 'contractArea' | 'areaId' | 'productId' | 'areaPlaces'
  | 'askReason' | 'recordUnapproved' | 'askFinance' | 'myAsks' | 'noAsks' | 'recordApproved' | 'askWaiting' | 'askApproved' | 'askRejected' | 'askUsed' | 'askExpired'
  | 'contractRecordedApproved' | 'contractRecordedUnapproved' | 'askSent' | 'cannotContract' | 'needContract' | 'needAskReason' | 'showAsks'
  | 'clustersH' | 'clustersLead' | 'showClusters' | 'noClusters' | 'cluster' | 'storesIn' | 'product' | 'effectiveFrom' | 'dropReason' | 'reasonNote' | 'replacedBy'
  | 'listInCluster' | 'dropInCluster' | 'listedInCluster' | 'dropOutcome' | 'routed_to_clearance' | 'delisted' | 'storeRangeH' | 'showRange' | 'rangeEmpty' | 'carried'
  | 'cannotRangeRead' | 'cannotRangeManage' | 'needClusterProduct' | 'needDropFields' | 'needStore'
  | 'poor_sales' | 'poor_margin' | 'supplier_discontinued' | 'quality_issue' | 'range_rationalisation' | 'seasonal_end' | 'replaced_by_alternative'
  | 'seasonsH' | 'seasonsLead' | 'showSeasons' | 'noSeasons' | 'planId' | 'scope' | 'scopeZone' | 'scopeStore' | 'scopeId' | 'products' | 'listFrom' | 'listTo' | 'seasonReason'
  | 'makeSeason' | 'seasonMade' | 'sweep' | 'swept' | 'needSeason' | 'upcoming' | 'in_season' | 'due_to_end' | 'ended'
  | 'layoutH' | 'layoutLead' | 'layoutStore' | 'loadLayout' | 'shelfMapH' | 'shelfMapLead' | 'locationId' | 'aisle' | 'rack' | 'bay' | 'shelf' | 'position' | 'zone' | 'label'
  | 'addLine' | 'removeLine' | 'publishShelfMap' | 'shelfMapPublished' | 'noShelfMapYet' | 'version' | 'by'
  | 'planogramH' | 'planogramLead' | 'planogramId' | 'capacity' | 'primary' | 'publishPlanogram' | 'planogramPublished' | 'noPlanogramYet' | 'inForce' | 'staleAgainstMap'
  | 'floorPlanH' | 'floorPlanLead' | 'widthFt' | 'depthFt' | 'name' | 'nameTa' | 'x' | 'y' | 'width' | 'depth' | 'squareFeet' | 'publishFloorPlan' | 'floorPlanPublished' | 'noFloorPlanYet'
  | 'cannotPublish' | 'cannotPlanRead' | 'cannotSpaceRead' | 'needLines' | 'badLine' | 'needPlanHead' | 'needFloorSize'
  | 'nobody' | 'refused' | 'unreachable' | 'unreadable' | 'notConnected';

export const MERCH_SETUP_COPY: BilingualCopy<MerchSetupCopyKey> = {
  en: {
    clustersTab: 'Clusters & seasons', layoutTab: 'Shelf layout',
    contractH: 'Record a display contract',
    contractLead: 'A supplier pays for display space: the space, the money and the dates. Finance approves the money — ask first, then record it with their approval. Recorded without it, it shows as "not approved by Finance".',
    contractId: 'Contract number', contractStore: 'Store', supplier: 'Supplier code', description: 'What the space is (e.g. end-cap aisle 3)', funding: 'Money agreed (₹)',
    startsOn: 'Starts on', endsOn: 'Ends on', places: 'Shelf places it covers (codes, separated by commas)', contractArea: 'Floor area (optional)', areaId: 'Area code', productId: 'Item code', areaPlaces: 'Shelf places in it',
    askReason: 'Why (for Finance)', recordUnapproved: 'Record without approval', askFinance: 'Ask Finance to approve', myAsks: 'Your asks to Finance', noAsks: 'You have not asked Finance about a display contract.',
    recordApproved: 'Record with this approval', askWaiting: 'waiting for Finance', askApproved: 'approved by', askRejected: 'refused by', askUsed: 'already used to record the contract', askExpired: 'approval ran out — ask again',
    contractRecordedApproved: 'Recorded at head office, with Finance’s approval.', contractRecordedUnapproved: 'Recorded at head office — not approved by Finance, so the review will flag it.',
    askSent: 'Asked. A person in Finance decides it on the Approvals page; then come back and record the contract with it.',
    cannotContract: 'Your role cannot record display contracts.', needContract: 'Fill in the contract number, store, supplier, what the space is, the money and both dates. Nothing was sent.',
    needAskReason: 'Write why, for Finance. Nothing was sent.', showAsks: 'Show my asks',
    clustersH: 'Store clusters', clustersLead: 'A cluster is a price zone: the stores in a zone share a range. Who is in which zone is set with the zone prices. Listing or dropping here does it in every store of the cluster.',
    showClusters: 'Show the clusters', noClusters: 'No store is in a price zone yet, so there is no cluster.', cluster: 'Cluster (price zone)', storesIn: 'Stores',
    product: 'Item code', effectiveFrom: 'From', dropReason: 'Why it is dropped', reasonNote: 'Note (optional)', replacedBy: 'Replaced by (item code)',
    listInCluster: 'List in every store of the cluster', dropInCluster: 'Drop in every store of the cluster', listedInCluster: 'Listed at head office in', dropOutcome: 'Head office recorded the drop:',
    routed_to_clearance: 'put on clearance (stock on hand)', delisted: 'delisted (no stock)', storeRangeH: 'A store’s range at head office', showRange: 'Show the range', rangeEmpty: 'Head office has nothing listed for this store on this date.', carried: 'Carried on',
    cannotRangeRead: 'Your role cannot read the range.', cannotRangeManage: 'Your role cannot change the range.', needClusterProduct: 'Choose the cluster, the item and the date. Nothing was sent.',
    needDropFields: 'Choose the cluster, the item, the date and why it is dropped. Nothing was sent.', needStore: 'Type the store first.',
    poor_sales: 'Poor sales', poor_margin: 'Poor margin', supplier_discontinued: 'Supplier stopped making it', quality_issue: 'Quality problem', range_rationalisation: 'Too many similar items',
    seasonal_end: 'The season is over', replaced_by_alternative: 'Replaced by something else',
    seasonsH: 'Season plans', seasonsLead: 'Items carried for a season only. They are listed from the first day; after the last day they leave the range by themselves — clearance where stock is left.',
    showSeasons: 'Show the season plans', noSeasons: 'No season plan has been made.', planId: 'Plan name (e.g. diwali-2026)', scope: 'For', scopeZone: 'a cluster', scopeStore: 'one store', scopeId: 'Cluster or store',
    products: 'Item codes (separated by commas)', listFrom: 'First day', listTo: 'Last day', seasonReason: 'Why', makeSeason: 'Make this season plan', seasonMade: 'Season plan made at head office for',
    sweep: 'End the seasons that are over now', swept: 'Seasons ended now:', needSeason: 'Fill in the plan name, the cluster or store, the items, both days and why. Nothing was sent.',
    upcoming: 'not started', in_season: 'in season', due_to_end: 'over — ending soon', ended: 'ended',
    layoutH: 'Shelf layout', layoutLead: 'The shelf map, the planogram and the floor plan head office holds for a store. Each publish is a new version of the whole thing — the old version is kept. Load the version in force, change it, publish.',
    layoutStore: 'Store', loadLayout: 'Load what head office holds', shelfMapH: 'Shelf map', shelfMapLead: 'Every shelf place in the store: its code and where it is (aisle, rack, bay, shelf, position).',
    locationId: 'Place code', aisle: 'Aisle', rack: 'Rack', bay: 'Bay', shelf: 'Shelf', position: 'Position', zone: 'Zone', label: 'Label',
    addLine: 'Add a line', removeLine: 'Remove', publishShelfMap: 'Publish the shelf map', shelfMapPublished: 'Shelf map published at head office — version', noShelfMapYet: 'No shelf map is published for this store yet.', version: 'Version', by: 'by',
    planogramH: 'Planogram', planogramLead: 'Which item sits on which shelf place, how many fit, and whether it is the item’s main place. Checked against the published shelf map.',
    planogramId: 'Plan name', capacity: 'How many fit', primary: 'Main place', publishPlanogram: 'Publish the planogram', planogramPublished: 'Planogram published at head office — version',
    noPlanogramYet: 'No planogram is published for this store yet.', inForce: 'In force', staleAgainstMap: 'Checked against an older shelf map — publish it again:',
    floorPlanH: 'Floor plan', floorPlanLead: 'The shop floor in feet, seen from above, front at the bottom: each area’s corner (x from the left, y from the front), its size, and the shelf places in it. The Floor heat map colours these areas.',
    widthFt: 'Floor width (ft)', depthFt: 'Floor depth (ft)', name: 'Name', nameTa: 'Name in Tamil', x: 'x (ft)', y: 'y (ft)', width: 'Width (ft)', depth: 'Depth (ft)', squareFeet: 'Selling sq ft (optional)',
    publishFloorPlan: 'Publish the floor plan', floorPlanPublished: 'Floor plan published at head office — version', noFloorPlanYet: 'No floor plan is published for this store yet.',
    cannotPublish: 'Your role can read the layout but not publish it.', cannotPlanRead: 'Your role cannot read the shelf map or the planogram.', cannotSpaceRead: 'Your role cannot read the floor plan.',
    needLines: 'Add at least one line. Nothing was sent.', badLine: 'Line {line}: “{field}” is missing or not a number. Nothing was sent.', needPlanHead: 'Give the plan a name and the date it starts. Nothing was sent.',
    needFloorSize: 'Give the floor width and depth in feet. Nothing was sent.',
    nobody: 'Nobody is signed in on this screen — nothing can be read or changed here.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was saved. Try again when the connection is back.',
    unreadable: 'Head office cannot be reached — nothing was read, so nothing is shown.', notConnected: 'This screen was not told who is looking, so it offers nothing to change.',
  },
  ta: {
    clustersTab: 'கடைக் குழுக்களும் பருவங்களும்', layoutTab: 'அலமாரி அமைப்பு',
    contractH: 'காட்சி ஒப்பந்தத்தைப் பதிவு செய்',
    contractLead: 'ஒரு சப்ளையர் காட்சி இடத்துக்குப் பணம் தருகிறார்: இடம், பணம், தேதிகள். பணத்தை நிதித் துறை ஒப்புதல் அளிக்கிறது — முதலில் கேளுங்கள், பிறகு அவர்களின் ஒப்புதலுடன் பதிவு செய்யுங்கள். ஒப்புதல் இல்லாமல் பதிவு செய்தால் "நிதித் துறை ஒப்புதல் இல்லை" எனக் காட்டப்படும்.',
    contractId: 'ஒப்பந்த எண்', contractStore: 'கடை', supplier: 'சப்ளையர் குறியீடு', description: 'இடம் எது (எ.கா. வரிசை 3 முனை அலமாரி)', funding: 'ஒப்புக்கொண்ட பணம் (₹)',
    startsOn: 'தொடங்கும் நாள்', endsOn: 'முடியும் நாள்', places: 'இது உள்ளடக்கும் அலமாரி இடங்கள் (குறியீடுகள், காற்புள்ளியால் பிரித்து)', contractArea: 'தளப் பகுதி (விருப்பம்)', areaId: 'பகுதிக் குறியீடு', productId: 'பொருள் குறியீடு', areaPlaces: 'இதிலுள்ள அலமாரி இடங்கள்',
    askReason: 'ஏன் (நிதித் துறைக்கு)', recordUnapproved: 'ஒப்புதல் இல்லாமல் பதிவு செய்', askFinance: 'நிதித் துறையிடம் ஒப்புதல் கேள்', myAsks: 'நிதித் துறையிடம் நீங்கள் கேட்டவை', noAsks: 'காட்சி ஒப்பந்தம் பற்றி நீங்கள் நிதித் துறையிடம் கேட்கவில்லை.',
    recordApproved: 'இந்த ஒப்புதலுடன் பதிவு செய்', askWaiting: 'நிதித் துறைக்காகக் காத்திருக்கிறது', askApproved: 'ஒப்புதல் அளித்தவர்', askRejected: 'மறுத்தவர்', askUsed: 'ஒப்பந்தத்தைப் பதிவு செய்ய ஏற்கனவே பயன்படுத்தப்பட்டது', askExpired: 'ஒப்புதல் காலாவதியானது — மீண்டும் கேளுங்கள்',
    contractRecordedApproved: 'நிதித் துறை ஒப்புதலுடன் தலைமை அலுவலகத்தில் பதிவு செய்யப்பட்டது.', contractRecordedUnapproved: 'தலைமை அலுவலகத்தில் பதிவு செய்யப்பட்டது — நிதித் துறை ஒப்புதல் இல்லை, எனவே மதிப்பாய்வு இதைச் சுட்டிக்காட்டும்.',
    askSent: 'கேட்கப்பட்டது. நிதித் துறையில் ஒருவர் ஒப்புதல்கள் பக்கத்தில் முடிவு செய்வார்; பிறகு திரும்பி வந்து அதனுடன் ஒப்பந்தத்தைப் பதிவு செய்யுங்கள்.',
    cannotContract: 'உங்கள் பங்கால் காட்சி ஒப்பந்தங்களைப் பதிவு செய்ய முடியாது.', needContract: 'ஒப்பந்த எண், கடை, சப்ளையர், இடம் எது, பணம், இரண்டு தேதிகளையும் நிரப்புங்கள். எதுவும் அனுப்பப்படவில்லை.',
    needAskReason: 'நிதித் துறைக்கு ஏன் என்று எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.', showAsks: 'நான் கேட்டவற்றைக் காட்டு',
    clustersH: 'கடைக் குழுக்கள்', clustersLead: 'ஒரு குழு என்பது ஒரு விலை மண்டலம்: ஒரு மண்டலத்தில் உள்ள கடைகள் ஒரே பொருள் வரிசையைப் பகிர்கின்றன. எந்தக் கடை எந்த மண்டலத்தில் என்பது மண்டல விலைகளுடன் அமைக்கப்படுகிறது. இங்கே சேர்ப்பதும் நீக்குவதும் குழுவின் ஒவ்வொரு கடையிலும் நடக்கும்.',
    showClusters: 'குழுக்களைக் காட்டு', noClusters: 'எந்தக் கடையும் இன்னும் விலை மண்டலத்தில் இல்லை, எனவே குழு இல்லை.', cluster: 'குழு (விலை மண்டலம்)', storesIn: 'கடைகள்',
    product: 'பொருள் குறியீடு', effectiveFrom: 'முதல்', dropReason: 'ஏன் நீக்கப்படுகிறது', reasonNote: 'குறிப்பு (விருப்பம்)', replacedBy: 'இதற்கு பதிலாக (பொருள் குறியீடு)',
    listInCluster: 'குழுவின் ஒவ்வொரு கடையிலும் சேர்', dropInCluster: 'குழுவின் ஒவ்வொரு கடையிலும் நீக்கு', listedInCluster: 'தலைமை அலுவலகத்தில் சேர்க்கப்பட்ட கடைகள்:', dropOutcome: 'தலைமை அலுவலகம் நீக்கத்தைப் பதிவு செய்தது:',
    routed_to_clearance: 'கிளியரன்ஸில் வைக்கப்பட்டது (இருப்பு உள்ளது)', delisted: 'நீக்கப்பட்டது (இருப்பு இல்லை)', storeRangeH: 'தலைமை அலுவலகத்தில் ஒரு கடையின் பொருள் வரிசை', showRange: 'வரிசையைக் காட்டு', rangeEmpty: 'இந்த நாளில் இந்தக் கடைக்கு தலைமை அலுவலகத்தில் எதுவும் சேர்க்கப்படவில்லை.', carried: 'வைத்திருக்கும் நாள்',
    cannotRangeRead: 'உங்கள் பங்கால் பொருள் வரிசையைப் படிக்க முடியாது.', cannotRangeManage: 'உங்கள் பங்கால் பொருள் வரிசையை மாற்ற முடியாது.', needClusterProduct: 'குழு, பொருள், தேதி ஆகியவற்றைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    needDropFields: 'குழு, பொருள், தேதி, நீக்கும் காரணம் ஆகியவற்றைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needStore: 'முதலில் கடையைத் தட்டச்சு செய்யவும்.',
    poor_sales: 'விற்பனை குறைவு', poor_margin: 'லாபம் குறைவு', supplier_discontinued: 'சப்ளையர் தயாரிப்பை நிறுத்திவிட்டார்', quality_issue: 'தரச் சிக்கல்', range_rationalisation: 'ஒரே மாதிரி பொருட்கள் அதிகம்',
    seasonal_end: 'சீசன் முடிந்தது', replaced_by_alternative: 'வேறு பொருளால் மாற்றப்பட்டது',
    seasonsH: 'பருவத் திட்டங்கள்', seasonsLead: 'ஒரு பருவத்துக்கு மட்டும் வைக்கும் பொருட்கள். முதல் நாளிலிருந்து சேர்க்கப்படும்; கடைசி நாளுக்குப் பிறகு தானாகவே வரிசையிலிருந்து வெளியேறும் — இருப்பு மீதமிருந்தால் கிளியரன்ஸ்.',
    showSeasons: 'பருவத் திட்டங்களைக் காட்டு', noSeasons: 'எந்தப் பருவத் திட்டமும் உருவாக்கப்படவில்லை.', planId: 'திட்டப் பெயர் (எ.கா. diwali-2026)', scope: 'யாருக்கு', scopeZone: 'ஒரு குழு', scopeStore: 'ஒரு கடை', scopeId: 'குழு அல்லது கடை',
    products: 'பொருள் குறியீடுகள் (காற்புள்ளியால் பிரித்து)', listFrom: 'முதல் நாள்', listTo: 'கடைசி நாள்', seasonReason: 'ஏன்', makeSeason: 'இந்தப் பருவத் திட்டத்தை உருவாக்கு', seasonMade: 'தலைமை அலுவலகத்தில் பருவத் திட்டம் உருவாக்கப்பட்ட கடைகள்:',
    sweep: 'முடிந்த பருவங்களை இப்போது முடி', swept: 'இப்போது முடிக்கப்பட்ட பருவங்கள்:', needSeason: 'திட்டப் பெயர், குழு அல்லது கடை, பொருட்கள், இரண்டு நாட்கள், காரணம் ஆகியவற்றை நிரப்புங்கள். எதுவும் அனுப்பப்படவில்லை.',
    upcoming: 'தொடங்கவில்லை', in_season: 'பருவத்தில்', due_to_end: 'முடிந்தது — விரைவில் முடிக்கப்படும்', ended: 'முடிக்கப்பட்டது',
    layoutH: 'அலமாரி அமைப்பு', layoutLead: 'ஒரு கடைக்கு தலைமை அலுவலகம் வைத்திருக்கும் அலமாரி வரைபடம், திட்ட வரைபடம், தளத் திட்டம். ஒவ்வொரு வெளியீடும் முழுவதின் புதிய பதிப்பு — பழைய பதிப்பு வைக்கப்படும். நடைமுறையில் உள்ள பதிப்பை ஏற்றி, மாற்றி, வெளியிடுங்கள்.',
    layoutStore: 'கடை', loadLayout: 'தலைமை அலுவலகம் வைத்திருப்பதை ஏற்று', shelfMapH: 'அலமாரி வரைபடம்', shelfMapLead: 'கடையின் ஒவ்வொரு அலமாரி இடமும்: அதன் குறியீடும் அது எங்கே உள்ளது என்பதும் (வரிசை, ரேக், பகுதி, அடுக்கு, நிலை).',
    locationId: 'இடக் குறியீடு', aisle: 'வரிசை', rack: 'ரேக்', bay: 'பகுதி', shelf: 'அடுக்கு', position: 'நிலை', zone: 'மண்டலம்', label: 'பெயர்ச்சீட்டு',
    addLine: 'ஒரு வரியைச் சேர்', removeLine: 'நீக்கு', publishShelfMap: 'அலமாரி வரைபடத்தை வெளியிடு', shelfMapPublished: 'தலைமை அலுவலகத்தில் அலமாரி வரைபடம் வெளியிடப்பட்டது — பதிப்பு', noShelfMapYet: 'இந்தக் கடைக்கு இன்னும் அலமாரி வரைபடம் வெளியிடப்படவில்லை.', version: 'பதிப்பு', by: 'வெளியிட்டவர்',
    planogramH: 'திட்ட வரைபடம்', planogramLead: 'எந்தப் பொருள் எந்த அலமாரி இடத்தில், எத்தனை கொள்ளும், அது பொருளின் முதன்மை இடமா என்பது. வெளியிடப்பட்ட அலமாரி வரைபடத்துடன் சரிபார்க்கப்படும்.',
    planogramId: 'திட்டப் பெயர்', capacity: 'எத்தனை கொள்ளும்', primary: 'முதன்மை இடம்', publishPlanogram: 'திட்ட வரைபடத்தை வெளியிடு', planogramPublished: 'தலைமை அலுவலகத்தில் திட்ட வரைபடம் வெளியிடப்பட்டது — பதிப்பு',
    noPlanogramYet: 'இந்தக் கடைக்கு இன்னும் திட்ட வரைபடம் வெளியிடப்படவில்லை.', inForce: 'நடைமுறையில்', staleAgainstMap: 'பழைய அலமாரி வரைபடத்துடன் சரிபார்க்கப்பட்டது — மீண்டும் வெளியிடுங்கள்:',
    floorPlanH: 'தளத் திட்டம்', floorPlanLead: 'அடிகளில் கடைத் தளம், மேலிருந்து பார்க்கும்போது, முன்பக்கம் கீழே: ஒவ்வொரு பகுதியின் மூலை (இடமிருந்து x, முன்பக்கத்திலிருந்து y), அதன் அளவு, அதிலுள்ள அலமாரி இடங்கள். தள வெப்ப வரைபடம் இந்தப் பகுதிகளுக்கு வண்ணமிடுகிறது.',
    widthFt: 'தள அகலம் (அடி)', depthFt: 'தள ஆழம் (அடி)', name: 'பெயர்', nameTa: 'தமிழில் பெயர்', x: 'x (அடி)', y: 'y (அடி)', width: 'அகலம் (அடி)', depth: 'ஆழம் (அடி)', squareFeet: 'விற்பனை சதுர அடி (விருப்பம்)',
    publishFloorPlan: 'தளத் திட்டத்தை வெளியிடு', floorPlanPublished: 'தலைமை அலுவலகத்தில் தளத் திட்டம் வெளியிடப்பட்டது — பதிப்பு', noFloorPlanYet: 'இந்தக் கடைக்கு இன்னும் தளத் திட்டம் வெளியிடப்படவில்லை.',
    cannotPublish: 'உங்கள் பங்கால் அமைப்பைப் படிக்கலாம், வெளியிட முடியாது.', cannotPlanRead: 'உங்கள் பங்கால் அலமாரி வரைபடத்தையோ திட்ட வரைபடத்தையோ படிக்க முடியாது.', cannotSpaceRead: 'உங்கள் பங்கால் தளத் திட்டத்தைப் படிக்க முடியாது.',
    needLines: 'குறைந்தது ஒரு வரியைச் சேருங்கள். எதுவும் அனுப்பப்படவில்லை.', badLine: 'வரி {line}: “{field}” இல்லை அல்லது எண் அல்ல. எதுவும் அனுப்பப்படவில்லை.', needPlanHead: 'திட்டத்துக்கு ஒரு பெயரும் தொடங்கும் நாளும் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    needFloorSize: 'தள அகலத்தையும் ஆழத்தையும் அடிகளில் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — இங்கே எதையும் படிக்கவோ மாற்றவோ முடியாது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் முயலுங்கள்.',
    unreadable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, எனவே எதுவும் காட்டப்படவில்லை.', notConnected: 'யார் பார்க்கிறார்கள் என்று இந்தத் திரைக்குச் சொல்லப்படவில்லை, எனவே மாற்ற எதுவும் வழங்கப்படவில்லை.',
  },
};
export const MERCH_SETUP_COPY_KEYS: readonly MerchSetupCopyKey[] = Object.freeze(Object.keys(MERCH_SETUP_COPY.en) as MerchSetupCopyKey[]);

export function merchSetupWords(lang: Lang): (key: MerchSetupCopyKey | string, fill?: Readonly<Record<string, string | number>>) => string {
  const t = translator(MERCH_SETUP_COPY, lang);
  return (key, fill) => Object.entries(fill ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key as MerchSetupCopyKey));
}

/**
 * What a refused, blocked or unanswered request says, in the reader's language. A refusal is head office's own words; an
 * `invalid` names the box; a line problem names the line and the box; `unreachable` says nothing was saved (or, for a read,
 * nothing was read). `done` is the caller's to word — this returns '' for it. Pure.
 */
export function merchSetupOutcomeWords(lang: Lang, o: Outcome<unknown>, mode: 'write' | 'read' = 'write'): string {
  const w = merchSetupWords(lang);
  switch (o.kind) {
    case 'done': return '';
    case 'refused': return `${w('refused')} ${o.whatHappened}${o.nextSafeAction === '' ? '' : ` ${o.nextSafeAction}`}`;
    case 'not_allowed': return w(o.needs);
    case 'invalid': {
      const m = /^badLine:(\d+):(\w+)$/.exec(o.detail);
      return m === null ? w(o.detail) : w('badLine', { line: m[1]!, field: w(m[2]!) });
    }
    case 'unreachable': return w(mode === 'read' ? 'unreadable' : 'unreachable');
  }
}

/** An approval ask's standing, in words. Pure. */
export function askWords(lang: Lang, a: Pick<ContractAsk, 'status' | 'decidedBy'>): string {
  const w = merchSetupWords(lang);
  switch (a.status) {
    case 'approved': return `${w('askApproved')} ${a.decidedBy ?? ''}`.trim();
    case 'rejected': return `${w('askRejected')} ${a.decidedBy ?? ''}`.trim();
    case 'used': return w('askUsed');
    case 'expired': return w('askExpired');
    default: return w('askWaiting');
  }
}

// ── The session ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface MerchSetupSession {
  readonly may: {
    readonly named: boolean; readonly contract: boolean; readonly rangeRead: boolean; readonly rangeManage: boolean;
    readonly publish: boolean; readonly planRead: boolean; readonly spaceRead: boolean;
  };
  /** Record a display contract with NO approval — head office keeps it as "not approved by Finance". */
  recordContract(form: ContractForm): Promise<Outcome<{ contractId: string; approved: boolean }>>;
  /** Ask Finance to approve exactly this contract (kind `display_contract`, the same body that will be sent). */
  askContractApproval(form: ContractForm, reason: string): Promise<Outcome<ContractAsk>>;
  /** This person's own asks about display contracts, newest first. */
  contractAsks(): Promise<Outcome<readonly ContractAsk[]>>;
  /** Record the contract an APPROVED ask was about — the body is the ask's own details, the approval its id. */
  recordApprovedContract(ask: ContractAsk): Promise<Outcome<{ contractId: string; approved: boolean }>>;

  clusters(): Promise<Outcome<{ clusters: readonly ClusterRow[] }>>;
  storeRange(storeId: string, onDate: string): Promise<Outcome<{ storeId: string; onDate: string; listed: readonly string[] }>>;
  listForCluster(zoneId: string, productId: string, effectiveFrom: string): Promise<Outcome<{ stores: readonly string[] }>>;
  dropForCluster(zoneId: string, productId: string, d: { readonly reason: string; readonly effectiveFrom: string; readonly reasonNote?: string; readonly replacedByProductId?: string }): Promise<Outcome<{ decisions: readonly { storeId: string; outcome: string; onHandMinor: number }[] }>>;

  seasonPlans(): Promise<Outcome<{ plans: readonly SeasonPlanRow[]; dueToEnd: number }>>;
  makeSeasonPlan(form: SeasonForm): Promise<Outcome<{ plan: SeasonPlanRow }>>;
  sweepSeasons(): Promise<Outcome<{ count: number }>>;

  /** The shelf map in force — `null` when the store has never published one (head office's 404). */
  shelfMap(storeId: string): Promise<Outcome<StoredShelfMapView | null>>;
  publishShelfMap(storeId: string, rows: readonly ShelfRow[]): Promise<Outcome<{ shelfMap: StoredShelfMapView }>>;
  planograms(storeId: string): Promise<Outcome<PlanogramsView>>;
  publishPlanogram(storeId: string, planogramId: string, effectiveFrom: string, rows: readonly PlanRow[]): Promise<Outcome<{ planogram: PlanogramView }>>;
  /** The floor plan in force — `null` when the store has never published one (head office's 404). */
  floorPlan(storeId: string): Promise<Outcome<FloorPlanView | null>>;
  publishFloorPlan(storeId: string, widthFt: string, depthFt: string, rows: readonly AreaRow[]): Promise<Outcome<{ plan: FloorPlanView }>>;
}

export function createMerchSetupSession(viewer: MerchSetupViewer | undefined, http: MerchSetupHttp): MerchSetupSession {
  const held = new Set(viewer?.permissions ?? []);
  const named = viewer?.userId !== undefined;
  const P = MERCH_SETUP_PERMISSIONS;
  const may = Object.freeze({
    named,
    contract: named && held.has(P.displayManage),
    rangeRead: named && held.has(P.rangeRead),
    rangeManage: named && held.has(P.rangeManage),
    publish: named && held.has(P.publish),
    planRead: named && held.has(P.planRead),
    spaceRead: named && held.has(P.spaceRead),
  });
  const blocked = (allowed: boolean, needs: MerchSetupCopyKey): Outcome<never> | undefined =>
    (!named ? { kind: 'not_allowed', needs: 'nobody' } : allowed ? undefined : { kind: 'not_allowed', needs });
  const invalid = (detail: string): Outcome<never> => ({ kind: 'invalid', detail });
  const lineProblem = (r: { ok: false; line: number; field: string }): Outcome<never> => (r.line === 0 ? invalid('needLines') : invalid(`badLine:${r.line}:${r.field}`));
  const get = async <T>(path: string): Promise<Outcome<T>> => outcomeOf<T>(await http.get(path));
  const send = async <T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<Outcome<T>> => outcomeOf<T>(await http.send(method, path, body));
  /** A register never published reads as `null` (head office's 404 `not_found`), never as a failure or as an empty register. */
  const orNone = <T, U>(o: Outcome<T>, pick: (b: T) => U): Outcome<U | null> => {
    if (o.kind === 'done') return { kind: 'done', status: o.status, body: pick(o.body) };
    if (o.kind === 'refused' && o.status === 404) return { kind: 'done', status: 404, body: null };
    return o;
  };

  return {
    may,

    recordContract: async (form) => {
      const no = blocked(may.contract, 'cannotContract'); if (no !== undefined) return no;
      const c = contractBody(form);
      if (c === undefined) return invalid('needContract');
      return send('POST', `/v1/merchandising/display-contracts/${seg(c.contractId)}`, c.body);
    },

    askContractApproval: async (form, reason) => {
      const no = blocked(may.contract, 'cannotContract'); if (no !== undefined) return no;
      const c = contractBody(form);
      if (c === undefined) return invalid('needContract');
      if (clean(reason) === '') return invalid('needAskReason');
      const money = c.body['fundingAmount'] as { minor: number };
      // The details are exactly the body that will be sent, plus the contract number in its address — head office's rule for
      // every ask (`actionDetails`), fingerprinted, so the recorded contract can only be the one Finance saw.
      return send('POST', '/v1/approvals/requests', {
        kind: 'display_contract', subjectRef: c.contractId, valueMinor: money.minor,
        details: { ...c.body, contractId: c.contractId },
        summary: `Display space for ${String(c.body['supplierId'])} at ${String(c.body['storeId'])}: ${String(c.body['description'])}, ${c.body['startsOn'] as string} to ${c.body['endsOn'] as string}`,
        reason: clean(reason),
      });
    },

    contractAsks: async () => {
      if (!named) return { kind: 'not_allowed', needs: 'nobody' };
      const r = await get<{ mine?: readonly ContractAsk[] }>('/v1/approvals/requests');
      if (r.kind !== 'done') return r;
      return { kind: 'done', status: r.status, body: (r.body.mine ?? []).filter((a) => a.kind === 'display_contract').slice().reverse() };
    },

    recordApprovedContract: async (ask) => {
      const no = blocked(may.contract, 'cannotContract'); if (no !== undefined) return no;
      if (ask.kind !== 'display_contract' || ask.status !== 'approved' || clean(ask.subjectRef) === '') return invalid('needContract');
      // The ask's own details, as head office holds them, minus the address — never rebuilt from the form.
      const { contractId: _address, ...body } = ask.details;
      void _address;
      return send('POST', `/v1/merchandising/display-contracts/${seg(ask.subjectRef)}`, { ...body, approvalId: ask.requestId });
    },

    clusters: async () => blocked(may.rangeRead, 'cannotRangeRead') ?? get('/v1/merchandising/clusters'),

    storeRange: async (storeId, onDate) => {
      const no = blocked(may.rangeRead, 'cannotRangeRead'); if (no !== undefined) return no;
      if (clean(storeId) === '') return invalid('needStore');
      return get(`/v1/merchandising/assortment/${seg(clean(storeId))}${DAY.test(clean(onDate)) ? `?onDate=${seg(clean(onDate))}` : ''}`);
    },

    listForCluster: async (zoneId, productId, effectiveFrom) => {
      const no = blocked(may.rangeManage, 'cannotRangeManage'); if (no !== undefined) return no;
      if (clean(zoneId) === '' || clean(productId) === '' || !DAY.test(clean(effectiveFrom))) return invalid('needClusterProduct');
      return send('POST', `/v1/merchandising/clusters/${seg(clean(zoneId))}/${seg(clean(productId))}/list`, { effectiveFrom: clean(effectiveFrom) });
    },

    dropForCluster: async (zoneId, productId, d) => {
      const no = blocked(may.rangeManage, 'cannotRangeManage'); if (no !== undefined) return no;
      if (clean(zoneId) === '' || clean(productId) === '' || !DAY.test(clean(d.effectiveFrom)) || !(CLUSTER_DROP_REASONS as readonly string[]).includes(d.reason)) return invalid('needDropFields');
      // No stock figure in the body — head office reads each store's own and refuses a typed one by name.
      return send('POST', `/v1/merchandising/clusters/${seg(clean(zoneId))}/${seg(clean(productId))}/drop`, {
        reason: d.reason, effectiveFrom: clean(d.effectiveFrom),
        ...(clean(d.reasonNote) === '' ? {} : { reasonNote: clean(d.reasonNote) }),
        ...(clean(d.replacedByProductId) === '' ? {} : { replacedByProductId: clean(d.replacedByProductId) }),
      });
    },

    seasonPlans: async () => blocked(may.rangeRead, 'cannotRangeRead') ?? get('/v1/merchandising/season-plans'),

    makeSeasonPlan: async (form) => {
      const no = blocked(may.rangeManage, 'cannotRangeManage'); if (no !== undefined) return no;
      const products = listOf(form.products);
      if (clean(form.planId) === '' || clean(form.scopeId) === '' || products.length === 0 || !DAY.test(clean(form.listFrom)) || !DAY.test(clean(form.listTo)) || clean(form.reason) === '') return invalid('needSeason');
      return send('POST', `/v1/merchandising/season-plans/${seg(clean(form.planId))}`, {
        ...(form.scope === 'store' ? { storeId: clean(form.scopeId) } : { zoneId: clean(form.scopeId) }),
        productIds: products, listFrom: clean(form.listFrom), listTo: clean(form.listTo), reason: clean(form.reason),
      });
    },

    sweepSeasons: async () => blocked(may.rangeManage, 'cannotRangeManage') ?? send('POST', '/v1/merchandising/season-plans/sweep', {}),

    shelfMap: async (storeId) => {
      const no = blocked(may.planRead, 'cannotPlanRead'); if (no !== undefined) return no;
      if (clean(storeId) === '') return invalid('needStore');
      return orNone(await get<{ shelfMap: StoredShelfMapView }>(`/v1/merchandising/stores/${seg(clean(storeId))}/shelf-map`), (b) => b.shelfMap);
    },

    publishShelfMap: async (storeId, rows) => {
      const no = blocked(may.publish, 'cannotPublish'); if (no !== undefined) return no;
      if (clean(storeId) === '') return invalid('needStore');
      const r = shelfMapFromRows(rows);
      if (!r.ok) return lineProblem(r);
      return send('PUT', `/v1/merchandising/stores/${seg(clean(storeId))}/shelf-map`, { locations: r.value });
    },

    planograms: async (storeId) => {
      const no = blocked(may.planRead, 'cannotPlanRead'); if (no !== undefined) return no;
      if (clean(storeId) === '') return invalid('needStore');
      return get(`/v1/merchandising/stores/${seg(clean(storeId))}/planograms`);
    },

    publishPlanogram: async (storeId, planogramId, effectiveFrom, rows) => {
      const no = blocked(may.publish, 'cannotPublish'); if (no !== undefined) return no;
      if (clean(storeId) === '') return invalid('needStore');
      if (clean(planogramId) === '' || !DAY.test(clean(effectiveFrom))) return invalid('needPlanHead');
      const r = planogramFromRows(rows);
      if (!r.ok) return lineProblem(r);
      return send('PUT', `/v1/merchandising/stores/${seg(clean(storeId))}/planograms/${seg(clean(planogramId))}`, { effectiveFrom: clean(effectiveFrom), assignments: r.value });
    },

    floorPlan: async (storeId) => {
      const no = blocked(may.spaceRead, 'cannotSpaceRead'); if (no !== undefined) return no;
      if (clean(storeId) === '') return invalid('needStore');
      return orNone(await get<{ plan: FloorPlanView }>(`/v1/merchandising/stores/${seg(clean(storeId))}/floor-plan`), (b) => b.plan);
    },

    publishFloorPlan: async (storeId, widthFt, depthFt, rows) => {
      const no = blocked(may.publish, 'cannotPublish'); if (no !== undefined) return no;
      if (clean(storeId) === '') return invalid('needStore');
      const w = num(widthFt); const d = num(depthFt);
      if (w === undefined || d === undefined) return invalid('needFloorSize');
      const r = floorAreasFromRows(rows);
      if (!r.ok) return lineProblem(r);
      return send('POST', `/v1/merchandising/stores/${seg(clean(storeId))}/floor-plan`, { widthFt: w, depthFt: d, areas: r.value });
    },
  };
}
