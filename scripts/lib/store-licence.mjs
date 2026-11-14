// The SHOP'S LICENCE on its store PC — CR-01 step 5 (OI-10 · M33-FR-04 · OB-710 · P-01 · P-06 · P-08 · hard rule 6).
//
// One folder, in the till's own data folder (EDGE_DATA_DIR\licence — the till service may write there, the backup takes it,
// a restore brings it back):
//   licence.json                — the licence in force (the seller's signed file, exactly as loaded);
//   licence-history.log         — APPEND-ONLY, never rewritten: every licence loaded (its whole file) and every refusal,
//                                  who, when and how (hard rule 6 — nothing is lost when a renewal replaces a licence);
//   licensing-first-seen.json   — the shop day this PC first ran with licensing: the setup period's start. Written once.
//
// Shared by the store-computer tool (`store-computer licence …`), the first-run screens (setup-server) and the till's
// screen server (the Licence screen and the office gate). Every read checks the signature again: a licence.json changed
// on disk is not a licence (P-08, said on the screen), never trusted because it is in the folder.
//
// The licence is checked OFFLINE with the seller's PUBLIC key the release carries (licence-signing.pub beside
// release.json). Nothing here can sign; no private key is ever on a shop's PC.

import { PUBLIC_KEY_FILE, checkLicenceFor, licenceRequest, licenceStanding, readLicence, replaces, shopDateOf } from './licence.mjs';

export const LICENCE_DIR = 'licence';
export const LICENCE_FILE = 'licence.json';
export const LICENCE_LOG = 'licence-history.log';
export const FIRST_SEEN_FILE = 'licensing-first-seen.json';
/** A licence file is small; anything larger is not one (and is not read into memory). */
export const LICENCE_MAX_BYTES = 16 * 1024;

/** The seller's public key(s) this release carries: `<release folder>\licence-signing.pub`. Empty when none. */
export function sellerKeys({ fs, path }, releaseDir) {
  if (releaseDir === undefined) return [];
  try {
    const text = fs.readFileSync(path.join(releaseDir, PUBLIC_KEY_FILE), 'utf8');
    return text.includes('PUBLIC KEY') ? [text] : [];
  } catch { return []; }
}

const folder = ({ path }, edgeDataDir) => path.join(edgeDataDir, LICENCE_DIR);
const readText = (fs, file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } };

/**
 * The shop day this PC first ran with licensing on (a seller key in its release). Written ONCE ('wx'); a later run reads
 * it. Undefined while licensing is not in force (nothing is started).
 */
export function firstSeen(io, edgeDataDir, { keyBuiltIn, now }) {
  const { fs, path } = io;
  const file = path.join(folder(io, edgeDataDir), FIRST_SEEN_FILE);
  const kept = readText(fs, file);
  if (kept !== undefined) {
    try { const d = JSON.parse(kept).firstSeenOn; if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d; } catch { /* below */ }
  }
  if (!keyBuiltIn) return undefined;
  const day = shopDateOf(now());
  try {
    fs.mkdirSync(folder(io, edgeDataDir), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ kind: 'sre-licensing-first-seen-v1', firstSeenOn: day, at: now().toISOString() })}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch { /* another reader wrote it first, or the folder cannot be written: the day is still today */ }
  return day;
}

