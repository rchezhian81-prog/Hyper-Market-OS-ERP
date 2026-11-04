// W5 (bundle 5 — store operations): the browser wiring for the sections `w5-sections.js` draws. From the global the page's
// server injected (identity only — who is looking and their words; the store the box names), each page gets ITS sections
// as `window.w5Sections`. One import and one call in browser-entry.ts. Nothing is read or written here.

import { policyNumbersSection, indentChangesSection, dsdHeldSection, osaSection, traceRequestsSection, ingredientCostSection, binsSection, type W5Section, type IndentProduct } from './w5-store-ops-sections';
import { facilitiesRecordsSection, lpRecordsSection, noReceiptReportSection } from './w5-facilities-lp-sections';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const storeOf = (raw: unknown): string | undefined => (isObj(raw) && typeof raw['storeId'] === 'string' && raw['storeId'].trim() !== '' ? raw['storeId'].trim() : undefined);
const productsOf = (raw: unknown): IndentProduct[] | undefined => (isObj(raw) && Array.isArray(raw['products'])
  ? raw['products'].filter(isObj).filter((p) => typeof p['productId'] === 'string').map((p) => ({ productId: p['productId'] as string, ...(typeof p['uom'] === 'string' ? { uom: p['uom'] } : {}) }))
  : undefined);

/** The sections each page global carries (in the order they are drawn). */
export function w5SectionsFor(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): W5Section[] {
  const out: (W5Section | null)[] = [];
  const has = (g: string): boolean => win[g] !== undefined && win[g] !== null;
  const viewer = (g: string) => viewerIdentity(win[g]);
  if (has('settingsData')) out.push(policyNumbersSection({ viewer: viewer('settingsData') }));
  if (has('indentsData')) { const p = productsOf(win['indentsData']); out.push(indentChangesSection({ viewer: viewer('indentsData'), ...(p === undefined ? {} : { products: p }) })); }
  if (has('goodsReceiptData')) out.push(dsdHeldSection({ viewer: viewer('goodsReceiptData') }));
  if (has('stockHealthData')) { const s = storeOf(win['stockHealthData']); out.push(osaSection({ viewer: viewer('stockHealthData'), ...(s === undefined ? {} : { storeId: s }) })); }
  if (has('recallTraceData')) out.push(traceRequestsSection({ viewer: viewer('recallTraceData') }));
  if (has('productionCostsData')) out.push(ingredientCostSection({ viewer: viewer('productionCostsData') }));
  if (has('warehouseSupervisorData')) { const s = storeOf(win['warehouseSupervisorData']); out.push(binsSection({ viewer: viewer('warehouseSupervisorData'), ...(s === undefined ? {} : { storeId: s }) })); }
  if (has('facilitiesSetupData')) { const s = storeOf(win['facilitiesSetupData']); out.push(facilitiesRecordsSection({ viewer: viewer('facilitiesSetupData'), ...(s === undefined ? {} : { storeId: s }) })); }
  if (has('lossPreventionInboxData')) out.push(lpRecordsSection({ viewer: viewer('lossPreventionInboxData') }));
  if (has('returnGovernanceData')) out.push(noReceiptReportSection({ viewer: viewer('returnGovernanceData') }));
  return out.filter((s): s is W5Section => s !== null && s.actions.length > 0);
}

export function wireW5StoreOps(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  const sections = w5SectionsFor(win, viewerIdentity);
  if (sections.length > 0) win['w5Sections'] = sections;
}
