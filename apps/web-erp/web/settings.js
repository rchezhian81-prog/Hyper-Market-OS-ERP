// Settings and their history (Round 4c · M01-FR-03) — the page over head office's versioned settings. The session
// (apps/web-erp/src/settings-session.ts, in the bundle as window.settings) does every call and every rule; this page lays out
// what it is told. It reads as it opens; going back is an explicit press with a reason. Every word this page adds has a Tamil
// twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.settings ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, write: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
/** Each setting's name in the reader's language, by its key (OB-699); head office's English label is the fallback. */
const SETTING_WORDS = {
  en: {
    tradingDayCutoff: 'Trading-day cut-off (HH:MM)', localeTimeZone: 'Store time zone (IANA name, e.g. Asia/Kolkata)', localeCurrency: 'Base currency (ISO 4217)', localeLanguages: 'Languages offered',
    taxDefaultBps: 'Default GST rate (basis points)', deliveryRadiusKm: 'Delivery serviceability radius (km)', catalogueBulkPublishThreshold: 'Products changed in one publish before it counts as bulk (needs a fresh second-factor sign-in)',
    posAgeRestrictedMinimumAge: 'Minimum age for age-restricted items (years)', posLicenceHoursEnabled: 'Restrict certain items to licensed selling hours', loyaltyPointsPer100Inr: 'Loyalty points earned per ₹100 spent (0 = loyalty off)',
    loyaltyPointValuePaise: 'Value of one loyalty point when spent (paise)', loyaltyTillSpendCapPaise: 'Most a loyalty member may spend at the till per day, points plus store credit (paise; 0 = off)', loyaltyGiftCardOfflineCapPaise: 'Most one till may take from one gift card while head office cannot be reached (paise; 0 = none offline)',
    productionDepartments: 'In-store production departments operated', pickingZoneOrder: 'Order a picker collects the shop\'s zones in', merchandisingShelfCountStaleAfterMinutes: 'How long a shelf count stays worth acting on (minutes)', merchandisingShelfRefillAtBp: 'How empty a facing must be before it is worth refilling (basis points)',
    platformBoxDiskWarnHours: 'Warn when a store computer would run out of disk within (hours of trading)', platformBoxUnsentWarnHours: 'Warn when bills have waited on a store computer, unsent, for more than (hours)', platformBoxClaimSlackNumbers: 'A store computer\'s "I still hold N bills between X and Y" may span at most this many extra numbers (at least)', platformBoxClaimSlackPercent: 'A store computer\'s "I still hold N bills between X and Y" may span this percentage of N in extra numbers, when that is more',
    receiptPaperFormat: 'Receipt paper size', invoiceB2cDynamicQrOn: 'Print the B2C dynamic QR on every bill (only required above ₹500 crore turnover)', invoiceB2cDynamicQrUpiId: 'The shop\'s UPI ID for the B2C dynamic QR (empty = not set)', invoiceB2cDynamicQrBankAccount: 'The bank account number that UPI ID pays into (empty = not set)', invoiceB2cDynamicQrIfsc: 'That bank account\'s IFSC (empty = not set)', deliveryTillFeeProduct: 'The product whose price is the till\'s delivery-fee line (empty = not set)',
  },
  ta: {
    tradingDayCutoff: 'வணிக நாள் முடியும் நேரம் (HH:MM)', localeTimeZone: 'கடையின் நேர மண்டலம் (IANA பெயர், எ.கா. Asia/Kolkata)', localeCurrency: 'அடிப்படை நாணயம் (ISO 4217)', localeLanguages: 'வழங்கப்படும் மொழிகள்',
    taxDefaultBps: 'இயல்பு GST விகிதம் (அடிப்படைப் புள்ளிகள்)', deliveryRadiusKm: 'விநியோகம் செய்யக்கூடிய தூரம் (கி.மீ.)', catalogueBulkPublishThreshold: 'ஒரு வெளியீட்டில் இத்தனை பொருட்கள் மாறினால் அது மொத்த மாற்றம் (புதிய இரண்டாம் படி உள்நுழைவு தேவை)',
    posAgeRestrictedMinimumAge: 'வயது வரம்புள்ள பொருட்களுக்கான குறைந்தபட்ச வயது (ஆண்டுகள்)', posLicenceHoursEnabled: 'சில பொருட்களை உரிம நேரத்தில் மட்டும் விற்க', loyaltyPointsPer100Inr: '₹100 செலவுக்கு கிடைக்கும் விசுவாசப் புள்ளிகள் (0 = விசுவாசத் திட்டம் இல்லை)',
    loyaltyPointValuePaise: 'ஒரு விசுவாசப் புள்ளியின் மதிப்பு செலவழிக்கும்போது (பைசா)', loyaltyTillSpendCapPaise: 'ஒரு உறுப்பினர் ஒரு நாளில் கல்லாவில் செலவழிக்கக்கூடிய அதிகபட்சம், புள்ளிகளும் கடைக் கடனும் சேர்த்து (பைசா; 0 = இல்லை)', loyaltyGiftCardOfflineCapPaise: 'தலைமை அலுவலகத்தை அடைய முடியாதபோது ஒரு கல்லா ஒரு பரிசு அட்டையிலிருந்து எடுக்கக்கூடிய அதிகபட்சம் (பைசா; 0 = ஆஃப்லைனில் இல்லை)',
    productionDepartments: 'கடையில் இயங்கும் உற்பத்திப் பிரிவுகள்', pickingZoneOrder: 'பொருட்களை எடுப்பவர் கடையின் பகுதிகளைச் சேகரிக்கும் வரிசை', merchandisingShelfCountStaleAfterMinutes: 'ஒரு அலமாரி எண்ணிக்கை எவ்வளவு நேரம் செயல்படத் தகுந்ததாக இருக்கும் (நிமிடங்கள்)', merchandisingShelfRefillAtBp: 'ஒரு அலமாரி முகப்பு எவ்வளவு காலியானால் நிரப்பத் தகுந்தது (அடிப்படைப் புள்ளிகள்)',
    platformBoxDiskWarnHours: 'கடைக் கணினியின் வட்டு இத்தனை வணிக மணி நேரத்தில் நிரம்பும் என்றால் எச்சரி', platformBoxUnsentWarnHours: 'பில்கள் கடைக் கணினியில் அனுப்பப்படாமல் இத்தனை மணி நேரத்திற்கு மேல் காத்திருந்தால் எச்சரி', platformBoxClaimSlackNumbers: 'கடைக் கணினியின் "X முதல் Y வரை N பில்கள் என்னிடம் உள்ளன" அறிக்கை அதிகபட்சம் இத்தனை கூடுதல் எண்களைக் கொள்ளலாம் (குறைந்தது)', platformBoxClaimSlackPercent: 'கடைக் கணினியின் "X முதல் Y வரை N பில்கள்" அறிக்கை N-இல் இத்தனை சதவீதம் கூடுதல் எண்களைக் கொள்ளலாம், அது அதிகமாக இருக்கும்போது',
    receiptPaperFormat: 'ரசீது காகித அளவு', invoiceB2cDynamicQrOn: 'ஒவ்வொரு பில்லிலும் B2C டைனமிக் QR அச்சிடு (₹500 கோடி விற்றுமுதலுக்கு மேல் மட்டும் தேவை)', invoiceB2cDynamicQrUpiId: 'B2C டைனமிக் QR-க்கான கடையின் UPI ID (காலி = அமைக்கப்படவில்லை)', invoiceB2cDynamicQrBankAccount: 'அந்த UPI ID பணம் செலுத்தும் வங்கிக் கணக்கு எண் (காலி = அமைக்கப்படவில்லை)', invoiceB2cDynamicQrIfsc: 'அந்த வங்கிக் கணக்கின் IFSC (காலி = அமைக்கப்படவில்லை)', deliveryTillFeeProduct: 'கல்லாவின் விநியோகக் கட்டண வரியாகும் பொருள் (காலி = அமைக்கப்படவில்லை)',
  },
};
const wordKey = (id) => id.replace(/[-._](\w)/g, (_, c) => c.toUpperCase()); // 'tax.default_bps' → taxDefaultBps (the table's bare keys)
const settingName = (s) => SETTING_WORDS[lang]?.[wordKey(s.key)] ?? s.label;

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, cls, onClick) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.className = cls; b.textContent = words; b.addEventListener('click', onClick); return b; }

