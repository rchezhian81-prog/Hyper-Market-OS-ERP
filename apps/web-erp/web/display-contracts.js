// Supplier display space (Wave 2 · M04-FR-04 · D02-FR-06 · §28): a THIN CLIENT over head office's display-contract register
// and its record route. The register and its summary are the shared office parts (window.sreOffice); each contract's
// finding is head office's, judged on the shop's today, and the money received is Finance's (its display-funding
// journals) or "Not known". Recording is append-only — a correction supersedes. The funding terms need a Finance approver
// (never the person recording them): asked here for exactly those terms, decided on the approver's Approvals page, and the
// contract is then recorded again naming the approval. Every word has a Tamil twin; nothing is written on open.

const $ = (id) => document.getElementById(id);
const who = window.displayContractsData && typeof window.displayContractsData === 'object' ? window.displayContractsData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = named && perms.has('merchandising.space.read');
const mayManage = named && perms.has('merchandising.display.manage');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Supplier display space',
    lead: 'Space a supplier pays for — an end cap, a stand, a shelf strip. Each contract names the space, the money and the dates; Finance approves the money, and the money received comes from the accounts. An expired contract with the display still up is space the shop is giving away.',
    kAll: 'Display contracts', kFlagged: 'Need attention', kUnapproved: 'Waiting for Finance', kEnded: 'Ended — check the display is down', kOwed: 'Money not yet received',
    nAll: 'recorded at head office', nFlagged: 'anything not running normally', nUnapproved: 'funding terms not approved', nEnded: 'past their last day', nOwed: 'agreed minus received, from the accounts',
    listH: 'Display contracts', listLead: 'Soonest to end first. Open one to see it in full or to correct it.',
    cId: 'Contract', cSupplier: 'Supplier', cWhat: 'Space', cStore: 'Store', cMoney: 'Money agreed', cFrom: 'Starts', cTo: 'Ends', cLeft: 'Days left', cFinding: 'Where it stands', cApproved: 'Finance', cReceived: 'Received', cOwed: 'Still owed', cPlaces: 'Shelf places', cArea: 'Floor area', cApprover: 'Approved by',
    empty: 'No display contracts yet', emptyDetail: 'Head office holds no supplier display contract. Recording one below is how the shop starts tracking paid space.',
    active: 'Running', expiring_soon: 'Ends soon', expired_still_occupying: 'Ended', unapproved: 'Waiting for Finance', no_space_named: 'No space named', funding_not_received: 'Money not received',
    dActive: 'Runs for another {n} day(s).', dSoon: 'Ends in {n} day(s) — renew it or plan the space.', dEnded: 'Ended {n} day(s) ago — take the display down, or renew the contract.', dUnapproved: 'Finance has not approved the funding terms yet.', dNoSpace: 'It does not name the space it buys, so nobody can check it on the floor.', dNotIn: '{owed} of the agreed money has not come in — the space is used, the money is not.',
    approvedYes: 'Approved', approvedNo: 'Not approved', notWired: 'Not known', correct: 'Correct this contract',
    formH: 'Record a display contract', formLead: 'Write what the supplier is paying for. A contract you record waits as "Waiting for Finance" until the accountant or the owner approves exactly these terms; you then record it again and it names them.',
    id: 'Contract code', supplier: 'Supplier code', what: 'What the space is (e.g. tea end cap by the tills)', store: 'Store', places: 'Shelf places it buys (codes, separated by commas)', area: 'Floor area (optional)', money: 'Money the supplier pays (₹)', from: 'Starts on', to: 'Ends on',
    record: 'Record the contract', why: 'Why (for the Finance approver)', ask: 'Ask Finance to approve these terms',
    savedUnapproved: 'Recorded. It waits for Finance: write why and press “Ask Finance to approve these terms”. Once they approve it on their Approvals page, press “Record the contract” again.',
    savedApproved: 'Recorded with the approval of {by}.', waiting: 'Recorded. Your request is still waiting for the Finance approver; once they approve it, press “Record the contract” again.',
    rejected: 'Recorded, but the Finance approver turned these terms down: {why}', asked: 'Asked. It waits for the accountant or the owner on their Approvals page.',
    needAll: 'Fill in the contract code, the supplier, the space, the store, the money and both dates. Nothing was sent.', needWhy: 'Write the reason first.', badMoney: 'Write the money in rupees, for example 5000 or 5000.50. Nothing was sent.',
    readOnly: 'You can read the display contracts. Recording one is for the person who manages display space.',
    noRight: 'This account may not read the display contracts.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was changed — try again.',
  },
  ta: {
    lang: 'English', title: 'சப்ளையர் காட்சி இடம்',
    lead: 'ஒரு சப்ளையர் பணம் செலுத்தும் இடம் — முனை அலமாரி, ஸ்டாண்ட், அலமாரிப் பட்டை. ஒவ்வொரு ஒப்பந்தமும் இடம், பணம், தேதிகளைக் குறிக்கிறது; பணத்தை நிதி ஒப்புக்கொள்கிறது, பெற்ற பணம் கணக்குகளிலிருந்து வருகிறது. காலாவதியான ஒப்பந்தத்துடன் காட்சி இன்னும் இருந்தால் கடை இலவசமாக இடம் கொடுக்கிறது.',
    kAll: 'காட்சி ஒப்பந்தங்கள்', kFlagged: 'கவனம் தேவை', kUnapproved: 'நிதிக்காகக் காத்திருக்கிறது', kEnded: 'முடிந்தது — காட்சி அகற்றப்பட்டதா பாருங்கள்', kOwed: 'இன்னும் பெறாத பணம்',
    nAll: 'தலைமை அலுவலகத்தில் பதிவானவை', nFlagged: 'சாதாரணமாக இயங்காதவை', nUnapproved: 'நிதி விதிமுறைகள் ஒப்புதல் பெறவில்லை', nEnded: 'கடைசி நாள் கடந்தவை', nOwed: 'ஒப்புக்கொண்டது கழித்தல் பெற்றது, கணக்குகளிலிருந்து',
    listH: 'காட்சி ஒப்பந்தங்கள்', listLead: 'விரைவில் முடிவது முதலில். முழுமையாகப் பார்க்க அல்லது திருத்த ஒன்றைத் திறக்கவும்.',
    cId: 'ஒப்பந்தம்', cSupplier: 'சப்ளையர்', cWhat: 'இடம்', cStore: 'கடை', cMoney: 'ஒப்புக்கொண்ட பணம்', cFrom: 'தொடக்கம்', cTo: 'முடிவு', cLeft: 'மீதமுள்ள நாட்கள்', cFinding: 'நிலை', cApproved: 'நிதி', cReceived: 'பெற்றது', cOwed: 'இன்னும் வர வேண்டியது', cPlaces: 'அலமாரி இடங்கள்', cArea: 'தளப் பகுதி', cApprover: 'ஒப்புதல் அளித்தவர்',
    empty: 'இன்னும் காட்சி ஒப்பந்தங்கள் இல்லை', emptyDetail: 'தலைமை அலுவலகத்திடம் சப்ளையர் காட்சி ஒப்பந்தம் எதுவும் இல்லை. கீழே ஒன்றைப் பதிவதே பணம் செலுத்திய இடத்தைக் கண்காணிக்கத் தொடக்கம்.',
    active: 'இயங்குகிறது', expiring_soon: 'விரைவில் முடியும்', expired_still_occupying: 'முடிந்தது', unapproved: 'நிதிக்காகக் காத்திருக்கிறது', no_space_named: 'இடம் குறிப்பிடப்படவில்லை', funding_not_received: 'பணம் வரவில்லை',
    dActive: 'இன்னும் {n} நாள்(கள்) இயங்கும்.', dSoon: '{n} நாளில் முடியும் — புதுப்பிக்கவும் அல்லது இடத்தைத் திட்டமிடவும்.', dEnded: '{n} நாள்(கள்) முன் முடிந்தது — காட்சியை அகற்றவும், அல்லது ஒப்பந்தத்தைப் புதுப்பிக்கவும்.', dUnapproved: 'நிதி இன்னும் பண விதிமுறைகளை ஒப்புக்கொள்ளவில்லை.', dNoSpace: 'அது வாங்கும் இடத்தைக் குறிப்பிடவில்லை, எனவே தரையில் யாரும் சரிபார்க்க முடியாது.', dNotIn: 'ஒப்புக்கொண்ட பணத்தில் {owed} இன்னும் வரவில்லை — இடம் பயன்படுகிறது, பணம் வரவில்லை.',
    approvedYes: 'ஒப்புதல் பெற்றது', approvedNo: 'ஒப்புதல் இல்லை', notWired: 'தெரியவில்லை', correct: 'இந்த ஒப்பந்தத்தைத் திருத்து',
    formH: 'காட்சி ஒப்பந்தத்தைப் பதி', formLead: 'சப்ளையர் எதற்குப் பணம் செலுத்துகிறார் என்று எழுதுங்கள். நீங்கள் பதியும் ஒப்பந்தம், கணக்காளர் அல்லது உரிமையாளர் இதே விதிமுறைகளை ஒப்புக்கொள்ளும் வரை "நிதிக்காகக் காத்திருக்கிறது" என்று இருக்கும்; பிறகு மீண்டும் பதிந்தால் அது அவர்களைக் குறிக்கும்.',
    id: 'ஒப்பந்தக் குறியீடு', supplier: 'சப்ளையர் குறியீடு', what: 'இடம் எது (எ.கா. கல்லா அருகே தேநீர் முனை அலமாரி)', store: 'கடை', places: 'அது வாங்கும் அலமாரி இடங்கள் (குறியீடுகள், காற்புள்ளியால் பிரித்து)', area: 'தளப் பகுதி (விருப்பம்)', money: 'சப்ளையர் செலுத்தும் பணம் (₹)', from: 'தொடங்கும் நாள்', to: 'முடியும் நாள்',
    record: 'ஒப்பந்தத்தைப் பதி', why: 'ஏன் (நிதி ஒப்புதலாளருக்கு)', ask: 'இந்த விதிமுறைகளுக்கு நிதி ஒப்புதல் கேள்',
    savedUnapproved: 'பதியப்பட்டது. நிதிக்காகக் காத்திருக்கிறது: ஏன் என்று எழுதி “இந்த விதிமுறைகளுக்கு நிதி ஒப்புதல் கேள்” அழுத்துங்கள். அவர்கள் தங்கள் ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும் “ஒப்பந்தத்தைப் பதி” மீண்டும் அழுத்துங்கள்.',
    savedApproved: '{by} அவர்களின் ஒப்புதலுடன் பதியப்பட்டது.', waiting: 'பதியப்பட்டது. உங்கள் கோரிக்கை இன்னும் நிதி ஒப்புதலாளருக்காகக் காத்திருக்கிறது; ஒப்புக்கொண்டதும் “ஒப்பந்தத்தைப் பதி” மீண்டும் அழுத்துங்கள்.',
    rejected: 'பதியப்பட்டது, ஆனால் நிதி ஒப்புதலாளர் இந்த விதிமுறைகளை நிராகரித்தார்: {why}', asked: 'கேட்கப்பட்டது. கணக்காளர் அல்லது உரிமையாளரின் ஒப்புதல்கள் பக்கத்தில் காத்திருக்கிறது.',
    needAll: 'ஒப்பந்தக் குறியீடு, சப்ளையர், இடம், கடை, பணம், இரண்டு தேதிகளையும் நிரப்புங்கள். எதுவும் அனுப்பப்படவில்லை.', needWhy: 'முதலில் காரணத்தை எழுதுங்கள்.', badMoney: 'பணத்தை ரூபாயில் எழுதுங்கள், எ.கா. 5000 அல்லது 5000.50. எதுவும் அனுப்பப்படவில்லை.',
    readOnly: 'காட்சி ஒப்பந்தங்களை நீங்கள் படிக்கலாம். பதிவது காட்சி இடத்தை நிர்வகிப்பவரின் பணி.',
    noRight: 'இந்தக் கணக்கு காட்சி ஒப்பந்தங்களைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை — மீண்டும் முயலவும்.',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const both = (k) => ({ en: WORDS.en[k] ?? k, ta: WORDS.ta[k] ?? WORDS.en[k] ?? k });
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const bothFill = (k, vars) => ({ en: fill(WORDS.en[k], vars), ta: fill(WORDS.ta[k] ?? WORDS.en[k], vars) });
const office = () => window.sreOffice ?? null;
const rupees = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const newKey = () => `display-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'idempotency-key': newKey() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const tell = (el, good, text) => { el.className = `status ${good ? 'good' : 'err'}`; el.textContent = text; };
const refusal = (out) => (out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);
const stateOf = (out) => (out.status === 0 ? 'offline' : out.status === 401 || out.status === 403 ? 'denied' : 'error');
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
/** This person's own request for exactly these terms: approved (its id and who), waiting, rejected, or none. */
async function ownApproval(contractId, details) {
  const out = await call('GET', '/v1/approvals/requests');
  if (!out.ok) return {};
  const mine = (Array.isArray(out.body?.mine) ? out.body.mine : []).filter((r) => r.kind === 'display_contract' && r.subjectRef === contractId && canonical(r.details) === canonical(details));
  const newest = (rows) => rows.slice().sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
  const approved = newest(mine.filter((r) => r.status === 'approved'));
  if (approved !== undefined) return { approvalId: approved.requestId, decidedBy: approved.decidedBy };
  if (mine.some((r) => r.status === 'waiting')) return { waiting: true };
  const last = newest(mine);
  return last?.status === 'rejected' ? { rejected: last.decisionReason ?? '' } : {};
}

let reg = undefined;     // the register's body | undefined
let regOut = null;
let register = null;
let pending = null;      // { contractId, details, valueMinor, summary } — terms recorded without an approval yet

const findingTone = (f) => (f === 'active' ? 'ok' : f === 'expiring_soon' || f === 'unapproved' ? 'pending' : 'degraded');
function findingDetail(c) {
  switch (c.finding) {
    case 'active': return bothFill('dActive', { n: c.daysRemaining });
    case 'expiring_soon': return bothFill('dSoon', { n: c.daysRemaining });
    case 'expired_still_occupying': return bothFill('dEnded', { n: -c.daysRemaining });
    case 'unapproved': return both('dUnapproved');
    case 'no_space_named': return both('dNoSpace');
    case 'funding_not_received': return bothFill('dNotIn', { owed: c.outstandingMinor === null ? t('notWired') : rupees(c.outstandingMinor) });
    default: return { en: c.finding, ta: c.finding };
  }
}
const spaceOf = (c) => [c.description, c.areaId, ...(c.locationIds ?? [])].filter((x) => typeof x === 'string' && x !== '').join(' · ');

async function load() {
  const out = await call('GET', '/v1/merchandising/display-contracts');
  reg = out.ok ? out.body : undefined; regOut = out;
  const st = $('page-status');
  if (!out.ok) tell(st, false, refusal(out));
  else if (!mayManage) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  paint();
}

function paintOffice() {
  const o = office(); if (o === null) return;
  const rows = reg?.contracts ?? null;
  const owedKnown = reg !== undefined && reg.receivedFrom !== 'not_wired';
  o.cards($('cards'), [
    { label: both('kAll'), value: rows === null ? null : rows.length, note: both('nAll'), icon: 'banknote' },
    { label: both('kFlagged'), value: rows === null ? null : reg.flagged, note: both('nFlagged'), tone: rows !== null && reg.flagged > 0 ? 'degraded' : undefined },
    { label: both('kUnapproved'), value: rows === null ? null : rows.filter((c) => !c.approved).length, note: both('nUnapproved'), tone: rows !== null && rows.some((c) => !c.approved) ? 'pending' : undefined },
    { label: both('kEnded'), value: rows === null ? null : rows.filter((c) => c.daysRemaining < 0).length, note: both('nEnded'), tone: rows !== null && rows.some((c) => c.daysRemaining < 0) ? 'degraded' : undefined },
    { label: both('kOwed'), value: rows === null || !owedKnown ? null : rupees(rows.reduce((s, c) => s + Math.max(0, c.outstandingMinor ?? 0), 0)), note: both('nOwed') },
  ]);
  if (register === null || !document.getElementById('display-contracts-table')) {
    register = o.table($('register'), {
      id: 'display-contracts', label: both('listH'), bodyId: 'contract-rows', pageSize: 10, rows: null,
      rowKey: (c) => c.contractId, rowData: (c) => ({ contract: c.contractId, finding: c.finding }),
      empty: { title: both('empty'), detail: both('emptyDetail') },
      columns: [
        { key: 'contractId', label: both('cId'), sort: 'text' },
        { key: 'supplierId', label: both('cSupplier'), sort: 'text', filter: true },
        { key: 'space', label: both('cWhat'), value: spaceOf },
        { key: 'storeId', label: both('cStore'), filter: true, hidden: true },
        { key: 'money', label: both('cMoney'), sort: 'number', align: 'end', value: (c) => c.fundingAmount.minor, render: (c) => rupees(c.fundingAmount.minor) },
        { key: 'endsOn', label: both('cTo'), sort: 'text' },
        { key: 'daysRemaining', label: both('cLeft'), sort: 'number', align: 'end' },
        { key: 'finding', label: both('cFinding'), filter: true, value: (c) => both(c.finding), render: (c) => o.chip(findingTone(c.finding), both(c.finding)) },
        { key: 'approved', label: both('cApproved'), filter: true, value: (c) => both(c.approved ? 'approvedYes' : 'approvedNo') },
      ],
      drawer: {
        title: (c) => `${c.contractId} · ${c.supplierId}`,
        body: (c) => {
          const box = document.createElement('div');
          box.append(o.facts([
            [both('cWhat'), c.description], [both('cStore'), c.storeId], [both('cPlaces'), (c.locationIds ?? []).join(', ')], [both('cArea'), c.areaId ?? ''],
            [both('cMoney'), rupees(c.fundingAmount.minor)], [both('cFrom'), c.startsOn], [both('cTo'), c.endsOn],
            [both('cFinding'), lang === 'ta' ? findingDetail(c).ta : findingDetail(c).en],
            [both('cApprover'), c.approvedBy ?? ''], [both('cReceived'), c.receivedMinor === null ? null : rupees(c.receivedMinor)], [both('cOwed'), c.outstandingMinor === null ? null : rupees(c.outstandingMinor)],
          ]));
          if (mayManage) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-primary'; b.dataset.action = 'correct'; b.textContent = t('correct');
            b.addEventListener('click', () => {
              o.closeDrawer();
              $('c-id').value = c.contractId; $('c-supplier').value = c.supplierId; $('c-what').value = c.description; $('c-store').value = c.storeId;
              $('c-places').value = (c.locationIds ?? []).join(', '); $('c-area').value = c.areaId ?? ''; $('c-money').value = String(c.fundingAmount.minor / 100);
              $('c-from').value = c.startsOn; $('c-to').value = c.endsOn;
              $('form-section').scrollIntoView({ block: 'start' });
            });
            box.append(b);
          }
          return box;
        },
      },
    });
  }
  if (!mayRead) register.setState('denied', { detail: t(named ? 'noRight' : 'nobody') });
  else if (reg !== undefined) register.setRows(reg.contracts);
  else if (regOut !== null) register.setState(stateOf(regOut), { detail: refusal(regOut) });
  else register.setRows(null);
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['list-h', 'listH'], ['list-lead', 'listLead'], ['form-h', 'formH'], ['form-lead', 'formLead'],
    ['l-id', 'id'], ['l-supplier', 'supplier'], ['l-what', 'what'], ['l-store', 'store'], ['l-places', 'places'], ['l-area', 'area'], ['l-money', 'money'], ['l-from', 'from'], ['l-to', 'to'],
    ['record', 'record'], ['l-why', 'why'], ['ask', 'ask']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  $('form-section').hidden = !mayManage;
  $('ask-row').hidden = pending === null;
  paintOffice();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('form-status');
  const v = (id) => $(id).value.trim();
  const contractId = v('c-id');
  if (contractId === '' || v('c-supplier') === '' || v('c-what') === '' || v('c-store') === '' || v('c-money') === '' || v('c-from') === '' || v('c-to') === '') { tell(st, false, t('needAll')); return; }
  if (!/^\d+(\.\d{1,2})?$/.test(v('c-money'))) { tell(st, false, t('badMoney')); return; }
  const minor = Math.round(Number(v('c-money')) * 100);
  const terms = {
    storeId: v('c-store'), supplierId: v('c-supplier'), description: v('c-what'), fundingAmount: { minor, currency: 'INR' }, startsOn: v('c-from'), endsOn: v('c-to'),
    locationIds: v('c-places').split(',').map((s) => s.trim()).filter((s) => s !== ''), ...(v('c-area') === '' ? {} : { areaId: v('c-area') }),
  };
  // The approval engine fingerprints exactly what will be recorded, plus the contract code from the path.
  const details = { ...terms, contractId };
  const found = await ownApproval(contractId, details);
  const out = await call('POST', `/v1/merchandising/display-contracts/${encodeURIComponent(contractId)}`, { ...terms, ...(found.approvalId === undefined ? {} : { approvalId: found.approvalId }) });
  if (!out.ok) { pending = null; paint(); tell(st, false, refusal(out)); return; }
  pending = out.body.approved ? null : { contractId, details, valueMinor: minor, summary: `Display space ${contractId}: ${terms.supplierId} pays ${rupees(minor)} for ${terms.description}, ${terms.startsOn} to ${terms.endsOn}` };
  await load();
  tell($('form-status'), true, out.body.approved ? fill(t('savedApproved'), { by: found.decidedBy ?? '' })
    : found.waiting === true ? t('waiting') : found.rejected !== undefined ? fill(t('rejected'), { why: found.rejected }) : t('savedUnapproved'));
});

$('ask').addEventListener('click', async () => {
  const st = $('form-status');
  const why = $('why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  if (pending === null) return;
  const out = await call('POST', '/v1/approvals/requests', { kind: 'display_contract', subjectRef: pending.contractId, details: pending.details, valueMinor: pending.valueMinor, summary: pending.summary, reason: why });
  if (out.ok) { pending = null; paint(); tell(st, true, t('asked')); } else tell(st, false, refusal(out));
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
document.addEventListener('sre:chrome', () => paintOffice());

if (typeof who?.storeId === 'string') $('c-store').value = who.storeId;
paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
