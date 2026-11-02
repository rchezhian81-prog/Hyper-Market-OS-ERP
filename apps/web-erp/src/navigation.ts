// Role-scoped navigation (§27 role surfaces / P-07 "the simplest interface each
// role needs" / P-04 least privilege). The ERP serves many roles — store manager,
// purchase, inventory, finance, security, admin — and each should see only their
// own work. So the menu is DERIVED from the user's actual permissions rather than
// hand-maintained per role: a section appears only if the user holds the permission
// that section requires, in the branch they are working in.
//
// Two consequences matter:
//   • the menu can never show a section the user would be refused on (default-deny
//     is the same engine that guards the action itself — `packages/rbac`), so the
//     screen and the server agree;
//   • adding a role is configuration, not code (choose-able per tenant, ADR-0003).
//
// Pure and deterministic — no I/O, no framework. Any SSR view can render this.

import type { AccessControl, Permission } from '../../../packages/rbac/src/rbac';

/** One navigable area of the ERP, gated by the permission it needs. */
export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  /** The permission a user must hold for this item to appear at all. */
  readonly requires: Permission;
  /**
   * R10-A · OB-543: a NARROWER word that also opens this one screen (and nothing else) — e.g. the accountant's
   * `inventory.goodsreceipt.read` for the goods-receipt screen, so a reader is not given a broad word for one screen.
   * Absent: only `requires` opens it.
   */
  readonly alsoOpenedWith?: readonly Permission[];
  /** Grouping for the sidebar; items keep their declared order within a group. */
  readonly group: string;
  /** The same label in Tamil (NFR-08) — the menu is drawn in the reader's language, never half of it. */
  readonly labelTa: string;
  /**
   * Where a person can reach this screen TODAY (Stage G slice 5b). `box` (the default) — the store computer serves
   * it, so the menu the box draws may offer it. `unserved` — the page exists in `apps/web-erp/web` but no product
   * component serves it yet, so the box omits it rather than offer a dead link (none since OB-380, 26 Oct 2026: the
   * store computer serves every office page head office answers). `unbuilt` — no page exists; the
   * item stays in the catalogue so the gap is named, not forgotten (none since OB-401, 27 Oct 2026: Reconciliation and
   * Settings open existing pages). Both non-box states are listed in the unit test and in docs/STATUS.md.
   */
  readonly served?: 'box' | 'unserved' | 'unbuilt';
}

/**
 * The group headings in both languages, keyed by the `group` an item declares — in the order the rail shows them.
 *
 * W1 (owner, 1 Nov 2026: "things are hard to find — a long confusing menu, unclear names"; P-07): the workspaces are
 * TASKS a store person recognises, not modules — "Goods coming in", "Waste, expiry & returns", "My work & pay" — and the
 * keys stay what they were, so every screen id, path and permission is unchanged and a page another builder adds under
 * an old key still lands in the workspace that does that job. `Daily` is not a catalogue group: it is drawn first, per
 * person, from `DAILY_WORK` (their role's everyday jobs), and those items are not repeated below it.
 */
export const NAV_GROUP_LABELS: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  Daily: { en: 'Your daily work', ta: 'உங்கள் தினசரி வேலை' },
  Today: { en: 'Today & approvals', ta: 'இன்றும் அனுமதிகளும்' },
  Products: { en: 'Products & prices', ta: 'பொருட்களும் விலைகளும்' },
  Purchase: { en: 'Buying from suppliers', ta: 'விநியோகஸ்தர்களிடம் வாங்குதல்' },
  Receiving: { en: 'Goods coming in', ta: 'வரும் சரக்கு' },
  Inventory: { en: 'Stock & counts', ta: 'சரக்கும் எண்ணிக்கையும்' },
  Waste: { en: 'Waste, expiry & returns', ta: 'வீணாதல், காலாவதி, திருப்பம்' },
  Floor: { en: 'Shelves & shop floor', ta: 'அலமாரிகளும் கடைத் தளமும்' },
  Customers: { en: 'Customers & service', ta: 'வாடிக்கையாளர்களும் சேவையும்' },
  Sales: { en: 'Sales & service', ta: 'விற்பனையும் சேவையும்' },
  Orders: { en: 'Online orders & delivery', ta: 'ஆன்லைன் ஆர்டர்களும் டெலிவரியும்' },
  Production: { en: 'Fresh food & café', ta: 'புதிய உணவும் கஃபேவும்' },
  Finance: { en: 'Cash, accounts & GST', ta: 'பணம், கணக்குகள், ஜிஎஸ்டி' },
  People: { en: 'Staff, rota & tasks', ta: 'பணியாளர்கள், பணி அட்டவணை, பணிகள்' },
  Mine: { en: 'My work & pay', ta: 'என் வேலையும் சம்பளமும்' },
  Operations: { en: 'Checks & investigations', ta: 'சோதனைகளும் விசாரணைகளும்' },
  Reports: { en: 'Reports & figures', ta: 'அறிக்கைகளும் எண்களும்' },
  Administration: { en: 'Setup, people & access', ta: 'அமைப்பு, நபர்கள், அணுகல்' },
  Systems: { en: 'Tills, devices & connections', ta: 'கல்லாக்கள், சாதனங்கள், இணைப்புகள்' },
  Devices: { en: 'Open a device screen', ta: 'சாதனத் திரையைத் திற' },
});

/** The key of the per-person "daily work" group drawn first on the rail. */
export const DAILY_GROUP = 'Daily';

/**
 * A role's everyday jobs, in the order they are done (W1 · P-07 "the simplest interface each role needs"). Keyed by the
 * product's own role ids (services/api/src/roles.ts — the roles are the product's configuration, not tenant data). Each
 * id is still gated item by item on its own permission: a job listed here that the person may not open is simply not
 * shown, so this table can never widen what anybody sees. A person with several roles gets each role's jobs, once, in
 * this table's order. A role not listed gets no daily group — the workspaces alone, as before.
 */
export const DAILY_WORK: Readonly<Record<string, readonly string[]>> = Object.freeze({
  owner: ['dashboard', 'approval-requests', 'morning-brief', 'company-report', 'owner-alerts', 'finance-close'],
  store_manager: ['dashboard', 'approval-requests', 'cash-office', 'goods-receipt', 'stock-health', 'expiry', 'store-tasks'],
  accountant: ['day-book', 'finance-close', 'supplier-bills', 'gst-returns', 'itc-review', 'approval-requests'],
  chartered_accountant: ['gst-returns'],
  cashier: ['till', 'my-tasks', 'approval-requests', 'my-payslip', 'help'],
  platform_admin: ['store-computers', 'integration-health', 'fleet', 'incidents'],
  security_reviewer: ['risk-acceptance'],
});

/**
 * Within a workspace, the screens a person reaches for most come first (W1). Ids named here lead, in this order; every
 * other item of the group follows in the catalogue's declaration order. Only order — nothing is added or hidden.
 */
export const NAV_ITEM_ORDER: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Today: ['dashboard', 'approval-requests'],
  Products: ['products', 'pricing', 'promotions', 'shelf-tags', 'price-integrity'],
  Purchase: ['buying', 'supplier-bills', 'suppliers', 'requisitions'],
  Receiving: ['goods-receipt', 'dock-diary'],
  Inventory: ['stock-health', 'counts', 'indents', 'transfers'],
  Waste: ['expiry', 'write-off-capture', 'waste'],
  Customers: ['customers', 'service', 'service-desk', 'loyalty-desk'],
  Finance: ['cash-office', 'day-book', 'finance-close', 'finance', 'gst-returns', 'itc-review', 'gst-reconciliation', 'tally-files'],
  People: ['store-tasks', 'rostering', 'schedule', 'checklist'],
  Mine: ['my-tasks', 'my-payslip', 'ess', 'help'],
  Reports: ['reporting', 'morning-brief', 'company-report'],
  Administration: ['users', 'store-setup', 'approval-rules', 'access-review'],
  Devices: ['till'],
});

/**
 * Plain words a store person might type to find a screen, beyond its name and its workspace's (W1: "search finds a page
 * by a plain word"). Both languages; matched case-free as a part of a word. Only words for what the screen IS for.
 */
