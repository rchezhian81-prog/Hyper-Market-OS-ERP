// The OWNER'S LICENCE DESK — CR-01 step 5 (OI-10 · M33-FR-04 · OB-710 · hard rule 4).
//
// Run by the owner (the seller) on HIS OWN computer, never on a shop's PC:
//   make-key --folder <USB drive folder>   once: the seller's master key pair. The private half is ENCRYPTED with a
//                                          passphrase he types (hidden, twice) and this program never writes down; a
//                                          printable paper backup (the encrypted key, a check on every line) is written
//                                          beside it, for a sealed envelope in the safe. The PUBLIC half is what every
//                                          release carries (infra/licence/licence-signing.pub — not a secret).
//   issue --key <key file> [--request <shop's licence request>] [--owner] [--tenant …] [--shop …] [--gstin …]
//         [--tills N] [--stores N] [--modules all|M01,M02] [--expires YYYY-MM-DD] [--out <folder>]
//                                          a licence file for one shop; anything not given is asked. Checked against the
//                                          public half before it is written; listed in issued-licences.log (append-only).
//   show <licence file> [--public-key <licence-signing.pub>]
//                                          what a licence says, and whether its signature checks.
//   restore-key --from <typed paper lines> --folder <folder>
//                                          the key file again, from the paper backup's lines (each line's check verified).
//
// Refused: making the key inside a code repository (it must never be committed) or on a shop's PC (SRE Retail OS
// installed). Nothing here sends anything anywhere: no network is used.

import { createHash, createPublicKey } from 'node:crypto';
import {
  LICENCE_REQUEST_KIND, MIN_PASSPHRASE, gstinOk, keyIdOf, makeSellerKey, newLicenceId, openSellerKey, readLicence, shopDateOf, signLicence, termsProblems,
} from './licence.mjs';

export const KEY_FILE = 'sre-licence-seller-key.pem';
export const PUBLIC_FILE = 'licence-signing.pub';
export const ISSUED_LOG = 'issued-licences.log';

/** Is `dir` (or a folder above it) a code repository? The key must never be where it could be committed. */
export function insideRepository({ fs, path }, dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    const up = path.dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** Is this a shop's PC (SRE Retail OS installed: its ProgramData folder, or its Program Files folder)? */
export function onAShopPc({ fs, path, env, platform }) {
  if (platform !== 'win32') return false;
  const candidates = [env.ProgramData && path.join(env.ProgramData, 'SRE'), env.ProgramFiles && path.join(env.ProgramFiles, 'SRE Retail OS')].filter(Boolean);
  return candidates.some((c) => fs.existsSync(c));
}

const PEM_LINE = /^[A-Za-z0-9+/=-]+$/;
const lineCheck = (n, line) => createHash('sha256').update(`${n}:${line}`).digest('hex').slice(0, 4).toUpperCase();

/** The printable paper backup: the ENCRYPTED key, one numbered line each with a 4-character check. Never the passphrase. */
export function paperBackupText({ privatePem, keyId, madeOn }) {
  const lines = privatePem.trim().split(/\r?\n/);
  return [
    'SRE RETAIL OS — SELLER LICENCE KEY — PAPER BACKUP',
    `Key id: ${keyId}        Made on: ${madeOn}`,
    '',
    'Keep this sheet in a SEALED envelope in the safe. It is the encrypted master key that signs every licence you sell.',
    'The passphrase is NOT on this paper. Write the passphrase by hand on a SEPARATE sheet, in a SEPARATE sealed envelope.',
    'Anyone with BOTH could make licences in your name. With only one, nobody can.',
    '',
    'To bring the key back: type the numbered lines below into a text file exactly (number, space, line, space, check),',
    'then run:  node scripts/licence-desk.mjs restore-key --from <that file> --folder <a folder on your USB drive>',
    '',
    ...lines.map((l, i) => `${String(i + 1).padStart(2, '0')} ${l} ${lineCheck(i + 1, l)}`),
    '',
    `Lines: ${lines.length}`,
  ].join('\n');
}

/** The key file again from the paper's typed lines. Each line's check must match: a typing slip is named by line. */
export function keyFromPaper(typed) {
  const rows = String(typed).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d\d /.test(l));
  if (rows.length < 3) return { ok: false, problem: 'no numbered lines were found' };
  const out = [];
  for (const [i, row] of rows.entries()) {
    const m = /^(\d\d) (.+) ([0-9A-F]{4})$/.exec(row);
    if (m === null || Number(m[1]) !== i + 1) return { ok: false, problem: `line ${i + 1} is not in the form "NN text CHECK"` };
    if (lineCheck(i + 1, m[2]) !== m[3]) return { ok: false, problem: `line ${m[1]} does not match its check ${m[3]} — look for a typing slip on that line` };
    if (!m[2].startsWith('-----') && !PEM_LINE.test(m[2])) return { ok: false, problem: `line ${m[1]} has a character a key never has` };
    out.push(m[2]);
  }
  return { ok: true, privatePem: `${out.join('\n')}\n` };
}

