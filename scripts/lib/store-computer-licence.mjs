// `store-computer licence` — the shop's licence at the store PC's keyboard (CR-01 step 5 · OI-10 · OB-710).
//
//   licence                         its standing in plain words (and what is limited, if anything)
//   licence --load <licence file>   load a licence the seller sent (checked offline: signature, terms, THIS shop)
//   licence --request [--out <dir>] write the licence request to send the seller (tenant id, shop name, GSTIN — names only)
//
// The same folder, history and checks as the Licence screen and the first-run screens (scripts/lib/store-licence.mjs).
// Run by an administrator at this PC's keyboard; every load and refusal is written to the append-only history.
// Exit: 0 done (or in force) · 1 not done / reduced mode · 2 refused.

import { loadSettings, pathFor } from './store-computer.mjs';
import { tillFolders } from './store-computer-recovery.mjs';
import { LICENCE_DIR, licenceNow, loadLicence, requestFor, sellerKeys } from './store-licence.mjs';
import { releaseInfo } from './store-computer-setup.mjs';

/** The request the first-run screens leave (with the shop's name and GSTIN), in the licence folder. */
export const REQUEST_FILE = 'licence-request.json';

/** The shop's identity as this PC knows it: the tenant id from its settings; name and GSTIN from the setup's request. */
export function shopIdentity(deps, edgeData) {
  const { settings } = loadSettings(deps);
  const p = pathFor(deps.platform);
  let kept = {};
  try { kept = JSON.parse(deps.fs.readFileSync(p.join(edgeData, LICENCE_DIR, REQUEST_FILE), 'utf8')); } catch { /* none */ }
  return {
    tenantId: settings?.EDGE_TENANT_ID === undefined ? undefined : String(settings.EDGE_TENANT_ID).trim(),
    ...(typeof kept.shopName === 'string' ? { shopName: kept.shopName } : {}),
    ...(typeof kept.gstin === 'string' ? { gstin: kept.gstin } : {}),
  };
}

export async function licenceCommand(deps, { load, request, out }) {
  const { say } = deps;
  const { L, settings } = loadSettings(deps);
  if (settings === undefined) { say('REFUSED — this PC is not set up yet (no settings file). Run SRE-Setup.exe first.'); return 2; }
  const p = pathFor(deps.platform);
  const io = { fs: deps.fs, path: p };
  const { edgeData } = tillFolders(deps, L);
  const keys = sellerKeys(io, deps.repoRoot);
  const shop = shopIdentity(deps, edgeData);
  const now = deps.now ?? (() => new Date());
  if (load !== undefined) {
    let text;
    try { text = deps.fs.readFileSync(p.resolve(load), 'utf8'); } catch { say(`REFUSED — ${load} could not be read.`); return 2; }
    const r = loadLicence(io, edgeData, { text, keys, shop, by: 'administrator at the store PC keyboard', via: 'store_computer_tool', now });
    say(r.ok ? r.en : `REFUSED — ${r.en}${r.detail === undefined ? '' : ` (${r.detail})`}`);
    say(r.ok ? r.ta : r.ta);
    return r.ok ? 0 : 2;
  }
  if (request === true) {
    if (shop.tenantId === undefined) { say('REFUSED — this PC\'s settings name no tenant id.'); return 2; }
    const req = requestFor({ tenantId: shop.tenantId, shopName: shop.shopName, gstin: shop.gstin, release: releaseInfo(deps)?.version }, now);
    const dir = out === undefined ? p.join(edgeData, LICENCE_DIR) : p.resolve(out);
    deps.fs.mkdirSync(dir, { recursive: true });
    const file = p.join(dir, `licence-request-${shop.tenantId.slice(0, 8)}.json`);
    deps.fs.writeFileSync(file, `${JSON.stringify(req, null, 2)}\n`, 'utf8');
    say(`LICENCE REQUEST WRITTEN — ${file}`);
    say(`  Tenant id ${shop.tenantId}${shop.shopName === undefined ? '' : `, ${shop.shopName}`}${shop.gstin === undefined ? '' : `, GSTIN ${shop.gstin}`}. Send this file to the seller; it holds no secret.`);
    return 0;
  }
  const n = licenceNow(io, edgeData, { keys, shop, now });
  const s = n.standing;
  say(`Licence: ${s.state.toUpperCase().replace(/_/g, ' ')} — ${s.en}`);
  say(`  ${s.ta}`);
  if (s.licence !== null) say(`  ${s.licence.licenceId}: ${s.licence.shopName}, GSTIN ${s.licence.gstin}, ${s.licence.tills} till(s), ${s.licence.stores} store(s), modules ${s.licence.modules.join(',')}, ${s.licence.expiresOn === null ? 'no end date' : `ends ${s.licence.expiresOn}`}.`);
  if (n.problem !== undefined && !n.problem.ok) say(`  The licence file on this PC is NOT in force: ${n.problem.en}${n.problem.detail === undefined ? '' : ` (${n.problem.detail})`}`);
  say(`  This shop's tenant id: ${shop.tenantId ?? 'not known'}. The till sells whatever the licence says; every record can always be viewed and exported.`);
  return s.state === 'reduced' ? 1 : 0;
}
