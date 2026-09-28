// Hosted demo — OFFLINE / RECONNECT + CONCURRENT TILLS drill (runbook §9.4). Non-production, synthetic.
//
// Uses the REAL till code (`bootPos` from apps/pos) whose durable write goes through the REAL lane socket
// into the REAL store-edge container (the socket is loopback inside the container, by design — so the
// post is made from inside it, exactly as a till on that box would). Then:
//   1. OFFLINE  — the cloud API is stopped; two tills ring sales at the same moment; every sale must be
//                 durably committed at the edge, and the cloud must have NONE of them (P-01, hard rule #1).
//   2. RECONNECT — the API is started; the edge's own sync loop must deliver every sale, exactly once.
//   3. REPLAY    — one sale is posted to the lane again; the cloud must still hold each sale once (§31.1).
// Evidence is read from the ledger by sale id. Nothing here mints a token or writes the ledger directly.
//
//   pnpm run drill:offline

import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { bootPos, type DurableWrite } from '../../../apps/pos/src/browser-entry';

const EDGE = 'sre-pilot-edge-1';
const API = 'sre-pilot-api-1';
const DB = 'sre-pilot-db-1';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8' }).trim();

/** POST one till record to the lane socket, from inside the edge container (where loopback is). */
const IN_CONTAINER = `let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',async()=>{try{const r=await fetch('http://127.0.0.1:'+process.env.EDGE_LANE_PORT+'/lane/sales',{method:'POST',headers:{'content-type':'application/json'},body:s});process.stdout.write(await r.text())}catch(e){process.stdout.write(JSON.stringify({committed:false,detail:String(e)}))}})`;

const laneWrite: DurableWrite = async (_saleId, record) => {
  const run = spawnSync('docker', ['exec', '-i', EDGE, 'node', '-e', IN_CONTAINER], { input: record, encoding: 'utf8' });
  if (run.status !== 0) return { committed: false, detail: `lane post failed: ${run.stderr.trim()}` };
  return JSON.parse(run.stdout) as Awaited<ReturnType<DurableWrite>>;
};

/** The recorded till records, so one can be replayed verbatim. */
const written = new Map<string, string>();
const recordingWrite: DurableWrite = async (saleId, record) => { written.set(saleId, record); return laneWrite(saleId, record); };

function sql(query: string): string {
  const env = Object.fromEntries(readFileSync('infra/compose/.env.pilot', 'utf8').split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return docker('exec', DB, 'psql', '-U', env['POSTGRES_USER']!, '-d', env['POSTGRES_DB']!, '-tAc', query);
}
const bankedCount = (ids: readonly string[]): number => Number(sql(
  `select count(*) from event_ledger where type = 'SaleCommitted' and payload->>'saleId' in (${ids.map((i) => `'${i.replace(/'/g, '')}'`).join(',')})`,
));
const bankedDistinct = (ids: readonly string[]): number => Number(sql(
  `select count(distinct payload->>'saleId') from event_ledger where type = 'SaleCommitted' and payload->>'saleId' in (${ids.map((i) => `'${i.replace(/'/g, '')}'`).join(',')})`,
));

async function waitUntil(what: string, check: () => boolean, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (check()) return Date.now() - t0;
    await sleep(5000);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${what}`);
}

async function main(): Promise<number> {
  // Preconditions: the edge is running, with a lane socket and a cloud to drain to.
  if (docker('inspect', '-f', '{{.State.Running}}', EDGE) !== 'true') throw new Error('the store edge is not running');
  if (docker('exec', EDGE, 'printenv', 'EDGE_LANE_PORT') === '') throw new Error('the edge has no lane socket (EDGE_LANE_PORT)');
  if (docker('exec', EDGE, 'printenv', 'CLOUD_API_URL') === '') throw new Error('the edge is not configured to sync (CLOUD_API_URL)');

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const tradingDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const lane1 = bootPos({ laneId: 'drill-lane-1', cashierId: 'pilot-cashier', tradingDay, durable: recordingWrite });
  const lane2 = bootPos({ laneId: 'drill-lane-2', cashierId: 'pilot-cashier', tradingDay, durable: recordingWrite });
  const ids = [`DRILL-${stamp}-L1-1`, `DRILL-${stamp}-L2-1`, `DRILL-${stamp}-L1-2`];

  // ── 1. OFFLINE ──────────────────────────────────────────────────────────────
  console.log(`[${new Date().toISOString()}] OFFLINE — stopping the cloud API`);
  docker('stop', API);
  const t0 = Date.now();
  lane1.scan({ productId: 'prod-soap', description: 'Demo Bath Soap 100g (demo)', unitPriceMinor: 3500, qty: 2 });
  lane2.scan({ productId: 'prod-brush', description: 'Demo Toothbrush (demo)', unitPriceMinor: 2500, qty: 1 });
  // Two tills at the same moment.
  const [r1, r2] = await Promise.all([
    lane1.tenderCash(ids[0]!, `DR-${stamp}-1`, new Date().toISOString()),
    lane2.tenderCash(ids[1]!, `DR-${stamp}-2`, new Date().toISOString()),
  ]);
  lane1.scan({ productId: 'prod-brush', description: 'Demo Toothbrush (demo)', unitPriceMinor: 2500, qty: 3 });
  const r3 = await lane1.tenderCash(ids[2]!, `DR-${stamp}-3`, new Date().toISOString());
  const offlineMs = Date.now() - t0;
  const receipts = [r1, r2, r3];
  console.log(`  receipts while offline: ${JSON.stringify(receipts)} in ${offlineMs} ms`);
  if (receipts.some((r) => r === null || r === undefined)) throw new Error('a till could not commit a sale while the cloud was down');
  const cloudWhileOffline = bankedCount(ids);
  console.log(`  cloud holds ${cloudWhileOffline} of the ${ids.length} sales (expect 0)`);
  await sleep(20_000); // let the edge try, fail, and back off — the sales must stay queued, not be lost

  // ── 2. RECONNECT ────────────────────────────────────────────────────────────
  console.log(`[${new Date().toISOString()}] RECONNECT — starting the cloud API`);
  docker('start', API);
  const tDown = Date.now() - t0;
  const drainedAfterMs = await waitUntil('every sale banked in the cloud', () => bankedDistinct(ids) === ids.length, 8 * 60_000);
  console.log(`  cloud was unreachable ~${Math.round(tDown / 1000)} s; all ${ids.length} sales banked ${Math.round(drainedAfterMs / 1000)} s after reconnect`);

  // ── 3. REPLAY ───────────────────────────────────────────────────────────────
  const replay = await laneWrite(ids[0]!, written.get(ids[0]!)!);
  console.log(`  replayed ${ids[0]} to the lane: committed=${String(replay.committed)} (${replay.detail})`);
  await sleep(45_000); // at least two edge sync passes
  const events = bankedCount(ids);
  const distinct = bankedDistinct(ids);
  console.log(`  cloud SaleCommitted events for the drill: ${events} (distinct sales ${distinct}; expect ${ids.length} and ${ids.length})`);

  const ok = cloudWhileOffline === 0 && distinct === ids.length && events === ids.length;
  console.log(ok ? 'GREEN — offline trading, concurrent tills and exactly-once sync all hold on the host.' : 'RED — see the lines above.');
  return ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`RED — ${err instanceof Error ? err.message : String(err)}`);
  // Never leave the demo's cloud down because the drill failed.
  try { if (docker('inspect', '-f', '{{.State.Running}}', API) !== 'true') { docker('start', API); console.error('  (the cloud API was restarted)'); } } catch { /* reported above */ }
  process.exitCode = 1;
}
