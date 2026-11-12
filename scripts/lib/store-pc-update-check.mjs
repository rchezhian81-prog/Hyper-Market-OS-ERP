// The store PC LEARNS OF A NEWER RELEASE (CR-01 step 3b · OI-05 · OB-717 · OB-721 "C" · P-04 · P-08 · hard rule #1 · #4).
//
//   store-computer check-update        ask GitHub for the newest store PC release and read its signed update record
//   store-computer update-key          keep a read-only download key (only needed if the project is made private)
//   store-computer update-key --remove forget it
//
// What it does, in order, and nothing more (nothing is downloaded but the small update record; nothing is installed —
// that is step 3d, behind the owner's PIN in step 3c):
//   1. The running release (release.json) and the release public key that came with it (release-signing.pub).
//   2. GitHub's "latest release" of this one project — with the download key when one is kept (OB-721 "C": the project
//      is public today, so none is needed; a private project needs one).
//   3. Its update.json, and the signature over its version, commit and fingerprint, checked with the running release's
//      public key. The setup program's own fingerprint is checked in step 3d, after it is downloaded.
//   4. One of four answers, said in plain words and kept in status\update-check.json for the Office page (step 3c):
//        up-to-date · available (newer, signed, verifies) · not-installable (newer, but unsigned or not verifying, or
//        this PC has no public key) · could-not-check (no internet, GitHub not answering, the key refused …).
// It never touches the tills or the database (hard rule #1: a sale never waits on it), and the key is never said,
// logged or written anywhere but its own file in the shop's locked data folder (hard rule #4).

import { pathFor } from './store-computer.mjs';
import { RELEASE_MARKER } from './store-computer-setup.mjs';
import { UPDATE_KIND, UPDATE_RECORD, compareVersions, isReleaseVersion, verifyUpdate } from './store-pc-update.mjs';

/** The one project the store PC takes releases from (OB-717). */
export const UPDATE_REPO = 'rchezhian81-prog/Hyper-Market-OS-ERP';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const UPDATE_KEY_FILE = 'update-key';
export const UPDATE_STATE_FILE = 'update-check.json';
export const PUBLIC_KEY_FILE = 'release-signing.pub';

/** A GitHub read-only key: a fine-grained token (github_pat_…) or a classic one (ghp_…). Nothing else is kept. */
export const KEY_SHAPE = /^(github_pat_[A-Za-z0-9_]{22,255}|ghp_[A-Za-z0-9]{36,255})$/;

const where = (deps, L) => {
  const p = pathFor(deps.platform);
  const dataRoot = L.dataRoot ?? deps.dataRoot;
  return {
    keyFile: dataRoot === undefined ? undefined : p.join(dataRoot, UPDATE_KEY_FILE),
    stateFile: L.statusDir === undefined ? undefined : p.join(L.statusDir, UPDATE_STATE_FILE),
    statusDir: L.statusDir,
    releaseFile: p.join(deps.repoRoot, RELEASE_MARKER),
    publicKey: p.join(deps.repoRoot, PUBLIC_KEY_FILE),
  };
};

const readText = (fs, file) => { try { return file !== undefined && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined; } catch { return undefined; } };

/** The kept download key, or undefined. Never said. */
export function keptKey(deps, L) {
  const t = readText(deps.fs, where(deps, L).keyFile)?.trim();
  return t !== undefined && KEY_SHAPE.test(t) ? t : undefined;
}

function headers(key, accept) {
  const h = { accept, 'user-agent': 'sre-store-pc-update-check', 'x-github-api-version': '2022-11-28' };
  if (key !== undefined) h.authorization = `Bearer ${key}`;
  return h;
}

/** Keep the answer for the Office page. A failure to keep it is said, never fatal. */
function keep(deps, w, state) {
  if (w.stateFile === undefined) return;
  try {
    deps.fs.mkdirSync(w.statusDir, { recursive: true });
    const tmp = `${w.stateFile}.tmp`;
    deps.fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    deps.fs.renameSync(tmp, w.stateFile);
  } catch (e) {
    deps.say(`(The answer could not be kept for the Office page: ${e.message})`);
  }
}

/**
 * Ask GitHub for the newest release. Returns { code, state }: code 0 when GitHub answered (whatever the answer), 1 when
 * it could not be asked. `state` is what is kept in status\update-check.json.
 */