export const NAV_SEARCH_WORDS: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  'dashboard': { en: 'home start figures sales today exceptions day close', ta: 'முகப்பு விற்பனை' },
  'approval-requests': { en: 'approve reject decide sign off waiting requests', ta: 'ஒப்புதல் நிராகரி' },
  'products': { en: 'items catalogue barcode sku', ta: 'பொருள் பார்கோடு' },
  'pricing': { en: 'price change mrp rate', ta: 'விலை மாற்றம்' },
  'promotions': { en: 'offer discount deal sale', ta: 'தள்ளுபடி சலுகை' },
  'shelf-tags': { en: 'label print price tag ticket', ta: 'விலைச் சீட்டு அச்சு' },
  'price-integrity': { en: 'wrong price shelf till mismatch', ta: 'தவறான விலை' },
  'buying': { en: 'purchase order po supplier invoice', ta: 'கொள்முதல் ஆணை' },
  'supplier-bills': { en: 'invoice bill purchase match', ta: 'பில் விலைப்பட்டியல்' },
  'requisitions': { en: 'quotation rfq compare quotes', ta: 'விலைப்புள்ளி' },
  'goods-receipt': { en: 'grn receive delivery inward unload', ta: 'சரக்கு வரவு' },
  'dock-diary': { en: 'delivery booking lorry truck unloading slot', ta: 'லாரி முன்பதிவு' },
  'stock-health': { en: 'stock out low stock availability inventory', ta: 'இருப்பு' },
  'counts': { en: 'stock take count audit physical', ta: 'சரக்கு எண்ணுதல்' },
  'indents': { en: 'refill shelf request indent replenish', ta: 'நிரப்புதல் கோரிக்கை' },
  'transfers': { en: 'move stock branch warehouse', ta: 'இடமாற்றம்' },
  'waste': { en: 'damage spoil write off', ta: 'சேதம் வீண்' },
  'write-off-capture': { en: 'damage spoil broken waste', ta: 'சேதம்' },
  'expiry': { en: 'expired date near expiry markdown recall batch', ta: 'காலாவதி' },
  'recall-trace': { en: 'recall batch lot trace', ta: 'திரும்பப் பெறுதல்' },
  'customers': { en: 'members segment duplicate merge', ta: 'வாடிக்கையாளர்' },
  'loyalty-desk': { en: 'points rewards member', ta: 'புள்ளிகள்' },
  'service': { en: 'return refund exchange bill', ta: 'திருப்பம் பணத்திருப்பம்' },
  'service-desk': { en: 'complaint case question', ta: 'புகார்' },
  'stored-value': { en: 'gift card voucher credit note', ta: 'பரிசு அட்டை' },
  'cash-office': { en: 'cash drawer till over short shortage excess variance', ta: 'பணம் கல்லா குறைவு' },
  'day-reopen': { en: 'unlock day close reopen', ta: 'நாள் திற' },
  'day-book': { en: 'accounts journal ledger daily', ta: 'கணக்கு நாள் புத்தகம்' },
  'finance-close': { en: 'month end close period profit loss p&l budget assets depreciation', ta: 'மாத இறுதி லாபம்' },
  'reconciliation': { en: 'card upi bank payments match settlement', ta: 'அட்டை யுபிஐ வங்கி' },
  'finance': { en: 'accounts money totals tally', ta: 'கணக்குகள்' },
  'tally-files': { en: 'tally export accounts', ta: 'டேலி' },
  settlement: { en: 'card upi bank statement settlement file provider payout cash deposit slip dispute chargeback reconciliation', ta: 'அட்டை UPI வங்கி அறிக்கை தீர்வு ரொக்கச் செலுத்தல் தகராறு' },
  'posting-map': { en: 'posting map ledger chart of accounts mapping tally ledger names setup', ta: 'கணக்கு வரைபடம் லெட்ஜர் டேலி பெயர்' },
  'gst-returns': { en: 'gst gstr tax return filing', ta: 'ஜிஎஸ்டி வரி' },
  'gst-reconciliation': { en: 'gst e-invoice irn e-way bill', ta: 'ஜிஎஸ்டி மின் விலைப்பட்டியல்' },
  'itc-review': { en: 'gst input tax credit 2b', ta: 'ஜிஎஸ்டி உள்ளீட்டு வரி' },
  'payroll': { en: 'salary wages pf esi pay', ta: 'சம்பளம்' },
  'my-payslip': { en: 'salary pay slip wages', ta: 'சம்பளச் சீட்டு' },
  'ess': { en: 'leave attendance my details', ta: 'விடுப்பு வருகை' },
  'my-tasks': { en: 'jobs to do work', ta: 'என் வேலைகள்' },
  'store-tasks': { en: 'jobs assign work to do', ta: 'வேலைகள்' },
  'rostering': { en: 'shift rota duty roster staff hours', ta: 'பணி நேரம் ஷிப்ட்' },
  'schedule': { en: 'shift duty roster hours', ta: 'ஷிப்ட்' },
  'checklist': { en: 'opening closing check list', ta: 'சரிபார்ப்பு பட்டியல்' },
  'help': { en: 'how to procedure sop guide', ta: 'உதவி வழிமுறை' },
  'reporting': { en: 'sales report figures export', ta: 'விற்பனை அறிக்கை' },
  'company-report': { en: 'all branches profit sales', ta: 'நிறுவன அறிக்கை' },
  'morning-brief': { en: 'summary yesterday owner brief', ta: 'காலைச் சுருக்கம்' },
  'users': { en: 'staff login role permission user', ta: 'பயனர் பங்கு' },
  'audit': { en: 'audit trail history log who did', ta: 'தணிக்கை' },
  'fleet': { en: 'till device printer scanner', ta: 'கல்லா சாதனம்' },
  'scales': { en: 'weighing scale weight', ta: 'எடை தராசு' },
  'till': { en: 'billing pos checkout sell', ta: 'பில்லிங் விற்பனை' },
  'food-safety': { en: 'temperature fridge freezer hygiene', ta: 'வெப்பநிலை குளிர்சாதனம்' },
  'facilities': { en: 'maintenance repair electricity generator ac', ta: 'பராமரிப்பு பழுது' },
  'production-recipes': { en: 'recipe bill of materials ingredients cafe bakery deli batch shelf life yield', ta: 'சமையல் முறை பொருட்கள் கஃபே பேக்கரி' },
  'facilities-setup': { en: 'asset spare parts amc chiller freezer cold room range schedule pest fire food safety check setup', ta: 'சொத்து உதிரி பாகம் குளிர் அறை அட்டவணை சோதனை அமைப்பு' },
  'loss-prevention': { en: 'theft fraud investigation case', ta: 'திருட்டு மோசடி' },
  'dispatch': { en: 'delivery driver van route', ta: 'டெலிவரி' },
  'online-store': { en: 'website app online orders', ta: 'ஆன்லைன்' },
  'store-setup': { en: 'settings configure shop setup', ta: 'அமைப்புகள்' },
  'data-io': { en: 'import export excel csv upload download', ta: 'இறக்குமதி ஏற்றுமதி' },
  'suppliers': { en: 'vendor supplier distributor', ta: 'விநியோகஸ்தர்' },
  // OB-620 (owner, 1 Nov 2026): the two shelf pages were renamed plainly; their old names still find them.
  'floor-heat-map': { en: 'floor heat map sales per square foot margin area space', ta: 'தள வெப்ப வரைபடம் சதுர அடி' },
  'planogram-compliance': { en: 'shelf compliance by bay planogram gaps photo', ta: 'அலமாரி இணக்கம் பகுதி வாரியாக' },
  'space-setup': { en: 'planogram shelf map bay aisle rack floor plan layout fixture', ta: 'அலமாரித் திட்டம் தளத் திட்டம்' },
  'display-contracts': { en: 'end cap gondola display contract supplier funding', ta: 'காட்சி ஒப்பந்தம்' },
  'range-clusters': { en: 'cluster season range assortment festival', ta: 'பருவம் வரிசை' },
  'product-checks': { en: 'hsn gst tax missing allergen ingredient barcode data check', ta: 'விடுபட்ட பார்கோடு ஒவ்வாமை' },
});

/**
 * The ERP's full navigation catalogue (§27 role surfaces). Sections map to the
 * modules already built, so the menu grows with the system rather than ahead of it.
 */
