// Domain data export — your data is yours, on the cloud API (M30-FR-02 / NFR-12 / OD-09 / P-06).
//
// The promise is that there is **no proprietary-only route to retrieve business data**: every
// authorised domain exports to an open, self-describing format (CSV + a JSON schema any spreadsheet
// or other system can read). The tested engine (`packages/export`) already enforces the three
// controls that make an export safe rather than a data leak:
//   • PERMISSION — default-deny via the same RBAC engine that guards every action; a user without
//     the domain's export permission gets nothing (P-04);
//   • SCOPE — rows outside the caller's branch scope are filtered out (§28);
//   • CLASSIFICATION — a column marked sensitive (PII / payment) is REDACTED, not dropped, unless
//     the caller additionally holds `export.sensitive` — so the file's shape never lies (PRV).
// None of it was reachable on the API. This wires it:
//
//   • LIST (`GET /v1/export`) — the catalogue of exportable domains and their columns (which are
//     sensitive), so a person knows what they can take and in what shape. No data.
//   • EXPORT (`POST /v1/export/:domain`) — run the engine for one domain: the caller's own
//     authority decides whether it is allowed, which branch's rows come back, and whether sensitive
//     columns are shown or redacted. Every export is LOGGED — an append-only record of who took
//     what, when, how many rows, and which columns were redacted for them (M30-FR-02, hard rule #6),
//     because the audit record is the only evidence afterwards of who extracted the shop's data.
//   • LOG (`GET /v1/exports`) — that export audit trail, newest first.
//
// All three gated `export.read`; the domain's own permission and `export.sensitive` are enforced
// underneath by the engine, per domain and per caller. No AI exports anything (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  exportDomain, type ExportSpec, type ExportContext, type ExportAudit, type ExportResult,
} from '../../../packages/export/src/export';
import { AccessControl, AccessDeniedError } from '../../../packages/rbac/src/rbac';
import type { ProductRecord } from '../../../packages/product/src/product';
import type { ImportCommitRecord } from './data-import';
import type { StoredPurchaseOrder } from './purchase-orders';

type Row = Readonly<Record<string, string>>;

/** A bounded period of whole days (inclusive), for a domain whose records are dated. */
export interface ExportPeriod { readonly from: string; readonly to: string }

/** One exportable domain: its open schema, and where its rows come from (a store fold). */
export interface ExportDomainSource {
  readonly spec: ExportSpec;
  /**
   * SF-10: a dated domain (attendance) is exported for a BOUNDED period only — `{ from, to }` (YYYY-MM-DD, inclusive) in
   * the request body, at most `maxDays` long. Absent: the domain is exported whole and takes no period.
   */
  readonly period?: { readonly maxDays: number };
  readonly rows: (tenantId: string, period?: ExportPeriod) => Promise<readonly Row[]> | readonly Row[];
}

