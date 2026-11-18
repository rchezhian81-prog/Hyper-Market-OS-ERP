#!/usr/bin/env node
// The relay's LINK DESK — OB-840 · ADR-0035. Node built-ins only; no secret is ever read or written here.
//
//   node link-desk.mjs serve                    the pairing desk behind the proxy (/remote-link/ask), in its container
//   node link-desk.mjs code <pins.json> <jwks.json>
//                                               print the LINK CODE for the keys this server publishes (setup-relay.sh)
//   node link-desk.mjs pending <folder>         list the pairing requests waiting, one JSON line each (sre-relay)
//
// The store computer sends its PUBLIC key here when the owner runs `remote-access setup`. The desk only writes it down,
// with its PAIRING CODE, in the pending folder: nothing is trusted until the owner runs `sudo sre-relay approve-link` on
// this server and types the code the store computer showed. At most five requests wait at once, each for thirty
// minutes; anything else is refused. Only an ed25519 key is taken.

import { createServer } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkCode, pairingCode, publicKeyCore } from '../../scripts/lib/remote-link-code.mjs';

export const MAX_PENDING = 5;
export const PENDING_MS = 30 * 60_000;
const MAX_BODY = 2048;

/** The waiting requests in `dir` that are still in time (older ones are removed). */
export function pendingIn(dir, nowMs, fs = { readdirSync, readFileSync, statSync, unlinkSync }) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[A-Z0-9-]{9}\.json$/.test(n)); } catch { return out; }
  for (const n of names) {
    const file = join(dir, n);
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof p.at !== 'string' || nowMs - Date.parse(p.at) > PENDING_MS) { fs.unlinkSync(file); continue; }
      out.push(p);
    } catch { /* not ours: left alone */ }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** One pairing request: 202 with its code, or a refusal in the three-part words. Pure apart from `write`. */
export function ask(body, from, nowMs, existing, write) {
  const refuse = (status, code, whatHappened) => ({ status, body: { error: { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Run remote-access setup again at the store computer.' } } });
  let o;
  try { o = JSON.parse(body); } catch { return refuse(400, 'not_readable', 'The request could not be read.'); }
  const key = publicKeyCore(o?.publicKey);
  if (key === undefined || !key.startsWith('ssh-ed25519 ')) return refuse(400, 'not_a_key', 'That is not a store computer\'s public key.');
  const code = pairingCode(key);
  if (existing.some((p) => p.code === code)) return { status: 202, body: { pairingCode: code, waiting: true } };
  if (existing.length >= MAX_PENDING) return refuse(429, 'too_many_waiting', 'Too many pairing requests are waiting on this server.');
  write(code, { code, publicKey: key, at: new Date(nowMs).toISOString(), from: String(from ?? 'unknown').slice(0, 64) });
  return { status: 202, body: { pairingCode: code, waiting: true } };
}

function serve() {
  const dir = process.env.LINK_DESK_PENDING ?? '/data/pending';
  mkdirSync(dir, { recursive: true });
  const server = createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/remote-link/ask') { req.resume(); reply(404, { error: { code: 'not_found', whatHappened: 'There is no such page here.', wasItSaved: 'not_saved', nextSafeAction: 'Open your shop\'s address.' } }); return; }
    let size = 0;
    const parts = [];
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) parts.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) { reply(413, { error: { code: 'too_large', whatHappened: 'That is too large to be a public key.', wasItSaved: 'not_saved', nextSafeAction: 'Run remote-access setup again at the store computer.' } }); return; }
      const now = Date.now();
      const out = ask(Buffer.concat(parts).toString('utf8'), String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim(), now, pendingIn(dir, now), (code, record) => {
        writeFileSync(join(dir, `${code}.json`), `${JSON.stringify(record)}\n`, { mode: 0o644 });
      });
      process.stdout.write(`${new Date(now).toISOString()} pairing request: ${out.status}${out.body.pairingCode ? ` ${out.body.pairingCode}` : ''}\n`);
      reply(out.status, out.body);
    });
  });
  server.listen(Number(process.env.PORT ?? 8094), () => process.stdout.write(`link desk on :${process.env.PORT ?? 8094}\n`));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
}

const [cmd, a, b] = process.argv.slice(2);
if (process.argv[1] !== undefined && /link-desk\.mjs$/.test(process.argv[1])) {
  if (cmd === 'serve') serve();
  else if (cmd === 'code') {
    const pins = JSON.parse(readFileSync(a, 'utf8'));
    const code = linkCode(pins.hostKeys, JSON.parse(readFileSync(b, 'utf8')));
    if (code === undefined) { process.stderr.write('No link code: the server has no host key or the sign-in server has no signing key yet.\n'); process.exit(1); }
    process.stdout.write(`${code}\n`);
  } else if (cmd === 'pending') {
    for (const p of pendingIn(a, Date.now())) process.stdout.write(`${JSON.stringify(p)}\n`);
  } else {
    process.stderr.write('Usage: node link-desk.mjs serve | code <pins.json> <jwks.json> | pending <folder>\n');
    process.exit(2);
  }
}