export const ERP_NAVIGATION: readonly NavItem[] = Object.freeze([
  { id: 'dashboard', label: 'Today', labelTa: 'இன்று', path: '/manager/', requires: 'till.dayclose.read', group: 'Today' },
  // Approvals — head office's maker-checker inbox (ADR-0024 · M02-FR-03 · §28): what other people asked for that this
  // person may decide (never their own), and where their own requests stand. Every signed-in person may open it, so it
  // is gated on the SAME word its three routes check (`identity.self.read`); head office then decides what waits for
  // whom by each kind's own permission. Not a revival of the retired `approvals` item (that was a tab of the manager's
  // screen): this is the page every person's second-person approvals now go through. The store computer serves it at
  // `/approvals` with only who is looking; the inbox itself is read live from head office.
  { id: 'approval-requests', label: 'Approvals', labelTa: 'அனுமதிகள்', path: '/approvals', requires: 'identity.self.read', group: 'Today' },
  // Every item below names the permission the SCREEN ITSELF checks (its browser-entry gate) or, for a screen fed
  // only by the store pack, the permission its own cloud read route checks — never a word nobody enforces (Stage G
  // slice 5b reconciled eighteen such words; docs/STATUS.md). Paths are the store computer's routes; `?tab=` opens a
  // tab of a screen, which the shared chrome does on arrival.

  { id: 'products', label: 'Products', labelTa: 'பொருட்கள்', path: '/products', requires: 'catalogue.pack.read', group: 'Products' },
  { id: 'pricing', label: 'Pricing', labelTa: 'விலை நிர்ணயம்', path: '/pricing', requires: 'price.change.propose', group: 'Products' },
  { id: 'promotions', label: 'Promotions', labelTa: 'சலுகைகள்', path: '/promotions', requires: 'promotion.launch', group: 'Products' },
  // Category rules — gated on the SAME permission the resolve route checks (`catalogue.pack.read`), so the
  // menu never offers a screen the server would refuse (M03-FR-01·CAT-POLICY).
  { id: 'category-policy', label: 'Category rules', labelTa: 'வகை விதிகள்', path: '/category-policy', requires: 'catalogue.pack.read', group: 'Products' },
  // Products waiting to publish — the operator delivers a queued product publish, as themselves (ADR-0013).
  // Gated on the SAME authority the publish route checks (`catalogue.pack.publish`), so the menu never offers
  // it to someone the server would refuse — it is the publisher's action screen (M03-FR-01/03).
  { id: 'product-publish-review', label: 'Products to publish', labelTa: 'வெளியிட வேண்டிய பொருட்கள்', path: '/product-publish-review', requires: 'catalogue.pack.publish', group: 'Products' },
  // Round 4a (M03-FR-01..04 · M05-FR-01 · WF-01 · re-audit G-1): the product master's own pages — one product's record,
  // barcodes, pack, bundle and substitutes; the category list and the report by category; duplicates and their two-person
  // merge; the GST and cess rates with Finance's approval of a change; and the dated, scoped price list with the zones and
  // channel switches. Each gated on the read its routes check; every write is head office's to accept. Head-office pages
  // served by the store computer (OB-380).
  { id: 'product-details', label: 'Product details', labelTa: 'பொருள் விவரங்கள்', path: '/product-details', requires: 'catalogue.pack.read', group: 'Products' },
  { id: 'product-categories', label: 'Categories', labelTa: 'வகைகள்', path: '/product-categories', requires: 'catalogue.pack.read', group: 'Products' },
  { id: 'product-merges', label: 'Duplicates and merges', labelTa: 'நகல்களும் இணைப்புகளும்', path: '/product-merges', requires: 'catalogue.pack.read', group: 'Products' },
  { id: 'tax-rates', label: 'GST and cess rates', labelTa: 'GST மற்றும் செஸ் விகிதங்கள்', path: '/tax-rates', requires: 'catalogue.pack.read', group: 'Products' },
  { id: 'price-lists', label: 'Price lists', labelTa: 'விலைப் பட்டியல்கள்', path: '/price-lists', requires: 'price.change.propose', group: 'Products' },
  // Round 4a (M05-FR-03/04): every offer, what it did against a baseline, and its Stop. Gated on the read its routes check.
  { id: 'offer-results', label: 'Offer results', labelTa: 'சலுகை முடிவுகள்', path: '/offer-results', requires: 'promotion.read', group: 'Products' },
  // Data quality — the A08 steward inbox (missing barcodes, duplicate records, missing prices). Gated on the
  // SAME permission the worklist route checks (`ai.proposal.read`), so the menu never offers a screen the
  // server would refuse (A08 · API-13).
  // Round 7 · OB-505 (roadmap addendum B3): shelf tags printed from the office — the till's price from the signed pack, the
  // MRP, the price per kg / litre / piece and Rule 9 character heights, English and Tamil. Gated on the pack read the page
  // makes (`catalogue.pack.read`). A head-office page, served by the store computer (OB-380).
  { id: 'shelf-tags', label: 'Shelf tags', labelTa: 'அலமாரி விலைச் சீட்டுகள்', path: '/shelf-tags', requires: 'catalogue.pack.read', group: 'Products' },
  { id: 'data-quality', label: 'Data quality', labelTa: 'தரவுத் தரம்', path: '/data-quality', requires: 'ai.proposal.read', group: 'Products' },
  // Wave 2 · OB-625 (owner, 1 Nov 2026): three read-only product checks — no tax mapping, allergen or ingredient details
  // missing where the category needs them, no barcode — with counts and the register of products. Gated on the report read
  // the route checks (`reporting.report.read`). A head-office page, served by the store computer (OB-380).
  { id: 'product-checks', label: 'Product checks', labelTa: 'பொருள் சரிபார்ப்புகள்', path: '/product-checks', requires: 'reporting.report.read', group: 'Products' },

  // Buying — the buyer's one screen: supplier invoices, matching against the order, raising an order (M06).
  // Gated on the purchase-commitment read the order list checks (`purchase.commitment.read`); the propose action
  // needs `purchase.order.propose`, which the route enforces.
  { id: 'buying', label: 'Buying', labelTa: 'வாங்குதல்', path: '/buying/', requires: 'purchase.commitment.read', group: 'Purchase' },
  { id: 'suppliers', label: 'Suppliers', labelTa: 'விநியோகஸ்தர்கள்', path: '/suppliers', requires: 'supplier.view', group: 'Purchase' },
  // R4 Lane 4 · D-10: a supplier's scorecard built from its orders, receipts and matched invoices (nothing typed). Gated on
  // the read the scorecard route checks (`purchase.commitment.read`). A head-office page (served by the store computer since OB-380).
  // P3 (OB-288) M06-FR-02 / WF-03: requisitions, the suppliers' quotes and the like-for-like comparison; an order is only
  // PROPOSED here. Gated on the read the requisition routes check (`purchase.commitment.read`). A head-office page.
  { id: 'requisitions', label: 'Requisitions and quotes', labelTa: 'கோரிக்கைகளும் விலைப்புள்ளிகளும்', path: '/requisitions', requires: 'purchase.commitment.read', group: 'Purchase' },
  { id: 'supplier-scorecard', label: 'Supplier scorecard', labelTa: 'விநியோகஸ்தர் மதிப்பெண் அட்டை', path: '/supplier-scorecard', requires: 'purchase.commitment.read', group: 'Purchase' },
  // QG-02 lane 1 R4 (M06-FR-02): standing (blanket) purchase agreements with their drawdown — proposed by a buyer, approved
  // by a second person. Gated on the read the agreement routes check (`purchase.commitment.read`); served by the box (OB-380).
  { id: 'blanket-orders', label: 'Standing orders', labelTa: 'நிலையான ஆணைகள்', path: '/blanket-orders', requires: 'purchase.commitment.read', group: 'Purchase' },
  // QG-02 · M06-FR-03 · D03-FR-03 · OB-404: supplier rebates — what each scheme earned, received and is still owed, and the claims
  // sent for it (raise → Finance approves → sent → matched; overdue after the owner's answer days). Gated on the register's
  // read (`purchase.commitment.read`); raising and sending need `purchase.contract.manage`, money `finance.journal.post`.
  { id: 'rebates', label: 'Supplier rebates', labelTa: 'விநியோகஸ்தர் தள்ளுபடிகள்', path: '/rebates', requires: 'purchase.commitment.read', group: 'Purchase' },
  // Round 12 (D03-FR-02 · WF-05): supplier bills handed in as a GST e-invoice or a scan, confirmed by a person, then checked
  // against the order — a head-office page over `/v1/purchase/invoice-documents/*` (served by the store computer since OB-380). Gated on the
  // permission those routes check (`purchase.invoice.capture`).
  { id: 'supplier-bills', label: 'Supplier bills', labelTa: 'சப்ளையர் பில்கள்', path: '/supplier-bills', requires: 'purchase.invoice.match', group: 'Purchase' },
  // ── OB-288 commercial desks (M22 · M24 · M27) — begin
  // M24-FR-01/02: the buyer's ONE queue of supplier submissions (invoices, delivery notes, price proposals, RFQ replies,
  // claims) decided with a reason, and each order's delivery status — a head-office page. Gated on the permission its routes
  // check (`supplier.portal.review`).
  { id: 'supplier-submissions', label: 'Supplier submissions', labelTa: 'சப்ளையர் சமர்ப்பிப்புகள்', path: '/supplier-submissions', requires: 'supplier.portal.review', group: 'Purchase' },
  // ── OB-288 commercial desks — end
  { id: 'goods-receipt', label: 'Goods receipt review', labelTa: 'சரக்கு வரவு ஆய்வு', path: '/goods-receipt', requires: 'inventory.availability.read', alsoOpenedWith: ['inventory.goodsreceipt.read'] /* R10-A · OB-543 */, group: 'Receiving' },
  // QG-02 lane 1 R4 (M07-FR-01 · WF-04): head office's dock diary — a store's day door by door, late bookings shown. Gated on
  // the read the diary route checks (`inventory.availability.read`); booking needs `inventory.movement.append` (the route's).
  { id: 'dock-diary', label: 'Dock diary', labelTa: 'டாக் நாட்குறிப்பு', path: '/dock-diary', requires: 'inventory.availability.read', group: 'Receiving' },

  { id: 'indents', label: 'Floor indents', labelTa: 'தளக் கோரிக்கைகள்', path: '/indents', requires: 'inventory.indent.read', group: 'Inventory' },
  { id: 'counts', label: 'Stock counts', labelTa: 'சரக்கு எண்ணிக்கை', path: '/counts', requires: 'count.view', group: 'Inventory' },
  // Round 12 (WF-08 · D05-FR-05 · M09-FR-04): plan, freeze, count, recount, cause, approve or cancel a stock count — a thin
  // client over head office's count-plan routes, gated on the planning permission the plan routes check. Head-office page.
  // R4 Lane 4 · D-13 (OB-219): each bay's shelf against the planogram in force, from the staff counts, every gap named; a
  // photo with a shelf check, kept on the shop's own server; image recognition switched off. Gated on the read the bay route
  // checks (`planogram.compliance.read`). A head-office page (served by the store computer since OB-380).
  // OB-288 P2 (M04-FR-04 · OB-308): the shop floor seen from above, each shelf area coloured by sales or margin per sq ft.
  { id: 'floor-heat-map', label: 'Which areas earn most', labelTa: 'எந்தப் பகுதிகள் அதிகம் ஈட்டுகின்றன', path: '/floor-heat-map', requires: 'merchandising.space.read', group: 'Floor' },
  { id: 'planogram-compliance', label: 'Shelves against the plan', labelTa: 'திட்டத்துடன் அலமாரிகள்', path: '/planogram-compliance', requires: 'planogram.compliance.read', group: 'Floor' },
  // Wave 2 · Round 4a part 2 (M04-FR-02/03/04 · SCREEN-GAP Round D): the setup the three shelf pages read — the shelf places,
  // the planograms and the floor plan, each published as a new version. Gated on the shelf-plan read the routes check
  // (`planogram.compliance.read`); publishing needs `planogram.publish`. A head-office page, served by the store computer.
  { id: 'space-setup', label: 'Set up shelves and floor plan', labelTa: 'அலமாரிகளையும் தளத் திட்டத்தையும் அமை', path: '/space-setup', requires: 'planogram.compliance.read', group: 'Floor' },
  // Wave 2 (M04-FR-04 · D02-FR-06): supplier-paid display space — each contract, its finding, Finance's approval of the funding
  // terms (maker-checker) and the money received. Gated on the register read (`merchandising.space.read`).
  { id: 'display-contracts', label: 'Supplier display space', labelTa: 'சப்ளையர் காட்சி இடம்', path: '/display-contracts', requires: 'merchandising.space.read', group: 'Floor' },
  // Wave 2 (D02-FR-02 · OB-318): the range for a group of stores (a price zone) and season plans. Gated on the range read.
  { id: 'range-clusters', label: 'Store groups and seasons', labelTa: 'கடைக் குழுக்களும் பருவங்களும்', path: '/range-clusters', requires: 'merchandising.range.read', group: 'Floor' },
  { id: 'count-plans', label: 'Count plans', labelTa: 'எண்ணிக்கைத் திட்டங்கள்', path: '/count-plans', requires: 'inventory.count.plan', group: 'Inventory' },
  // Round 12 (WF-07 · M09-FR-03): send and count in transfers, settle a shortfall — gated on the read the register checks.
  { id: 'transfers', label: 'Transfers', labelTa: 'இடமாற்றங்கள்', path: '/transfers', requires: 'inventory.availability.read', group: 'Inventory' },
  { id: 'waste', label: 'Waste & write-off', labelTa: 'வீணானவை மற்றும் தள்ளுபடி', path: '/waste', requires: 'waste.view', group: 'Waste' },
  // Round 6 · M28-FR-02: scrap and recycling — every disposal with its weight, money and evidence, flagged (never refused) when
  // the evidence or the books are missing. Gated on the review the scrap routes check (`scrap.review.read`); recording needs
  // `scrap.sale.record`. A head-office page, served by the store computer (OB-380).
  { id: 'scrap', label: 'Scrap and recycling', labelTa: 'கழிவுப் பொருள் மற்றும் மறுசுழற்சி', path: '/scrap', requires: 'scrap.review.read', group: 'Waste' },
  // Round 6 · M28-FR-03: packaging and crates — the item master, movements and each item's position (still out, never came
  // back, negative shown negative). Gated on the position read (`inventory.availability.read`); writes need
  // `inventory.movement.append`. A head-office page, served by the store computer (OB-380).
  { id: 'packaging', label: 'Packaging and crates', labelTa: 'பொதிப் பொருட்களும் கூடைகளும்', path: '/packaging', requires: 'inventory.availability.read', group: 'Inventory' },
  // Record a write-off from the shop floor — the WRITE sibling of the read-only /waste review. Gated on the
  // SAME authority the governed write-off route checks (`inventory.movement.append`), so the menu never offers
  // it to someone the server would refuse; §28/evidence/threshold all stay server-side (M28-FR-01).
  { id: 'write-off-capture', label: 'Record a write-off', labelTa: 'தள்ளுபடியைப் பதிவு செய்', path: '/write-off-capture', requires: 'inventory.movement.append', group: 'Waste' },
  { id: 'stock-health', label: 'Stock health', labelTa: 'சரக்கு நிலை', path: '/stock-health', requires: 'inventory.availability.read', group: 'Inventory' },
  // Products nobody can sell (SP-8c-ii · P-08): what the till refuses or was never given, and why — the list the box builds the
  // till's catalogue from, shown to the person who can fix it. Read-only, so gated on the same availability read as stock health.
  // WF-11 · M13-FR-02: returned goods held off the shelf, each waiting for a person's decision (restock / write off /
  // back to the supplier / repair). Gated on the authority the decision route checks (`quality.hold.manage`).
  { id: 'held-returns', label: 'Returned goods to decide', labelTa: 'முடிவு தேவைப்படும் திரும்பிய பொருட்கள்', path: '/held-returns', requires: 'quality.hold.manage', group: 'Waste' },
  { id: 'unsellable', label: 'Products nobody can sell', labelTa: 'யாரும் விற்க முடியாத பொருட்கள்', path: '/unsellable', requires: 'inventory.availability.read', group: 'Waste' },
  // Shelves and space — counts on the shelf, refills, the range, the planogram (M04). Gated on the range read
  // (`merchandising.range.read`) the assortment route checks.
  { id: 'merchandising', label: 'Shelves & space', labelTa: 'அடுக்குகளும் இடமும்', path: '/merchandising/', requires: 'merchandising.range.read', group: 'Floor' },
  // Expiry and recalls (M10) — gated on the recall read (`quality.recall.read`); starting or closing a recall needs
  // `quality.recall.initiate`, which the route enforces.
  { id: 'expiry', label: 'Expiry & recalls', labelTa: 'காலாவதி மற்றும் திரும்பப்பெறல்', path: '/expiry/', requires: 'quality.recall.read', group: 'Waste' },
  // Lane 2 · P1 (P-07 · M10-FR-03/04 · OB-297/328/329): start or open a recall, trace forward and backward, the recall's call
  // list and the owner's SMS switch. A head-office page — it reads live traces from head office's API, so the store
  // computer does not serve it. Gated on the trace read (`quality.lottrace.read`); each action's route checks its own word.
  { id: 'recall-trace', label: 'Recalls & trace', labelTa: 'திரும்பப்பெறலும் தடமறிதலும்', path: '/recall-trace', requires: 'quality.lottrace.read', group: 'Waste' },
  // Production runs and QC release (M11) — gated on `production.read`; release needs `production.release`.
  { id: 'production', label: 'Production', labelTa: 'உற்பத்தி', path: '/production/', requires: 'production.read', group: 'Production' },
  // Round 4d (M11-FR-01 · Screen D): the recipes the Production page records runs against — what each item is made from,
  // what one batch makes, how long it keeps. A head-office page served by the store computer. Gated on the read the
  // route checks (`production.read`); saving checks `production.recipe.manage` on the server.
  { id: 'production-recipes', label: 'Recipes', labelTa: 'சமையல் முறைகள்', path: '/production-recipes', requires: 'production.read', group: 'Production' },
  // Warehouse oversight — occupancy, stock, §28 approvals, transfers, tasks (M09). Gated on the availability read
  // the bin and transfer routes check (`inventory.availability.read`).
  { id: 'warehouse-supervisor', label: 'Warehouse', labelTa: 'கிடங்கு', path: '/warehouse-supervisor/', requires: 'inventory.availability.read', group: 'Inventory' },

  { id: 'finance', label: 'Finance', labelTa: 'நிதி', path: '/finance', requires: 'finance.period.read', group: 'Finance' },
  // Day book — the M23 posting screen: one trading day's sales, returns, takings and refunds posted as balanced
  // journals through the posting map; open exceptions are money the accounts have not taken. Gated on the SAME
  // permission the day-book read route checks (`finance.period.read`), so the menu never offers a screen the server
  // would refuse (M23-FR-01).
  { id: 'day-book', label: 'Day book', labelTa: 'நாள் புத்தகம்', path: '/day-book', requires: 'finance.period.read', group: 'Finance' },
  // Round 12 (M23 · WF-18 · D10-FR-03/05 · OB-55/56/57/69): the month-end page — payments with no answer, the P&L, the
  // stock adjustment, the budget and the fixed assets — a thin client over head office's own finance routes. A head-office
  // page, served by the store computer since OB-380. Gated on the same read the routes check (`finance.period.read`).
  { id: 'finance-close', label: 'Month-end', labelTa: 'மாத இறுதி', path: '/finance-close', requires: 'finance.period.read', group: 'Finance' },
  // OB-288 P5 (OB-293 · M23-FR-01/04 · M32-FR-04): the accountant's daily Tally import files, the dead letter and the trial
  // balance — a head-office page (served by the store computer since OB-380). Gated on the read the routes check (`finance.period.read`);
  // making and requeueing check `finance.posting.configure` on the server.
  { id: 'tally-files', label: 'Tally files', labelTa: 'டேலி கோப்புகள்', path: '/tally-files', requires: 'finance.period.read', group: 'Finance' },
  // Round 4d (M23-FR-01 · AVR-09 · Screen D): the accounts set-up — which account each kind of posting goes to (the posting
  // map) and what each account is called in Tally. Without it the Day book, Tally files, Month-end and Supplier offer
  // funding post nothing. A head-office page served by the store computer. Gated on the read both routes check
  // (`finance.period.read`); saving checks `finance.posting.configure` on the server.
  // W3 (M23-FR-03 · M14-FR-03 · C14): the provider's settlement file and the bank's statement loaded, cash taken to the bank
  // recorded, the tills' card and UPI takings checked against what was paid, the cases and the payment disputes. A
  // head-office page served by the store computer. Gated on the read the review checks (`settlement.review.read`); loading,
  // cases and disputes each check their own word on the server.
  { id: 'settlement', label: 'Card, UPI and bank', labelTa: 'அட்டை, UPI மற்றும் வங்கி', path: '/settlement', requires: 'settlement.review.read', group: 'Finance' },
  { id: 'posting-map', label: 'Accounts and Tally names', labelTa: 'கணக்குகளும் டேலி பெயர்களும்', path: '/posting-map', requires: 'finance.period.read', group: 'Finance' },
  // QG-02 lane 1 R4 (M05-FR-04): supplier funding of offers, earned from the bills and reconciled to the books. Gated on the
  // register's read (`finance.period.read`); recording an agreement needs `promotion.launch`, a receipt `finance.journal.post`.
  { id: 'promotion-funding', label: 'Supplier offer funding', labelTa: 'விநியோகஸ்தர் சலுகை நிதி', path: '/promotion-funding', requires: 'finance.period.read', group: 'Finance' },
  // ── OB-288 commercial desks (M22 · M24 · M27) — begin
  // M27-FR-01..04 · OB-304 (switched off until the owner turns it on): concession counters — contract, deposit, charge,
  // settlement and the dates that stop a counter trading. Gated on the read its routes check (`concession.charge.read`).
  { id: 'concessions', label: 'Concessions', labelTa: 'சலுகைக் கவுண்டர்கள்', path: '/concessions', requires: 'concession.charge.read', group: 'Finance' },
  // ── OB-288 commercial desks — end
  // OB-401 (owner, 27 Oct 2026): "Reconciliation" opens the month-end checks page that already exists — its first section is
  // the card and UPI payments with no answer, raised by the store or carried by a day close. Gated as that page is.
  { id: 'reconciliation', label: 'Reconciliation', labelTa: 'சரிக்கட்டல்', path: '/finance-close?tab=payments', requires: 'finance.period.read', group: 'Finance' },
  // GST e-invoice / e-way-bill reconciliation — gated on the SAME permission the queue route checks
  // (`finance.einvoice.read`), so the menu can never offer a screen the server would refuse (item 3 inc2).
  { id: 'gst-reconciliation', label: 'GST reconciliation', labelTa: 'GST சரிக்கட்டல்', path: '/gst-reconciliation', requires: 'finance.einvoice.read', group: 'Finance' },
  // GST returns — the GSTR-1 filing-status queue, gated on the SAME permission the queue route checks
  // (`finance.gstr.read`), so the menu can never offer a screen the server would refuse (item 3, 4th domain).
  { id: 'gst-returns', label: 'GST returns', labelTa: 'GST ரிட்டர்ன்கள்', path: '/gst-returns', requires: 'finance.gstr.read', group: 'Finance' },

  // Payroll — its OWN group, gated on the payroll permission the server enforces (`payroll.statutory.read`),
  // so cashier/warehouse/floor/ordinary-manager roles never see it and the menu can never offer a screen the
  // server would refuse (owner directive; §27 least-privilege surfaces).
  { id: 'payroll', label: 'Payroll', labelTa: 'ஊதியப் பட்டியல்', path: '/payroll', requires: 'payroll.statutory.read', group: 'People' },
  // Employee self-service — own payslip only. Gated on `payroll.ess.self`, which ordinary staff MAY hold for
  // themselves (it is own-record only; the engine refuses any other employee), so it is a separate item.
  { id: 'my-payslip', label: 'My payslip', labelTa: 'என் சம்பளச் சீட்டு', path: '/my-payslip', requires: 'payroll.ess.self', group: 'Mine' },
  // Employee self-service — my rota + my payslip on one screen. Same own-record grant `payroll.ess.self`.
  { id: 'ess', label: 'My self-service', labelTa: 'என் சுய சேவை', path: '/ess', requires: 'payroll.ess.self', group: 'Mine' },

  // Rota — the manager's rostering screen (M25-FR-01). Gated on the roster read (`workforce.roster.read`);
  // assigning a shift needs `workforce.roster.manage`, which the route enforces.
  { id: 'rostering', label: 'Rota', labelTa: 'பணி முறை', path: '/rostering/', requires: 'workforce.roster.read', group: 'People' },
  // Round 4c (M25-FR-01): the Staff list and shifts — add a person or change one, mark a leaver (kept, never deleted), and
  // create the shifts the Rota is built on. Gated on the roster read; the writes need `workforce.roster.manage` (the route
  // enforces it). Rota, Staff certificates, Appointment letters and the Staff schedule read this list. A head-office page.
  { id: 'staff', label: 'Staff list and shifts', labelTa: 'பணியாளர் பட்டியலும் ஷிப்டுகளும்', path: '/staff', requires: 'workforce.roster.read', group: 'People' },
  // Checklists — the day's opening, closing and hygiene checks (M25-FR-02). Gated on `workforce.checklist.read`.
  // Round 8 · OB-522 (M25-FR-03 · OB-502): staff certificates — record, verify and renew each person's certificates (food
  // handling; FoSTaC counts as the same). Gated on the certificate read (`workforce.roster.read`); recording and verifying need
  // `workforce.roster.manage`, which head office's route enforces. A head-office page, served by the store computer (OB-380).
  { id: 'certificates', label: 'Staff certificates', labelTa: 'பணியாளர் சான்றிதழ்கள்', path: '/certificates', requires: 'workforce.roster.read', group: 'People' },
  { id: 'checklist', label: 'Checklists', labelTa: 'சரிபார்ப்புப் பட்டியல்கள்', path: '/checklist/', requires: 'workforce.checklist.read', group: 'People' },
  // Round 4c (M02-FR-01/02/04 · §28 · OB-615): Users & roles — who holds which role, give one and take one back (two people:
  // one asks, the owner approves), limit a role to departments, suppliers, categories or locations, the four roles waiting
  // for the owner, and the platform administrator's sign-ins (`platform.person.read`, OB-15-c). A head-office page served by
  // the store computer (OB-380). Each section shows only for its own word; head office re-checks every one.
  { id: 'users', label: 'Users & roles', labelTa: 'பயனர்களும் பங்குகளும்', path: '/users', requires: 'identity.role.read', alsoOpenedWith: ['identity.role.request', 'platform.person.read'], group: 'Administration' },
  // Round 10 (M01-FR-01 · M02-FR-03): the organisation hierarchy and approval delegation — thin clients over head office's
  // own routes. Head-office pages, served by the store computer since OB-380 (identity only; every figure is a live read).
  { id: 'organisation', label: 'Organisation', labelTa: 'அமைப்பு', path: '/organisation', requires: 'org.branch.read', group: 'Administration' },
  // Round 4c (M01-FR-04): open, close for now, reopen or close a branch for good — head office measures the branch and
  // names every blocker; every change but a reopen needs the owner's approval. Gated on the readiness read
  // (`branch.transition.evaluate`); the change needs `branch.transition.execute`. A head-office page (OB-380).
  { id: 'branches', label: 'Open and close branches', labelTa: 'கிளைகளைத் திறத்தலும் மூடுதலும்', path: '/branches', requires: 'branch.transition.evaluate', group: 'Administration' },
  { id: 'delegation', label: 'Delegation', labelTa: 'அதிகாரப் பகிர்வு', path: '/delegation', requires: 'approvals.delegation.read', group: 'Administration' },
  // Round 12 (M35-FR-02/04 · WF-20): incidents with a named owner per follow-up, the post-mortem and the close, and the
  // recovery-drill register — a head-office page over its own routes (served by the store computer since OB-380).
  { id: 'incidents', label: 'Incidents & recovery drills', labelTa: 'சம்பவங்களும் மீட்பு ஒத்திகைகளும்', path: '/incidents', requires: 'platform.health.read', group: 'Systems' },
  // Round 4c (M35-FR-04): the CERT-In six-hour clock (classify an incident, record the report — the owner's) and the
  // capacity report and plan. Gated on the health read; each write's route checks its own word. A head-office page.
  { id: 'cert-in', label: 'CERT-In reports and capacity', labelTa: 'CERT-In அறிக்கைகளும் திறனும்', path: '/cert-in', requires: 'platform.health.read', group: 'Systems' },
  // Round 26 (OB-99 · OB-97 · OB-98): which store computer each till's bill numbers belong to, what needs a person, and the
  // owner-approved "store computer replaced" act — a head-office page over its own routes (served by the store computer since OB-380).
  { id: 'store-computers', label: 'Store computers', labelTa: 'கடை கணினிகள்', path: '/store-computers', requires: 'platform.health.read', group: 'Systems' },
  // ── OB-288 P4 — begin
  // R8-9 · OB-316 · M36-FR-01 · OB-321 · C8 · C9 · OB-324: trial switches per branch and per till lane, the usage meter
  // (information only), the CA's customer-data watch and the consent record — a head-office page over its own routes.
  { id: 'rollout', label: 'Trial switches and shop account', labelTa: 'சோதனை சுவிட்சுகள் மற்றும் கடை கணக்கு', path: '/rollout', requires: 'platform.flag.read', group: 'Administration' },
  // QG-02 lane 1 R4 (M01-FR-03): feature-flag governance over `/v1/platform/flags*` — reason and version every time, the owner
  // approves a high-impact switch, rollback in one step. Gated on the board's read (`platform.flag.read`).
  { id: 'switches', label: 'Feature switches', labelTa: 'அம்சச் சுவிட்சுகள்', path: '/switches', requires: 'platform.flag.read', group: 'Administration' },
  // ── OB-288 P4 — end
  // OB-154 "A" (B6 · B7 · L2): the weighing-scale register — every scale's Legal Metrology stamp, certificate and tills, and
  // adding or updating one (a later stamp date with a second person's approval) — a head-office page over its own routes.
  { id: 'scales', label: 'Weighing scales', labelTa: 'எடைத் தராசுகள்', path: '/scales', requires: 'facilities.asset.read', group: 'Systems' },
  // Outside access — the admin screen on its "Outside access" tab: support sessions granted and expiring (M02 /
  // M36). Gated on the support-session read (`platform.support.read`).
  { id: 'support-access', label: 'Outside access', labelTa: 'வெளி அணுகல்', path: '/admin/?tab=support', requires: 'platform.support.read', group: 'Administration' },
  // Tills and devices — the fleet screen (M33): health, registration, status. Gated on `platform.health.read`;
  // registering or changing a device needs `platform.device.manage`, which the routes enforce.
  { id: 'fleet', label: 'Tills & devices', labelTa: 'கல்லாக்களும் சாதனங்களும்', path: '/fleet/', requires: 'platform.health.read', group: 'Systems' },
  // Connections — integration health (M32): each connector's state, dead letters, last contact. Gated on the SAME
  // permission its route checks (`platform.health.read`).
  { id: 'integration-health', label: 'Connections', labelTa: 'இணைப்புகள்', path: '/integration-health/', requires: 'platform.health.read', group: 'Systems' },
  // Facilities — overdue maintenance and compliance tasks (M26). Gated on `facilities.overdue.read`.
  { id: 'facilities', label: 'Facilities', labelTa: 'வசதிகள்', path: '/facilities/', requires: 'facilities.overdue.read', group: 'Floor' },
  // OB-154 (owner, 16 Oct 2026, "Add screens before pilot"): the store-operations pages — head-office pages over their own
  // routes (served by the store computer since OB-380), each gated on the SAME permission its read route checks.
  // Round 4d (M26-FR-01/02/03 · D-6 · Screen D): the facilities set-up — assets and their services with the spare parts
  // used, the spare-parts register, the monitored rooms' ranges, the maintenance schedules and the food-safety checks the
  // two pages above work from. A head-office page served by the store computer for its own store. Gated on the asset read
  // (`facilities.asset.read`); head office re-checks every read and write by its own permission.
  { id: 'facilities-setup', label: 'Facilities set-up', labelTa: 'வசதிகள் அமைப்பு', path: '/facilities-setup', requires: 'facilities.asset.read', group: 'Floor' },
  { id: 'food-safety', label: 'Food-safety checks', labelTa: 'உணவுப் பாதுகாப்புச் சோதனைகள்', path: '/food-safety', requires: 'facilities.overdue.read', group: 'Floor' },
  { id: 'price-integrity', label: 'Price mismatches', labelTa: 'விலை முரண்பாடுகள்', path: '/price-integrity', requires: 'price.integrity.audit', group: 'Products' },
  { id: 'store-tasks', label: 'Store tasks', labelTa: 'கடைப் பணிகள்', path: '/store-tasks', requires: 'workforce.task.read', group: 'People' },
  { id: 'my-tasks', label: 'My tasks', labelTa: 'என் பணிகள்', path: '/my-tasks', requires: 'workforce.task.complete.own', group: 'Mine' },
  { id: 'waste-analytics', label: 'Waste analytics', labelTa: 'வீண் பகுப்பாய்வு', path: '/waste-analytics', requires: 'waste.view', group: 'Reports' },
  // R3 D-9 (OB-142 "A"): the Staff schedule — staff needed per hour from the sales, a draft roster within the Shops Act
  // limits that a manager commits, and actual attendance against it. A head-office page over its own routes.
  { id: 'schedule', label: 'Staff schedule', labelTa: 'பணியாளர் அட்டவணை', path: '/schedule', requires: 'workforce.roster.read', group: 'People' },
  // ── R4 Lane 3 (customer insight, offers and demand): head-office pages over their own routes ──
  { id: 'customers', label: 'Customers', labelTa: 'வாடிக்கையாளர்கள்', path: '/customers', requires: 'customer.segment.read', group: 'Customers' },
  // OB-288 wave 3 (OB-329 · OB-295 · M16-FR-01 · M17-FR-01): enrol a customer at the desk (the name optional), find a member,
  // tie the app, and the owner's tiers and points expiry — a head-office page over its own routes (since OB-380 the store
  // computer serves it). Gated on the member read (`loyalty.points.read`); each write's route checks its own word.
  { id: 'loyalty-desk', label: 'Loyalty', labelTa: 'லாயல்டி', path: '/loyalty', requires: 'loyalty.points.read', group: 'Customers' },
  // Round 4c (M31-FR-04): the do-not-contact list — a customer who says "never contact me" is recorded at the desk (channel,
  // who asked, why) and lifted the same way, append-only. Gated on the list read (`notification.send.check`); the writes need
  // `notification.suppression.manage`. A head-office page (OB-380).
  { id: 'do-not-contact', label: 'Do not contact', labelTa: 'தொடர்பு கொள்ள வேண்டாம்', path: '/do-not-contact', requires: 'notification.send.check', group: 'Customers' },
  // OB-288 wave 3 (M21-FR-01 · M21-FR-02): plan, approve, send and follow a campaign, and switch the journeys on or off — a
  // head-office page (served by the store computer since OB-380). Gated on the campaign read (`customer.campaign.read`); each
  // write's route checks its own word (template manage, campaign send).
  { id: 'campaigns', label: 'Campaigns', labelTa: 'பிரச்சாரங்கள்', path: '/campaigns', requires: 'customer.campaign.read', group: 'Customers' },
  { id: 'basket-affinity', label: 'Bought together', labelTa: 'சேர்ந்து வாங்கப்பட்டவை', path: '/basket-affinity', requires: 'reporting.report.read', group: 'Reports' },
  { id: 'demand-events', label: 'Store events', labelTa: 'கடை நிகழ்வுகள்', path: '/demand-events', requires: 'inventory.availability.read', group: 'Inventory' },
  // OB-391 (owner, 26 Oct 2026): the company-wide report — head office's own branches and company (GET /v1/org/nodes), its
  // roll-up and its logged export — served by the store computer like the other office pages. Gated on the report read.
  { id: 'company-report', label: 'Company report', labelTa: 'நிறுவன அறிக்கை', path: '/company-report', requires: 'reporting.report.read', group: 'Reports' },
  { id: 'morning-brief', label: 'Morning brief', labelTa: 'காலைச் சுருக்கம்', path: '/morning-brief', requires: 'owner.kpi.read', group: 'Reports' },
  // Round 6 · M29-FR-02 · §27 Owner "branch comparison": rank branches, departments, suppliers or staff on head office's own
  // governed figures and drill to the exact transactions; scope is the server's. Gated on what the drill and compare routes
  // check (`owner.kpi.read`). A head-office page, served by the store computer (OB-380).
  { id: 'branch-compare', label: 'Compare side by side', labelTa: 'அருகருகே ஒப்பிடு', path: '/branch-compare', requires: 'owner.kpi.read', group: 'Reports' },
  // ── OB-288 lane 4 · P2 — begin
  // M29-FR-03/04: the owner's five exception-alert thresholds (each "not set" until entered), today's exceptions, and his
  // scheduled reports and exports. Gated on the SAME permission the thresholds read checks (`owner.alert.read`).
  { id: 'owner-alerts', label: 'Owner alerts and schedules', labelTa: 'உரிமையாளர் எச்சரிக்கைகளும் திட்டங்களும்', path: '/owner-alerts', requires: 'owner.alert.read', group: 'Reports' },
  // ── OB-288 lane 4 · P2 — end
  // OB-609 (owner, 29 Oct 2026) · P-03 · P-08 · M29-FR-03 · M25-FR-01: what head office found on till bills (critical and
  // material findings, `GET /v1/sales/exceptions`) and the attendance marks of a shop day that do not pair up — both kept at
  // head office and, until this page, seen on no screen. Read only. Opened by either word; each section shows only for its own.
  { id: 'findings', label: 'Bill findings and attendance flags', labelTa: 'பில் கண்டறிதல்களும் வருகை எச்சரிக்கைகளும்', path: '/findings', requires: 'pos.exception.read', alsoOpenedWith: ['workforce.roster.read'], group: 'Reports' },
  // ── end R4 Lane 3 ──
  // AI control — the kill switch, agents, the proposal queue, cost (A01–A10 governance). Gated on the budget read
  // (`ai.budget.read`), the owner's permission; the switches need `ai.killswitch.set` / `ai.budget.set` /
  // `ai.agent.enable`, which the routes enforce.
  { id: 'ai', label: 'AI control', labelTa: 'AI கட்டுப்பாடு', path: '/ai/', requires: 'ai.budget.read', group: 'Administration' },
  // Migration — where the cutover stands, the figures, the data, the parallel run, the old system (MG-01–MG-12).
  // Gated on the exceptions read the desk route checks (`migration.cleaning.read`); a decision needs
  // `migration.exception.resolve` / `migration.controltotal.sign`, which the routes enforce.
  { id: 'migration', label: 'Migration', labelTa: 'தரவு மாற்றம்', path: '/migration/', requires: 'migration.cleaning.read', group: 'Administration' },  { id: 'store-setup', label: 'Store setup', labelTa: 'கடை அமைப்பு', path: '/setup', requires: 'platform.setup.read', group: 'Administration' },
  // Document templates — the wording on every bill / invoice / PO / GRN / statement, versioned: drafted by one
  // person, approved by another, published; the previous version kept (M01-FR-02, §28). Gated on the SAME
  // permission the register route checks (`platform.setup.read`), so the menu never offers a screen the server
  // would refuse; the writes need `platform.setup.write` and the screen withholds them without it.
  { id: 'document-templates', label: 'Document templates', labelTa: 'ஆவண வார்ப்புருக்கள்', path: '/document-templates', requires: 'platform.setup.read', group: 'Administration' },
  // OB-401 (owner, 27 Oct 2026) pointed "Settings" at Store setup so no item was a dead end. Round 4c (screen audit
  // 31 Oct 2026, "Settings duplicates Store setup" · M01-FR-03): Settings is now its own page — every setting's history and
  // going back to an earlier value (a new version; a high-impact one only with the owner's approval). Store setup keeps
  // answering the setup questions. Gated as Store setup is (`platform.setup.read`); going back needs `platform.setup.write`.
  { id: 'settings', label: 'Settings', labelTa: 'அமைப்புகள்', path: '/settings', requires: 'platform.setup.read', group: 'Administration' },
  // Round 4c (M34-FR-01/02): the Audit log reads head office's stored domain trail — search, check the chain, rebuild one
  // thing from the evidence. Read only. Gated on the trail read (`audit.retention.read`). A head-office page (OB-380).
  { id: 'audit', label: 'Audit log', labelTa: 'தணிக்கைப் பதிவு', path: '/audit-log', requires: 'audit.retention.read', group: 'Administration' },
  // Operations — the A06 incident inbox (a stuck sync queue, a growing dead-letter pile, an unwell
  // connection, each with its runbook). Gated on the SAME permission the worklist route checks
  // (`ai.proposal.read`), so the menu never offers a screen the server would refuse (A06 · API-13).
  { id: 'operations', label: 'Operations', labelTa: 'செயல்பாடுகள்', path: '/operations', requires: 'ai.proposal.read', group: 'Today' },
  // Loss prevention — the M15 investigations inbox (a till short, a run of voids, a suspicious refund, each an
  // open case with the money at stake). Gated on the SAME permission the worklist route checks (`lp.case.read`),
  // so the menu never offers a screen the server would refuse (M15-FR-04).
  { id: 'loss-prevention', label: 'Investigations', labelTa: 'விசாரணைகள்', path: '/loss-prevention', requires: 'lp.case.read', group: 'Operations' },
  // Delivery exceptions — the M19 substitution-exception inbox (a swap that left a refund due, an adjustment to
  // collect, a charge above the cap, a short-picked line — each owned by a queue with an SLA clock). Gated on the
  // SAME permission the worklist route checks (`order.read`), so the menu never offers a screen the server would
  // refuse (M19-FR-01 · Item 2).
  // Reports — the reporting screen (D13): sales by day, what cannot be run yet, what to record next. Gated on the
  // report read the catalogue and report routes check (`reporting.report.read`); an export is checked on the box
  // against the pack's own roles per family.
  { id: 'reporting', label: 'Reports', labelTa: 'அறிக்கைகள்', path: '/reporting/', requires: 'reporting.report.read', group: 'Reports' },
  // Service desk — returns taken and cases worked (M13 / M21). Gated on the case read (`service.case.read`).
  { id: 'service', label: 'Service desk', labelTa: 'சேவை மேசை', path: '/service/', requires: 'service.case.read', group: 'Customers' },
  // ── OB-288 commercial desks (M22 · M24 · M27) — begin
  // M22-FR-01/02/04: the B2B selling desk — contracts, quotation → order → proforma → challan → tax invoice, credit and money
  // owed — a head-office page behind the shop's `b2b` switch (OB-280: business bills stay on the old system for real
  // trading). Gated on the read its routes check (`b2b.document.read`).
  // Round 7 · OB-506 (M12-FR-02): retail quotations — make, list, follow up and void; the cashier rings one up at the till by
  // its number. Gated on the list read (`pos.quotation.read`); making and voiding need `pos.quotation.write`. A head-office
  // page, served by the store computer (OB-380).
  { id: 'quotations', label: 'Quotations', labelTa: 'விலைப்புள்ளிகள்', path: '/quotations', requires: 'pos.quotation.read', group: 'Customers' },
  { id: 'b2b', label: 'Business customers', labelTa: 'வணிக வாடிக்கையாளர்கள்', path: '/b2b', requires: 'b2b.document.read', group: 'Customers' },
  // ── OB-288 commercial desks — end
  // Store credit and vouchers — liability, velocity, double spends (M17). Gated on the SAME permission its three
  // read routes check (`lp.case.read`): it is loss-prevention oversight of stored value.
  { id: 'stored-value', label: 'Store credit & vouchers', labelTa: 'கடை கடன் மற்றும் வவுச்சர்கள்', path: '/stored-value/', requires: 'lp.case.read', group: 'Customers' },
  // Round 8 — customer cases (WF-17 · M21 · A05): the cases and their SLA clocks, the assistant's drafted reply that a
  // named person approves and a person sends, and the root cause once a case is resolved. Gated on the case read the
  // list route checks (`service.case.read`); every act is re-checked by the cloud (`service.case.manage`).
  { id: 'service-desk', label: 'Customer cases', labelTa: 'வாடிக்கையாளர் வழக்குகள்', path: '/service-desk', requires: 'service.case.read', group: 'Customers' },
  // Round 8 — the assistant's drafts (A09 · A07): campaign words waiting for a second person's approval, and the anomaly
  // summaries for the security officer. Gated on the assistant's proposal read (`ai.proposal.read`); approving a
  // template and asking for a summary are re-checked by the cloud on their own permissions.
  { id: 'ai-drafts', label: 'Assistant drafts', labelTa: 'உதவியாளர் வரைவுகள்', path: '/ai-drafts', requires: 'ai.proposal.read', group: 'Today' },
  { id: 'substitution-exceptions', label: 'Delivery exceptions', labelTa: 'டெலிவரி விதிவிலக்குகள்', path: '/substitution-exceptions', requires: 'order.read', group: 'Orders' },
  // OB-288 fulfilment & delivery (M19-FR-01/03 · WF-14/15): the dispatch office — waves from confirmed orders, the day's
  // routes handed to drivers, every door's captured proof and the cash. Head office's page, served by the store computer since OB-380.
  { id: 'dispatch', label: 'Dispatch', labelTa: 'அனுப்புதல்', path: '/dispatch', requires: 'delivery.run.read', group: 'Orders' },
  // OB-288 wave 3 (M18-FR-04): refund an online order to its own payment token after a second person approves, and the
  // worklist of payments and refunds still waiting on the bank — a head-office page (served by the store computer since OB-380).
  // Gated on the read the worklist checks (`order.read`); issuing checks `order.refund.issue` on the server.
  { id: 'order-refunds', label: 'Order refunds', labelTa: 'ஆர்டர் பணத் திருப்பம்', path: '/order-refunds', requires: 'order.read', group: 'Orders' },
  // Refund exceptions — the M13/M17 governance surface: refunds that reconciled with a rule broken (store credit
  // over the owner's cap, a credit with no customer, a §28 approval breach, more sent back than the bill sold or
  // was paid). Gated on the SAME permission the exceptions route checks (`lp.case.read`), so the menu never offers
  // a screen the server would refuse (P-03 control-by-exception, P-08 no silent failure).
  { id: 'return-governance', label: 'Refund exceptions', labelTa: 'பணத்திருப்ப விதிவிலக்குகள்', path: '/return-governance', requires: 'lp.case.read', group: 'Customers' },
  { id: 'cash-office', label: 'Cash over / short', labelTa: 'பணம் கூடுதல் / குறைவு', path: '/cash-office', requires: 'till.shift.read', group: 'Finance' },
  { id: 'risk-acceptance', label: 'Risk acceptance', labelTa: 'இடர் ஏற்பு', path: '/risk-acceptance', requires: 'compliance.risk.read', group: 'Operations' },
  // OB-288 gates lane (QG-12): every quality gate's GO / HOLD / REWORK for a release, decided by the owner with evidence.
  { id: 'gates', label: 'Quality gates', labelTa: 'தர வாயில்கள்', path: '/gates', requires: 'compliance.gate.read', group: 'Operations' },
  // OB-288 lane 1 · P1 (OB-290/291/292): the owner's money limits, escalation waits and price-check size — two people change them.
  // OB-288 lane 1 · P1 (M02-FR-01/02): who holds which role, where and up to how much — read-only, with the permission matrix as CSV.
  { id: 'access-review', label: 'Access review', labelTa: 'அணுகல் மீளாய்வு', path: '/access-review', requires: 'identity.access.review', group: 'Administration' },
  { id: 'approval-rules', label: 'Approval rules', labelTa: 'ஒப்புதல் விதிகள்', path: '/approval-rules', requires: 'approvals.rules.read', group: 'Administration' },
  // Reopen a locked day — the controlled, audited unlock (M14-FR-04 / §28). Gated on `till.dayclose.read` (the
  // permission the locked-day list checks); the reopen itself needs `till.dayclose.approve`, which the box and
  // cloud enforce, and the screen offers the form only to a holder. Accountant/owner work.
  { id: 'day-reopen', label: 'Reopen a locked day', labelTa: 'மூடிய நாளை மீண்டும் திற', path: '/day-reopen', requires: 'till.dayclose.read', group: 'Finance' },
  // Data import & export — the M30 console (take data out to an open CSV with an audit trail; bring data in
  // under §28 maker-checker). Gated on `export.read`, the permission the export catalogue/log checks; the import
  // routes additionally enforce their own permissions server-side (M30-FR-01/02/03).
  { id: 'data-io', label: 'Import & export', labelTa: 'தரவு இறக்கம் மற்றும் ஏற்றம்', path: '/data-io', requires: 'export.read', group: 'Administration' },
  // Workforce — the A10 guidance inbox (the day's late staff tasks, a critical overdue one escalated to the
  // manager on duty, each with the recommended action). Gated on the SAME permission the worklist route checks
  // (`ai.proposal.read`), so the menu never offers a screen the server would refuse (A10 · API-13).
  { id: 'workforce', label: 'Workforce', labelTa: 'பணியாளர்கள்', path: '/workforce', requires: 'ai.proposal.read', group: 'People' },
  // ── OB-288 LP/workforce package — begin
  // M25-FR-04 · D11-FR-06: the role help centre and emergency procedures — the box serves it (it works with the line down).
  { id: 'help', label: 'Help and procedures', labelTa: 'உதவி மற்றும் நடைமுறைகள்', path: '/help', requires: 'workforce.help.read', group: 'Mine' },
  // QG-09 · M25-FR-01/03 · D11-FR-04 · OB-317 · OB-320: training, competency, curriculum, champions and the adoption gate.
  { id: 'adoption', label: 'Training and adoption', labelTa: 'பயிற்சி மற்றும் ஏற்பு', path: '/adoption', requires: 'workforce.roster.read', group: 'People' },
  // C17 · OB-323: appointment letters made from the staff record, with the signed copy kept.
  { id: 'appointment-letters', label: 'Appointment letters', labelTa: 'நியமனக் கடிதங்கள்', path: '/appointment-letters', requires: 'hr.appointmentletter.issue', group: 'People' },
  // M15-FR-03 · OB-301: the related-party list, staff buying rules, staff and salary accounts.
  { id: 'related-parties', label: 'Related parties and staff buying', labelTa: 'தொடர்புடையவர்களும் பணியாளர் கொள்முதலும்', path: '/related-parties', requires: 'lp.case.read', group: 'Operations' },
  // ── OB-288 LP/workforce package — end
  // The device apps the store computer serves (OB-16, "one application"): the till, the owner's figures and the three
  // handhelds open from the same rail. Each is gated on the permission its own gate checks; the box serves all five.
  { id: 'till', label: 'Till', labelTa: 'கல்லா', path: '/pos/', requires: 'pos.sale.read', group: 'Devices' },
  { id: 'owner-figures', label: 'Owner — the day in figures', labelTa: 'உரிமையாளர் — நாளின் எண்கள்', path: '/owner/', requires: 'owner.kpi.read', group: 'Devices' },
  { id: 'warehouse-handheld', label: 'Warehouse handheld', labelTa: 'கிடங்கு கைக்கருவி', path: '/warehouse/', requires: 'inventory.movement.append', group: 'Devices' },
  { id: 'picker-handheld', label: 'Picker handheld', labelTa: 'பிக்கர் கைக்கருவி', path: '/picker/', requires: 'fulfilment.assignment.read', group: 'Devices' },
  { id: 'driver-handheld', label: 'Delivery handheld', labelTa: 'டெலிவரி கைக்கருவி', path: '/driver/', requires: 'fulfilment.assignment.read', group: 'Devices' },
  // R2 C20 · OB-154 "A": the owner's view of the Internal Committee's annual report — due, overdue or filed, counts only,
  // and recording the filing. Gated on the filing permission the route checks (`posh.report.file`, the owner's). A
  // head-office page (served by the store computer since OB-380). The complaints register itself stays the committee's (OB-157).
  { id: 'posh-report', label: 'Committee annual report', labelTa: 'குழு ஆண்டு அறிக்கை', path: '/posh-report', requires: 'posh.report.file', group: 'People' },
  // Round 4c (C20 · OB-157): the Internal Committee's OWN page — make the year's report from its register and read it back
  // (counts only). Gated on the committee's word (`posh.report.generate`), so only the committee's role sees it; the owner
  // records the filing on his page above. A head-office page (OB-380).
  { id: 'posh-committee', label: 'Committee: make the annual report', labelTa: 'குழு: ஆண்டு அறிக்கை தயாரி', path: '/posh-committee', requires: 'posh.report.generate', group: 'People' },
  // R3 lane 2 · A17 · OB-145 "A": the accountant's GSTR-2B review — upload the month's file, see every line matched with
  // the books and the exceptions, accept / reject / keep pending each line. Gated on the read the review route checks
  // (`finance.itc.read`). A head-office page (served by the store computer since OB-380).
  { id: 'itc-review', label: 'Input tax credit (GSTR-2B)', labelTa: 'உள்ளீட்டு வரி வரவு (GSTR-2B)', path: '/itc-review', requires: 'finance.itc.read', group: 'Finance' },
  // R4 Lane 1 · B20 · B21 · B22 · OB-212: the EPR registers — own-brand plastic per category for the year with the CPCB
  // file (nothing filed), the take-back register and its exceptions, recording a take-back and handing over to a
  // registered recycler. Gated on the read the register routes check (`epr.register.read`). A head-office page.
  { id: 'epr', label: 'EPR registers (plastic, e-waste, batteries)', labelTa: 'EPR பதிவேடுகள் (பிளாஸ்டிக், மின்கழிவு, பேட்டரி)', path: '/epr', requires: 'epr.register.read', group: 'Operations' },
  // R4 Lane 2 · B23 · A26 · WF-16: the online store — the shop's details every listing carries (the grievance officer
  // "not set" until named, OB-223), each product's listing, the complaint clock, the TCS line and online returns. Gated on
  // the read its routes check (`online.store.read`). A head-office page (served by the store computer since OB-380).
  { id: 'online-store', label: 'Online store', labelTa: 'ஆன்லைன் கடை', path: '/online-store', requires: 'online.store.read', group: 'Customers' },
  // R4 Lane 2 · D01-FR-06: the product content editor — app description, synonyms, versions, completeness and the image
  // on the shop's own server (OB-215). Gated on the catalogue read its editor read checks (`catalogue.pack.read`).
  { id: 'product-content', label: 'App content', labelTa: 'செயலி உள்ளடக்கம்', path: '/product-content', requires: 'catalogue.pack.read', group: 'Products' },
]);

