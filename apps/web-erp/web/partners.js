// Partners and sandboxes (W3 · M36-FR-04 · P-06 · OB-385 · hard rules #4 and #7): a THIN CLIENT over head office's partner
// register. A credential is a scoped, dated grant — the shops or sandboxes it may reach, sandbox or the real shop, named
// scopes, an expiry — registered and revoked as new versions (the history stays). A sandbox holds GENERATED data only: the
// page seeds it with generated records, and head office refuses a seed with anything from production, whole. A connector's
// certification names the API versions it was tested against; "today" is judged against head office's own published
// manifest (GET /v1/platform/api-manifest), never a list typed here. No secret is made, typed, shown or stored on this page
// (#4): a partner's access token is issued out of band. Every word has a Tamil twin; nothing is written on open.

const $ = (id) => document.getElementById(id);
const who = window.partnersData && typeof window.partnersData === 'object' ? window.partnersData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('platform.partner.read');
const mayEdit = perms.has('platform.partner.manage');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Partners and sandboxes',
    lead: 'The people who build connections to the shop\'s system: what each partner\'s credential may reach and do, the practice spaces (sandboxes) they build in — which hold made-up data only — and which of their connectors are certified. No password or secret is ever shown or kept on this page.',
    kCreds: 'Credentials in force', kSandboxes: 'Sandboxes', kCerts: 'Certified connectors', docs: 'Developer guide (every API call, generated from the published contract)',
    credH: 'Credentials', credLead: 'A credential reaches only the shops or sandboxes named on it, does only the scopes named, and stops on its last day. A sandbox credential never reaches the real shop. Revoking keeps the record, with the date.',
    cCid: 'Credential', cPartner: 'Partner', cEnv: 'Where', cReach: 'Reaches', cScopes: 'May do', cExpires: 'Until', cState: 'State',
    envSandbox: 'Sandbox only', envProduction: 'The real shop', stActive: 'In force', stRevoked: 'Revoked on {d}', stExpired: 'Expired', stNotYet: 'Not yet', nobodyReach: 'none',
    revoke: 'Revoke', revoked: 'Revoked from {d}. The record stays.', crId: 'Credential name', crPartner: 'Partner', crEnv: 'Where it works', crReach: 'Shops or sandboxes it may reach (names, commas)',
    crScopes: 'What it may do (scopes, commas)', crExpires: 'Until (date)', crSave: 'Register the credential', crSaved: 'Registered. Its access token is issued to the partner out of band — it is not made or shown here.',
    needCred: 'Fill in the name, the partner, at least one scope and the last day.', noCreds: 'No credential registered yet.',
    sbH: 'Sandboxes', sbLead: 'A practice space for a partner, with made-up data only — never a copy of the shop\'s real records. It stops on its last day.',
    cSid: 'Sandbox', cSpartner: 'Partner', cScreated: 'Made', cSexpires: 'Until', cSdata: 'Data', synthetic: 'Made-up data only', sbExpired: 'Expired', noSandboxes: 'No sandbox yet.',
    sbId: 'Sandbox name', sbPartner: 'Partner', sbExpires: 'Until (date)', sbCount: 'Generated records to seed', sbSave: 'Make the sandbox', seed: 'Seed with generated records',
    sbSaved: 'Sandbox made. Seed it with generated records when the partner is ready.', seeded: 'Head office checked {n} generated record(s) for this sandbox: {detail}', notSeeded: 'Not seeded: {detail}', needSb: 'Fill in the name, the partner and the last day.',
    ceH: 'Connector certifications', ceLead: 'A connector is certified against the API versions it was tested with. When head office\'s API moves on, it shows here as behind; a connector never certified may not run in the real shop.',
    cEcpartner: 'Partner', cEcconn: 'Connector', cEcon: 'Certified on', cEcby: 'By', cEcvs: 'Tested against', cEcnow: 'Today', check: 'Check against today', noCerts: 'No connector certified yet.',
    ceId: 'Certification name', cePartner: 'Partner', ceConn: 'Connector', ceOn: 'Certified on (date)', ceSave: 'Record the certification', ceApis: 'Tested against these APIs (current version)',
    ceSaved: 'Certification recorded, signed off by you.', needCe: 'Fill in the name, the partner, the connector, the date, and tick at least one API.', verdict: '{detail}{prod}', mayProd: ' — may run in the real shop.', notProd: ' — may NOT run in the real shop.',
    acH: 'May this credential make this call?', acLead: 'Head office decides from the stored credential: a sandbox credential is refused in the real shop, and so is a shop it was not given, a revoked or expired credential, or a call to no version.',
    acCred: 'Credential', acEnv: 'Where', acTenant: 'Shop or sandbox', acScope: 'Scope it needs', acApi: 'API', acCheck: 'Check', allowed: 'Allowed: {detail}', refusedCall: 'Refused: {detail}', needAc: 'Choose the credential and fill in the shop or sandbox and the scope.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was changed — try again.', readOnly: 'You can read the partner register. Registering, revoking and sandboxes need the partner-management right.',
    noRight: 'This account may not read the partner register.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.', notKnown: 'Not known',
  },
  ta: {
    lang: 'English', title: 'கூட்டாளர்களும் சோதனைத் தளங்களும்',
    lead: 'கடையின் அமைப்புடன் இணைப்புகளை உருவாக்குபவர்கள்: ஒவ்வொரு கூட்டாளரின் சான்று எதை அடையலாம், எதைச் செய்யலாம், அவர்கள் உருவாக்கும் பயிற்சித் தளங்கள் (கற்பனைத் தரவு மட்டும்), சான்றளிக்கப்பட்ட இணைப்பிகள். இந்தப் பக்கத்தில் கடவுச்சொல்லோ ரகசியமோ ஒருபோதும் காட்டப்படுவதோ வைக்கப்படுவதோ இல்லை.',
    kCreds: 'நடப்பிலுள்ள சான்றுகள்', kSandboxes: 'சோதனைத் தளங்கள்', kCerts: 'சான்றளிக்கப்பட்ட இணைப்பிகள்', docs: 'உருவாக்குநர் வழிகாட்டி (வெளியிட்ட ஒப்பந்தத்திலிருந்து ஒவ்வொரு API அழைப்பும்)',
    credH: 'சான்றுகள்', credLead: 'ஒரு சான்று அதில் பெயரிட்ட கடைகள் அல்லது சோதனைத் தளங்களை மட்டுமே அடையும், பெயரிட்ட வரம்புகளை மட்டுமே செய்யும், கடைசி நாளில் நிற்கும். சோதனைச் சான்று உண்மையான கடையை ஒருபோதும் அடையாது. திரும்பப் பெற்றாலும் பதிவு தேதியுடன் இருக்கும்.',
    cCid: 'சான்று', cPartner: 'கூட்டாளர்', cEnv: 'எங்கே', cReach: 'அடைவது', cScopes: 'செய்யக்கூடியது', cExpires: 'வரை', cState: 'நிலை',
    envSandbox: 'சோதனைத் தளம் மட்டும்', envProduction: 'உண்மையான கடை', stActive: 'நடப்பில்', stRevoked: '{d} அன்று திரும்பப் பெறப்பட்டது', stExpired: 'காலாவதி', stNotYet: 'இன்னும் இல்லை', nobodyReach: 'எதுவும் இல்லை',
    revoke: 'திரும்பப் பெறு', revoked: '{d} முதல் திரும்பப் பெறப்பட்டது. பதிவு இருக்கும்.', crId: 'சான்றுப் பெயர்', crPartner: 'கூட்டாளர்', crEnv: 'எங்கே வேலை செய்யும்', crReach: 'அடையக்கூடிய கடைகள் அல்லது சோதனைத் தளங்கள் (பெயர்கள், காற்புள்ளி)',
    crScopes: 'செய்யக்கூடியது (வரம்புகள், காற்புள்ளி)', crExpires: 'வரை (தேதி)', crSave: 'சான்றைப் பதி', crSaved: 'பதியப்பட்டது. அதன் அணுகல் குறியீடு கூட்டாளருக்குத் தனியாக வழங்கப்படும் — இங்கே உருவாக்கப்படுவதோ காட்டப்படுவதோ இல்லை.',
    needCred: 'பெயர், கூட்டாளர், குறைந்தது ஒரு வரம்பு, கடைசி நாள் ஆகியவற்றை நிரப்பவும்.', noCreds: 'இன்னும் சான்று பதியப்படவில்லை.',
    sbH: 'சோதனைத் தளங்கள்', sbLead: 'கூட்டாளருக்கான பயிற்சித் தளம், கற்பனைத் தரவு மட்டும் — கடையின் உண்மைப் பதிவுகளின் நகல் ஒருபோதும் அல்ல. கடைசி நாளில் நிற்கும்.',
    cSid: 'சோதனைத் தளம்', cSpartner: 'கூட்டாளர்', cScreated: 'உருவானது', cSexpires: 'வரை', cSdata: 'தரவு', synthetic: 'கற்பனைத் தரவு மட்டும்', sbExpired: 'காலாவதி', noSandboxes: 'இன்னும் சோதனைத் தளம் இல்லை.',
    sbId: 'சோதனைத் தளப் பெயர்', sbPartner: 'கூட்டாளர்', sbExpires: 'வரை (தேதி)', sbCount: 'நிரப்ப வேண்டிய கற்பனைப் பதிவுகள்', sbSave: 'சோதனைத் தளத்தை உருவாக்கு', seed: 'கற்பனைப் பதிவுகளால் நிரப்பு',
    sbSaved: 'சோதனைத் தளம் உருவானது. கூட்டாளர் தயாரானதும் கற்பனைப் பதிவுகளால் நிரப்புங்கள்.', seeded: 'இந்தச் சோதனைத் தளத்துக்கான {n} கற்பனைப் பதிவுகளைத் தலைமை அலுவலகம் சரிபார்த்தது: {detail}', notSeeded: 'நிரப்பப்படவில்லை: {detail}', needSb: 'பெயர், கூட்டாளர், கடைசி நாள் ஆகியவற்றை நிரப்பவும்.',
    ceH: 'இணைப்பிச் சான்றளிப்புகள்', ceLead: 'ஒரு இணைப்பி சோதிக்கப்பட்ட API பதிப்புகளுக்கு எதிராகச் சான்றளிக்கப்படுகிறது. தலைமை அலுவலக API முன்னேறினால் இங்கே பின்தங்கியதாகக் காட்டும்; சான்றளிக்கப்படாத இணைப்பி உண்மையான கடையில் இயங்க முடியாது.',
    cEcpartner: 'கூட்டாளர்', cEcconn: 'இணைப்பி', cEcon: 'சான்றளித்த தேதி', cEcby: 'யார்', cEcvs: 'சோதித்த பதிப்புகள்', cEcnow: 'இன்று', check: 'இன்றைக்கு எதிராகச் சரிபார்', noCerts: 'இன்னும் இணைப்பி சான்றளிக்கப்படவில்லை.',
    ceId: 'சான்றளிப்புப் பெயர்', cePartner: 'கூட்டாளர்', ceConn: 'இணைப்பி', ceOn: 'சான்றளித்த தேதி', ceSave: 'சான்றளிப்பைப் பதி', ceApis: 'இந்த API-களுக்கு எதிராகச் சோதிக்கப்பட்டது (நடப்புப் பதிப்பு)',
    ceSaved: 'சான்றளிப்பு பதியப்பட்டது, நீங்கள் ஒப்புக்கொண்டீர்கள்.', needCe: 'பெயர், கூட்டாளர், இணைப்பி, தேதி ஆகியவற்றை நிரப்பி குறைந்தது ஒரு API-ஐத் தேர்வு செய்யவும்.', verdict: '{detail}{prod}', mayProd: ' — உண்மையான கடையில் இயங்கலாம்.', notProd: ' — உண்மையான கடையில் இயங்கக் கூடாது.',
    acH: 'இந்தச் சான்று இந்த அழைப்பைச் செய்யலாமா?', acLead: 'பதிந்த சான்றிலிருந்து தலைமை அலுவலகம் முடிவு செய்கிறது: சோதனைச் சான்று உண்மையான கடையில் மறுக்கப்படும்; வழங்காத கடை, திரும்பப் பெற்ற அல்லது காலாவதியான சான்று, பதிப்பில்லா அழைப்பும் மறுக்கப்படும்.',
    acCred: 'சான்று', acEnv: 'எங்கே', acTenant: 'கடை அல்லது சோதனைத் தளம்', acScope: 'தேவையான வரம்பு', acApi: 'API', acCheck: 'சரிபார்', allowed: 'அனுமதி: {detail}', refusedCall: 'மறுப்பு: {detail}', needAc: 'சான்றைத் தேர்ந்து கடை அல்லது சோதனைத் தளத்தையும் வரம்பையும் நிரப்பவும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை — மீண்டும் முயலவும்.', readOnly: 'கூட்டாளர் பதிவேட்டை நீங்கள் படிக்கலாம். பதிய, திரும்பப் பெற, சோதனைத் தளங்களுக்குக் கூட்டாளர் நிர்வாக உரிமை தேவை.',
    noRight: 'இந்தக் கணக்கு கூட்டாளர் பதிவேட்டைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.', notKnown: 'தெரியவில்லை',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const shopDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const list = (v) => v.split(',').map((x) => x.trim()).filter((x) => x !== '');

const newKey = () => `ptn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);

let reg = null;       // GET /v1/platform/partners
let manifest = null;  // GET /v1/platform/api-manifest
const verdicts = new Map(); // `${partnerId}\u001f${connectorId}` → status answer
/** Today's API versions, from head office's own manifest: each API with routes, at the manifest's major version, current. */
const currentVersions = () => (manifest?.apis ?? []).filter((a) => Array.isArray(a.routes) && a.routes.length > 0).map((a) => ({ contract: a.api, version: manifest.majorVersion, status: 'current' }));

function cell(tr, text, warn = false) { const td = document.createElement('td'); td.textContent = text; if (warn) td.className = 'warn'; tr.append(td); return td; }
function button(text, fn) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', fn); return b; }
function emptyRow(tbody, cols, text) { const tr = document.createElement('tr'); const td = cell(tr, text); td.colSpan = cols; tbody.append(tr); }
const stateWords = (c) => (c.state === 'active' ? t('stActive') : c.state === 'revoked' ? fill(t('stRevoked'), { d: c.revokedOn }) : c.state === 'expired' ? t('stExpired') : t('stNotYet'));

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['k-creds', 'kCreds'], ['k-sandboxes', 'kSandboxes'], ['k-certs', 'kCerts'], ['docs-link', 'docs'],
    ['cred-h', 'credH'], ['cred-lead', 'credLead'], ['c-cid', 'cCid'], ['c-partner', 'cPartner'], ['c-env', 'cEnv'], ['c-reach', 'cReach'], ['c-scopes', 'cScopes'], ['c-expires', 'cExpires'], ['c-state', 'cState'],
    ['l-cr-id', 'crId'], ['l-cr-partner', 'crPartner'], ['l-cr-env', 'crEnv'], ['o-sandbox', 'envSandbox'], ['o-production', 'envProduction'], ['l-cr-reach', 'crReach'], ['l-cr-scopes', 'crScopes'], ['l-cr-expires', 'crExpires'], ['cr-save', 'crSave'],
    ['sb-h', 'sbH'], ['sb-lead', 'sbLead'], ['c-sid', 'cSid'], ['c-spartner', 'cSpartner'], ['c-screated', 'cScreated'], ['c-sexpires', 'cSexpires'], ['c-sdata', 'cSdata'],
    ['l-sb-id', 'sbId'], ['l-sb-partner', 'sbPartner'], ['l-sb-expires', 'sbExpires'], ['l-sb-count', 'sbCount'], ['sb-save', 'sbSave'],
    ['ce-h', 'ceH'], ['ce-lead', 'ceLead'], ['c-ecpartner', 'cEcpartner'], ['c-ecconn', 'cEcconn'], ['c-econ', 'cEcon'], ['c-ecby', 'cEcby'], ['c-ecvs', 'cEcvs'], ['c-ecnow', 'cEcnow'],
    ['l-ce-id', 'ceId'], ['l-ce-partner', 'cePartner'], ['l-ce-conn', 'ceConn'], ['l-ce-on', 'ceOn'], ['ce-save', 'ceSave'], ['l-ce-apis', 'ceApis'],
    ['ac-h', 'acH'], ['ac-lead', 'acLead'], ['l-ac-cred', 'acCred'], ['l-ac-env', 'acEnv'], ['o-ac-sandbox', 'envSandbox'], ['o-ac-production', 'envProduction'], ['l-ac-tenant', 'acTenant'], ['l-ac-scope', 'acScope'], ['l-ac-api', 'acApi'], ['ac-check', 'acCheck']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  for (const id of ['cred-form', 'sb-form', 'ce-form', 'ce-apis']) $(id).hidden = !mayEdit;
  const known = (el, ok, v) => { el.textContent = ok ? String(v) : t('notKnown'); el.classList.toggle('unknown', !ok); };
  known($('v-creds'), reg !== null, (reg?.credentials ?? []).filter((c) => c.state === 'active').length);
  known($('v-sandboxes'), reg !== null, (reg?.sandboxes ?? []).filter((s) => !s.expired).length);
  known($('v-certs'), reg !== null, (reg?.certifications ?? []).length);

  const creds = $('cred-rows'); creds.replaceChildren();
  if (reg !== null && reg.credentials.length === 0) emptyRow(creds, 8, t('noCreds'));
  for (const c of reg?.credentials ?? []) {
    const tr = document.createElement('tr'); tr.dataset.id = c.credentialId;
    cell(tr, c.credentialId); cell(tr, c.partnerId); cell(tr, c.environment === 'production' ? t('envProduction') : t('envSandbox'), c.environment === 'production');
    cell(tr, c.scopedTenantIds.length === 0 ? t('nobodyReach') : c.scopedTenantIds.join(', ')); cell(tr, c.scopes.join(', ')); cell(tr, c.expiresOn); cell(tr, stateWords(c), c.state !== 'active');
    const act = cell(tr, '');
    if (mayEdit && c.state !== 'revoked') act.append(button(t('revoke'), () => { void revoke(c.credentialId); }));
    creds.append(tr);
  }
  const sbs = $('sb-rows'); sbs.replaceChildren();
  if (reg !== null && reg.sandboxes.length === 0) emptyRow(sbs, 6, t('noSandboxes'));
  for (const s of reg?.sandboxes ?? []) {
    const tr = document.createElement('tr'); tr.dataset.id = s.sandboxId;
    cell(tr, s.sandboxId); cell(tr, s.partnerId); cell(tr, s.createdOn); cell(tr, s.expiresOn, s.expired); cell(tr, s.expired ? t('sbExpired') : t('synthetic'), s.expired);
    const act = cell(tr, '');
    if (mayEdit && !s.expired) act.append(button(t('seed'), () => { void seed(s.sandboxId); }));
    sbs.append(tr);
  }
  $('sandbox-ids').replaceChildren(...(reg?.sandboxes ?? []).map((s) => Object.assign(document.createElement('option'), { value: s.sandboxId })));
  const certs = $('ce-rows'); certs.replaceChildren();
  if (reg !== null && reg.certifications.length === 0) emptyRow(certs, 6, t('noCerts'));
  for (const c of reg?.certifications ?? []) {
    const tr = document.createElement('tr'); tr.dataset.id = `${c.partnerId}/${c.connectorId}`;
    cell(tr, c.partnerId); cell(tr, c.connectorId); cell(tr, c.certifiedOn); cell(tr, c.certifiedBy); cell(tr, c.againstVersions.map((v) => `${v.contract} ${v.version}`).join(', '));
    const v = verdicts.get(`${c.partnerId}\u001f${c.connectorId}`);
    const td = cell(tr, v === undefined ? '' : fill(t('verdict'), { detail: v.detail, prod: v.mayRunInProduction ? t('mayProd') : t('notProd') }), v !== undefined && (!v.mayRunInProduction || v.behind.length > 0));
    if (v === undefined && manifest !== null) td.append(button(t('check'), () => { void checkCert(c.partnerId, c.connectorId); }));
    certs.append(tr);
  }
  const apis = $('ce-apis');
  const had = new Set([...apis.querySelectorAll('input:checked')].map((i) => i.value));
  apis.querySelectorAll('label').forEach((l) => l.remove());
  for (const v of currentVersions()) {
    const l = document.createElement('label'); const i = document.createElement('input'); i.type = 'checkbox'; i.value = v.contract; i.checked = had.has(v.contract);
    const name = manifest.apis.find((a) => a.api === v.contract)?.name ?? '';
    l.append(i, document.createTextNode(`${v.contract} ${v.version} — ${name}`)); apis.append(l);
  }
  const keep = $('ac-cred').value; $('ac-cred').replaceChildren(...(reg?.credentials ?? []).map((c) => Object.assign(document.createElement('option'), { value: c.credentialId, textContent: `${c.credentialId} (${c.partnerId})` })));
  if (keep !== '') $('ac-cred').value = keep;
  const keepApi = $('ac-api').value; $('ac-api').replaceChildren(...currentVersions().map((v) => Object.assign(document.createElement('option'), { value: v.contract, textContent: `${v.contract} ${v.version}` })));
  if (keepApi !== '') $('ac-api').value = keepApi;
}

async function load() {
  const [r, m] = await Promise.all([call('GET', '/v1/platform/partners'), call('GET', '/v1/platform/api-manifest')]);
  const st = $('page-status');
  reg = r.ok ? r.body : null; manifest = m.ok ? m.body : null;
  if (!r.ok) say(st, r, ''); else if (!m.ok) say(st, m, ''); else if (!mayEdit) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  paint();
}

async function revoke(id) {
  const out = await call('POST', `/v1/platform/partners/${encodeURIComponent(id)}/revoke`, {});
  if (!out.ok) { say($('cred-status'), out, ''); return; }
  await load();
  tell($('cred-status'), true, fill(t('revoked'), { d: out.body?.revokedOn ?? '' }));
}
async function seed(id) {
  const n = Math.max(1, Math.min(500, Number.parseInt($('sb-count').value, 10) || 25));
  // Generated here, by the page — never a copy of a shop record (hard rule #7). Head office judges every record's origin.
  const records = Array.from({ length: n }, (_, i) => ({ recordId: `gen-${id}-${i + 1}`, origin: 'generated' }));
  const out = await call('POST', `/v1/platform/partners/sandboxes/${encodeURIComponent(id)}/seed`, { records });
  if (!out.ok) { say($('sb-status'), out, ''); return; }
  tell($('sb-status'), out.body?.seeded === true, out.body?.seeded === true ? fill(t('seeded'), { n: out.body.records, detail: out.body.detail }) : fill(t('notSeeded'), { detail: out.body?.detail ?? '' }));
}
async function checkCert(partnerId, connectorId) {
  const out = await call('POST', `/v1/platform/partners/${encodeURIComponent(partnerId)}/certifications/${encodeURIComponent(connectorId)}/status`, { currentVersions: currentVersions() });
  if (!out.ok) { say($('ce-status'), out, ''); return; }
  verdicts.set(`${partnerId}\u001f${connectorId}`, out.body);
  paint();
}

$('cred-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('cred-status');
  const id = $('cr-id').value.trim(); const partnerId = $('cr-partner').value.trim(); const scopes = list($('cr-scopes').value); const expiresOn = $('cr-expires').value;
  if (id === '' || partnerId === '' || scopes.length === 0 || expiresOn === '') { tell(st, false, t('needCred')); return; }
  const out = await call('POST', `/v1/platform/partners/${encodeURIComponent(id)}`, { partnerId, environment: $('cr-env').value, scopedTenantIds: list($('cr-reach').value), scopes, issuedOn: shopDay(), expiresOn });
  if (!out.ok) { say(st, out, ''); return; }
  await load();
  tell(st, true, t('crSaved'));
});
$('sb-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('sb-status');
  const id = $('sb-id').value.trim(); const partnerId = $('sb-partner').value.trim(); const expiresOn = $('sb-expires').value;
  if (id === '' || partnerId === '' || expiresOn === '') { tell(st, false, t('needSb')); return; }
  const out = await call('POST', `/v1/platform/partners/sandboxes/${encodeURIComponent(id)}`, { partnerId, createdOn: shopDay(), expiresOn });
  if (!out.ok) { say(st, out, ''); return; }
  await load();
  tell(st, true, t('sbSaved'));
});
$('ce-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('ce-status');
  const id = $('ce-id').value.trim(); const partnerId = $('ce-partner').value.trim(); const connectorId = $('ce-conn').value.trim(); const certifiedOn = $('ce-on').value;
  const ticked = new Set([...$('ce-apis').querySelectorAll('input:checked')].map((i) => i.value));
  const againstVersions = currentVersions().filter((v) => ticked.has(v.contract)).map((v) => ({ contract: v.contract, version: v.version }));
  if (id === '' || partnerId === '' || connectorId === '' || certifiedOn === '' || againstVersions.length === 0) { tell(st, false, t('needCe')); return; }
  const out = await call('POST', `/v1/platform/partners/certifications/${encodeURIComponent(id)}`, { partnerId, connectorId, certifiedOn, againstVersions, certifiedBy: who.userId });
  if (!out.ok) { say(st, out, ''); return; }
  verdicts.delete(`${partnerId}\u001f${connectorId}`);
  await load();
  tell(st, true, t('ceSaved'));
});
$('ac-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('ac-status');
  const credentialId = $('ac-cred').value; const tenantId = $('ac-tenant').value.trim(); const requiredScope = $('ac-scope').value.trim(); const contract = $('ac-api').value;
  if (credentialId === '' || tenantId === '' || requiredScope === '' || contract === '') { tell(st, false, t('needAc')); return; }
  const out = await call('POST', '/v1/platform/partners/access-check', { credentialId, environment: $('ac-env').value, tenantId, requiredScope, contract, requestedVersion: manifest?.majorVersion, versions: currentVersions() });
  if (!out.ok) { say(st, out, ''); return; }
  tell(st, out.body?.allowed === true, fill(out.body?.allowed === true ? t('allowed') : t('refusedCall'), { detail: out.body?.detail ?? '' }));
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