/** Append one line to the history (durably). Throws when it cannot: the caller then says nothing was loaded. */
export function appendHistory(io, edgeDataDir, entry) {
  const { fs, path } = io;
  fs.mkdirSync(folder(io, edgeDataDir), { recursive: true });
  const fd = fs.openSync(path.join(folder(io, edgeDataDir), LICENCE_LOG), 'a');
  try { fs.writeSync(fd, `${JSON.stringify(entry)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** The history, oldest first (unreadable lines skipped). */
export function readHistory(io, edgeDataDir) {
  const text = readText(io.fs, io.path.join(folder(io, edgeDataDir), LICENCE_LOG));
  if (text === undefined) return [];
  return text.split('\n').filter((l) => l.trim() !== '').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/**
 * The licence in force: re-checked now against the release's key and THIS shop. `problem` when a file is there but is
 * not this shop's signed licence (changed on disk, or a key change) — said, never hidden.
 */
export function licenceInForce(io, edgeDataDir, { keys, shop }) {
  const text = readText(io.fs, io.path.join(folder(io, edgeDataDir), LICENCE_FILE));
  if (text === undefined) return { licence: null };
  if (keys.length === 0) return { licence: null };
  const read = checkLicenceFor(text, keys, shop);
  return read.ok ? { licence: read.licence, keyId: read.keyId } : { licence: null, problem: read };
}

/** Everything the screens say about the licence, now: its standing on the shop's day, the terms, and any problem. */
export function licenceNow(io, edgeDataDir, { keys, shop, now }) {
  const keyBuiltIn = keys.length > 0;
  const firstSeenOn = firstSeen(io, edgeDataDir, { keyBuiltIn, now });
  const held = licenceInForce(io, edgeDataDir, { keys, shop });
  const standing = licenceStanding({ licence: held.licence, today: shopDateOf(now()), keyBuiltIn, ...(firstSeenOn === undefined ? {} : { firstSeenOn }) });
  return { standing, keyBuiltIn, ...(held.problem === undefined ? {} : { problem: held.problem }), ...(firstSeenOn === undefined ? {} : { firstSeenOn }) };
}

/**
 * LOAD a licence file's text: check it (signature, terms, this shop), refuse an older one than the one in force, write the
 * history line FIRST (a load that cannot be recorded is not made), then put it in force (written whole, then renamed).
 * `by`: who loaded it; `via`: 'setup_screens' | 'licence_screen' | 'store_computer_tool'.
 */
export function loadLicence(io, edgeDataDir, { text, keys, shop, by, via, now }) {
  const { fs, path } = io;
  const at = now().toISOString();
  const record = (outcome, extra) => {
    try { appendHistory(io, edgeDataDir, { kind: 'licence_load', at, by, via, outcome, ...extra }); return true; } catch { return false; }
  };
  const notRecorded = { ok: false, refusedBecause: 'not_recorded', en: 'The licence could not be written down on this PC, so it was not loaded.', ta: 'உரிமத்தை இந்தக் கணினியில் பதிவு செய்ய முடியவில்லை; அது ஏற்றப்படவில்லை.' };
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LICENCE_MAX_BYTES) {
    const r = { ok: false, refusedBecause: 'not_a_licence', en: 'This is not a licence file, or it is damaged.', ta: 'இது உரிமக் கோப்பு அல்ல, அல்லது சேதமடைந்துள்ளது.' };
    return record('refused:not_a_licence', {}) ? r : notRecorded;
  }
  const read = checkLicenceFor(text, keys, shop);
  if (!read.ok) {
    const id = (() => { try { return JSON.parse(text)?.terms?.licenceId; } catch { return undefined; } })();
    return record(`refused:${read.refusedBecause}`, { ...(typeof id === 'string' ? { licenceId: id.slice(0, 40) } : {}), ...(read.detail === undefined ? {} : { detail: read.detail }) }) ? read : notRecorded;
  }
  const current = licenceInForce(io, edgeDataDir, { keys, shop }).licence;
  if (current !== null && current.licenceId !== read.licence.licenceId && !replaces(current, read.licence)) {
    const r = { ok: false, refusedBecause: 'older_than_in_force', en: `This licence (${read.licence.licenceId}, ends ${read.licence.expiresOn}) is older than the one in force (${current.licenceId}, ends ${current.expiresOn ?? 'never'}); it was not loaded.`, ta: 'இந்த உரிமம் நடப்பில் உள்ளதைவிடப் பழையது; அது ஏற்றப்படவில்லை.' };
    return record('refused:older_than_in_force', { licenceId: read.licence.licenceId }) ? r : notRecorded;
  }
  if (!record('loaded', { licenceId: read.licence.licenceId, keyId: read.keyId, terms: read.licence, file: text, replaces: current?.licenceId ?? null })) return notRecorded;
  try {
    const file = path.join(folder(io, edgeDataDir), LICENCE_FILE);
    fs.writeFileSync(`${file}.tmp`, text, 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    record('refused:not_recorded', { licenceId: read.licence.licenceId, step: 'put_in_force' });
    return notRecorded;
  }
  const l = read.licence;
  return {
    ok: true, licence: l,
    en: `LICENCE LOADED — ${l.licenceId}: ${l.shopName}, ${l.kind === 'owner' ? 'the owner\'s licence' : 'shop licence'}, ${l.tills} till(s), ${l.stores} store(s), ${l.expiresOn === null ? 'no end date' : `until ${l.expiresOn}`}.`,
    ta: `உரிமம் ஏற்றப்பட்டது — ${l.licenceId}: ${l.shopName}, ${l.expiresOn === null ? 'முடிவுத் தேதி இல்லை' : `${l.expiresOn} வரை`}.`,
  };
}

/** The licence request a new shop sends the seller (names only). */
export function requestFor({ tenantId, shopName, gstin, release }, now) {
  return licenceRequest({ tenantId, shopName, gstin, release, at: now().toISOString() });
}

export { readLicence };
