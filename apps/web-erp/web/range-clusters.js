// Store groups and seasons (Wave 2 · D02-FR-02 · OB-318 · M04-FR-01): a THIN CLIENT over head office's store groups (the
// price-zone register), the range decided for a whole group, and season plans. The registers and the summary are the
// shared office parts (window.sreOffice). A drop never carries stock: head office reads each store's own and sends what is
// still on the shelf to clearance — the page shows what happened in each store, in words. Tamil for every word; nothing
// is written on open.

const $ = (id) => document.getElementById(id);
const who = window.rangeClustersData && typeof window.rangeClustersData === 'object' ? window.rangeClustersData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = named && perms.has('merchandising.range.read');
const mayManage = named && perms.has('merchandising.range.manage');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const DROP_REASONS = ['poor_sales', 'poor_margin', 'supplier_discontinued', 'quality_issue', 'range_rationalisation', 'seasonal_end', 'replaced_by_alternative'];

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Store groups and seasons',
    lead: 'Decide the range for a group of stores at once, and plan seasonal ranges with a first and last day. A store group is its price zone (set on Price lists). Taking a product out never deletes it: what is still on a shelf goes to clearance until it is sold.',
    kGroups: 'Store groups', kStores: 'Stores in a group', kSeasons: 'Season plans', kIn: 'In season today', kDue: 'Due to end',
    nGroups: 'price zones with stores', nStores: 'across all groups', nSeasons: 'made at head office', nIn: 'listed in their stores now', nDue: 'last day passed; ends into clearance on the next pass',
    groupsH: 'Store groups', groupsLead: 'Each group and the stores in it today. Put a store in a group on the Price lists page.',
    cGroup: 'Store group', cStores: 'Stores', cCount: 'How many',
    groupsEmpty: 'No store groups yet', groupsEmptyDetail: 'No store is in a price zone, so there is no group to decide a range for. Put stores in zones on the Price lists page.',
    rangeH: 'Change the range for a whole group', rzone: 'Store group', rproduct: 'Product code', raction: 'What to do', list: 'Carry it', drop: 'Take it out of the range', rfrom: 'From', rreason: 'Why it is taken out', rnote: 'Note (optional)',
    rangeNote: 'No size has been set yet for a range change big enough to need the owner\'s approval (OB-644, owner, 1 Nov 2026: deferred until he names one). Until then a group change is not sent to the owner; each one is kept in the audit trail with who made it and why.',
    rangeGo: 'Record this for every store in the group', listed: 'Carried in {n} store(s) from {from}: {stores}.', dropped: 'Taken out of the range from {from}:',
    routed_to_clearance: '{store}: {qty} still on hand — goes to clearance until sold', delisted: '{store}: none on hand — taken out of the range',
    poor_sales: 'Sells poorly', poor_margin: 'Earns too little', supplier_discontinued: 'Supplier stopped making it', quality_issue: 'Quality problem', range_rationalisation: 'Too many similar products', seasonal_end: 'Season over', replaced_by_alternative: 'Replaced by another product',
    needRange: 'Choose the group, write the product code and the date. Nothing was sent.', noGroups: 'No store groups yet',
    seasonsH: 'Season plans', seasonsLead: 'A season lists its products in its stores from the first day; after the last day head office ends it, and what is still on a shelf goes to clearance.',
    cSeason: 'Season', cFor: 'For', cProducts: 'Products', cFrom: 'First day', cTo: 'Last day', cStanding: 'Where it stands', cReason: 'What it is', cBy: 'Made by',
    upcoming: 'Starts later', in_season: 'In season', due_to_end: 'Due to end', ended: 'Ended',
    seasonsEmpty: 'No season plans yet', seasonsEmptyDetail: 'Head office holds no season plan. Make one below for a festival or a season.',
    seasonH: 'Make a season plan', sid: 'Season name (letters, numbers, dashes)', szone: 'For a store group', sstore: '…or for one store', sproducts: 'Products (codes, separated by commas)', sfrom: 'First day of the season', sto: 'Last day of the season', sreason: 'What the season is',
    seasonGo: 'Make this season plan', seasonSaved: 'Season {id} made for {n} store(s), {from} to {to}.', needSeason: 'Write the season name, choose a group or write one store (not both), the products, both days and what the season is. Nothing was sent.', oneStore: '(one store)', groupNone: '— none —',
    readOnly: 'You can read the groups and seasons. Deciding the range is for the person who manages it.',
    noRight: 'This account may not read the range.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was changed — try again.',
  },
  ta: {
    lang: 'English', title: 'கடைக் குழுக்களும் பருவங்களும்',
    lead: 'ஒரு கடைக் குழுவுக்கு ஒரே நேரத்தில் வரிசையை முடிவு செய்யுங்கள், முதல் மற்றும் கடைசி நாளுடன் பருவ வரிசைகளைத் திட்டமிடுங்கள். கடைக் குழு என்பது அதன் விலை மண்டலம் (விலைப் பட்டியல்கள் பக்கத்தில் அமைக்கப்படும்). ஒரு பொருளை நீக்குவது அதை அழிக்காது: அலமாரியில் இன்னும் இருப்பது விற்கும் வரை தள்ளுபடிக்குச் செல்லும்.',
    kGroups: 'கடைக் குழுக்கள்', kStores: 'குழுவில் உள்ள கடைகள்', kSeasons: 'பருவத் திட்டங்கள்', kIn: 'இன்று பருவத்தில்', kDue: 'முடிய வேண்டியவை',
    nGroups: 'கடைகள் உள்ள விலை மண்டலங்கள்', nStores: 'அனைத்துக் குழுக்களிலும்', nSeasons: 'தலைமை அலுவலகத்தில் செய்யப்பட்டவை', nIn: 'இப்போது கடைகளில் பட்டியலில்', nDue: 'கடைசி நாள் கடந்தது; அடுத்த சுற்றில் தள்ளுபடியாக முடியும்',
    groupsH: 'கடைக் குழுக்கள்', groupsLead: 'ஒவ்வொரு குழுவும் இன்று அதிலுள்ள கடைகளும். விலைப் பட்டியல்கள் பக்கத்தில் ஒரு கடையை குழுவில் சேருங்கள்.',
    cGroup: 'கடைக் குழு', cStores: 'கடைகள்', cCount: 'எத்தனை',
    groupsEmpty: 'இன்னும் கடைக் குழுக்கள் இல்லை', groupsEmptyDetail: 'எந்தக் கடையும் விலை மண்டலத்தில் இல்லை, எனவே வரிசையை முடிவு செய்யக் குழு இல்லை. விலைப் பட்டியல்கள் பக்கத்தில் கடைகளை மண்டலங்களில் சேருங்கள்.',
    rangeH: 'முழுக் குழுவுக்கும் வரிசையை மாற்று', rzone: 'கடைக் குழு', rproduct: 'பொருள் குறியீடு', raction: 'என்ன செய்வது', list: 'இதை வைத்திரு', drop: 'வரிசையிலிருந்து நீக்கு', rfrom: 'முதல்', rreason: 'ஏன் நீக்கப்படுகிறது', rnote: 'குறிப்பு (விருப்பம்)',
    rangeNote: 'உரிமையாளரின் ஒப்புதல் தேவைப்படும் அளவுக்குப் பெரிய வரிசை மாற்றத்துக்கு இன்னும் அளவு அமைக்கப்படவில்லை (OB-644, உரிமையாளர், 1 நவ. 2026: அவர் ஒன்றைக் குறிப்பிடும் வரை ஒத்திவைக்கப்பட்டது). அதுவரை குழு மாற்றம் உரிமையாளருக்கு அனுப்பப்படாது; ஒவ்வொன்றும் யார், ஏன் என்பதுடன் தணிக்கைப் பதிவில் வைக்கப்படும்.',
    rangeGo: 'குழுவின் ஒவ்வொரு கடைக்கும் இதைப் பதி', listed: '{from} முதல் {n} கடை(களில்) வைக்கப்படும்: {stores}.', dropped: '{from} முதல் வரிசையிலிருந்து நீக்கப்பட்டது:',
    routed_to_clearance: '{store}: இன்னும் {qty} கையிருப்பில் — விற்கும் வரை தள்ளுபடிக்கு', delisted: '{store}: கையிருப்பு இல்லை — வரிசையிலிருந்து நீக்கப்பட்டது',
    poor_sales: 'குறைவாக விற்கிறது', poor_margin: 'மிகக் குறைவாக ஈட்டுகிறது', supplier_discontinued: 'சப்ளையர் தயாரிப்பை நிறுத்தினார்', quality_issue: 'தரப் பிரச்சினை', range_rationalisation: 'ஒத்த பொருட்கள் அதிகம்', seasonal_end: 'பருவம் முடிந்தது', replaced_by_alternative: 'வேறு பொருளால் மாற்றப்பட்டது',
    needRange: 'குழுவைத் தேர்ந்தெடுத்து, பொருள் குறியீட்டையும் தேதியையும் எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.', noGroups: 'இன்னும் கடைக் குழுக்கள் இல்லை',
    seasonsH: 'பருவத் திட்டங்கள்', seasonsLead: 'ஒரு பருவம் முதல் நாளிலிருந்து அதன் பொருட்களை அதன் கடைகளில் பட்டியலிடும்; கடைசி நாளுக்குப் பிறகு தலைமை அலுவலகம் அதை முடிக்கும், அலமாரியில் இன்னும் இருப்பது தள்ளுபடிக்குச் செல்லும்.',
    cSeason: 'பருவம்', cFor: 'யாருக்கு', cProducts: 'பொருட்கள்', cFrom: 'முதல் நாள்', cTo: 'கடைசி நாள்', cStanding: 'நிலை', cReason: 'அது என்ன', cBy: 'செய்தவர்',
    upcoming: 'பின்னர் தொடங்கும்', in_season: 'பருவத்தில்', due_to_end: 'முடிய வேண்டியது', ended: 'முடிந்தது',
    seasonsEmpty: 'இன்னும் பருவத் திட்டங்கள் இல்லை', seasonsEmptyDetail: 'தலைமை அலுவலகத்திடம் பருவத் திட்டம் இல்லை. ஒரு பண்டிகைக்கு அல்லது பருவத்துக்குக் கீழே ஒன்றைச் செய்யுங்கள்.',
    seasonH: 'பருவத் திட்டம் செய்', sid: 'பருவப் பெயர் (எழுத்துகள், எண்கள், கோடுகள்)', szone: 'ஒரு கடைக் குழுவுக்கு', sstore: '…அல்லது ஒரு கடைக்கு', sproducts: 'பொருட்கள் (குறியீடுகள், காற்புள்ளியால் பிரித்து)', sfrom: 'பருவத்தின் முதல் நாள்', sto: 'பருவத்தின் கடைசி நாள்', sreason: 'பருவம் எது',
    seasonGo: 'இந்தப் பருவத் திட்டத்தைச் செய்', seasonSaved: 'பருவம் {id}, {n} கடை(களுக்கு), {from} முதல் {to} வரை செய்யப்பட்டது.', needSeason: 'பருவப் பெயர், ஒரு குழு அல்லது ஒரு கடை (இரண்டும் அல்ல), பொருட்கள், இரண்டு நாட்கள், பருவம் எது என்பதை எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.', oneStore: '(ஒரு கடை)', groupNone: '— இல்லை —',
    readOnly: 'குழுக்களையும் பருவங்களையும் நீங்கள் படிக்கலாம். வரிசையை முடிவு செய்வது அதை நிர்வகிப்பவரின் பணி.',
    noRight: 'இந்தக் கணக்கு வரிசையைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை — மீண்டும் முயலவும்.',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const both = (k) => ({ en: WORDS.en[k] ?? k, ta: WORDS.ta[k] ?? WORDS.en[k] ?? k });
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const office = () => window.sreOffice ?? null;
const shopToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const newKey = () => `range-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

let groups = undefined; let groupsOut = null;
let seasons = undefined; let seasonsOut = null;
const regs = { groups: null, seasons: null };

async function load() {
  const [g, s] = await Promise.all([call('GET', '/v1/merchandising/clusters'), call('GET', '/v1/merchandising/season-plans')]);
  groups = g.ok ? g.body.clusters : undefined; groupsOut = g;
  seasons = s.ok ? s.body.plans : undefined; seasonsOut = s;
  const st = $('page-status');
  const failed = [g, s].find((x) => !x.ok);
  if (failed !== undefined) tell(st, false, refusal(failed));
  else if (!mayManage) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  paint();
}

const standingTone = (s) => (s === 'in_season' ? 'ok' : s === 'upcoming' ? 'pending' : s === 'due_to_end' ? 'degraded' : 'idle');
function paintOffice() {
  const o = office(); if (o === null) return;
  o.cards($('cards'), [
    { label: both('kGroups'), value: groups === undefined ? null : groups.length, note: both('nGroups'), icon: 'calendar-days' },
    { label: both('kStores'), value: groups === undefined ? null : new Set(groups.flatMap((c) => c.stores)).size, note: both('nStores') },
    { label: both('kSeasons'), value: seasons === undefined ? null : seasons.length, note: both('nSeasons') },
    { label: both('kIn'), value: seasons === undefined ? null : seasons.filter((p) => p.standing === 'in_season').length, note: both('nIn') },
    { label: both('kDue'), value: seasons === undefined ? null : seasons.filter((p) => p.standing === 'due_to_end').length, note: both('nDue'), tone: seasons !== undefined && seasons.some((p) => p.standing === 'due_to_end') ? 'degraded' : undefined },
  ]);
  if (regs.groups === null || !document.getElementById('store-groups-table')) {
    regs.groups = o.table($('groups-register'), {
      id: 'store-groups', label: both('groupsH'), bodyId: 'group-rows', pageSize: 10, rows: null,
      rowKey: (c) => c.zoneId, rowData: (c) => ({ group: c.zoneId }),
      empty: { title: both('groupsEmpty'), detail: both('groupsEmptyDetail') },
      columns: [
        { key: 'zoneId', label: both('cGroup'), sort: 'text' },
        { key: 'count', label: both('cCount'), sort: 'number', align: 'end', value: (c) => c.stores.length },
        { key: 'stores', label: both('cStores'), value: (c) => c.stores.join(', ') },
      ],
      drawer: { title: (c) => c.zoneId, body: (c) => o.facts([[both('cGroup'), c.zoneId], [both('cStores'), c.stores.join(', ')]]) },
    });
  }
  if (regs.seasons === null || !document.getElementById('season-plans-table')) {
    regs.seasons = o.table($('seasons-register'), {
      id: 'season-plans', label: both('seasonsH'), bodyId: 'season-rows', pageSize: 10, rows: null,
      rowKey: (p) => p.planId, rowData: (p) => ({ season: p.planId, standing: p.standing }),
      empty: { title: both('seasonsEmpty'), detail: both('seasonsEmptyDetail') },
      columns: [
        { key: 'planId', label: both('cSeason'), sort: 'text' },
        { key: 'for', label: both('cFor'), filter: true, value: (p) => (p.zoneId ?? `${p.storeId} ${t('oneStore')}`) },
        { key: 'products', label: both('cProducts'), value: (p) => p.productIds.join(', ') },
        { key: 'listFrom', label: both('cFrom'), sort: 'text' },
        { key: 'listTo', label: both('cTo'), sort: 'text' },
        { key: 'standing', label: both('cStanding'), filter: true, value: (p) => both(p.standing), render: (p) => o.chip(standingTone(p.standing), both(p.standing)) },
      ],
      drawer: {
        title: (p) => p.planId,
        body: (p) => o.facts([[both('cReason'), p.reason], [both('cFor'), p.zoneId ?? p.storeId], [both('cStores'), p.storeIds.join(', ')], [both('cProducts'), p.productIds.join(', ')], [both('cFrom'), p.listFrom], [both('cTo'), p.listTo], [both('cBy'), p.setBy], [both('cStanding'), t(p.standing)]]),
      },
    });
  }
  const set = (reg, rows, out) => {
    if (!mayRead) reg.setState('denied', { detail: t(named ? 'noRight' : 'nobody') });
    else if (rows !== undefined) reg.setRows(rows);
    else if (out !== null) reg.setState(stateOf(out), { detail: refusal(out) });
    else reg.setRows(null);
  };
  set(regs.groups, groups, groupsOut);
  set(regs.seasons, seasons, seasonsOut);
}

function options(sel, values, words, allowNone) {
  const keep = sel.value;
  const opts = values.map((v) => Object.assign(document.createElement('option'), { value: v, textContent: words(v) }));
  if (allowNone) opts.unshift(Object.assign(document.createElement('option'), { value: '', textContent: t('groupNone') }));
  if (opts.length === 0) opts.push(Object.assign(document.createElement('option'), { value: '', textContent: t('noGroups') }));
  sel.replaceChildren(...opts);
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['groups-h', 'groupsH'], ['groups-lead', 'groupsLead'], ['range-h', 'rangeH'], ['l-rzone', 'rzone'], ['l-rproduct', 'rproduct'], ['l-raction', 'raction'],
    ['l-rfrom', 'rfrom'], ['l-rreason', 'rreason'], ['l-rnote', 'rnote'], ['range-go', 'rangeGo'], ['range-note', 'rangeNote'], ['seasons-h', 'seasonsH'], ['seasons-lead', 'seasonsLead'], ['season-h', 'seasonH'], ['l-sid', 'sid'], ['l-szone', 'szone'], ['l-sstore', 'sstore'],
    ['l-sproducts', 'sproducts'], ['l-sfrom', 'sfrom'], ['l-sto', 'sto'], ['l-sreason', 'sreason'], ['season-go', 'seasonGo']]) $(id).textContent = t(k);
  for (const a of ['list', 'drop']) $('r-action').querySelector(`option[value="${a}"]`).textContent = t(a);
  const zones = (groups ?? []).map((c) => c.zoneId);
  options($('r-zone'), zones, (z) => z, false);
  options($('s-zone'), zones, (z) => z, true);
  options($('r-reason'), DROP_REASONS, (r) => t(r), false);
  $('r-reason').disabled = $('r-action').value !== 'drop';
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  $('range-form').hidden = !mayManage; $('season-form').hidden = !mayManage;
  paintOffice();
}

$('r-action').addEventListener('change', () => { $('r-reason').disabled = $('r-action').value !== 'drop'; });
$('range-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('range-status');
  const zone = $('r-zone').value; const product = $('r-product').value.trim(); const from = $('r-from').value; const action = $('r-action').value;
  if (zone === '' || product === '' || from === '') { tell(st, false, t('needRange')); return; }
  const note = $('r-note').value.trim();
  const body = action === 'list' ? { effectiveFrom: from } : { reason: $('r-reason').value, effectiveFrom: from, ...(note === '' ? {} : { reasonNote: note }) };
  const out = await call('POST', `/v1/merchandising/clusters/${encodeURIComponent(zone)}/${encodeURIComponent(product)}/${action}`, body);
  const ul = $('range-result');
  if (!out.ok) { ul.replaceChildren(); tell(st, false, refusal(out)); return; }
  if (action === 'list') { ul.replaceChildren(); tell(st, true, fill(t('listed'), { n: out.body.stores.length, from, stores: out.body.stores.join(', ') })); }
  else {
    tell(st, true, fill(t('dropped'), { from }));
    ul.replaceChildren(...out.body.decisions.map((d) => { const li = document.createElement('li'); li.dataset.store = d.storeId; li.textContent = fill(t(d.outcome), { store: d.storeId, qty: d.onHandMinor }); return li; }));
  }
  await load();
});

$('season-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('season-status');
  const id = $('s-id').value.trim(); const zone = $('s-zone').value; const storeId = $('s-store').value.trim();
  const productIds = $('s-products').value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const from = $('s-from').value; const to = $('s-to').value; const reason = $('s-reason').value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id) || (zone === '') === (storeId === '') || productIds.length === 0 || from === '' || to === '' || reason === '') { tell(st, false, t('needSeason')); return; }
  const out = await call('POST', `/v1/merchandising/season-plans/${encodeURIComponent(id)}`, { ...(zone !== '' ? { zoneId: zone } : { storeId }), productIds, listFrom: from, listTo: to, reason });
  if (!out.ok) { tell(st, false, refusal(out)); return; }
  await load();
  tell($('season-status'), true, fill(t('seasonSaved'), { id, n: out.body.plan.storeIds.length, from, to }));
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
document.addEventListener('sre:chrome', () => paintOffice());

$('r-from').value = shopToday();
paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