export async function checkForUpdate(deps, L) {
  const w = where(deps, L);
  const checkedAt = deps.now().toISOString();
  let running;
  try { running = JSON.parse(readText(deps.fs, w.releaseFile) ?? 'null')?.version; } catch { running = undefined; }
  const publicKey = readText(deps.fs, w.publicKey);
  const key = keptKey(deps, L);
  const base = { kind: 'sre-store-pc-update-check-v1', checkedAt, running: running ?? null, withKey: key !== undefined };

  const finish = (code, state, line) => {
    const full = { ...base, ...state };
    keep(deps, w, full);
    deps.say(line);
    return { code, state: full };
  };
  const couldNot = (why) => finish(1, { state: 'could-not-check', latest: null, said: why }, `COULD NOT CHECK — ${why}. The shop keeps working as it is; try again later.`);

  if (deps.web === undefined) return couldNot('this PC has no way to reach the internet from the store-computer tool');

  // 2. The newest release.
  let res;
  try { res = await deps.web(LATEST_RELEASE_URL, headers(key, 'application/vnd.github+json')); } catch {
    return couldNot('GitHub did not answer (no internet, or GitHub is down)');
  }
  if (res.status === 401 || res.status === 403) {
    return couldNot(key === undefined ? `GitHub refused the question (${res.status}) — it may be limiting how often it is asked; wait an hour` : `GitHub refused the download key (${res.status}) — it may have expired; make a new one and keep it with: store-computer update-key`);
  }
  if (res.status === 404) {
    return couldNot(key === undefined ? 'GitHub has no release to give this PC — if the project was made private, keep a download key with: store-computer update-key' : 'GitHub has no release to give this PC — the download key may not reach this project');
  }
  if (res.status !== 200) return couldNot(`GitHub answered ${res.status}`);
  let release;
  try { release = JSON.parse(await res.text()); } catch { return couldNot('GitHub\'s answer could not be read'); }
  const asset = Array.isArray(release?.assets) ? release.assets.find((a) => a?.name === UPDATE_RECORD) : undefined;
  if (asset === undefined || typeof asset.url !== 'string') {
    return couldNot(`the newest release (${release?.tag_name ?? 'unnamed'}) has no ${UPDATE_RECORD}`);
  }

  // 3. Its update record.
  let recRes;
  try { recRes = await deps.web(asset.url, headers(key, 'application/octet-stream')); } catch {
    return couldNot(`the ${UPDATE_RECORD} of ${release.tag_name} could not be downloaded`);
  }
  if (recRes.status !== 200) return couldNot(`the ${UPDATE_RECORD} of ${release.tag_name} could not be downloaded (${recRes.status})`);
  let record;
  try { record = JSON.parse(await recRes.text()); } catch { record = undefined; }
  if (record?.kind !== UPDATE_KIND || !isReleaseVersion(record?.version)) {
    return couldNot(`the ${UPDATE_RECORD} of ${release.tag_name} is not one this PC understands`);
  }
  const latest = record.version;
  const tag = release.tag_name ?? null;

  // 4. The answer.
  if (isReleaseVersion(running) && compareVersions(latest, running) <= 0) {
    return finish(0, { state: 'up-to-date', latest, tag, said: `version ${running} is the newest` }, `UP TO DATE — this PC runs version ${running}, the newest.`);
  }
  const notInstallable = (why) => finish(0, { state: 'not-installable', latest, tag, said: why }, `A NEWER VERSION EXISTS BUT CANNOT BE INSTALLED — ${why}.`);
  if (record.signature === null || record.signature === undefined) return notInstallable(`version ${latest} is NOT SIGNED`);
  if (publicKey === undefined || publicKey.trim() === '') return notInstallable(`this PC's version (${running ?? 'unknown'}) carries no release public key to check the signature with — install version 1.0.2005 or newer by hand once`);
  if (!verifyUpdate({ version: record.version, commit: record.commit, sha256: record.sha256 }, publicKey, record.signature)) {
    return notInstallable(`the signature on version ${latest} does not verify with this PC's release public key`);
  }
  return finish(0, { state: 'available', latest, tag, commit: record.commit, sha256: record.sha256, said: `version ${latest} is ready, signed and checked` },
    `A NEWER VERSION IS READY — version ${latest} (this PC runs ${running ?? 'an unknown version'}). It is signed and the signature checks. The owner can install it from the Office page once step 3c is in.`);
}

/** `check-update`. */
export async function checkUpdateCommand(deps, L) {
  return (await checkForUpdate(deps, L)).code;
}

/** `update-key` (typed with nothing shown) and `update-key --remove`. The key is never said. */
export async function updateKeyCommand(deps, L, { remove = false } = {}) {
  const w = where(deps, L);
  if (w.keyFile === undefined) { deps.say('REFUSED — this PC has no shop data folder yet; run the setup first.'); return 2; }
  if (remove) {
    if (deps.fs.existsSync(w.keyFile)) deps.fs.rmSync(w.keyFile, { force: true });
    deps.say('The download key is forgotten. While the project is public, updates are still found without one.');
    return 0;
  }
  if (deps.askSecret === undefined) { deps.say('REFUSED — the key must be typed (or pasted) here, with nothing shown; there is no keyboard on this run.'); return 2; }
  const typed = (await deps.askSecret('Paste the read-only download key (nothing will show), then press Enter: '))?.trim() ?? '';
  if (!KEY_SHAPE.test(typed)) {
    deps.say('REFUSED — that is not a GitHub key (it starts with github_pat_ or ghp_). Nothing was kept.');
    return 2;
  }
  const tmp = `${w.keyFile}.tmp`;
  deps.fs.writeFileSync(tmp, `${typed}\n`, { encoding: 'utf8', mode: 0o600 });
  deps.fs.renameSync(tmp, w.keyFile);
  deps.say("The download key is kept in the shop's locked data folder. It is never shown again. Checking that GitHub accepts it …");
  const { state } = await checkForUpdate(deps, L);
  return state.state === 'could-not-check' ? 1 : 0;
}