const DAY_MS = 86_400_000;
const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
/** Every date from `from` to `to`, inclusive. */
export function daysOf(period: ExportPeriod): readonly string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${period.from}T00:00:00Z`); t <= Date.parse(`${period.to}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** The append-only export audit ledger (who took what) — an `ExportAudit` per export. */
export interface DataExportAuditDeps {
  readonly exports: (tenantId: string) => Promise<readonly ExportAudit[]> | readonly ExportAudit[];
  readonly recordExport: (tenantId: string, record: ExportAudit, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export interface DataExportDeps extends DataExportAuditDeps {
  readonly domains: readonly ExportDomainSource[];
  /** The caller's authority for this tenant — the SAME per-tenant resolver the kernel uses. */
  readonly access: (tenantId: string) => Promise<AccessControl> | AccessControl;
}

/**
 * The production export domains, each backed by an already-folded read model:
 *   • `products` — the product master (M03), gated `catalogue.pack.read`;
 *   • `import-commits` — the M30 bulk-import audit ledger (what was loaded, by whom, approved by
 *     whom), gated `purchase.import.read`.
 * Every value is emitted as text for an open CSV; a missing optional is blank, never invented.
 */
/** A sale as the export reads it — the sales ledger's own record (SF-10). */
export interface ExportSale {
  readonly saleId: string; readonly receiptNumber: string; readonly tradingDay: string; readonly committedAt: string;
  readonly locationId?: string; readonly laneId: string; readonly cashierId: string; readonly totalMinor: number;
  readonly tenders: readonly { readonly kind: string; readonly amountMinor: number }[]; readonly customerRef?: string;
}
/** A stock position as the export reads it — the stock ledger's availability fold. */
export interface ExportStockRow { readonly productId: string; readonly locationId: string; readonly onHandMinor: number }
/** A supplier as the export reads it — the supplier master. */
export interface ExportSupplier {
  readonly supplierId: string; readonly name: string; readonly gstin: string | null; readonly phone: string | null; readonly email: string | null;
  readonly address: string | null; readonly paymentTermsDays: number | null; readonly status: string; readonly approvedBy: string | null;
}
/** One journal line as the export reads it — the finance ledger. */
export interface ExportJournal {
  readonly entryId: string; readonly period: string; readonly documentDate: string; readonly narrative: string; readonly postedBy: string;
  readonly lines: readonly { readonly accountCode: string; readonly debitMinor: number; readonly creditMinor: number }[];
}

/**
 * A customer as the export reads it (SF-10 · M16): the loyalty member register — the shop's register of enrolled
 * customers (OB-28/29: a member code and the last four digits of the mobile, NEVER the number or an email, P-04) — with
 * the customer's consent ledger folded to the latest decision per purpose and channel.
 */
export interface ExportCustomer {
  readonly customerRef: string; readonly status: string; readonly mobileLast4: string; readonly enrolledAt: string; readonly enrolledBy: string;
  readonly leftAt?: string;
  readonly consents: readonly { readonly purpose: string; readonly channel: string; readonly given: boolean; readonly recordedAt: string; readonly evidence: string }[];
}
/** A member's wallet as the export reads it — the SAME feed the store computers pull (`GET /v1/loyalty/wallets`). */
export interface ExportLoyaltyWallet { readonly memberRef: string; readonly points: number; readonly storeCreditMinor: number }
/** An order as the export reads it — the order index, each order at its current state (M18). */
export interface ExportOrder {
  readonly orderId: string; readonly locationId: string; readonly placedAt: string; readonly currentState: string;
  readonly lines: readonly unknown[]; readonly fulfilment?: string; readonly customerRef?: string;
}
/** An attendance day as the export reads it — the attendance store's latest hours for (employee, date). */
export interface ExportAttendance { readonly date: string; readonly employeeId: string; readonly hours: number }
/** A member of staff as the export reads it — the staff register (branch, hourly rate). */
export interface ExportStaff { readonly employeeId: string; readonly branchId: string; readonly hourlyRateMinor?: number }

/** An issued payslip as the export reads it — the payslip register, with the employee's branch from the staff register. */
export interface ExportPayslip {
  readonly employeeId: string; readonly branchId: string | null; readonly period: string; readonly onDate: string;
  readonly paidDays: number; readonly lopDays: number; readonly grossMinor: number; readonly totalEmployeeDeductionMinor: number;
  readonly totalEmployerContributionMinor: number; readonly netPayMinor: number;
}

/**
 * The EXPORT COVERAGE REGISTER (audit SF-10 · M30-FR-02 · P-06): every business-data domain, and whether the shop can
 * take it out through the governed export (`exported`) or not yet (`not_yet`, with why and where it is planned). A
 * guardrail checks that every `exported` entry is a registered domain, so the register cannot claim coverage the
 * engine does not give.
 */
export const EXPORT_COVERAGE: readonly { readonly domain: string; readonly module: string; readonly status: 'exported' | 'not_yet'; readonly exportDomain?: string; readonly why?: string }[] = [
  { domain: 'Product master', module: 'M03', status: 'exported', exportDomain: 'products' },
  { domain: 'Import loads (what was loaded, by whom)', module: 'M30', status: 'exported', exportDomain: 'import-commits' },
  { domain: 'Sales (bills and how they were paid)', module: 'M12/M13', status: 'exported', exportDomain: 'sales' },
  { domain: 'Stock on hand by store', module: 'M08', status: 'exported', exportDomain: 'stock-on-hand' },
  { domain: 'Supplier master', module: 'M06/M24', status: 'exported', exportDomain: 'suppliers' },
  { domain: 'Ledger journals', module: 'M23', status: 'exported', exportDomain: 'ledger-journals' },
  { domain: 'Purchase orders', module: 'M06', status: 'exported', exportDomain: 'purchase-orders' },
  { domain: 'Customers and consent', module: 'M16', status: 'exported', exportDomain: 'customers' },
  { domain: 'Loyalty points and store credit', module: 'M17', status: 'exported', exportDomain: 'loyalty-wallets' },
  { domain: 'Orders (desk and online)', module: 'M18', status: 'exported', exportDomain: 'orders' },
  { domain: 'Payroll (issued payslips)', module: 'M26', status: 'exported', exportDomain: 'payslips' },
  { domain: 'Attendance hours (a bounded period)', module: 'M25/M26', status: 'exported', exportDomain: 'attendance' },
];

export function buildExportDomains(sources: {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
  readonly importCommits: (tenantId: string) => Promise<readonly ImportCommitRecord[]> | readonly ImportCommitRecord[];
  /** SF-10: the further governed domains. Each optional — absent, the domain is not offered (never an empty file). */
  readonly sales?: (tenantId: string) => Promise<readonly ExportSale[]>;
  readonly stock?: (tenantId: string) => Promise<readonly ExportStockRow[]>;
  readonly suppliers?: (tenantId: string) => Promise<readonly ExportSupplier[]>;
  readonly journals?: (tenantId: string) => Promise<readonly ExportJournal[]>;
  /** SF-10 round 5: the remaining domains, each from its own read model. */
  readonly purchaseOrders?: (tenantId: string) => Promise<readonly StoredPurchaseOrder[]>;
  readonly customers?: (tenantId: string) => Promise<readonly ExportCustomer[]>;
  readonly loyaltyWallets?: (tenantId: string) => Promise<{ readonly pointValuePaise: number; readonly members: readonly ExportLoyaltyWallet[] }>;
  readonly orders?: (tenantId: string) => Promise<readonly ExportOrder[]>;
  readonly payslips?: (tenantId: string) => Promise<readonly ExportPayslip[]>;
  /** The attendance store's read for ONE day (the same read `GET /v1/hr/workforce/attendance?date=` answers) and the staff register. */
  readonly attendanceOn?: (tenantId: string, date: string) => Promise<readonly ExportAttendance[]>;
  readonly staff?: (tenantId: string) => Promise<readonly ExportStaff[]>;
}): readonly ExportDomainSource[] {
  const more: ExportDomainSource[] = [];
  if (sources.attendanceOn !== undefined && sources.staff !== undefined) {
    const attendanceOn = sources.attendanceOn;
    const staff = sources.staff;
    more.push({
      spec: {
        // The same authority as the attendance read itself (workforce.roster.read), scoped to the employee's branch.
        // Hours and what they cost are pay-relevant: under the payroll rule they are REDACTED for anyone without
        // export.sensitive (today the owner), so a manager's file says who was recorded on which day, not their pay.
        domain: 'attendance', requires: 'workforce.roster.read', branchColumn: 'branch',
        columns: [
          { name: 'date', type: 'date' }, { name: 'employeeId', type: 'text' },
          { name: 'branch', type: 'text', description: 'The employee\'s branch on the staff register (blank if not on it).' },
          { name: 'hours', type: 'text', sensitive: true, description: 'Hours worked that day, as recorded (the latest record wins).' },
          { name: 'hourlyRateMinor', type: 'integer', sensitive: true, description: 'The hourly rate on the staff register, in paise; blank if none.' },
          { name: 'costMinor', type: 'integer', sensitive: true, description: 'hours × hourly rate, rounded to the paisa; blank if no rate.' },
        ],
      },
      // One calendar month of days at most — a pay period — so an export is never an unbounded scan of every day.
      period: { maxDays: 31 },
      rows: async (t, period) => {
        if (period === undefined) return [];
        const register = new Map((await staff(t)).map((e) => [e.employeeId, e] as const));
        const out: Row[] = [];
        for (const date of daysOf(period)) {
          const day = [...(await attendanceOn(t, date))].sort((a, b) => a.employeeId.localeCompare(b.employeeId));
          for (const r of day) {
            const who = register.get(r.employeeId);
            const rate = who?.hourlyRateMinor;
            out.push({
              date: r.date, employeeId: r.employeeId, branch: who?.branchId ?? '', hours: String(r.hours),
              hourlyRateMinor: rate === undefined ? '' : String(rate), costMinor: rate === undefined ? '' : String(Math.round(r.hours * rate)),
            });
          }
        }
        return out;
      },
    });
  }
  if (sources.purchaseOrders !== undefined) {
    const pos = sources.purchaseOrders;
    more.push({
      spec: {
        // A PO is delivered to a store (OB-37): a store-limited buyer exports that store's orders only.
        domain: 'purchase-orders', requires: 'purchase.commitment.read', branchColumn: 'store',
        columns: [
          { name: 'poId', type: 'text' }, { name: 'number', type: 'text' }, { name: 'supplierId', type: 'text' },
          { name: 'store', type: 'text', description: 'The store it is delivered to; blank for an order raised before OB-37 (store not named).' },
          { name: 'status', type: 'enum', description: 'proposed | issued.' }, { name: 'lines', type: 'integer' },
          { name: 'totalMinor', type: 'integer', description: 'Order value in paise.' }, { name: 'currency', type: 'text' },
          { name: 'requisitionedBy', type: 'text' }, { name: 'approvedBy', type: 'text', description: 'The second person who issued it (§28).' },
          { name: 'raisedAt', type: 'date' }, { name: 'issuedAt', type: 'date' },
          { name: 'receivedQty', type: 'text', description: 'productId:quantity pairs received against it, base units.' },
          { name: 'cancelledQty', type: 'text', description: 'productId:quantity pairs cancelled, base units.' },
        ],
      },
      rows: async (t) => (await pos(t)).map((p) => ({
        poId: p.poId, number: p.number, supplierId: p.supplierId, store: p.deliverToLocationId ?? '', status: p.status, lines: String(p.lines.length),
        totalMinor: String(p.totalMinor), currency: p.currency, requisitionedBy: p.requisitionedBy, approvedBy: p.approvedBy ?? '', raisedAt: p.at, issuedAt: p.issuedAt ?? '',
        receivedQty: Object.entries(p.receivedByProduct).map(([k, v]) => `${k}:${v}`).join(';'),
        cancelledQty: Object.entries(p.cancelledByProduct).map(([k, v]) => `${k}:${v}`).join(';'),
      })),
    });
  }
  if (sources.customers !== undefined) {
    const customers = sources.customers;
    more.push({
      spec: {
        // Personal data (P-04 · DPDP): exported only to a role that may read a customer's record, and the identifying
        // columns are REDACTED unless the person also holds export.sensitive. The shop holds no full mobile number or
        // email for a customer — only what is listed here.
        domain: 'customers', requires: 'customer.profile.read',
        columns: [
          { name: 'customerRef', type: 'text', sensitive: true, description: 'The member code (pseudonymous).' },
          { name: 'status', type: 'enum', description: 'member | left.' },
          { name: 'mobileLast4', type: 'text', sensitive: true, description: 'The last four digits of the mobile — the shop keeps no more.' },
          { name: 'enrolledAt', type: 'date', description: 'When the customer said yes to loyalty.' }, { name: 'enrolledBy', type: 'text' },
          { name: 'leftAt', type: 'date' },
          { name: 'consent', type: 'text', description: 'purpose/channel=given|withdrawn@date pairs, the latest decision for each.' },
          { name: 'consentEvidence', type: 'text', sensitive: true, description: 'How each latest decision was captured.' },
        ],
      },
      rows: async (t) => (await customers(t)).map((c) => ({
        customerRef: c.customerRef, status: c.status, mobileLast4: c.mobileLast4, enrolledAt: c.enrolledAt, enrolledBy: c.enrolledBy, leftAt: c.leftAt ?? '',
        consent: c.consents.map((x) => `${x.purpose}/${x.channel}=${x.given ? 'given' : 'withdrawn'}@${x.recordedAt}`).join(';'),
        consentEvidence: c.consents.map((x) => `${x.purpose}/${x.channel}:${x.evidence}`).join(';'),
      })),
    });
  }
  if (sources.loyaltyWallets !== undefined) {
    const wallets = sources.loyaltyWallets;
    more.push({
      spec: {
        domain: 'loyalty-wallets', requires: 'loyalty.points.read',
        columns: [
          { name: 'memberRef', type: 'text', sensitive: true, description: 'The member code (pseudonymous) — redacted without export.sensitive.' },
          { name: 'points', type: 'integer' },
          { name: 'pointsValueMinor', type: 'integer', description: 'points × the point value in force, in paise.' },
          { name: 'storeCreditMinor', type: 'integer', description: 'Store credit still held, in paise.' },
        ],
      },
      rows: async (t) => {
        const feed = await wallets(t);
        return feed.members.map((m) => ({
          memberRef: m.memberRef, points: String(m.points), pointsValueMinor: String(m.points * feed.pointValuePaise), storeCreditMinor: String(m.storeCreditMinor),
        }));
      },
    });
  }
  if (sources.orders !== undefined) {
    const orders = sources.orders;
    more.push({
      spec: {
        domain: 'orders', requires: 'order.read', branchColumn: 'store',
        columns: [
          { name: 'orderId', type: 'text' }, { name: 'store', type: 'text', description: 'The store that fulfils it.' },
          { name: 'placedAt', type: 'date' }, { name: 'state', type: 'enum', description: 'Its state now (the last step of its lifecycle).' },
          { name: 'lines', type: 'integer' }, { name: 'fulfilment', type: 'enum', description: 'delivery | pickup | blank (a desk order).' },
          { name: 'customerRef', type: 'text', sensitive: true, description: 'Who placed it through the storefront — redacted without export.sensitive.' },
        ],
      },
      rows: async (t) => (await orders(t)).map((o) => ({
        orderId: o.orderId, store: o.locationId, placedAt: o.placedAt, state: o.currentState, lines: String(o.lines.length), fulfilment: o.fulfilment ?? '', customerRef: o.customerRef ?? '',
      })),
    });
  }
  if (sources.payslips !== undefined) {
    const payslips = sources.payslips;
    more.push({
      spec: {
        // Pay is the most sensitive figure the shop holds: exported only by those who hold payroll.statutory.read (the
        // owner; HR when the owner names an HR role), the pay columns redacted for anyone without export.sensitive, scoped
        // to the employee's branch. READ-ONLY: this carries no bank details and is never a salary bank file — the bank-file
        // release stays under the payroll pilot hold.
        domain: 'payslips', requires: 'payroll.statutory.read', branchColumn: 'branch',
        columns: [
          { name: 'employeeId', type: 'text' }, { name: 'branch', type: 'text', description: 'The employee\'s branch (blank if not on the staff register).' },
          { name: 'period', type: 'text' }, { name: 'onDate', type: 'date' },
          { name: 'paidDays', type: 'integer' }, { name: 'lopDays', type: 'integer', description: 'Loss-of-pay days.' },
          { name: 'grossMinor', type: 'integer', sensitive: true }, { name: 'employeeDeductionsMinor', type: 'integer', sensitive: true, description: 'PF + ESI + PT + TDS withheld.' },
          { name: 'employerContributionsMinor', type: 'integer', sensitive: true }, { name: 'netPayMinor', type: 'integer', sensitive: true },
        ],
      },
      rows: async (t) => (await payslips(t)).map((p) => ({
        employeeId: p.employeeId, branch: p.branchId ?? '', period: p.period, onDate: p.onDate, paidDays: String(p.paidDays), lopDays: String(p.lopDays),
        grossMinor: String(p.grossMinor), employeeDeductionsMinor: String(p.totalEmployeeDeductionMinor),
        employerContributionsMinor: String(p.totalEmployerContributionMinor), netPayMinor: String(p.netPayMinor),
      })),
    });
  }
  if (sources.sales !== undefined) {
    const sales = sources.sales;
    more.push({
      spec: {
        domain: 'sales', requires: 'reporting.report.read', branchColumn: 'store',
        columns: [
          { name: 'saleId', type: 'text' }, { name: 'receiptNumber', type: 'text' }, { name: 'tradingDay', type: 'date' },
          { name: 'committedAt', type: 'date' }, { name: 'store', type: 'text', description: 'The store (location) the bill was rung at.' },
          { name: 'lane', type: 'text' }, { name: 'cashier', type: 'text' }, { name: 'totalMinor', type: 'integer', description: 'Bill total in paise, GST included.' },
          { name: 'tenders', type: 'text', description: 'kind:amount pairs, e.g. cash:5000;card:50000.' },
          { name: 'memberRef', type: 'text', sensitive: true, description: 'The loyalty member code (pseudonymous) — redacted without export.sensitive.' },
        ],
      },
      rows: async (t) => (await sales(t)).map((x) => ({
        saleId: x.saleId, receiptNumber: x.receiptNumber, tradingDay: x.tradingDay, committedAt: x.committedAt, store: x.locationId ?? '',
        lane: x.laneId, cashier: x.cashierId, totalMinor: String(x.totalMinor), tenders: x.tenders.map((d) => `${d.kind}:${d.amountMinor}`).join(';'),
        memberRef: x.customerRef ?? '',
      })),
    });
  }
  if (sources.stock !== undefined) {
    const stock = sources.stock;
    more.push({
      spec: {
        domain: 'stock-on-hand', requires: 'inventory.availability.read', branchColumn: 'store',
        columns: [{ name: 'productId', type: 'text' }, { name: 'store', type: 'text' }, { name: 'onHandMinor', type: 'integer', description: 'In the product\'s base unit (grams for weighed goods, OB-31).' }],
      },
      rows: async (t) => (await stock(t)).map((r) => ({ productId: r.productId, store: r.locationId, onHandMinor: String(r.onHandMinor) })),
    });
  }
  if (sources.suppliers !== undefined) {
    const suppliers = sources.suppliers;
    more.push({
      spec: {
        domain: 'suppliers', requires: 'supplier.view',
        columns: [
          { name: 'supplierId', type: 'text' }, { name: 'name', type: 'text' }, { name: 'gstin', type: 'text' },
          { name: 'phone', type: 'text', sensitive: true }, { name: 'email', type: 'text', sensitive: true }, { name: 'address', type: 'text', sensitive: true },
          { name: 'paymentTermsDays', type: 'integer' }, { name: 'status', type: 'enum', description: 'proposed | active.' }, { name: 'approvedBy', type: 'text' },
        ],
      },
      rows: async (t) => (await suppliers(t)).map((x) => ({
        supplierId: x.supplierId, name: x.name, gstin: x.gstin ?? '', phone: x.phone ?? '', email: x.email ?? '', address: x.address ?? '',
        paymentTermsDays: x.paymentTermsDays === null ? '' : String(x.paymentTermsDays), status: x.status, approvedBy: x.approvedBy ?? '',
      })),
    });
  }
  if (sources.journals !== undefined) {
    const journals = sources.journals;
    more.push({
      spec: {
        domain: 'ledger-journals', requires: 'finance.period.read',
        columns: [
          { name: 'entryId', type: 'text' }, { name: 'period', type: 'text' }, { name: 'documentDate', type: 'date' }, { name: 'account', type: 'text' },
          { name: 'debitMinor', type: 'integer' }, { name: 'creditMinor', type: 'integer' }, { name: 'narrative', type: 'text' }, { name: 'postedBy', type: 'text' },
        ],
      },
      // One row per journal LINE — the shape any accounting package imports.
      rows: async (t) => (await journals(t)).flatMap((j) => j.lines.map((l) => ({
        entryId: j.entryId, period: j.period, documentDate: j.documentDate, account: l.accountCode,
        debitMinor: String(l.debitMinor), creditMinor: String(l.creditMinor), narrative: j.narrative, postedBy: j.postedBy,
      }))),
    });
  }
  return [
    ...more,
    {
      spec: {
        domain: 'products',
        requires: 'catalogue.pack.read',
        columns: [
          { name: 'productId', type: 'text', description: 'Stable internal product id.' },
          { name: 'sku', type: 'text', description: 'Stock-keeping unit.' },
          { name: 'name', type: 'text' },
          { name: 'brand', type: 'text' },
          { name: 'manufacturer', type: 'text' },
          { name: 'category', type: 'text', description: 'Primary reporting category id.' },
          { name: 'uom', type: 'text', description: 'Base unit of measure.' },
          { name: 'taxClass', type: 'text', description: 'HSN / tax-class code.' },
          { name: 'status', type: 'enum', description: 'draft | new | active | clearance | discontinued.' },
          { name: 'recallBlocked', type: 'enum', description: 'yes when sale and purchase are blocked.' },
        ],
      },
      rows: async (t) =>
        (await sources.products(t)).map((p) => ({
          productId: p.productId,
          sku: p.sku,
          name: p.name,
          brand: p.brand ?? '',
          manufacturer: p.manufacturer ?? '',
          category: p.primaryCategoryId ?? '',
          uom: p.baseUom,
          taxClass: p.taxClass ?? '',
          status: p.lifecycle,
          recallBlocked: p.recallBlocked === true ? 'yes' : 'no',
        })),
    },
    {
      spec: {
        domain: 'import-commits',
        requires: 'purchase.import.read',
        columns: [
          { name: 'jobId', type: 'text' },
          { name: 'template', type: 'text', description: 'Import template id.' },
          { name: 'domain', type: 'text', description: 'What the file loaded into.' },
          { name: 'uploadedBy', type: 'text' },
          { name: 'approvedBy', type: 'text', description: 'The separate approver (§28).' },
          { name: 'rowsApplied', type: 'integer' },
          { name: 'reconciles', type: 'text', description: 'yes | no | blank (not a financial import).' },
          { name: 'at', type: 'date' },
          { name: 'rolledBack', type: 'enum', description: 'yes when the load was rolled back (M30-FR-04) — its records withdrawn by compensating records.' },
          { name: 'rolledBackAt', type: 'date' },
          { name: 'rollbackApprovedBy', type: 'text', description: 'The second person who approved the rollback (§28).' },
        ],
      },
      rows: async (t) =>
        (await sources.importCommits(t)).map((c) => ({
          jobId: c.jobId,
          template: c.templateId,
          domain: c.domain,
          uploadedBy: c.uploadedBy,
          approvedBy: c.approvedBy,
          rowsApplied: String(c.rowsApplied),
          reconciles: c.reconciles === undefined ? '' : c.reconciles ? 'yes' : 'no',
          at: c.at,
          rolledBack: c.rolledBack === undefined ? 'no' : 'yes',
          rolledBackAt: c.rolledBack?.at ?? '',
          rollbackApprovedBy: c.rolledBack?.approvedBy ?? '',
        })),
    },
  ];
}

export function dataExportRoutes(deps: DataExportDeps): readonly Route[] {
  return [
    {
      // LIST — what can be exported, and in what shape (which columns are sensitive). No data.
      api: 'API-03', method: 'GET', path: '/v1/export',
      permission: 'export.read',
      handler: async () => ({
        status: 200,
        body: {
          domains: deps.domains.map((d) => ({
            domain: d.spec.domain,
            requires: d.spec.requires,
            ...(d.period === undefined ? {} : { period: { required: true, maxDays: d.period.maxDays } }),
            columns: d.spec.columns.map((c) => ({
              name: c.name,
              type: c.type,
              sensitive: c.sensitive === true,
              ...(c.description !== undefined ? { description: c.description } : {}),
            })),
          })),
          asAt: deps.now(),
        },
      }),
    },
    {
      // EXPORT — run the engine for one domain. POST because it produces an audited artifact: the
      // caller's own authority decides allowed / which branch / sensitive-or-redacted, and the export
      // is logged. A replay of the same idempotency key returns the first export.
      api: 'API-03', method: 'POST', path: '/v1/export/:domain',
      permission: 'export.read', idempotent: true,
      handler: async (ctx) => {
        const name = ctx.params['domain'] ?? '';
        const source = deps.domains.find((d) => d.spec.domain === name);
        if (source === undefined) {
          throw apiError(404, {
            code: 'unknown_export_domain',
            whatHappened: `There is no exportable domain '${name}'.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the name against GET /v1/export.',
          });
        }
        // SF-10: a dated domain takes a bounded period, checked before anything is read.
        let period: ExportPeriod | undefined;
        if (source.period !== undefined) {
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          const from = b['from']; const to = b['to'];
          const span = isIsoDate(from) && isIsoDate(to) ? (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1 : NaN;
          if (!isIsoDate(from) || !isIsoDate(to) || !(span >= 1) || span > source.period.maxDays) {
            throw apiError(400, {
              code: 'export_period_not_bounded',
              whatHappened: `'${source.spec.domain}' is exported for a bounded period: { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }, from on or before to, at most ${source.period.maxDays} days.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send the period in the body. Nothing was exported or logged.',
            });
          }
          period = { from, to };
        }
        const access = await deps.access(ctx.tenantId);
        const context: ExportContext = { userId: ctx.userId, branchId: ctx.branchId, at: deps.now() };
        const rows = await source.rows(ctx.tenantId, period);

        let result: ExportResult;
        try {
          // The engine is the single gate: the domain's own permission, branch scope, and
          // sensitive-column redaction all decided here against the caller's real authority.
          result = exportDomain(source.spec, rows, access, context);
        } catch (e) {
          if (e instanceof AccessDeniedError) {
            throw apiError(403, {
              code: 'export_not_permitted',
              whatHappened: `You may not export '${source.spec.domain}'.`,
              wasItSaved: 'not_saved',
              nextSafeAction: `This export needs the '${source.spec.requires}' permission.`,
            });
          }
          throw e;
        }

        // Exports are logged — the audit record is the only evidence afterwards of who took the data.
        const audit = period === undefined ? result.audit : { ...result.audit, period };
        await deps.recordExport(ctx.tenantId, audit, ctx.idempotencyKey ?? `${source.spec.domain}-${context.at}`);
        return {
          status: 200,
          body: { domain: source.spec.domain, csv: result.csv, schema: result.schema, audit },
        };
      },
    },
    {
      // COVERAGE (SF-10) — every business-data domain and whether it can be taken out here yet, with why not. No data.
      api: 'API-03', method: 'GET', path: '/v1/export/coverage',
      permission: 'export.read',
      handler: () => {
        const offered = new Set(deps.domains.map((d) => d.spec.domain));
        const register = EXPORT_COVERAGE.map((c) => ({ ...c, offeredHere: c.exportDomain !== undefined && offered.has(c.exportDomain) }));
        return { status: 200, body: { coverage: register, exported: register.filter((c) => c.offeredHere).length, notYet: register.filter((c) => c.status === 'not_yet').length, asAt: deps.now() } };
      },
    },
    {
      // LOG — the export audit trail, newest first: who took what, when, how many rows, what was redacted.
      api: 'API-03', method: 'GET', path: '/v1/exports',
      permission: 'export.read',
      handler: async (ctx) => {
        const all = await deps.exports(ctx.tenantId);
        const ordered = [...all].sort((a, b) => b.at.localeCompare(a.at));
        return { status: 200, body: { exports: ordered, total: ordered.length, asAt: deps.now() } };
      },
    },
  ];
}