let settings = null;
const open = new Map(); // key -> versions shown
const asked = new Map(); // `${key}:${version}` -> { requestId, ask }
// What the last "put back" on a version said: kept across the reload that follows it, so the person always sees it.
const said = new Map(); // `${key}:${version}` -> words

function versionNode(s, v) {
  const li = document.createElement('li'); li.dataset.version = String(v.version);
  li.append(text('p', `${t('version')} ${v.version}: ${api.valueWords(v.value)}`),
    text('p', `${t('by')} ${v.author} · ${t('at')} ${session.moment(v.at)} · ${t('why')}: ${v.reason}${v.rolledBackFrom === null ? '' : ` · ${t('restoredFrom')} ${v.rolledBackFrom}`}`, 'meta'));
  if (may.write && v.version !== s.version) {
    const status = text('p', said.get(`${s.key}:${v.version}`) ?? '', 'status'); status.setAttribute('role', 'status');
    const l = document.createElement('label'); const id = `why-${s.key}-${v.version}`; l.htmlFor = id; l.append(text('span', t('reason')));
    const why = document.createElement('input'); why.id = id; why.autocomplete = 'off'; l.append(why);
    const acts = document.createElement('div'); acts.className = 'acts';
    const tag = `${s.key}:${v.version}`;
    const goBack = async (approvalId) => {
      status.textContent = t('reading');
      const out = await session.goBack(s.key, v.version, asked.get(tag)?.ask.reason ?? why.value, s.version, approvalId);
      if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
      if (out.value.kind === 'needs_owner') {
        status.textContent = t('needsOwner');
        acts.append(button(t('askOwner'), 'quiet', async () => {
          const a = await session.askOwner(out.value.ask);
          if (a.result !== 'ok') { status.textContent = api.outcomeWords(lang, a); return; }
          asked.set(tag, { requestId: a.value.requestId, ask: out.value.ask });
          status.textContent = t('asked');
          acts.append(button(t('sendApproved'), 'quiet', async () => {
            const st = await session.approvalOf(a.value.requestId);
            if (st.result !== 'ok') { status.textContent = api.outcomeWords(lang, st); return; }
            if (st.value !== 'approved') { status.textContent = t('waiting'); return; }
            await goBack(a.value.requestId);
          }));
        }));
        return;
      }
      status.textContent = t('restored').replace('{v}', String(out.value.version));
      said.set(tag, status.textContent);
      void load();
    };
    acts.append(l, button(t('goBack'), 'quiet', () => { void goBack(undefined); }));
    li.append(acts, status);
  }
  return li;
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  $('list-h').textContent = t('listH');
  const ul = $('rows'); ul.replaceChildren();
  if (settings === null) return;
  for (const s of settings) {
    const li = document.createElement('li'); li.dataset.key = s.key; if (!s.isDefault) li.className = 'answered';
    const head = document.createElement('div'); head.className = 'head';
    // The value in force is the setting's own code or figure, shown as code; the name follows the toggle.
    const meta = text('span', `${t('inForce')}: `, 'meta'); const val = document.createElement('code'); val.textContent = api.valueWords(s.value); meta.append(val, document.createTextNode(s.isDefault ? ` (${t('onDefault')})` : ` · ${t('version')} ${s.version}`));
    head.append(text('h4', settingName(s)), meta);
    li.append(head);
    const versions = open.get(s.key);
    li.append(button(versions === undefined ? t('history') : t('hide'), 'quiet', async () => {
      if (open.has(s.key)) { open.delete(s.key); paint(); return; }
      const out = await session.history(s.key);
      if (out.result !== 'ok') { $('list-status').textContent = api.outcomeWords(lang, out); return; }
      open.set(s.key, out.value); paint();
    }));
    if (versions !== undefined) {
      if (versions.length === 0) li.append(text('p', t('noHistory'), 'meta'));
      else { const vs = document.createElement('ul'); vs.className = 'versions'; vs.replaceChildren(...versions.map((v) => versionNode(s, v))); li.append(vs); }
    }
    ul.append(li);
  }
}

async function load() {
  $('list-status').textContent = t('reading');
  const out = await session.settings();
  if (out.result !== 'ok') { settings = null; $('list-status').textContent = api.outcomeWords(lang, out); paint(); return; }
  settings = out.value; $('list-status').textContent = '';
  for (const key of [...open.keys()]) { const h = await session.history(key); if (h.result === 'ok') open.set(key, h.value); }
  paint();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('list').hidden = false; if (!may.write) $('page-status').textContent = t('cannotWrite'); void load(); }