async function passphraseTwice(d) {
  const a = await d.ask(`Choose a passphrase for the key (at least ${MIN_PASSPHRASE} characters; nothing you type is shown): `, true);
  const b = await d.ask('Type the same passphrase again: ', true);
  if (a !== b) return { problem: 'the two passphrases are not the same. Nothing was made. Run it again.' };
  if (a.length < MIN_PASSPHRASE) return { problem: `the passphrase must be at least ${MIN_PASSPHRASE} characters. Nothing was made.` };
  return { passphrase: a };
}

const writeOnce = (fs, file, text, mode) => fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', ...(mode === undefined ? {} : { mode }) });

/** `make-key`: the seller's master key pair, once. 0 made · 2 refused. */
export async function makeKeyCommand(d, { folder }) {
  const { fs, path, say } = d;
  if (typeof folder !== 'string' || folder.trim() === '') { say('REFUSED — name the folder for the key, on your own USB drive: make-key --folder E:\\SRE-licence-key'); return 2; }
  if (onAShopPc(d)) { say('REFUSED — this is a shop\'s PC (SRE Retail OS is installed here). The master key is NEVER made or kept on a shop\'s PC. Use your own computer.'); return 2; }
  const repo = insideRepository(d, folder);
  if (repo !== undefined) { say(`REFUSED — ${folder} is inside a code repository (${repo}). The master key must never be where it could be committed. Choose a folder on your USB drive.`); return 2; }
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(path.join(folder, KEY_FILE))) { say(`REFUSED — ${folder} already holds a seller key. It is never replaced: a new key would make every licence you sold unreadable to the next release. If the key is lost or leaked, follow "If the key is lost or leaked" in docs/runbooks/licensing.md.`); return 2; }
  const p = await passphraseTwice(d);
  if (p.problem !== undefined) { say(`REFUSED — ${p.problem}`); return 2; }
  const key = makeSellerKey(p.passphrase);
  const madeOn = shopDateOf(d.now());
  const paperFile = path.join(folder, `PAPER-BACKUP-${key.keyId}.txt`);
  writeOnce(fs, path.join(folder, KEY_FILE), key.privatePem, 0o600);
  writeOnce(fs, path.join(folder, PUBLIC_FILE), key.publicPem);
  writeOnce(fs, paperFile, `${paperBackupText({ privatePem: key.privatePem, keyId: key.keyId, madeOn })}\n`);
  say(`KEY MADE — key id ${key.keyId}, on ${madeOn}.`);
  say(`  ${path.join(folder, KEY_FILE)}   the master key, encrypted with your passphrase. Keep it ONLY on this USB drive.`);
  say(`  ${path.join(folder, PUBLIC_FILE)}   the PUBLIC key. Not a secret: it goes into the program (send it to be committed).`);
  say(`  ${paperFile}   print it, then delete the file; seal the paper in the safe.`);
  say('Write the passphrase by hand on a separate sheet, sealed separately. It is not written anywhere by this program.');
  return 0;
}

const asNumber = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : NaN);

