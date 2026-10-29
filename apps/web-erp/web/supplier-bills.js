// Supplier bills — the view over the tested session model (`apps/web-erp/src/supplier-bills-session.ts`, attached by the
// bundle as `window.supplierBillsSession`). It holds no rule: what head office read, which lines need a person, whether a
// bill is a duplicate, whether the lines add up and what the match pays are all head office's, and every refusal is shown
// in head office's own words. Nothing is written on open: the register is a GET; every write is a person's click.
// Every word has a Tamil twin and follows the one language toggle.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const $ = (id) => document.getElementById(id);
const who = window.supplierBillsData && typeof window.supplierBillsData === 'object' ? window.supplierBillsData : null;
const session = window.supplierBillsSession ?? null;

const WORDS = {
  en: {
    title: 'Supplier bills',
    purpose: 'Hand in a supplier\'s bill, check what head office read off it, confirm it line by line, then check it against the order.',
    handH: 'Hand in a bill', handLede: 'The supplier\'s GST e-invoice file (.json), or a photo or PDF of the paper bill. Nothing goes on the register until a person confirms it.',
    billFile: 'The bill file', handSupplier: 'Supplier code (if the bill has no GSTIN)', handPo: 'Purchase order number (if you have it)', handIn: 'Hand in this bill',
    registerH: 'Bills handed in', waiting: 'Waiting for a person', engine: 'Reading scans', noEngine: 'No reading engine connected — scans are typed by a person',
    drawerH: 'Bill', open: 'Open',
    confirmH: 'Map each line to a product, then confirm',
    confirmLede: 'Head office suggests a product only where a person mapped this supplier\'s item code before. A line head office was unsure of needs its quantity, price and amount typed from the paper.',
    confirmInvoice: 'Invoice number on our register', supplierCode: 'Supplier code', poNumber: 'Purchase order number',
    confirmAccept: 'The lines differ from the bill\'s printed total and I will say why on the match', confirm: 'Confirm this bill',
    typeH: 'Type this bill from the paper',
    typeLede: 'No reading engine is connected, so head office could not read this scan. Type the bill as the paper says it; head office checks every line multiplies and the lines add up to the total.',
    typeTotal: 'Total printed on the bill (₹)', addLine: 'Add a line', typeSave: 'Save this bill',
    matchH: 'Check against the order', matchLede: 'Head office compares what was ordered, what arrived and what this bill claims. Where they disagree it holds the difference back.',
    runMatch: 'Check this bill against the order',
    line: 'Line', itemCode: 'Their item code', description: 'What the bill says', qty: 'Quantity', price: 'Price each (₹)', amount: 'Amount (₹)', tax: 'GST (₹)',
    product: 'Our product code', cgst: 'CGST (₹)', sgst: 'SGST (₹)', typeFigures: 'type from the paper', remove: 'Remove',
    eInvoice: 'GST e-invoice', scan: 'Scan', st_draft: 'Read — waiting for a person to confirm', st_awaiting_manual_capture: 'Scan — waiting for a person to type it',
    st_unreadable: 'Nothing could be read — waiting for a person to type it', st_confirmed: 'Confirmed onto the register', st_captured: 'Typed onto the register',
    supplier: 'supplier', noSupplier: 'supplier not found', invoiceNo: 'bill no.', dated: 'dated', total: 'printed total', handedBy: 'handed in by',
    linesWord: 'lines', onRegisterAs: 'on the register as', irn: 'IRN', unverifiedIrp: 'The e-invoice\'s IRP signature is not verified here (that needs the government portal).',
    handed: 'Handed in — head office read it. Open it below to confirm.', handedScan: 'Handed in — no reading engine is connected, so it waits for a person to type it.',
    alreadyHanded: 'This file was already handed in — it is the same bill.',
    pickFile: 'Pick the bill file first.', notBill: 'That is not a bill file — hand in the e-invoice (.json), a photo (PNG, JPEG, WebP) or a PDF.',
    notJson: 'That .json file could not be read as JSON — ask the supplier for the e-invoice file again.',
    confirmed: 'Confirmed — the bill is on head office\'s register as', typed: 'Saved — the bill is on head office\'s register as',
    needTyped: 'Give the invoice number, the supplier, the printed total and at least one line.', notMoney: 'A figure is not an amount of money or a whole quantity — line',
    agreed: 'These agree — the bill may be paid', blocked: 'Do not pay this yet', payable: 'May be paid', invoiced: 'Billed', withheld: 'Held back',
    m_matched: 'Agrees', m_within_tolerance: 'Within the allowed difference', m_blocked: 'Does not agree', whatIsWrong: 'What head office found', item: 'Item',
    flags: 'Head office also says', checkedBy: 'checked by',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    reading: 'Reading the bills from head office…', empty: 'No bills handed in yet.',
    mayNotCapture: 'Your role cannot hand in or confirm supplier bills.', mayNotMatch: 'Checking a bill against the order needs the bill-checking right — another person does it.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
    typedAs: 'Typed onto the register as', typedBy: 'typed by',
    // OB-509 (G3): deliveries waiting for their bill.
    cnkH: 'Deliveries waiting for their bill',
    cnkLede: 'Goods that came with no order, or that were not on the order, are booked with their cost not known. Pick the supplier\'s bill for the delivery and match it: their cost becomes the bill\'s. A typed figure never sets the stock\'s value.',
    cnkReading: 'Reading the deliveries waiting for a bill…', cnkNone: 'No delivery is waiting for its bill — every cost is known.',
    cnkMayNot: 'Matching a bill to a delivery needs the bill-checking right — another person does it.',
    cnkPill: 'Cost not known', noOrder: 'no purchase order', order: 'order', store: 'store', receivedBy: 'received by',
    inStock: 'in stock', because_no_issued_order: 'no purchase order', because_not_on_order: 'not on the order',
    noBillYet: 'No bill on head office\'s register names these goods yet — hand in or type the supplier\'s bill above first.',
    pickBillLabel: 'The supplier bill for this delivery', matchBill: 'Match this bill to the delivery', each: 'each', per: 'per',
  },
  ta: {
    title: 'சப்ளையர் பில்கள்',
    purpose: 'சப்ளையரின் பில்லைக் கொடுங்கள், தலைமை அலுவலகம் அதிலிருந்து படித்ததைச் சரிபாருங்கள், வரி வரியாக உறுதிசெய்யுங்கள், பின் ஆர்டருடன் சரிபாருங்கள்.',
    handH: 'ஒரு பில்லைக் கொடு', handLede: 'சப்ளையரின் ஜிஎஸ்டி இ-இன்வாய்ஸ் கோப்பு (.json), அல்லது காகித பில்லின் புகைப்படம் அல்லது PDF. ஒருவர் உறுதிசெய்யும் வரை எதுவும் பதிவேட்டில் சேராது.',
    billFile: 'பில் கோப்பு', handSupplier: 'சப்ளையர் குறியீடு (பில்லில் GSTIN இல்லையென்றால்)', handPo: 'கொள்முதல் ஆர்டர் எண் (இருந்தால்)', handIn: 'இந்த பில்லைக் கொடு',
    registerH: 'கொடுக்கப்பட்ட பில்கள்', waiting: 'ஒருவருக்காகக் காத்திருப்பவை', engine: 'ஸ்கேன்களைப் படித்தல்', noEngine: 'படிக்கும் இயந்திரம் இணைக்கப்படவில்லை — ஸ்கேன்களை ஒருவர் தட்டச்சு செய்வார்',
    drawerH: 'பில்', open: 'திற',
    confirmH: 'ஒவ்வொரு வரியையும் ஒரு பொருளுடன் இணைத்து, உறுதிசெய்',
    confirmLede: 'இந்த சப்ளையரின் பொருள் குறியீட்டை முன்பு ஒருவர் இணைத்திருந்தால் மட்டுமே தலைமை அலுவலகம் ஒரு பொருளைப் பரிந்துரைக்கும். உறுதியில்லாத வரிக்கு அளவு, விலை, தொகையைத் தாளிலிருந்து தட்டச்சு செய்ய வேண்டும்.',
    confirmInvoice: 'நமது பதிவேட்டில் இன்வாய்ஸ் எண்', supplierCode: 'சப்ளையர் குறியீடு', poNumber: 'கொள்முதல் ஆர்டர் எண்',
    confirmAccept: 'வரிகள் பில்லில் அச்சிட்ட மொத்தத்திலிருந்து வேறுபடுகின்றன; ஏன் என்று சரிபார்ப்பில் சொல்வேன்', confirm: 'இந்த பில்லை உறுதிசெய்',
    typeH: 'இந்த பில்லைத் தாளிலிருந்து தட்டச்சு செய்',
    typeLede: 'படிக்கும் இயந்திரம் இணைக்கப்படாததால் தலைமை அலுவலகம் இந்த ஸ்கேனைப் படிக்க முடியவில்லை. தாளில் உள்ளபடி தட்டச்சு செய்யுங்கள்; ஒவ்வொரு வரியும் பெருக்கலில் சரியா, மொத்தம் பொருந்துகிறதா என்று தலைமை அலுவலகம் சரிபார்க்கும்.',
    typeTotal: 'பில்லில் அச்சிட்ட மொத்தம் (₹)', addLine: 'ஒரு வரியைச் சேர்', typeSave: 'இந்த பில்லைச் சேமி',
    matchH: 'ஆர்டருடன் சரிபார்', matchLede: 'ஆர்டர் செய்தது, வந்தது, இந்த பில் கேட்பது — மூன்றையும் தலைமை அலுவலகம் ஒப்பிடும். பொருந்தாத இடத்தில் வித்தியாசத்தை நிறுத்தி வைக்கும்.',
    runMatch: 'இந்த பில்லை ஆர்டருடன் சரிபார்',
    line: 'வரி', itemCode: 'அவர்களின் பொருள் குறியீடு', description: 'பில்லில் உள்ளது', qty: 'அளவு', price: 'ஒன்றின் விலை (₹)', amount: 'தொகை (₹)', tax: 'ஜிஎஸ்டி (₹)',
    product: 'நமது பொருள் குறியீடு', cgst: 'CGST (₹)', sgst: 'SGST (₹)', typeFigures: 'தாளிலிருந்து தட்டச்சு செய்', remove: 'நீக்கு',
    eInvoice: 'ஜிஎஸ்டி இ-இன்வாய்ஸ்', scan: 'ஸ்கேன்', st_draft: 'படிக்கப்பட்டது — ஒருவர் உறுதிசெய்யக் காத்திருக்கிறது', st_awaiting_manual_capture: 'ஸ்கேன் — ஒருவர் தட்டச்சு செய்யக் காத்திருக்கிறது',
    st_unreadable: 'எதையும் படிக்க முடியவில்லை — ஒருவர் தட்டச்சு செய்யக் காத்திருக்கிறது', st_confirmed: 'பதிவேட்டில் உறுதிசெய்யப்பட்டது', st_captured: 'தட்டச்சு செய்து பதிவேட்டில் சேர்க்கப்பட்டது',
    supplier: 'சப்ளையர்', noSupplier: 'சப்ளையர் கிடைக்கவில்லை', invoiceNo: 'பில் எண்', dated: 'தேதி', total: 'அச்சிட்ட மொத்தம்', handedBy: 'கொடுத்தவர்',
    linesWord: 'வரிகள்', onRegisterAs: 'பதிவேட்டில்', irn: 'IRN', unverifiedIrp: 'இ-இன்வாய்ஸின் IRP கையொப்பம் இங்கே சரிபார்க்கப்படவில்லை (அதற்கு அரசு போர்ட்டல் தேவை).',
    handed: 'கொடுக்கப்பட்டது — தலைமை அலுவலகம் படித்தது. உறுதிசெய்ய கீழே திறக்கவும்.', handedScan: 'கொடுக்கப்பட்டது — படிக்கும் இயந்திரம் இல்லாததால் ஒருவர் தட்டச்சு செய்யக் காத்திருக்கிறது.',
    alreadyHanded: 'இந்தக் கோப்பு ஏற்கனவே கொடுக்கப்பட்டது — இது அதே பில்.',
    pickFile: 'முதலில் பில் கோப்பைத் தேர்ந்தெடுக்கவும்.', notBill: 'இது பில் கோப்பு அல்ல — இ-இன்வாய்ஸ் (.json), புகைப்படம் (PNG, JPEG, WebP) அல்லது PDF கொடுக்கவும்.',
    notJson: 'அந்த .json கோப்பை JSON ஆகப் படிக்க முடியவில்லை — சப்ளையரிடம் இ-இன்வாய்ஸ் கோப்பை மீண்டும் கேளுங்கள்.',
    confirmed: 'உறுதிசெய்யப்பட்டது — தலைமை அலுவலகப் பதிவேட்டில் பில்லின் எண்', typed: 'சேமிக்கப்பட்டது — தலைமை அலுவலகப் பதிவேட்டில் பில்லின் எண்',
    needTyped: 'இன்வாய்ஸ் எண், சப்ளையர், அச்சிட்ட மொத்தம், குறைந்தது ஒரு வரி — இவற்றைக் கொடுக்கவும்.', notMoney: 'ஒரு எண் பணத் தொகையோ முழு அளவோ அல்ல — வரி',
    agreed: 'இவை பொருந்துகின்றன — பில்லைச் செலுத்தலாம்', blocked: 'இதை இன்னும் செலுத்த வேண்டாம்', payable: 'செலுத்தலாம்', invoiced: 'பில் தொகை', withheld: 'நிறுத்தி வைக்கப்பட்டது',
    m_matched: 'பொருந்துகிறது', m_within_tolerance: 'அனுமதித்த வித்தியாசத்திற்குள்', m_blocked: 'பொருந்தவில்லை', whatIsWrong: 'தலைமை அலுவலகம் கண்டது', item: 'பொருள்',
    flags: 'தலைமை அலுவலகம் மேலும் சொல்வது', checkedBy: 'சரிபார்த்தவர்',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    reading: 'தலைமை அலுவலகத்திலிருந்து பில்களைப் படிக்கிறது…', empty: 'இன்னும் பில்கள் கொடுக்கப்படவில்லை.',
    mayNotCapture: 'உங்கள் பங்கால் சப்ளையர் பில்களைக் கொடுக்கவோ உறுதிசெய்யவோ முடியாது.', mayNotMatch: 'பில்லை ஆர்டருடன் சரிபார்க்க பில் சரிபார்ப்பு உரிமை தேவை — வேறு ஒருவர் செய்வார்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
    typedAs: 'தட்டச்சு செய்து பதிவேட்டில் சேர்த்த எண்', typedBy: 'தட்டச்சு செய்தவர்',
    cnkH: 'பில்லுக்காகக் காத்திருக்கும் டெலிவரிகள்',
    cnkLede: 'ஆர்டர் இல்லாமல் வந்த அல்லது ஆர்டரில் இல்லாத பொருட்கள் விலை தெரியாமல் பதிவு செய்யப்படுகின்றன. அந்த டெலிவரிக்கான சப்ளையர் பில்லைத் தேர்ந்தெடுத்துப் பொருத்துங்கள்: அவற்றின் விலை பில்லின் விலையாகும். தட்டச்சு செய்த எண் ஒருபோதும் இருப்பின் மதிப்பை அமைக்காது.',
    cnkReading: 'பில்லுக்காகக் காத்திருக்கும் டெலிவரிகளைப் படிக்கிறது…', cnkNone: 'எந்த டெலிவரியும் பில்லுக்காகக் காத்திருக்கவில்லை — எல்லா விலைகளும் தெரியும்.',
    cnkMayNot: 'பில்லை டெலிவரியுடன் பொருத்த பில் சரிபார்ப்பு உரிமை தேவை — வேறு ஒருவர் செய்வார்.',
    cnkPill: 'விலை தெரியவில்லை', noOrder: 'கொள்முதல் ஆர்டர் இல்லை', order: 'ஆர்டர்', store: 'கடை', receivedBy: 'பெற்றவர்',
    inStock: 'இருப்பில்', because_no_issued_order: 'கொள்முதல் ஆர்டர் இல்லை', because_not_on_order: 'ஆர்டரில் இல்லை',
    noBillYet: 'இந்தப் பொருட்களைக் குறிப்பிடும் பில் தலைமை அலுவலகப் பதிவேட்டில் இன்னும் இல்லை — முதலில் மேலே சப்ளையர் பில்லைக் கொடுக்கவும் அல்லது தட்டச்சு செய்யவும்.',
    pickBillLabel: 'இந்த டெலிவரிக்கான சப்ளையர் பில்', matchBill: 'இந்த பில்லை டெலிவரியுடன் பொருத்து', each: 'ஒன்றுக்கு', per: 'க்கு',
  },
};
let lang = 'en';
const t = (k) => WORDS[lang][k] ?? WORDS.en[k] ?? k;
const inr = (minor) => (minor === null || minor === undefined ? '—' : '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

let register = null;
let openDoc = null;
let typeRows = [];

function say(el, answer, good) {
  if (answer.ok) { el.className = 'status good'; el.textContent = good; return; }
  el.className = 'status err';
  el.textContent = answer.unreachable ? t('unreachable') : `${t('refused')} ${answer.whatHappened}`;
}
function sayLocal(el, text) { el.className = 'status err'; el.textContent = text; }

// ── The register ───────────────────────────────────────────────────────────

async function refresh() {
  if (session === null) return;
  $('register-status').className = 'status';
  $('register-status').textContent = t('reading');
  const answer = await session.register();
  if (!answer.ok) {
    say($('register-status'), answer, '');
    // A role without the capture right: head office's own refusal, with what it means here.
    if (!session.mayCapture) $('register-status').textContent = `${t('mayNotCapture')} ${$('register-status').textContent}`;
    return;
  }
  register = answer.value;
  $('register-status').textContent = register.documents.length === 0 ? t('empty') : '';
  renderRegister();
  if (openDoc !== null) {
    const again = register.documents.find((d) => d.documentId === openDoc.documentId);
    if (again) { openDoc = again; renderDrawer(); }
  }
}

function factsOf(d) {
  const x = d.extracted;
  const parts = [d.channel === 'e_invoice' ? t('eInvoice') : t('scan')];
  parts.push(d.supplierId ? `${t('supplier')} ${d.supplierId}` : (x ? t('noSupplier') : ''));
  if (x?.supplierInvoiceNo) parts.push(`${t('invoiceNo')} ${x.supplierInvoiceNo}`);
  if (x?.invoiceDate) parts.push(`${t('dated')} ${x.invoiceDate}`);
  if (x?.statedTotalMinor !== null && x?.statedTotalMinor !== undefined) parts.push(`${t('total')} ${inr(x.statedTotalMinor)}`);
  if (d.lines.length > 0) parts.push(`${d.lines.length} ${t('linesWord')}`);
  if (d.invoiceId) parts.push(`${d.state === 'captured' ? t('typedAs') : t('onRegisterAs')} ${d.invoiceId}`);
  if (d.typedBy) parts.push(`${t('typedBy')} ${d.typedBy}`);
  parts.push(`${t('handedBy')} ${d.receivedBy}`);
  return parts.filter((p) => p !== '').join(' · ');
}

function renderRegister() {
  if (register === null) return;
  $('waiting').textContent = String(register.waiting);
  $('engine').textContent = register.ocrEngine ?? t('noEngine');
  $('register').replaceChildren(...register.documents.map((d) => {
    const li = document.createElement('li');
    li.className = 'bill';
    li.dataset.doc = d.documentId;
    li.dataset.state = d.state;
    const head = document.createElement('div');
    head.className = 'head';
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = d.extracted?.supplierInvoiceNo ?? d.documentId;
    const pill = document.createElement('span');
    pill.className = `pill ${d.state === 'confirmed' || d.state === 'captured' ? 'done' : 'waiting'}`;
    pill.textContent = t(`st_${d.state}`);
    const open = document.createElement('button');
    open.type = 'button';
    open.dataset.act = 'open';
    open.textContent = t('open');
    open.addEventListener('click', () => { openDoc = d; renderDrawer(); $('drawer').scrollIntoView({ block: 'start' }); });
    head.append(what, pill, open);
    const facts = document.createElement('div');
    facts.className = 'facts';
    facts.textContent = factsOf(d);
    li.append(head, facts);
    return li;
  }));
}

// ── Hand in ────────────────────────────────────────────────────────────────

const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

$('hand-in').addEventListener('click', async () => {
  const file = $('bill-file').files?.[0];
  if (!file) { sayLocal($('hand-status'), t('pickFile')); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const picked = {
    name: file.name, mediaType: file.type || (/\.json$/i.test(file.name) ? 'application/json' : ''),
    contentBase64: toBase64(bytes), sha256: hex(await crypto.subtle.digest('SHA-256', bytes)),
    ...(/\.json$/i.test(file.name) || file.type === 'application/json' ? { text: new TextDecoder().decode(bytes) } : {}),
  };
  const answer = await session.handIn(picked, { supplierId: $('hand-supplier').value, poId: $('hand-po').value });
  if (!answer.ok && !answer.unreachable && answer.status === 0) { sayLocal($('hand-status'), answer.code === 'not_json' ? t('notJson') : t('notBill')); return; }
  const doc = answer.ok ? answer.value.document : null;
  say($('hand-status'), answer, answer.ok ? (answer.value.alreadyReceived ? t('alreadyHanded') : doc.state === 'draft' ? t('handed') : t('handedScan')) : '');
  if (answer.ok) { openDoc = doc; await refresh(); renderDrawer(); }
});

// ── The drawer: one bill ───────────────────────────────────────────────────

const safeId = (text) => String(text ?? '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

function cell(tag, text, cls) { const c = document.createElement(tag); if (text !== undefined) c.textContent = text; if (cls) c.className = cls; return c; }
function input(cls, value, label) { const i = document.createElement('input'); i.className = cls; i.value = value ?? ''; i.autocomplete = 'off'; i.setAttribute('aria-label', label); return i; }

function renderDrawer() {
  const d = openDoc;
  $('drawer').hidden = d === null;
  if (d === null) return;
  $('drawer').dataset.doc = d.documentId;
  $('drawer-h').textContent = `${t('drawerH')} ${d.extracted?.supplierInvoiceNo ?? d.documentId} — ${t(`st_${d.state}`)}`;
  $('drawer-facts').textContent = factsOf(d) + (d.extracted?.irn ? ` · ${t('irn')} ${d.extracted.irn.slice(0, 16)}…` : '');
  $('drawer-problems').replaceChildren(...d.problems.map((p) => cell('li', p === 'irp_signature_not_verified' ? t('unverifiedIrp') : p)));

  const canCapture = session !== null && session.mayCapture;
  $('confirm-part').hidden = !(d.state === 'draft' && canCapture);
  $('type-part').hidden = !((d.state === 'awaiting_manual_capture' || d.state === 'unreadable') && canCapture);
  const invoiceId = d.invoiceId ?? null;
  $('match-part').hidden = invoiceId === null;

  if (!$('confirm-part').hidden) renderDraft(d);
  if (!$('type-part').hidden) renderTyping(d);
  if (invoiceId !== null) void renderMatchPart(d, invoiceId);
}

function renderDraft(d) {
  const table = $('draft-lines');
  const head = document.createElement('tr');
  for (const [k, cls] of [['line', ''], ['itemCode', ''], ['description', ''], ['qty', 'amount'], ['price', 'amount'], ['amount', 'amount'], ['tax', 'amount'], ['product', '']]) head.append(cell('th', t(k), cls));
  const rows = d.lines.map((l) => {
    const tr = document.createElement('tr');
    tr.dataset.line = String(l.lineNo);
    if (l.needsFigures) tr.dataset.needsFigures = 'true';
    tr.append(cell('td', String(l.lineNo)), cell('td', l.supplierItemCode ?? '—'), cell('td', l.description || '—'));
    if (l.needsFigures) {
      // The figures head office was unsure of: typed from the paper, never the machine's guess.
      const q = cell('td'); q.append(input('f-qty', '', `${t('line')} ${l.lineNo} ${t('qty')} — ${t('typeFigures')}`));
      const p = cell('td'); p.append(input('f-price', '', `${t('line')} ${l.lineNo} ${t('price')} — ${t('typeFigures')}`));
      const a = cell('td'); a.append(input('f-amount', '', `${t('line')} ${l.lineNo} ${t('amount')} — ${t('typeFigures')}`));
      tr.append(q, p, a);
    } else {
      tr.append(cell('td', `${l.quantity ?? '—'}${l.uom && l.uom !== 'ea' ? ` ${l.uom}` : ''}`, 'amount'), cell('td', inr(l.unitPriceMinor), 'amount'), cell('td', inr(l.lineTotalMinor), 'amount'));
    }
    tr.append(cell('td', inr(l.cgstMinor + l.sgstMinor + l.igstMinor), 'amount'));
    const prod = cell('td'); prod.append(input('f-product', l.suggestedProductId ?? '', `${t('line')} ${l.lineNo} ${t('product')}`));
    tr.append(prod);
    return tr;
  });
  table.replaceChildren(head, ...rows);
  if ($('confirm-invoice').dataset.doc !== d.documentId) {
    $('confirm-invoice').dataset.doc = d.documentId;
    $('confirm-invoice').value = safeId(`${d.supplierId ?? ''}-${d.extracted?.supplierInvoiceNo ?? ''}`);
    $('confirm-supplier').value = d.supplierId ?? '';
    $('confirm-po').value = d.poId ?? '';
    $('confirm-accept').checked = false;
    $('confirm-status').textContent = '';
  }
}

$('confirm').addEventListener('click', async () => {
  const d = openDoc;
  if (d === null) return;
  const entries = [...$('draft-lines').querySelectorAll('tr[data-line]')].map((tr) => ({
    lineNo: Number(tr.dataset.line),
    productId: tr.querySelector('.f-product')?.value ?? '',
    ...(tr.dataset.needsFigures ? { quantity: tr.querySelector('.f-qty').value, unitPrice: tr.querySelector('.f-price').value, amount: tr.querySelector('.f-amount').value } : {}),
  }));
  const answer = await session.confirm(d, { invoiceId: $('confirm-invoice').value, supplierId: $('confirm-supplier').value, poId: $('confirm-po').value, entries, acceptTotalDifference: $('confirm-accept').checked });
  say($('confirm-status'), answer, answer.ok ? `${t('confirmed')} ${answer.value.invoiceId}.` : '');
  if (answer.ok) { openDoc = answer.value.document; await refresh(); renderDrawer(); }
});

function renderTyping(d) {
  if ($('type-invoice').dataset.doc !== d.documentId) {
    $('type-invoice').dataset.doc = d.documentId;
    $('type-invoice').value = '';
    $('type-supplier').value = d.supplierId ?? '';
    $('type-po').value = d.poId ?? '';
    $('type-total').value = '';
    $('type-status').textContent = '';
    typeRows = [{}];
  }
  drawTypeRows();
}
function drawTypeRows() {
  const head = document.createElement('tr');
  for (const [k, cls] of [['product', ''], ['qty', 'amount'], ['price', 'amount'], ['amount', 'amount'], ['cgst', 'amount'], ['sgst', 'amount'], ['remove', '']]) head.append(cell('th', t(k), cls));
  const rows = typeRows.map((r, i) => {
    const tr = document.createElement('tr');
    tr.dataset.row = String(i + 1);
    for (const [k, field] of [['product', 'productId'], ['qty', 'quantity'], ['price', 'unitPrice'], ['amount', 'amount'], ['cgst', 'cgst'], ['sgst', 'sgst']]) {
      const td = cell('td');
      const box = input(`t-${field}`, r[field], `${t('line')} ${i + 1} ${t(k)}`);
      box.addEventListener('input', () => { typeRows[i] = { ...typeRows[i], [field]: box.value }; });
      td.append(box);
      tr.append(td);
    }
    const rm = cell('td');
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = t('remove');
    b.addEventListener('click', () => { typeRows.splice(i, 1); if (typeRows.length === 0) typeRows.push({}); drawTypeRows(); });
    rm.append(b);
    tr.append(rm);
    return tr;
  });
  $('type-lines').replaceChildren(head, ...rows);
}
$('type-add-line').addEventListener('click', () => { typeRows.push({}); drawTypeRows(); });

$('type-save').addEventListener('click', async () => {
  const d = openDoc;
  if (d === null) return;
  const lines = typeRows.filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== '')).map((r) => ({
    productId: r.productId ?? '', quantity: r.quantity ?? '', unitPrice: r.unitPrice ?? '', amount: r.amount ?? '', cgst: r.cgst ?? '', sgst: r.sgst ?? '',
  }));
  // The capture names this scan, so head office records it as typed — the list then reads it as captured (no tab memory).
  const answer = await session.type({ invoiceId: $('type-invoice').value, supplierId: $('type-supplier').value, poId: $('type-po').value, total: $('type-total').value, lines, documentId: d.documentId });
  if (answer.ok === false && 'problem' in answer) { sayLocal($('type-status'), answer.problem === 'not_money' ? `${t('notMoney')} ${answer.line ?? ''}` : t('needTyped')); return; }
  say($('type-status'), answer, answer.ok ? `${t('typed')} ${answer.value.invoiceId}.` : '');
  if (answer.ok) await refresh();
});

// ── The three-way match ────────────────────────────────────────────────────

async function renderMatchPart(d, invoiceId) {
  if ($('match-part').dataset.invoice !== invoiceId) {
    // Another bill: nothing of the last one's check stays on the screen.
    $('match-status').textContent = '';
    $('match-verdict').hidden = true;
    $('match-lines').replaceChildren();
  }
  $('match-part').dataset.invoice = invoiceId;
  $('match-invoice').textContent = `${d.state === 'captured' ? t('typedAs') : t('onRegisterAs')} ${invoiceId}`;
  $('run-match').hidden = !(session !== null && session.mayMatch);
  if (!session.mayMatch) { $('match-status').className = 'status'; $('match-status').textContent = t('mayNotMatch'); }
  const latest = await session.latestMatch(invoiceId);
  if (latest.ok && latest.value !== null) drawMatch(latest.value);
  else { $('match-verdict').hidden = true; $('match-lines').replaceChildren(); }
}

function drawMatch(m) {
  const v = $('match-verdict');
  v.hidden = false;
  v.className = `verdict ${m.blocked ? 'problem' : 'ready'}`;
  v.dataset.blocked = String(m.blocked);
  v.dataset.invoice = m.invoiceId;
  const parts = [
    cell('strong', m.blocked ? t('blocked') : t('agreed')),
    cell('span', `${t('payable')}: ${inr(m.payableMinor)} · ${t('invoiced')}: ${inr(m.invoicedMinor)}${m.withheldMinor > 0 ? ` · ${t('withheld')}: ${inr(m.withheldMinor)}` : ''}`),
    // Head office's own sentence on what to do — never reworded here.
    cell('span', m.ownerAction, 'muted'),
    cell('span', `${t('checkedBy')} ${m.matchedBy}`, 'muted'),
  ];
  if (m.flags.length > 0) parts.push(cell('span', `${t('flags')}: ${m.flags.join(', ')}`, 'muted'));
  v.replaceChildren(...parts);
  const head = document.createElement('tr');
  for (const [k, cls] of [['item', ''], ['m_matched', ''], ['payable', 'amount'], ['whatIsWrong', '']]) head.append(cell('th', k === 'm_matched' ? '' : t(k), cls));
  $('match-lines').replaceChildren(head, ...m.lines.map((l) => {
    const tr = document.createElement('tr');
    tr.dataset.product = l.productId;
    tr.dataset.status = l.status;
    if (l.status === 'blocked') tr.className = 'blocked';
    const status = cell('td');
    status.append(cell('span', t(`m_${l.status}`), `pill ${l.status === 'blocked' ? 'blocked' : l.status === 'matched' ? 'done' : 'waiting'}`));
    tr.append(cell('td', l.productId), status, cell('td', inr(l.payableMinor), 'amount'), cell('td', l.detail));
    return tr;
  }));
}

$('run-match').addEventListener('click', async () => {
  const invoiceId = $('match-part').dataset.invoice;
  if (!invoiceId) return;
  const answer = await session.match(invoiceId);
  say($('match-status'), answer, answer.ok ? (answer.value.blocked ? t('blocked') : t('agreed')) : '');
  if (answer.ok) drawMatch(answer.value);
});

// ── Deliveries waiting for their bill (OB-509 · G3) ─────────────────────────

let waitingList = null;
const steps = (minor, uom) => (uom === 'kg' || uom === 'L' ? (minor / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : String(minor));
const priceWords = (p) => `${p.productId} ${inr(p.unitPriceMinor)} ${p.unitPricePer > 1 ? `${t('per')} ${p.unitPricePer}` : t('each')}`;

async function refreshWaiting() {
  if (session === null) return;
  const status = $('cnk-status');
  if (!session.mayMatch) { status.className = 'status'; status.textContent = t('cnkMayNot'); $('cnk-list').replaceChildren(); return; }
  status.className = 'status';
  status.textContent = t('cnkReading');
  const answer = await session.waitingForBill();
  if (!answer.ok) { say(status, answer, ''); return; }
  waitingList = answer.value;
  status.textContent = waitingList.receipts.length === 0 ? t('cnkNone') : '';
  renderWaiting();
}

function renderWaiting() {
  if (waitingList === null) return;
  $('cnk-list').replaceChildren(...waitingList.receipts.map((r) => {
    const li = document.createElement('li');
    li.className = 'bill';
    li.dataset.grn = r.grnId;
    const head = document.createElement('div');
    head.className = 'head';
    head.append(cell('span', r.number || r.grnId, 'what'), cell('span', t('cnkPill'), 'pill waiting'));
    const when = r.receivedAt ? shopWhen(r.receivedAt) : '';
    const facts = cell('div', [r.poId === null ? t('noOrder') : `${t('order')} ${r.poId}`, `${t('store')} ${r.warehouseId}`, `${t('receivedBy')} ${r.receivedBy}`, when].filter((x) => x !== '').join(' · '), 'facts');
    const lines = cell('div', r.waiting.map((w) => `${w.productId} × ${steps(w.inStockMinor, w.uom)} ${t('inStock')} — ${t(`because_${w.because}`)}`).join(' · '), 'facts');
    li.append(head, facts, lines);
    const rowStatus = cell('p', '', 'status');
    rowStatus.setAttribute('role', 'status');
    rowStatus.setAttribute('aria-live', 'polite');
    if (r.receivedByYou) {
      li.append(cell('p', session.matchWords(lang, { ok: false, unreachable: false, status: 403, code: 'receivedByYou', whatHappened: '', nextSafeAction: '' }).text, 'muted'));
    } else if (r.bills.length === 0) {
      li.append(cell('p', t('noBillYet'), 'muted'));
    } else {
      const id = `cnk-bill-${safeId(r.grnId)}`;
      const label = document.createElement('label');
      label.htmlFor = id;
      label.append(cell('span', t('pickBillLabel')));
      const select = document.createElement('select');
      select.id = id;
      select.className = 'cnk-bill';
      select.replaceChildren(...r.bills.map((b) => {
        const opt = document.createElement('option');
        opt.value = b.invoiceId;
        opt.textContent = `${b.invoiceId} · ${t('supplier')} ${b.supplierId} · ${b.prices.map(priceWords).join(', ')}`;
        return opt;
      }));
      label.append(select);
      const button = cell('button', t('matchBill'), 'primary');
      button.type = 'button';
      button.dataset.act = 'match-bill';
      button.dataset.grn = r.grnId;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const answer = await session.matchToReceipt(r.grnId, select.value);
          const said = session.matchWords(lang, answer);
          rowStatus.className = `status ${said.good ? 'good' : 'err'}`;
          rowStatus.textContent = said.text;
          // A match head office recorded: the list is read again (this delivery leaves it) and what happened stays said above it.
          if (answer.ok) { await refreshWaiting(); $('cnk-status').className = 'status good'; $('cnk-status').textContent = said.text; }
        } finally { button.disabled = false; }
      });
      li.append(label, button);
    }
    li.append(rowStatus);
    return li;
  }));
}