/** An item retired from the catalogue, with the reason and where its job lives now — never a silent drop. */
export interface RetiredNavItem {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  /** The id of the catalogue item that covers it today. */
  readonly insteadUse: string;
}

/**
 * Items retired in Stage G slice 5b while the catalogue was reconciled with the screens the store computer serves.
 * Each was either a TAB of a screen that has its own item (the menu opens the screen; its tabs are on the page) or a
 * second door to a screen another item already opens — and every one gated on a permission no server checked.
 */
export const RETIRED_NAV_ITEMS: readonly RetiredNavItem[] = Object.freeze([
  { id: 'approvals', label: 'Approvals', reason: 'A tab of the manager\'s screen (Dashboard), not a screen of its own.', insteadUse: 'dashboard' },
  { id: 'exceptions', label: 'Exceptions', reason: 'The manager\'s Today view IS the exceptions view; investigations are their own item.', insteadUse: 'dashboard' },
  { id: 'cash', label: 'Cash & day close', reason: 'The "Close the day" tab of the manager\'s screen; over/short and reopen are their own items.', insteadUse: 'dashboard' },
  { id: 'purchase-orders', label: 'Purchase orders', reason: 'The "Raise an order" tab of the buyer\'s screen.', insteadUse: 'buying' },
  { id: 'receiving', label: 'Receiving', reason: 'Goods receipt review is the receiving screen, and already an item.', insteadUse: 'goods-receipt' },
  { id: 'stock', label: 'Stock', reason: 'Stock health is the stock screen, and already an item.', insteadUse: 'stock-health' },
  { id: 'sales', label: 'Sales', reason: 'Sales by day is the Reports screen\'s first report.', insteadUse: 'reporting' },
  { id: 'returns', label: 'Returns', reason: 'Returns are taken on the service desk and governed on Refund exceptions.', insteadUse: 'service' },
]);

