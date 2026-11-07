// Shelf labels, RFID and cameras (W3 · D14-FR-05 · R8-4..R8-7 · OB-217 · OB-316 · OB-407 · P-08 · hard rules #2, #4, #5): a
// THIN CLIENT over head office's floor-device routes for THIS store (the branch the box's signed pack names). It lists the
// registered devices with their switch, when each was last heard and what was refused; registers a device with its own
// PUBLIC key (never a secret); blocks, reinstates or retires one with a reason (a new event — retired is final); shows each
// price push and which labels confirmed it, sending the SAME price again to the ones that did not (never a new price); the
// RFID counts that differ from the book (a reader never changes stock — a person counts); the camera events next to till
// exceptions on a day (metadata only — a place to look, never an accusation); and every refusal, kept. No vendor is
// connected: head office marks every answer as a stand-in, and the page says so. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const who = window.floorDevicesData && typeof window.floorDevicesData === 'object' ? window.floorDevicesData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const store = typeof who?.storeId === 'string' && who.storeId !== '' ? who.storeId : null;
const mayRead = perms.has('platform.health.read');
const mayManage = perms.has('platform.device.manage');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Shelf labels and floor devices',
    lead: 'The electronic shelf labels, RFID readers, temperature sensors and camera event sources on this store\'s floor: whether each is switched on, when it was last heard, what it reported and what was refused. None of them can change a price, the stock or a bill.',
    standin: 'No device maker is connected yet: every device here works through a stand-in, not verified on real hardware.',
    kDevices: 'Devices', kSilent: 'Never heard from', kPushes: 'Prices not confirmed on the shelf', kRfid: 'RFID counts to check', kRefused: 'Refused', refresh: 'Refresh',
    devH: 'Devices', devLead: 'A kind of device is switched on for the store by the owner and the security reviewer on the Feature switches page; until then its reports are refused (and kept below).',
    cLabel: 'Device', cKind: 'Kind', cBound: 'Watches', cSwitch: 'Switch', cHeard: 'Heard', cStatus: 'State', noDevices: 'No floor device registered for this store yet.',
    kind_esl_label: 'Shelf label', kind_rfid_reader: 'RFID reader', kind_iot_sensor: 'Temperature sensor', kind_cctv_source: 'Camera events',
    swOn: 'On', swOff: 'Off', lastHeard: 'last {at}', st_active: 'Working', st_blocked: 'Blocked', st_retired: 'Retired',
    block: 'Block', reinstate: 'Reinstate', retire: 'Retire', stReason: 'Why (for the record)', needReason: 'Write why first, in the box under the list.', stDone: '{id} is now {state}. The history is kept.',
    bound_esl_label: '{productId} at {shelfAddress}', bound_rfid_reader: 'stock at {locationId}', bound_iot_sensor: 'equipment {assetId}', bound_cctv_source: 'camera {cameraId} on {lanes}',
    regH: 'Register a device', regLead: 'One record per device. A device that moves or gets a new key is retired and registered again under a new name. Its reports are believed only when they are signed with the key given here.',
    rId: 'Device name (as on its sticker)', rKind: 'Kind', oEsl: 'Electronic shelf label', oRfid: 'RFID reader', oIot: 'Temperature sensor', oCctv: 'Camera event source', rLabel: 'What people call it', rVendor: 'Maker',
    rProduct: 'Product it shows', rShelf: 'Shelf place', rLocation: 'Stock location it reads', rAsset: 'Equipment it sits in', rCamera: 'Camera', rLanes: 'Tills it looks at (names, commas)',
    rKey: 'The device\'s public key (from the maker\'s set-up tool — never a password)', rSave: 'Register it', needReg: 'Fill in the name, what people call it, the maker, the public key and what it watches.',
    regDone: 'Registered. {switch}', regSwitchOn: 'Its kind is switched on here, so its reports are kept.', regSwitchOff: 'Its kind is switched off here — its reports are refused until the owner and the security reviewer switch it on.',
    eslH: 'Prices sent to the shelf labels', eslLead: 'After a price change head office sends the new price to that product\'s labels. The shelf is known to match the till only once every label has shown the price back. Sending again sends the same price — a price is changed only on the pricing page.',
    pushLine: '{product} at ₹{price} ({because}, {at}): {confirmed} of {all} label(s) confirmed', because_price_change: 'price change', because_retry: 'sent again', confirmedAll: 'Every label shows it.', notConfirmed: 'Not confirmed: {labels}', again: 'Send the same price again', againDone: 'The same price was sent again to {labels}.', noPushes: 'No price has been sent to the labels here.',
    rfidH: 'RFID counts that differ from the book', rfidLead: 'A reader\'s count is only an observation. A difference is for a person to count and correct through the ordinary stock count — the stock is never changed by a reader.',
    rfidLine: '{product} at {location}: counted {counted}, book {book} ({diff}) — {at}', noRfid: 'No RFID count differs from the book.', agreeing: '{n} count(s) agree with the book.',
    camH: 'Camera events beside till exceptions', camLead: 'A camera event (times only — no picture, no face) next to the voids and refunds at the tills that camera looks at. A place to look, never an accusation: a person opens a case.', camDay: 'Day', camRead: 'Read that day',
    camLine: 'Camera {camera}, {kind}, {from} to {to}: {n} till exception(s)', excLine: '{kind} at {lane} by {cashier}, ₹{value}, {at}', noCam: 'No camera event on that day.',
    exH: 'Refused', exLead: 'Every report head office refused — a switch that is off, a signature that did not verify, a field that is not allowed — kept, never deleted.', exBatch: 'Batch from {device}: {detail} ({n} report(s), {at})', exEvent: 'Report {event} from {device}: {detail} ({at})', noEx: 'Nothing refused.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was changed — try again.', readOnly: 'You can read the devices. Registering, blocking or retiring one needs the device-management right.',
    noStore: 'This store computer\'s pack names no store, so there is nothing to show.', noRight: 'This account may not read the floor devices.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.', notKnown: 'Not known',
  },
  ta: {
    lang: 'English', title: 'அலமாரி லேபிள்களும் தளச் சாதனங்களும்',
    lead: 'இந்தக் கடைத் தளத்திலுள்ள மின்னணு அலமாரி லேபிள்கள், RFID வாசிப்பான்கள், வெப்ப உணரிகள், கேமரா நிகழ்வு மூலங்கள்: ஒவ்வொன்றும் இயக்கத்திலா, கடைசியாக எப்போது கேட்டது, என்ன தெரிவித்தது, எது மறுக்கப்பட்டது. இவற்றில் எதுவும் விலை, சரக்கு, பில் எதையும் மாற்ற முடியாது.',
    standin: 'இன்னும் எந்தச் சாதன உற்பத்தியாளரும் இணைக்கப்படவில்லை: இங்குள்ள ஒவ்வொரு சாதனமும் மாற்று வழியில் இயங்குகிறது, உண்மைக் கருவியில் சரிபார்க்கப்படவில்லை.',
    kDevices: 'சாதனங்கள்', kSilent: 'ஒருமுறையும் கேட்கவில்லை', kPushes: 'அலமாரியில் உறுதியாகாத விலைகள்', kRfid: 'சரிபார்க்க வேண்டிய RFID எண்ணிக்கைகள்', kRefused: 'மறுக்கப்பட்டவை', refresh: 'புதுப்பி',
    devH: 'சாதனங்கள்', devLead: 'ஒரு வகைச் சாதனத்தை உரிமையாளரும் பாதுகாப்பு மதிப்பாய்வாளரும் அம்சச் சுவிட்சுகள் பக்கத்தில் இயக்குகிறார்கள்; அதுவரை அதன் அறிக்கைகள் மறுக்கப்படும் (கீழே வைக்கப்படும்).',
    cLabel: 'சாதனம்', cKind: 'வகை', cBound: 'கவனிப்பது', cSwitch: 'சுவிட்ச்', cHeard: 'கேட்டது', cStatus: 'நிலை', noDevices: 'இந்தக் கடைக்கு இன்னும் தளச் சாதனம் பதியப்படவில்லை.',
    kind_esl_label: 'அலமாரி லேபிள்', kind_rfid_reader: 'RFID வாசிப்பான்', kind_iot_sensor: 'வெப்ப உணரி', kind_cctv_source: 'கேமரா நிகழ்வுகள்',
    swOn: 'இயக்கம்', swOff: 'அணைப்பு', lastHeard: 'கடைசியாக {at}', st_active: 'இயங்குகிறது', st_blocked: 'தடுக்கப்பட்டது', st_retired: 'ஓய்வு',
    block: 'தடு', reinstate: 'மீண்டும் இயக்கு', retire: 'ஓய்வு கொடு', stReason: 'ஏன் (பதிவுக்கு)', needReason: 'பட்டியலின் கீழுள்ள பெட்டியில் முதலில் ஏன் என்று எழுதுங்கள்.', stDone: '{id} இப்போது {state}. வரலாறு வைக்கப்பட்டுள்ளது.',
    bound_esl_label: '{productId}, {shelfAddress}', bound_rfid_reader: '{locationId} இருப்பு', bound_iot_sensor: 'கருவி {assetId}', bound_cctv_source: 'கேமரா {cameraId}, {lanes}',
    regH: 'சாதனத்தைப் பதி', regLead: 'ஒரு சாதனத்துக்கு ஒரு பதிவு. இடம் மாறிய அல்லது புதிய சாவி பெற்ற சாதனத்துக்கு ஓய்வு கொடுத்து புதிய பெயரில் மீண்டும் பதியவும். இங்கே கொடுத்த சாவியால் கையொப்பமிட்ட அறிக்கைகள் மட்டுமே நம்பப்படும்.',
    rId: 'சாதனப் பெயர் (அதன் ஸ்டிக்கரில் உள்ளபடி)', rKind: 'வகை', oEsl: 'மின்னணு அலமாரி லேபிள்', oRfid: 'RFID வாசிப்பான்', oIot: 'வெப்ப உணரி', oCctv: 'கேமரா நிகழ்வு மூலம்', rLabel: 'மக்கள் அழைக்கும் பெயர்', rVendor: 'உற்பத்தியாளர்',
    rProduct: 'காட்டும் பொருள்', rShelf: 'அலமாரி இடம்', rLocation: 'வாசிக்கும் இருப்பிடம்', rAsset: 'அமர்ந்துள்ள கருவி', rCamera: 'கேமரா', rLanes: 'பார்க்கும் கல்லாக்கள் (பெயர்கள், காற்புள்ளி)',
    rKey: 'சாதனத்தின் பொதுச் சாவி (உற்பத்தியாளர் அமைப்புக் கருவியிலிருந்து — கடவுச்சொல் அல்ல)', rSave: 'பதி', needReg: 'பெயர், அழைக்கும் பெயர், உற்பத்தியாளர், பொதுச் சாவி, கவனிப்பது ஆகியவற்றை நிரப்பவும்.',
    regDone: 'பதியப்பட்டது. {switch}', regSwitchOn: 'இதன் வகை இங்கே இயக்கத்தில் உள்ளது, எனவே அறிக்கைகள் வைக்கப்படும்.', regSwitchOff: 'இதன் வகை இங்கே அணைப்பில் உள்ளது — உரிமையாளரும் பாதுகாப்பு மதிப்பாய்வாளரும் இயக்கும் வரை அறிக்கைகள் மறுக்கப்படும்.',
    eslH: 'அலமாரி லேபிள்களுக்கு அனுப்பிய விலைகள்', eslLead: 'விலை மாற்றத்துக்குப் பிறகு தலைமை அலுவலகம் புதிய விலையை அந்தப் பொருளின் லேபிள்களுக்கு அனுப்புகிறது. ஒவ்வொரு லேபிளும் விலையைத் திருப்பிக் காட்டிய பின்னரே அலமாரி கல்லாவுடன் பொருந்துவது உறுதி. மீண்டும் அனுப்புவது அதே விலையையே — விலை விலை நிர்ணயப் பக்கத்தில் மட்டுமே மாறும்.',
    pushLine: '{product} ₹{price} ({because}, {at}): {all} லேபிள்களில் {confirmed} உறுதி', because_price_change: 'விலை மாற்றம்', because_retry: 'மீண்டும் அனுப்பியது', confirmedAll: 'ஒவ்வொரு லேபிளும் காட்டுகிறது.', notConfirmed: 'உறுதியாகாதவை: {labels}', again: 'அதே விலையை மீண்டும் அனுப்பு', againDone: 'அதே விலை {labels} க்கு மீண்டும் அனுப்பப்பட்டது.', noPushes: 'இங்கே லேபிள்களுக்கு எந்த விலையும் அனுப்பப்படவில்லை.',
    rfidH: 'கணக்குப் புத்தகத்திலிருந்து வேறுபடும் RFID எண்ணிக்கைகள்', rfidLead: 'வாசிப்பானின் எண்ணிக்கை ஒரு கவனிப்பு மட்டுமே. வேறுபாட்டை ஒருவர் எண்ணி வழக்கமான சரக்கு எண்ணிக்கையில் திருத்த வேண்டும் — வாசிப்பான் சரக்கை ஒருபோதும் மாற்றாது.',
    rfidLine: '{product}, {location}: எண்ணியது {counted}, புத்தகம் {book} ({diff}) — {at}', noRfid: 'எந்த RFID எண்ணிக்கையும் புத்தகத்திலிருந்து வேறுபடவில்லை.', agreeing: '{n} எண்ணிக்கைகள் புத்தகத்துடன் பொருந்துகின்றன.',
    camH: 'கல்லா விதிவிலக்குகளுக்கு அருகிலுள்ள கேமரா நிகழ்வுகள்', camLead: 'அந்தக் கேமரா பார்க்கும் கல்லாக்களில் நடந்த ரத்துகள், திருப்பிச் செலுத்தல்களுக்கு அருகில் ஒரு கேமரா நிகழ்வு (நேரம் மட்டும் — படமோ முகமோ இல்லை). பார்க்க ஓர் இடம், குற்றச்சாட்டு அல்ல: வழக்கை ஒருவர் திறக்கிறார்.', camDay: 'நாள்', camRead: 'அந்த நாளைப் படி',
    camLine: 'கேமரா {camera}, {kind}, {from} முதல் {to}: {n} கல்லா விதிவிலக்குகள்', excLine: '{kind} {lane}, {cashier}, ₹{value}, {at}', noCam: 'அந்த நாளில் கேமரா நிகழ்வு இல்லை.',
    exH: 'மறுக்கப்பட்டவை', exLead: 'தலைமை அலுவலகம் மறுத்த ஒவ்வொரு அறிக்கையும் — அணைத்த சுவிட்ச், சரிபார்க்காத கையொப்பம், அனுமதியில்லாப் புலம் — வைக்கப்படும், ஒருபோதும் நீக்கப்படாது.', exBatch: '{device} இலிருந்து தொகுப்பு: {detail} ({n} அறிக்கைகள், {at})', exEvent: '{device} இலிருந்து அறிக்கை {event}: {detail} ({at})', noEx: 'எதுவும் மறுக்கப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை — மீண்டும் முயலவும்.', readOnly: 'சாதனங்களை நீங்கள் படிக்கலாம். பதிய, தடுக்க, ஓய்வு கொடுக்கச் சாதன நிர்வாக உரிமை தேவை.',
    noStore: 'இந்தக் கடைக் கணினியின் தொகுப்பு எந்தக் கடையையும் பெயரிடவில்லை, எனவே காட்ட எதுவும் இல்லை.', noRight: 'இந்தக் கணக்கு தளச் சாதனங்களைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.', notKnown: 'தெரியவில்லை',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const when = (iso) => (typeof iso === 'string' ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');
const shopDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const rupees = (minor) => (minor / 100).toFixed(2);
const q = (extra = '') => `?branchId=${encodeURIComponent(store ?? '')}${extra}`;

const newKey = () => `fdv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const tell = (el, ok, text) => { el.className = `status ${ok ? 'good' : 'err'}`; el.textContent = text; };
const refusal = (out) => (out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : refusal(out));

let fleet = null; let pushes = null; let rfid = null; let exceptions = null; let cam = null;
const answers = { fleet: null, pushes: null, rfid: null, exceptions: null };

function cell(tr, text, warn = false) { const td = document.createElement('td'); td.textContent = text; if (warn) td.className = 'warn'; tr.append(td); return td; }
function button(text, fn) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.textContent = text; b.addEventListener('click', fn); return b; }
function li(text, extra) { const el = document.createElement('li'); const s = document.createElement('span'); s.textContent = text; el.append(s); if (extra) el.append(extra); return el; }
const boundWords = (b) => fill(t(`bound_${b.kind}`), { ...b, lanes: Array.isArray(b.laneIds) ? b.laneIds.join(', ') : '' });
const labelOf = (id) => fleet?.devices.find((d) => d.deviceId === id)?.label ?? id;

function paintKinds() {
  const kind = $('r-kind').value;
  for (const l of $('reg-form').querySelectorAll('label[data-for]')) l.hidden = l.dataset.for !== kind;
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['standin', 'standin'], ['k-devices', 'kDevices'], ['k-silent', 'kSilent'], ['k-pushes', 'kPushes'], ['k-rfid', 'kRfid'], ['k-refused', 'kRefused'], ['refresh', 'refresh'],
    ['dev-h', 'devH'], ['dev-lead', 'devLead'], ['c-label', 'cLabel'], ['c-kind', 'cKind'], ['c-bound', 'cBound'], ['c-switch', 'cSwitch'], ['c-heard', 'cHeard'], ['c-status', 'cStatus'], ['l-st-reason', 'stReason'],
    ['reg-h', 'regH'], ['reg-lead', 'regLead'], ['l-r-id', 'rId'], ['l-r-kind', 'rKind'], ['o-esl', 'oEsl'], ['o-rfid', 'oRfid'], ['o-iot', 'oIot'], ['o-cctv', 'oCctv'], ['l-r-label', 'rLabel'], ['l-r-vendor', 'rVendor'],
    ['l-r-product', 'rProduct'], ['l-r-shelf', 'rShelf'], ['l-r-location', 'rLocation'], ['l-r-asset', 'rAsset'], ['l-r-camera', 'rCamera'], ['l-r-lanes', 'rLanes'], ['l-r-key', 'rKey'], ['r-save', 'rSave'],
    ['esl-h', 'eslH'], ['esl-lead', 'eslLead'], ['rfid-h', 'rfidH'], ['rfid-lead', 'rfidLead'], ['cam-h', 'camH'], ['cam-lead', 'camLead'], ['l-cam-day', 'camDay'], ['cam-read', 'camRead'], ['ex-h', 'exH'], ['ex-lead', 'exLead']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  $('reg').hidden = !mayManage;
  $('status-form').hidden = !mayManage || (fleet?.devices.length ?? 0) === 0;
  paintKinds();

  const known = (el, ok, v) => { el.textContent = ok ? String(v) : t('notKnown'); el.classList.toggle('unknown', !ok); el.classList.toggle('warn', ok && Number(v) > 0 && el.id !== 'v-devices'); };
  known($('v-devices'), fleet !== null, fleet?.count ?? 0);
  known($('v-silent'), fleet !== null, (fleet?.devices ?? []).filter((d) => d.lastHeardAt === null && d.status !== 'retired').length);
  known($('v-pushes'), pushes !== null, pushes?.notConfirmed ?? 0);
  known($('v-rfid'), rfid !== null, rfid?.variances.length ?? 0);
  known($('v-refused'), exceptions !== null, exceptions?.count ?? 0);

  const rows = $('dev-rows'); rows.replaceChildren();
  if (fleet !== null && fleet.devices.length === 0) { const tr = document.createElement('tr'); cell(tr, t('noDevices')).colSpan = 7; rows.append(tr); }
  for (const d of fleet?.devices ?? []) {
    const tr = document.createElement('tr'); tr.dataset.id = d.deviceId;
    cell(tr, `${d.label} (${d.deviceId})`); cell(tr, t(`kind_${d.kind}`)); cell(tr, boundWords(d.binding));
    cell(tr, d.switchOn ? t('swOn') : `${t('swOff')} — ${d.switchDetail}`, !d.switchOn);
    cell(tr, d.lastHeardAt === null ? d.heard : `${d.heard}, ${fill(t('lastHeard'), { at: when(d.lastHeardAt) })}`, d.lastHeardAt === null);
    cell(tr, t(`st_${d.status}`), d.status !== 'active');
    const act = cell(tr, '');
    if (mayManage && d.status !== 'retired') {
      if (d.status === 'active') act.append(button(t('block'), () => { void setStatus(d.deviceId, 'blocked'); }));
      else act.append(button(t('reinstate'), () => { void setStatus(d.deviceId, 'active'); }));
      act.append(button(t('retire'), () => { void setStatus(d.deviceId, 'retired'); }));
    }
    rows.append(tr);
  }

  $('esl-list').replaceChildren(...(pushes === null ? [li(answers.pushes ?? t('notKnown'))] : pushes.pushes.length === 0 ? [li(t('noPushes'))] : pushes.pushes.map((j) => {
    const p = j.push;
    const text = `${fill(t('pushLine'), { product: p.productId, price: rupees(p.priceMinor), because: t(`because_${p.because}`), at: when(p.at), confirmed: j.confirmed.length, all: j.confirmed.length + j.unconfirmed.length })} — ${j.unconfirmed.length === 0 ? t('confirmedAll') : fill(t('notConfirmed'), { labels: j.unconfirmed.map(labelOf).join(', ') })}`;
    const row = li(text, j.unconfirmed.length > 0 ? button(t('again'), () => { void retry(p.pushId); }) : undefined); row.dataset.push = p.pushId; return row;
  })));
  $('rfid-list').replaceChildren(...(rfid === null ? [li(answers.rfid ?? t('notKnown'))] : [
    ...(rfid.variances.length === 0 ? [li(t('noRfid'))] : rfid.variances.map((r) => li(fill(t('rfidLine'), { product: r.productId, location: r.locationId, counted: r.countedUnits, book: r.bookUnits ?? '—', diff: r.differenceUnits > 0 ? `+${r.differenceUnits}` : r.differenceUnits, at: when(r.countedAt) })))),
    ...rfid.notComparable.map((r) => li(`${r.productId} at ${r.locationId}: ${r.detail}`)),
    ...(rfid.agreeing > 0 ? [li(fill(t('agreeing'), { n: rfid.agreeing }))] : []),
  ]));
  $('cam-list').replaceChildren(...(cam === null ? [] : cam.links.length === 0 ? [li(t('noCam'))] : cam.links.map((l) => {
    const ul = document.createElement('ul'); ul.className = 'rows';
    for (const e of l.exceptions) ul.append(li(fill(t('excLine'), { kind: e.kind, lane: e.laneId, cashier: e.cashierId, value: rupees(e.valueMinor), at: when(e.at) })));
    return li(fill(t('camLine'), { camera: l.cameraId, kind: l.eventKind, from: when(l.from), to: when(l.to), n: l.exceptions.length }), ul);
  })));
  $('ex-list').replaceChildren(...(exceptions === null ? [li(answers.exceptions ?? t('notKnown'))] : exceptions.count === 0 ? [li(t('noEx'))] : [
    ...exceptions.refusedBatches.map((b) => li(fill(t('exBatch'), { device: labelOf(b.deviceId), detail: b.detail, n: b.events, at: when(b.at) }))),
    ...exceptions.refusedEvents.map((e) => li(fill(t('exEvent'), { event: e.eventId, device: labelOf(e.deviceId), detail: e.detail ?? e.code ?? '', at: when(e.receivedAt) }))),
  ]));
}

async function load() {
  const [f, p, r, x] = await Promise.all([call('GET', `/v1/devices/floor${q()}`), call('GET', `/v1/devices/esl/pushes${q()}`), call('GET', `/v1/devices/rfid/variances${q()}`), call('GET', `/v1/devices/floor/exceptions${q()}`)]);
  fleet = f.ok ? f.body : null; pushes = p.ok ? p.body : null; rfid = r.ok ? r.body : null; exceptions = x.ok ? x.body : null;
  answers.pushes = p.ok ? null : refusal(p); answers.rfid = r.ok ? null : refusal(r); answers.exceptions = x.ok ? null : refusal(x);
  const st = $('page-status');
  if (!f.ok) say(st, f, ''); else if (!mayManage) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  if (typeof fleet?.hardware === 'string') $('standin').title = fleet.hardware;
  paint();
}

async function setStatus(deviceId, status) {
  const st = $('dev-status');
  const reason = $('st-reason').value.trim();
  if (reason === '') { tell(st, false, t('needReason')); return; }
  const out = await call('POST', `/v1/devices/floor/${encodeURIComponent(deviceId)}/status`, { status, reason });
  if (!out.ok) { say(st, out, ''); return; }
  $('st-reason').value = '';
  await load();
  tell(st, true, fill(t('stDone'), { id: deviceId, state: t(`st_${status}`) }));
}
async function retry(pushId) {
  const out = await call('POST', `/v1/devices/esl/pushes/${encodeURIComponent(pushId)}/retry`, {});
  if (!out.ok) { say($('esl-status'), out, ''); return; }
  await load();
  tell($('esl-status'), true, fill(t('againDone'), { labels: (out.body?.sentTo ?? []).map(labelOf).join(', ') }));
}

$('r-kind').addEventListener('change', paintKinds);
$('r-save').addEventListener('click', async () => {
  const st = $('reg-status');
  const id = $('r-id').value.trim(); const kind = $('r-kind').value;
  const base = { kind, branchId: store, label: $('r-label').value.trim(), vendor: $('r-vendor').value.trim(), publicKey: $('r-key').value.trim() + '\n' };
  const bind = kind === 'esl_label' ? { productId: $('r-product').value.trim(), shelfAddress: $('r-shelf').value.trim() }
    : kind === 'rfid_reader' ? { locationId: $('r-location').value.trim() || store }
      : kind === 'iot_sensor' ? { assetId: $('r-asset').value.trim() }
        : { cameraId: $('r-camera').value.trim(), laneIds: $('r-lanes').value.split(',').map((x) => x.trim()).filter((x) => x !== '') };
  if (id === '' || base.label === '' || base.vendor === '' || base.publicKey.trim() === '' || Object.values(bind).some((v) => v === '' || (Array.isArray(v) && v.length === 0))) { tell(st, false, t('needReg')); return; }
  // While this one saves, the last "Registered" is taken down and the button held, so the next device's details are never
  // typed into a form this save is about to clear.
  st.textContent = ''; $('r-save').disabled = true;
  try {
    const out = await call('POST', `/v1/devices/floor/${encodeURIComponent(id)}`, { ...base, ...bind });
    if (!out.ok) { say(st, out, ''); return; }
    for (const f of ['r-id', 'r-label', 'r-key', 'r-product', 'r-shelf', 'r-asset', 'r-camera', 'r-lanes']) $(f).value = '';
    await load();
    tell(st, true, fill(t('regDone'), { switch: out.body?.switchOn === true ? t('regSwitchOn') : t('regSwitchOff') }));
  } finally { $('r-save').disabled = false; }
});
$('cam-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dayValue = $('cam-day').value || shopDay();
  const out = await call('GET', `/v1/devices/cctv/links${q(`&day=${encodeURIComponent(dayValue)}`)}`);
  if (!out.ok) { cam = null; say($('cam-status'), out, ''); paint(); return; }
  $('cam-status').textContent = '';
  cam = out.body; paint();
});
$('refresh').addEventListener('click', () => { void load(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

$('cam-day').value = shopDay();
paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
else if (named && store === null) tell($('page-status'), false, t('noStore'));
if (named && mayRead && store !== null) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