/** `issue`: one licence file. 0 issued · 2 refused. */
export async function issueCommand(d, o) {
  const { fs, path, say } = d;
  if (typeof o.key !== 'string' || !fs.existsSync(o.key)) { say('REFUSED — name the seller key file: issue --key E:\\SRE-licence-key\\sre-licence-seller-key.pem'); return 2; }
  let req = {};
  if (o.request !== undefined) {
    try { req = JSON.parse(fs.readFileSync(o.request, 'utf8')); } catch { say(`REFUSED — ${o.request} could not be read as a licence request.`); return 2; }
    if (req.kind !== LICENCE_REQUEST_KIND) { say(`REFUSED — ${o.request} is not a licence request from a shop's store PC.`); return 2; }
  }
  const val = async (given, fromReq, question) => {
    const v = given ?? fromReq;
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    return String(await d.ask(question, false)).trim();
  };
  const tenantId = await val(o.tenant, req.tenantId, 'The shop\'s tenant id (from its About or Licence screen): ');
  const shopName = await val(o.shop, req.shopName, 'The shop\'s name: ');
  const gstin = (await val(o.gstin, req.gstin, 'The shop\'s GSTIN: ')).toUpperCase();
  if (!gstinOk(gstin)) { say(`REFUSED — ${gstin} is not a right GSTIN (15 characters, its check character right). Nothing was issued.`); return 2; }
  const tills = asNumber(await val(o.tills, undefined, 'How many tills: '));
  const stores = asNumber(await val(o.stores, undefined, 'How many stores: '));
  const modulesText = await val(o.modules, undefined, 'Which modules ("all", or a list such as M01,M02,M03): ');
  const modules = modulesText.toLowerCase() === 'all' ? ['all'] : modulesText.split(',').map((m) => m.trim().toUpperCase()).filter((m) => m !== '');
  const kind = o.owner === true ? 'owner' : 'shop';
  const expiresText = o.owner === true ? (o.expires ?? '') : await val(o.expires, undefined, 'The last day of the licence (YYYY-MM-DD): ');
  const issuedOn = shopDateOf(d.now());
  const terms = { licenceId: newLicenceId(issuedOn), kind, tenantId, shopName, gstin, tills, stores, modules, issuedOn, expiresOn: expiresText === '' ? null : expiresText };
  const problems = termsProblems(terms);
  if (problems.length > 0) { say(`REFUSED — ${problems.join('; ')}. Nothing was issued.`); return 2; }
  let key;
  try { key = openSellerKey(fs.readFileSync(o.key, 'utf8'), await d.ask('The key\'s passphrase (nothing you type is shown): ', true)); } catch (e) { say(`REFUSED — ${e instanceof Error ? e.message : 'the key could not be opened'}. Nothing was issued.`); return 2; }
  const text = signLicence(terms, key);
  // Checked with the PUBLIC half before it is written: exactly what a shop's PC will do.
  const publicPem = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const pubBeside = path.join(path.dirname(o.key), PUBLIC_FILE);
  const keys = [publicPem, ...(fs.existsSync(pubBeside) ? [fs.readFileSync(pubBeside, 'utf8')] : [])];
  const check = readLicence(text, keys);
  if (!check.ok) { say(`NOT DONE — the licence did not check against the public key (${check.en}). Nothing was written.`); return 1; }
  const out = o.out ?? process.cwd();
  fs.mkdirSync(out, { recursive: true });
  const slug = shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'shop';
  const file = path.join(out, `licence-${slug}-${terms.licenceId}.json`);
  writeOnce(fs, file, text);
  fs.appendFileSync(path.join(path.dirname(o.key), ISSUED_LOG), `${JSON.stringify({ at: d.now().toISOString(), keyId: keyIdOf(publicPem), ...terms })}\n`, 'utf8');
  say(`LICENCE ISSUED — ${terms.licenceId} for ${shopName} (tenant ${tenantId}), ${kind === 'owner' ? 'the owner\'s licence, no end date' : `until ${terms.expiresOn}`}, ${tills} till(s), ${stores} store(s), modules ${modules.join(',')}.`);
  say(`  File: ${file}`);
  say('  Give the shop this file (USB drive, e-mail or WhatsApp — it is not a secret). They load it on the Licence screen.');
  return 0;
}

/** `show`: what a licence says, and whether it checks. 0 checks · 1 does not · 2 not read. */
export async function showCommand(d, { file, publicKey }) {
  const { fs, say } = d;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { say(`REFUSED — ${file} could not be read.`); return 2; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { say('This is not a licence file.'); return 1; }
  const t = parsed?.terms ?? {};
  say(`Licence ${t.licenceId ?? '?'} — ${t.kind ?? '?'} — ${t.shopName ?? '?'} (tenant ${t.tenantId ?? '?'}, GSTIN ${t.gstin ?? '?'})`);
  say(`  tills ${t.tills ?? '?'}, stores ${t.stores ?? '?'}, modules ${Array.isArray(t.modules) ? t.modules.join(',') : '?'}, issued ${t.issuedOn ?? '?'}, ends ${t.expiresOn === null ? 'never' : (t.expiresOn ?? '?')}`);
  if (publicKey === undefined) { say('  (no public key named: the signature was not checked)'); return 0; }
  const r = readLicence(text, [fs.readFileSync(publicKey, 'utf8')]);
  say(r.ok ? '  SIGNATURE CHECKS — signed by this seller key, not changed since.' : `  ${r.en}${r.detail === undefined ? '' : ` (${r.detail})`}`);
  return r.ok ? 0 : 1;
}

/** `restore-key`: the key file again from the paper's typed lines. 0 written · 2 refused. */
export async function restoreKeyCommand(d, { from, folder }) {
  const { fs, path, say } = d;
  if (onAShopPc(d)) { say('REFUSED — this is a shop\'s PC. The master key is never put on a shop\'s PC.'); return 2; }
  if (typeof folder !== 'string' || insideRepository(d, folder) !== undefined) { say('REFUSED — name a folder on your USB drive, not inside a code repository: restore-key --from <file> --folder <folder>'); return 2; }
  let typed;
  try { typed = fs.readFileSync(from, 'utf8'); } catch { say(`REFUSED — ${from} could not be read.`); return 2; }
  const r = keyFromPaper(typed);
  if (!r.ok) { say(`REFUSED — ${r.problem}. Nothing was written.`); return 2; }
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(path.join(folder, KEY_FILE))) { say(`REFUSED — ${folder} already holds a key file; choose an empty folder.`); return 2; }
  writeOnce(fs, path.join(folder, KEY_FILE), r.privatePem, 0o600);
  say(`KEY RESTORED — ${path.join(folder, KEY_FILE)}. Check it: issue one test licence and "show" it with your public key.`);
  return 0;
}