export interface NavGroup {
  readonly group: string;
  readonly items: readonly NavItem[];
}

export interface NavigationContext {
  readonly userId: string;
  /** The branch the user is working in; null = a company-wide view. */
  readonly branchId: string | null;
  /**
   * W1: the product role ids this person holds here, when the caller knows them (the store computer does, from its role
   * register). They choose only the "daily work" group (`DAILY_WORK`) — never what may be opened, which stays the
   * permission check alone. Absent: no daily group.
   */
  readonly roleIds?: readonly string[];
}

/**
 * The navigation this user may actually see, grouped for the sidebar. Empty groups
 * are omitted. Default-deny: an unknown user, or one with no grants, sees nothing.
 */
export function navigationFor(
  access: AccessControl,
  context: NavigationContext,
  catalogue: readonly NavItem[] = ERP_NAVIGATION,
): NavGroup[] {
  const permitted = catalogue.filter((item) => mayOpenItem(access, context, item));

  // W1: the person's daily jobs first — each still one they may open — and not repeated in their workspace below.
  const dailyIds: string[] = [];
  for (const [roleId, jobs] of Object.entries(DAILY_WORK)) {
    if (!(context.roleIds ?? []).includes(roleId)) continue;
    for (const id of jobs) if (!dailyIds.includes(id) && permitted.some((i) => i.id === id)) dailyIds.push(id);
  }
  const daily = dailyIds.map((id) => permitted.find((i) => i.id === id)!);

  const groups: NavGroup[] = [];
  for (const item of permitted) {
    if (dailyIds.includes(item.id)) continue;
    const existing = groups.find((g) => g.group === item.group);
    if (existing === undefined) {
      groups.push({ group: item.group, items: [item] });
    } else {
      (existing.items as NavItem[]).push(item);
    }
  }
  // Within a workspace the most-used screens lead (NAV_ITEM_ORDER); the rest keep their declared order.
  for (const g of groups) {
    const lead = NAV_ITEM_ORDER[g.group] ?? [];
    const rank = (id: string): number => { const i = lead.indexOf(id); return i === -1 ? lead.length : i; };
    (g.items as NavItem[]).sort((x, y) => rank(x.id) - rank(y.id) || g.items.indexOf(x) - g.items.indexOf(y));
  }
  // The rail's order is the order of NAV_GROUP_LABELS (the task-based workspaces), never the order items happen
  // to be declared in; a group the labels do not know comes last, in declaration order.
  const order = Object.keys(NAV_GROUP_LABELS);
  const rank = (g: string): number => { const i = order.indexOf(g); return i === -1 ? order.length : i; };
  const sorted = groups.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g.group) - rank(b.g.group) || a.i - b.i).map(({ g }) => g);
  return daily.length > 0 ? [{ group: DAILY_GROUP, items: daily }, ...sorted] : sorted;
}

/** True if the user may open this path — the same check the server must apply. */
export function canOpen(
  access: AccessControl,
  context: NavigationContext,
  path: string,
  catalogue: readonly NavItem[] = ERP_NAVIGATION,
): boolean {
  const item = catalogue.find((i) => i.path === path);
  if (item === undefined) return false; // unknown path → denied, never a blank allow
  return mayOpenItem(access, context, item);
}

/** Every word that opens an item: its `requires`, then any narrower `alsoOpenedWith` (R10-A · OB-543). */
export function permissionsOpening(item: NavItem): readonly Permission[] {
  return [item.requires, ...(item.alsoOpenedWith ?? [])];
}

/** The user holds a word that opens this item, in the branch they are working in. */
function mayOpenItem(access: AccessControl, context: NavigationContext, item: NavItem): boolean {
  return permissionsOpening(item).some((permission) => access.can({ userId: context.userId, permission, branchId: context.branchId }));
}

/** The landing page for this user: their first permitted item, or null if none. */
export function landingPath(
  access: AccessControl,
  context: NavigationContext,
  catalogue: readonly NavItem[] = ERP_NAVIGATION,
): string | null {
  const groups = navigationFor(access, context, catalogue);
  return groups[0]?.items[0]?.path ?? null;
}