// ── Language and boot ──────────────────────────────────────────────────────

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title').textContent = t('title');
  $('purpose').textContent = t('purpose');
  $('hand-h').textContent = t('handH'); $('hand-lede').textContent = t('handLede');
  $('l-bill-file').textContent = t('billFile'); $('l-hand-supplier').textContent = t('handSupplier'); $('l-hand-po').textContent = t('handPo');
  $('hand-in').textContent = t('handIn');
  $('register-h').textContent = t('registerH'); $('l-waiting').textContent = t('waiting'); $('l-engine').textContent = t('engine');
  $('confirm-h').textContent = t('confirmH'); $('confirm-lede').textContent = t('confirmLede');
  $('l-confirm-invoice').textContent = t('confirmInvoice'); $('l-confirm-supplier').textContent = t('supplierCode'); $('l-confirm-po').textContent = t('poNumber');
  $('l-confirm-accept').textContent = t('confirmAccept'); $('confirm').textContent = t('confirm');
  $('type-h').textContent = t('typeH'); $('type-lede').textContent = t('typeLede');
  $('l-type-invoice').textContent = t('confirmInvoice'); $('l-type-supplier').textContent = t('supplierCode'); $('l-type-po').textContent = t('poNumber'); $('l-type-total').textContent = t('typeTotal');
  $('type-add-line').textContent = t('addLine'); $('type-save').textContent = t('typeSave');
  $('match-h').textContent = t('matchH'); $('match-lede').textContent = t('matchLede'); $('run-match').textContent = t('runMatch');
  $('cnk-h').textContent = t('cnkH'); $('cnk-lede').textContent = t('cnkLede');
  if (session !== null && !session.mayMatch) $('cnk-status').textContent = t('cnkMayNot');
  else if (waitingList !== null && waitingList.receipts.length === 0) $('cnk-status').textContent = t('cnkNone');
  if (who === null || session === null) { $('nobody').hidden = false; $('nobody').textContent = t('nobody'); }
  renderRegister();
  renderWaiting();
  if (openDoc !== null) renderDrawer();
}

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paint();
});

if (who === null || session === null) {
  $('hand-section').hidden = true;
} else if (!session.mayCapture) {
  // Nothing to hand in or confirm is offered; the register is still asked for (a read), so the refusal is head office's.
  $('hand-section').hidden = true;
}
paint();
if (session !== null) { void refresh(); void refreshWaiting(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it just will not be cached */ });
}
