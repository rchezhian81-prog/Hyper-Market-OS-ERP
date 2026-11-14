// LICENSING for sale to other shops — CR-01 step 5 (OI-10 · M33-FR-04 · OB-710 · P-01 · P-06).
//
// One file a shop loads: a LICENCE, signed by the seller's own MASTER key (Ed25519). The seller (the owner of SRE Hyper
// Market) holds the private half — made once on his own computer by scripts/licence-desk.mjs, kept on a USB drive and on
// sealed paper, NEVER on a shop's PC and never in this repository. Every release carries only the PUBLIC half
// (licence-signing.pub), and checks a licence with it OFFLINE: no internet, no head office (P-01).
//
// A licence names: the shop's tenant id (made by its own setup program, OI-03), the shop's name, its GSTIN, how many tills
// and stores, which modules, and when it ends. The owner's own shop holds an OWNER licence (kind "owner"; it may have no end).
//
// Refused, each BY NAME, never silently:
//   • not_a_licence            — not a licence file at all (or damaged);
//   • not_signed_by_the_seller — the signature does not check: FORGED, or EDITED after it was signed (one changed letter);
//   • unknown_seller_key       — signed by a key this release does not know;
//   • terms_not_valid          — signed, but its terms are not a licence's terms;
//   • another_shop             — a COPY: it names another tenant id (or another GSTIN) than this shop's.
//
// Its STANDING on a shop day (the shop's own date, Asia/Kolkata — never the UTC date):
//   not_in_force  — this release carries no seller key (licensing not switched on yet): nothing is limited;
//   owner         — the owner's own licence with no end: nothing is limited;
//   valid         — in force;  expiring — in force, ending within `warnDays` (warned on every office page);
//   grace         — ended, within `graceDays` after its end (warned, nothing limited yet);
//   no_licence    — none loaded yet: the setup period of `setupDays` from the day this PC first ran with licensing;
//   reduced       — grace (or the setup period) over: REDUCED MODE.
// Whatever the standing: the till ALWAYS sells (a sale never asks the licence — hard rule 1, P-01), and the shop can
// ALWAYS view and export its own data (P-06). Reduced mode starts at the start of a shop day, never in the middle of one,
// and what it limits is LICENCE_POLICY.reduced (owner decision OB-751): as proposed, NO NEW SOFTWARE VERSIONS (the
// Software update page refuses) and a red notice on every office page — nothing else stops. Renewal is a NEW licence file
// loaded on the Licence screen — no code, no reinstall; the next moment the standing is read, the limit is gone.
//
// No secret is ever in a licence: it is signed, not encrypted, and its terms are shown on the Licence screen.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export const LICENCE_KIND = 'sre-retail-os-licence-v1';
export const LICENCE_REQUEST_KIND = 'sre-retail-os-licence-request-v1';
/** The public half of the seller's key, as a release carries it (beside release.json) and as the repository commits it. */
export const PUBLIC_KEY_FILE = 'licence-signing.pub';
export const PUBLIC_KEY_IN_REPO = 'infra/licence/licence-signing.pub';
export const LICENCE_KINDS = Object.freeze(['owner', 'shop']);
/** The 36 modules of the roadmap (M01–M36), or "all". */
export const MODULE_IDS = Object.freeze(Array.from({ length: 36 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
/** A seller key's passphrase: long enough to resist guessing if the USB drive is lost. */
export const MIN_PASSPHRASE = 12;

/**
 * How long the warnings, the grace and the setup period are, and what reduced mode limits.
 * PROPOSED — waiting for the owner's decisions OB-750 (warning and grace), OB-751 (what reduced mode limits) and OB-752
 * (a new shop's setup period) — options A/B/C in docs/registers/decisions.md. Changing a number here
 * is the only change a different choice needs; the tests read these values, never their own copies.
 */
export const LICENCE_POLICY = Object.freeze({
  decision: 'OB-750',
  warnDays: 30,
  graceDays: 30,
  setupDays: 30,
  /**
   * Reduced mode (proposed option A): no new software versions until a licence is loaded; the till sells, every record can
   * be viewed and exported, and the office keeps working. (Option B would also refuse office changes; C would also stop new
   * till shifts from the next shop day — neither is built unless the owner chooses it.)
   */
  reduced: Object.freeze({ tillSells: true, viewAndExport: true, officeChanges: true, updates: false }),
});

const DAY_MS = 86_400_000;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GSTIN_SHAPE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTIN's own check character (the 15th), by the GSTN's mod-36 rule. */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    if (v < 0) return undefined;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** True when `g` is a 15-character GSTIN whose check character is right. */
export function gstinOk(g) {
  return typeof g === 'string' && GSTIN_SHAPE.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

/** The shop's own date (Asia/Kolkata) of a moment — never the UTC date. */
export function shopDateOf(moment) {
  const d = moment instanceof Date ? moment : new Date(moment);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** JSON with its keys in one fixed order at every depth — the exact bytes that are signed. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A key's short id: the first 16 hex of the SHA-256 of its public half (DER). Shown, never secret. */
export function keyIdOf(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** What is wrong with a licence's terms, in plain words (empty when they are a licence's terms). */
export function termsProblems(t) {
  const p = [];
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return ['the terms are missing'];
  if (typeof t.licenceId !== 'string' || !/^LIC-[0-9]{8}-[0-9A-F]{8}$/.test(t.licenceId)) p.push('the licence number is not right');
  if (!LICENCE_KINDS.includes(t.kind)) p.push('the kind must be "owner" or "shop"');
  if (typeof t.tenantId !== 'string' || !UUID.test(t.tenantId)) p.push('the tenant id must be the shop\'s tenant id (as on its About screen)');
  if (typeof t.shopName !== 'string' || t.shopName.trim().length < 2 || t.shopName.length > 120) p.push('the shop\'s name is missing');
  if (!gstinOk(t.gstin)) p.push('the GSTIN is not a right GSTIN (15 characters, its check character right)');
  for (const k of ['tills', 'stores']) if (!Number.isInteger(t[k]) || t[k] < 1 || t[k] > 999) p.push(`the number of ${k} must be a whole number from 1 to 999`);
  if (!Array.isArray(t.modules) || t.modules.length === 0) p.push('the modules are missing (list them, or "all")');
  else if (!(t.modules.length === 1 && t.modules[0] === 'all') && !t.modules.every((m) => MODULE_IDS.includes(m))) p.push('a module is not one of M01–M36 (or "all")');
  else if (new Set(t.modules).size !== t.modules.length) p.push('a module is named twice');
  if (!isDate(t.issuedOn)) p.push('the issue date is not a date (YYYY-MM-DD)');
  if (t.expiresOn === null) { if (t.kind !== 'owner') p.push('only the owner\'s own licence may have no end date'); }
  else if (!isDate(t.expiresOn)) p.push('the end date is not a date (YYYY-MM-DD)');
  else if (isDate(t.issuedOn) && t.expiresOn <= t.issuedOn) p.push('the end date must be after the issue date');
  const known = ['licenceId', 'kind', 'tenantId', 'shopName', 'gstin', 'tills', 'stores', 'modules', 'issuedOn', 'expiresOn'];
  for (const k of Object.keys(t)) if (!known.includes(k)) p.push(`"${k}" is not a licence term`);
  return p;
}

/** A new licence number: LIC-<issue date>-<8 hex>. */
export function newLicenceId(issuedOn, random = randomBytes) {
  return `LIC-${String(issuedOn).replace(/-/g, '')}-${random(4).toString('hex').toUpperCase()}`;
}

/**
 * Sign a licence with the seller's private key. Returns the licence FILE's text. Refuses terms that are not a licence's.
 * Used only by the seller's tool, on the seller's own computer.
 */
export function signLicence(terms, privateKey) {
  const problems = termsProblems(terms);
  if (problems.length > 0) throw new Error(`not a licence: ${problems.join('; ')}`);
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const keyId = keyIdOf(createPublicKey(key).export({ type: 'spki', format: 'pem' }));
  const signature = sign(null, Buffer.from(canonicalJson({ kind: LICENCE_KIND, keyId, terms }), 'utf8'), key).toString('base64');
  return `${JSON.stringify({ kind: LICENCE_KIND, keyId, terms, signature }, null, 2)}\n`;
}

export const REFUSAL_WORDS = Object.freeze({
  not_a_licence: { en: 'This is not a licence file, or it is damaged.', ta: 'இது உரிமக் கோப்பு அல்ல, அல்லது சேதமடைந்துள்ளது.' },
  not_signed_by_the_seller: { en: 'This licence is FORGED or was EDITED after it was signed: its signature does not check.', ta: 'இந்த உரிமம் போலியானது அல்லது கையொப்பமிட்ட பின் மாற்றப்பட்டது: கையொப்பம் சரியில்லை.' },
  unknown_seller_key: { en: 'This licence was signed by a key this program does not know.', ta: 'இந்த உரிமம் இந்த நிரலுக்குத் தெரியாத சாவியால் கையொப்பமிடப்பட்டது.' },
  terms_not_valid: { en: 'This licence\'s terms are not right.', ta: 'இந்த உரிமத்தின் விதிமுறைகள் சரியில்லை.' },
  another_shop: { en: 'This licence is for ANOTHER shop (a copy): it names another tenant id than this shop\'s.', ta: 'இந்த உரிமம் வேறொரு கடைக்கானது (நகல்): இது இந்தக் கடையின் டெனன்ட் எண் அல்ல.' },
  no_seller_key: { en: 'This program carries no seller key, so it cannot check a licence.', ta: 'இந்த நிரலில் விற்பனையாளர் சாவி இல்லை; உரிமத்தைச் சரிபார்க்க முடியாது.' },
});

const refused = (why, detail) => ({ ok: false, refusedBecause: why, ...REFUSAL_WORDS[why], ...(detail === undefined ? {} : { detail }) });

/**
 * Read a licence file's text and check its signature against the seller's PUBLIC key(s) — offline. Does NOT yet say whether
 * it is for this shop (forShop does). `publicKeys`: PEM texts (a release carries one; a key change carries two).
 */
export function readLicence(text, publicKeys) {
  const keys = (publicKeys ?? []).filter((k) => typeof k === 'string' && k.includes('PUBLIC KEY'));
  if (keys.length === 0) return refused('no_seller_key');
  let file;
  try { file = JSON.parse(String(text)); } catch { return refused('not_a_licence'); }
  if (file === null || typeof file !== 'object' || file.kind !== LICENCE_KIND || typeof file.signature !== 'string' || typeof file.keyId !== 'string' || file.terms === null || typeof file.terms !== 'object') {
    return refused('not_a_licence');
  }
  const extra = Object.keys(file).filter((k) => !['kind', 'keyId', 'terms', 'signature'].includes(k));
  if (extra.length > 0) return refused('not_signed_by_the_seller', `it carries ${extra.map((k) => `"${k}"`).join(', ')}, which no signed licence has`);
  const key = keys.find((k) => { try { return keyIdOf(k) === file.keyId; } catch { return false; } });
  // A key id this release does not know: still try every key (an edited key id is an edit, said as one).
  const candidates = key === undefined ? keys : [key];
  const message = Buffer.from(canonicalJson({ kind: LICENCE_KIND, keyId: file.keyId, terms: file.terms }), 'utf8');
  let signature;
  try { signature = Buffer.from(file.signature, 'base64'); } catch { return refused('not_signed_by_the_seller'); }
  const checks = candidates.some((k) => { try { return verify(null, message, createPublicKey(k), signature); } catch { return false; } });
  if (!checks) return key === undefined ? refused('unknown_seller_key', `its key id is ${String(file.keyId).slice(0, 16)}`) : refused('not_signed_by_the_seller');
  const problems = termsProblems(file.terms);
  if (problems.length > 0) return refused('terms_not_valid', problems.join('; '));
  return { ok: true, licence: { ...file.terms }, keyId: file.keyId };
}

/** Is a checked licence for THIS shop? A licence naming another tenant id (or GSTIN, when known) is a copy, refused. */
export function forShop(read, shop) {
  if (!read.ok) return read;
  const l = read.licence;
  if (typeof shop?.tenantId !== 'string' || shop.tenantId.toLowerCase() !== l.tenantId.toLowerCase()) {
    return refused('another_shop', `the licence names tenant ${l.tenantId} (${l.shopName}); this shop is tenant ${shop?.tenantId ?? 'not known'}`);
  }
  if (typeof shop.gstin === 'string' && shop.gstin !== '' && shop.gstin.toUpperCase() !== l.gstin) {
    return refused('another_shop', `the licence names GSTIN ${l.gstin}; this shop's GSTIN is ${shop.gstin.toUpperCase()}`);
  }
  return read;
}

/** Check a licence file's text for this shop in one step. */
export function checkLicenceFor(text, publicKeys, shop) {
  return forShop(readLicence(text, publicKeys), shop);
}

const STANDING_WORDS = {
  not_in_force: (s) => ({ en: 'Licensing is not switched on in this program version: nothing is limited.', ta: 'இந்தப் பதிப்பில் உரிமச் சரிபார்ப்பு இயக்கப்படவில்லை: எதுவும் கட்டுப்படுத்தப்படவில்லை.' }),
  owner: (s) => ({ en: `Owner's licence for ${s.licence.shopName}: no end date.`, ta: `${s.licence.shopName}-க்கான உரிமையாளர் உரிமம்: முடிவுத் தேதி இல்லை.` }),
  valid: (s) => ({ en: `Licensed to ${s.licence.shopName} until ${s.licence.expiresOn} (${s.daysLeft} days left).`, ta: `${s.licence.shopName}-க்கு ${s.licence.expiresOn} வரை உரிமம் உள்ளது (${s.daysLeft} நாட்கள் மீதம்).` }),
  expiring: (s) => ({ en: `The licence ends on ${s.licence.expiresOn} — ${s.daysLeft} day(s) left. Ask the seller for a renewal file and load it on the Licence screen.`, ta: `உரிமம் ${s.licence.expiresOn} அன்று முடிகிறது — ${s.daysLeft} நாள் மீதம். புதுப்பித்தல் கோப்பைப் பெற்று உரிமத் திரையில் ஏற்றவும்.` }),
  grace: (s) => ({ en: `The licence ENDED on ${s.licence.expiresOn}. Grace period: ${s.daysLeft} day(s) left before reduced mode (from ${s.reducedFrom}). The till keeps selling.`, ta: `உரிமம் ${s.licence.expiresOn} அன்று முடிந்தது. சலுகைக் காலம்: ${s.reducedFrom} முதல் குறைந்த பயன்முறைக்கு முன் ${s.daysLeft} நாள் மீதம். பணப்பெட்டி தொடர்ந்து விற்கும்.` }),
  no_licence: (s) => ({ en: `No licence is loaded yet. Setup period: ${s.daysLeft} day(s) left before reduced mode (from ${s.reducedFrom}). Send the licence request to the seller.`, ta: `இன்னும் உரிமம் ஏற்றப்படவில்லை. அமைப்புக் காலம்: ${s.reducedFrom} முதல் குறைந்த பயன்முறைக்கு முன் ${s.daysLeft} நாள் மீதம். உரிமக் கோரிக்கையை விற்பனையாளருக்கு அனுப்பவும்.` }),
  reduced: (s) => ({ en: `REDUCED MODE since ${s.reducedFrom}: ${s.licence === null ? 'no licence was loaded' : `the licence ended on ${s.licence.expiresOn}`}. The till still sells and every record can be viewed and exported; no new software version is installed until a licence is loaded.`, ta: `${s.reducedFrom} முதல் குறைந்த பயன்முறை: ${s.licence === null ? 'உரிமம் ஏற்றப்படவில்லை' : `உரிமம் ${s.licence.expiresOn} அன்று முடிந்தது`}. பணப்பெட்டி விற்கும்; எல்லாப் பதிவுகளையும் பார்க்கவும் ஏற்றுமதி செய்யவும் முடியும்; உரிமம் ஏற்றும் வரை புதிய மென்பொருள் பதிப்பு நிறுவப்படாது.` }),
};

/**
 * The licence's standing on a shop day. `licence`: the checked terms (or null); `keyBuiltIn`: does this release carry a
 * seller key; `firstSeenOn`: the shop day this PC first ran with licensing (the setup period's start). Pure.
 */
export function licenceStanding({ licence, today, keyBuiltIn, firstSeenOn, policy = LICENCE_POLICY }) {
  if (!isDate(today)) throw new Error('today must be the shop\'s date (YYYY-MM-DD)');
  const base = { licence: licence ?? null, today, tillSells: true, viewAndExport: true };
  const out = (state, extra) => {
    const s = { ...base, state, officeChanges: state === 'reduced' ? policy.reduced.officeChanges : true, updates: state === 'reduced' ? policy.reduced.updates : true, warn: ['expiring', 'grace', 'no_licence', 'reduced'].includes(state), ...extra };
    return { ...s, ...STANDING_WORDS[state](s) };
  };
  if (!keyBuiltIn) return out('not_in_force', {});
  if (licence === null || licence === undefined) {
    const start = isDate(firstSeenOn) ? firstSeenOn : today;
    const reducedFrom = addDays(start, policy.setupDays);
    return today >= reducedFrom ? out('reduced', { reducedFrom, daysLeft: 0 }) : out('no_licence', { reducedFrom, daysLeft: daysBetween(today, reducedFrom) });
  }
  if (licence.expiresOn === null) return out('owner', {});
  // The licence holds for the whole of its end day; the grace starts the day after.
  const daysLeft = daysBetween(today, licence.expiresOn);
  if (daysLeft >= 0) return out(daysLeft < policy.warnDays ? 'expiring' : 'valid', { daysLeft, reducedFrom: addDays(licence.expiresOn, 1 + policy.graceDays) });
  const reducedFrom = addDays(licence.expiresOn, 1 + policy.graceDays);
  return today >= reducedFrom ? out('reduced', { reducedFrom, daysLeft: 0 }) : out('grace', { reducedFrom, daysLeft: daysBetween(today, reducedFrom) });
}

/** What a shop sends the seller to ask for a licence: names only (tenant id, shop, GSTIN), never a secret. */
export function licenceRequest({ tenantId, shopName, gstin, release, at }) {
  return { kind: LICENCE_REQUEST_KIND, tenantId, shopName: shopName ?? null, gstin: gstin ?? null, release: release ?? null, madeAt: at };
}

/** Is `newer` allowed to replace `current`? A licence for the same shop replaces another only when it is not older. */
export function replaces(current, newer) {
  if (current === null || current === undefined) return true;
  const end = (l) => (l.expiresOn === null ? '9999-12-31' : l.expiresOn);
  return end(newer) >= end(current) || newer.issuedOn > current.issuedOn;
}

/**
 * The seller's key pair, made once. The private half is ENCRYPTED with the passphrase (PKCS#8, AES-256-CBC); the passphrase
 * itself is never written anywhere by this program.
 */
export function makeSellerKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  return { privatePem, publicPem, keyId: keyIdOf(publicPem) };
}

/** Open the encrypted private key with its passphrase. Throws "the passphrase is not right" (never says more). */
export function openSellerKey(privatePem, passphrase) {
  try { return createPrivateKey({ key: privatePem, format: 'pem', passphrase }); } catch { throw new Error('the passphrase is not right, or this is not the seller key file'); }
}
