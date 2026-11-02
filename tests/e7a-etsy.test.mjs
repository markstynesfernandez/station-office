// e7a-etsy.test.mjs — E7a, owner decisions 2 and 3 (19/10/2026; DECISIONS.md "E7a"): the own-shop Etsy connection, all
// against the MOCK Etsy (providers/etsy-mock.mjs; no network, FIXTURE keys and shop). The real client refuses off the live
// instance and without its keys; OAuth 2.0 with PKCE (S256) and a single-use state; the pasted callback; the token
// encrypted at rest, refreshed (before expiry and once on a 401), deleted on disconnect; read scopes only; the rate limiter
// and Retry-After backoff on a 429; the cache within the Terms' limits; one ledger row per call (kind etsy, USD 0); no
// token in a log, a ledger row, a status or a page response; the server actions behind the usual write checks; the page's
// builders and the Terms' notice in the footer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createEngineServer } from '../src/server/engine-server.mjs';
import { createLedger } from '../src/engine/ledger.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { createEtsyClient, etsySettings, createRateLimiter, createTokenStore, parseCallback, pkcePair, b64url, retryAfterMs, EtsyError } from '../src/engine/providers/etsy.mjs';
import { createMockEtsyApi, createMockEtsyClient, MOCK_KEYS, MOCK_LISTINGS } from '../src/engine/providers/etsy-mock.mjs';
import { etsyStatusHtml, etsyButtonLabel, connectStepsHtml, isLive } from '../src/web/ui/etsy.js';

const ENGINE = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'engine.json'), 'utf8'));
const LIVE_ENV = { STATION_INSTANCE: 'live', ETSY_API_KEY: MOCK_KEYS.apiKey, ETSY_SHARED_SECRET: MOCK_KEYS.sharedSecret, ETSY_TOKEN_KEY: 'test-token-key-0123456789-abcdefghijklmnop' };
const T0 = Date.parse('2026-10-19T10:00:00Z');

// a fake clock: sleep advances it (no real waits)
function clock() { const c = { t: T0, slept: [] }; c.now = () => c.t; c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; }; return c; }
// the REAL client (live instance env) on the mock Etsy
function live(t, { api = null, env = LIVE_ENV, cfg = ENGINE } = {}) {
  const r = tempRoot('e7a-etsy'), c = clock();
  t.after(() => r.cleanup());
  const mock = api || createMockEtsyApi({ now: c.now });
  const ledger = createLedger({ J: r.J, log: r.log });
  const client = createEtsyClient({ engineCfg: cfg, env, J: r.J, ledger, log: r.log, fetchImpl: mock.fetch, now: c.now, sleep: c.sleep });
  return { r, c, mock, ledger, client };
}
async function connect(x) { const s = x.client.startConnect(); return { s, st: await x.client.finishConnect(x.mock.approve(s.authorizeUrl)) }; }
const logText = (r) => (fs.existsSync(r.logs) ? fs.readdirSync(r.logs).map((f) => fs.readFileSync(path.join(r.logs, f), 'utf8')).join('\n') : '');
const tokenFile = (r) => path.join(r.dataRoot, 'etsy', 'token.enc.json');

test('the real client refuses off the live instance and without its keys; the dev instance gets the mock', (t) => {
  const r = tempRoot('e7a-refuse'); t.after(() => r.cleanup());
  const ledger = createLedger({ J: r.J, log: r.log });
  for (const env of [{}, { STATION_INSTANCE: 'dev' }, { ...LIVE_ENV, STATION_INSTANCE: 'dev' }]) assert.throws(() => createEtsyClient({ engineCfg: ENGINE, env, J: r.J, ledger, log: r.log, fetchImpl: () => { throw new Error('no call'); } }), (e) => e instanceof EtsyError && e.code === 'NOT_LIVE');
  for (const k of ['ETSY_API_KEY', 'ETSY_SHARED_SECRET', 'ETSY_TOKEN_KEY']) assert.throws(() => createEtsyClient({ engineCfg: ENGINE, env: { ...LIVE_ENV, [k]: '' }, J: r.J, ledger, log: r.log }), (e) => e.code === 'NO_KEY' && e.message.includes(k));
  assert.throws(() => createEtsyClient({ engineCfg: ENGINE, env: { ...LIVE_ENV, ETSY_TOKEN_KEY: 'short' }, J: r.J, ledger, log: r.log }), (e) => e.code === 'NO_TOKEN_KEY');
  const m = createMockEtsyClient({ engineCfg: ENGINE, J: r.J, ledger, log: r.log });
  assert.equal(m.mode, 'mock'); assert.equal(ledger.rows().length, 0, 'building makes no call');
  // the server start-up picks by instance (src/server/index.mjs)
  const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'server', 'index.mjs'), 'utf8');
  assert.match(src, /if \(inst\.name === 'live'\) \{ const \{ createEtsyClient \}/); assert.match(src, /else \{ const \{ createMockEtsyClient \}/);
});

test('settings: read scopes only, the cache within the Terms (6 h listings, 24 h other), an https redirect URI', () => {
  const s = etsySettings(ENGINE, {});
  assert.deepEqual(s.scopes, ['shops_r', 'listings_r']); assert.equal(s.redirectUri, 'https://localhost/station/etsy-callback');
  assert.ok(s.listingsTtlMs <= 6 * 3600e3 && s.shopTtlMs <= 24 * 3600e3);
  assert.equal(etsySettings(ENGINE, { ETSY_REDIRECT_URI: 'https://example.org/cb' }).redirectUri, 'https://example.org/cb');
  const bad = (patch, env = {}) => assert.throws(() => etsySettings({ etsy: { ...ENGINE.etsy, ...patch } }, env), (e) => e.code === 'CONFIG', JSON.stringify(patch));
  bad({ scopes: ['shops_r', 'listings_w'] }); bad({ scopes: ['transactions_r'] }); bad({ scopes: [] });
  bad({ listingsTtlMs: 6 * 3600e3 + 1 }); bad({ shopTtlMs: 24 * 3600e3 + 1 });
  bad({ redirectUri: 'http://localhost:8790/cb' }); bad({}, { ETSY_REDIRECT_URI: 'https://x.example/cb?a=1' });
  bad({ tokenUrl: 'https://evil.example.com/token' }); bad({ notice: '' });
  assert.equal(ENGINE.etsy.notice, 'The term \'Etsy\' is a trademark of Etsy, Inc. This Application uses Etsy\'s API, but is not endorsed or certified by Etsy.');
});

test('OAuth: PKCE (S256) and state on the authorize URL, the code exchange with the verifier, the shop and scopes; the token encrypted at rest', async (t) => {
  const x = live(t);
  const s = x.client.startConnect(), u = new URL(s.authorizeUrl), q = u.searchParams;
  assert.equal(u.origin + u.pathname, 'https://www.etsy.com/oauth/connect');
  assert.equal(q.get('response_type'), 'code'); assert.equal(q.get('client_id'), MOCK_KEYS.apiKey); assert.equal(q.get('redirect_uri'), 'https://localhost/station/etsy-callback');
  assert.equal(q.get('scope'), 'shops_r listings_r'); assert.match(s.authorizeUrl, /scope=shops_r%20listings_r/);
  assert.equal(q.get('code_challenge_method'), 'S256'); assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/); assert.match(q.get('state'), /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!s.authorizeUrl.includes(MOCK_KEYS.sharedSecret), 'the shared secret never leaves the server');
  const st = await x.client.finishConnect(x.mock.approve(s.authorizeUrl));
  assert.equal(st.connected, true); assert.equal(st.shop.name, 'FixtureShopMock'); assert.deepEqual(st.scopes, ['shops_r', 'listings_r']);
  assert.deepEqual(st.listings.items.map((l) => l.id), MOCK_LISTINGS.map((l) => l.listing_id)); assert.deepEqual(st.listings.items[0].price, { amount: 4.5, currency: 'USD' });
  // the token request: form-encoded, the verifier whose SHA256 is the challenge, no API key header (Etsy's example)
  const tok = x.mock.calls.find((c) => c.path === '/v3/public/oauth/token');
  assert.equal(tok.apiKey, false); assert.equal(tok.bearer, false);
  for (const c of x.mock.calls.filter((c) => c.path.startsWith('/v3/application/'))) assert.ok(c.apiKey, c.path + ' carries x-api-key');
  // encrypted at rest: no token, no shop name in the file; it decrypts with the key, never with another
  const raw = fs.readFileSync(tokenFile(x.r), 'utf8'), access = [...x.mock.access.keys()][0];
  assert.ok(!raw.includes(access) && !/\d+\.[A-Za-z0-9_-]{20,}/.test(raw) && !raw.includes('FixtureShopMock'));
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['alg', 'data', 'iv', 'kdf', 'salt', 'tag', 'v']);
  assert.equal(createTokenStore({ J: x.r.J, file: tokenFile(x.r), secret: LIVE_ENV.ETSY_TOKEN_KEY }).load().access, access);
  assert.throws(() => createTokenStore({ J: x.r.J, file: tokenFile(x.r), secret: 'another-key-0123456789-abcdefghijklmnop' }).load(), (e) => e.code === 'TOKEN_DECRYPT');
  // a restart reads it back: still connected, no new connect
  const again = createEtsyClient({ engineCfg: ENGINE, env: LIVE_ENV, J: x.r.J, ledger: x.ledger, log: x.r.log, fetchImpl: x.mock.fetch, now: x.c.now, sleep: x.c.sleep });
  assert.equal(again.status().connected, true); assert.equal(again.status().shop.id, 90000001);
});

test('OAuth: the state check (wrong, reused, expired), a denial, a wrong address; the PKCE pair; nothing connected on a refusal', async (t) => {
  const x = live(t);
  const s = x.client.startConnect(), back = x.mock.approve(s.authorizeUrl);
  const forged = back.replace(/state=[^&]+/, 'state=' + b64url(crypto.randomBytes(24)));
  await assert.rejects(x.client.finishConnect(forged), (e) => e.code === 'STATE');
  await assert.rejects(x.client.finishConnect(x.mock.approve(s.authorizeUrl, { deny: true })), (e) => e.code === 'DENIED');
  await assert.rejects(x.client.finishConnect('https://localhost/other?code=a&state=b'), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(x.client.finishConnect('hello'), (e) => e.code === 'BAD_REQUEST');
  assert.equal(x.client.status().connected, false); assert.ok(!fs.existsSync(tokenFile(x.r)));
  await x.client.finishConnect(back);   // the right state works once
  await assert.rejects(x.client.finishConnect(back), (e) => e.code === 'STATE', 'single use');
  // expired: older than connectTtlMs
  const y = live(t), s2 = y.client.startConnect(), b2 = y.mock.approve(s2.authorizeUrl);
  y.c.t += ENGINE.etsy.connectTtlMs + 1;
  await assert.rejects(y.client.finishConnect(b2), (e) => e.code === 'STATE');
  // the pasted forms: the full address, or the query alone
  assert.deepEqual(parseCallback('https://localhost/station/etsy-callback?code=abc&state=xyz', 'https://localhost/station/etsy-callback'), { code: 'abc', state: 'xyz' });
  assert.deepEqual(parseCallback('code=abc&state=xyz', 'https://localhost/station/etsy-callback'), { code: 'abc', state: 'xyz' });
  const p = pkcePair();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/); assert.equal(p.challenge, b64url(crypto.createHash('sha256').update(p.verifier).digest()));
});

test('read scopes only: a token granted a write scope is disconnected at once', async (t) => {
  const x = live(t, { api: createMockEtsyApi({ now: () => T0, grant: ['shops_r', 'listings_r', 'listings_w'] }) });
  const s = x.client.startConnect();
  const back = x.mock.approve(s.authorizeUrl.replace('scope=shops_r%20listings_r', 'scope=shops_r%20listings_r%20listings_w'));
  await assert.rejects(x.client.finishConnect(back), (e) => e.code === 'SCOPES');
  assert.equal(x.client.status().connected, false); assert.ok(!fs.existsSync(tokenFile(x.r)));
});

test('refresh: before expiry and once on a 401; the new refresh token is kept (encrypted); a revoked refresh asks for a reconnect; disconnect deletes the token', async (t) => {
  const x = live(t);
  await connect(x);
  const firstRefresh = [...x.mock.refresh.keys()][0];
  // within a minute of expiry: refreshed first
  x.c.t += 3600 * 1000 - 30000;
  await x.client.listings({ force: true });
  assert.ok(x.mock.calls.some((c) => c.path === '/v3/public/oauth/token' && c.method === 'POST'), 'refreshed');
  assert.ok(!x.mock.refresh.has(firstRefresh), 'the old refresh token was used'); assert.equal(x.mock.refresh.size, 1);
  assert.equal(createTokenStore({ J: x.r.J, file: tokenFile(x.r), secret: LIVE_ENV.ETSY_TOKEN_KEY }).load().refresh, [...x.mock.refresh.keys()][0]);
  // a 401 (the access token revoked early): one refresh, then the call again
  x.mock.expireAccess();
  const tokensBefore = x.mock.calls.filter((c) => c.path === '/v3/public/oauth/token').length;
  const l = await x.client.listings({ force: true });
  assert.equal(l.items.length, 2); assert.equal(x.mock.calls.filter((c) => c.path === '/v3/public/oauth/token').length, tokensBefore + 1);
  // the refresh token revoked: reconnect needed, never a loop
  x.mock.refresh.clear(); x.mock.expireAccess();
  await assert.rejects(x.client.listings({ force: true }), (e) => e.code === 'RECONNECT');
  assert.equal(x.client.status().needsReconnect, true);
  await assert.rejects(x.client.listings({ force: true }), (e) => e.code === 'RECONNECT');
  const d = x.client.disconnect();
  assert.equal(d.connected, false); assert.equal(d.shop, null); assert.ok(!fs.existsSync(tokenFile(x.r)));
  await assert.rejects(x.client.listings(), (e) => e.code === 'NOT_CONNECTED');
});

test('the rate limiter: at most perSecond a second (it waits), perDay a day (it refuses)', async () => {
  const c = clock(), L = createRateLimiter({ perSecond: 2, perDay: 5, now: c.now, sleep: c.sleep });
  await L.acquire(); await L.acquire(); assert.deepEqual(c.slept, []);
  await L.acquire(); assert.equal(c.slept.length, 1); assert.ok(c.slept[0] >= 1 && c.slept[0] <= 1000);
  await L.acquire(); await L.acquire();
  await assert.rejects(L.acquire(), (e) => e.code === 'DAY_LIMIT');
  c.t += 86400000 + 1; await L.acquire();   // a sliding 24 hours
  L.block(5000); const before = c.slept.length; await L.acquire(); assert.equal(c.slept[before], 5000, 'held after a 429');
  assert.equal(retryAfterMs('2'), 2000); assert.equal(retryAfterMs(null), null);
});

test('429: waits the Retry-After, then retries; repeated 429s stop at the retry limit; a 5xx backs off exponentially; every attempt is a ledger row', async (t) => {
  const x = live(t);
  await connect(x);
  x.mock.failNext({ status: 429, retryAfter: 2 });
  const slept = x.c.slept.length;
  await x.client.listings({ force: true });
  assert.ok(x.c.slept.slice(slept).includes(2000), 'waited the Retry-After: ' + x.c.slept.slice(slept));
  x.mock.failNext(...Array(ENGINE.etsy.retries + 1).fill({ status: 429, retryAfter: 1 }));
  await assert.rejects(x.client.listings({ force: true }), (e) => e.code === 'RATE_LIMITED' && e.status === 429);
  x.mock.failNext({ status: 503 }, { status: 503 });
  const s2 = x.c.slept.length;
  await x.client.listings({ force: true });
  assert.deepEqual(x.c.slept.slice(s2).filter((ms) => ms >= ENGINE.etsy.backoffMs), [ENGINE.etsy.backoffMs, ENGINE.etsy.backoffMs * 2]);
  const rows = x.ledger.rows().filter((r) => r.model === 'getListingsByShop');
  assert.ok(rows.some((r) => r.httpStatus === 429) && rows.some((r) => r.httpStatus === 503) && rows.some((r) => r.httpStatus === 200));
});

test('cache: listings read once within their TTL, read again after it; the status never shows listings older than the TTL', async (t) => {
  const x = live(t);
  await connect(x);
  const reads = () => x.mock.calls.filter((c) => /\/listings$/.test(c.path)).length;
  const n = reads();
  const a = await x.client.listings(); assert.equal(a.cached, true); assert.equal(reads(), n);
  x.c.t += ENGINE.etsy.listingsTtlMs - 1000;
  assert.ok(x.client.status().listings, 'still shown inside the TTL');
  x.c.t += 2000;
  assert.equal(x.client.status().listings, null, 'not shown once older than the TTL');
  const b = await x.client.listings(); assert.equal(b.cached, false); assert.equal(reads(), n + 1);
  // the shop: cached within shopTtlMs
  const shopReads = () => x.mock.calls.filter((c) => /\/shops\/\d+$/.test(c.path)).length, s = shopReads();
  await x.client.shop(); assert.equal(shopReads(), s);
  x.c.t += ENGINE.etsy.shopTtlMs + 1; await x.client.shop(); assert.equal(shopReads(), s + 1);
});

test('the ledger: one row per Etsy call, kind etsy, USD 0, the operation and status; no token in a row, the status, a log line', async (t) => {
  const x = live(t);
  const { st } = await connect(x);
  const rows = x.ledger.rows();
  assert.deepEqual(rows.map((r) => r.model), ['oauth-token', 'tokenScopes', 'getMe', 'getShop', 'getListingsByShop']);
  for (const r of rows) { assert.equal(r.kind, 'etsy'); assert.equal(r.usd, 0); assert.equal(r.provider, 'etsy'); assert.equal(r.jobId, null); assert.equal(r.httpStatus, 200); }
  assert.equal(x.ledger.totals.usd, 0);
  x.mock.expireAccess(); await x.client.listings({ force: true });   // a refresh too
  const secrets = [...x.mock.access.keys(), ...x.mock.refresh.keys(), ...[...x.mock.codes.keys()], MOCK_KEYS.sharedSecret, MOCK_KEYS.apiKey, LIVE_ENV.ETSY_TOKEN_KEY];
  const ledgerText = fs.readFileSync(x.ledger.file, 'utf8'), logs = logText(x.r), status = JSON.stringify(x.client.status()) + JSON.stringify(st);
  assert.ok(logs.length > 0, 'the client logged');
  for (const s of secrets) { assert.ok(!ledgerText.includes(s), 'ledger'); assert.ok(!logs.includes(s), 'logs'); assert.ok(!status.includes(s), 'status'); }
  assert.doesNotMatch(logs + ledgerText + status, /\b\d{3,}\.[A-Za-z0-9_-]{20,}/, 'no token-shaped text');
  // the logger also redacts a token by its shape, before anyone registered it
  x.r.log.info('etsy test line', { t: '12345678.abcdefghijklmnopqrstuvwxyzABCD' });
  assert.match(logText(x.r), /<redacted-token>/); assert.doesNotMatch(logText(x.r), /12345678\.abcdefghijklmnopqrstuvwxyzABCD/);
});

// ---- the server and the page

async function server(t) {
  const r = tempRoot('e7a-srv');
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  const etsy = createMockEtsyClient({ engineCfg: engine.cfg.engine, J: r.J, ledger: engine.ledger, log: r.log });
  const es = createEngineServer({ engine, log: r.log, etsy });
  await new Promise((res) => es.server.listen(0, '127.0.0.1', res));
  const port = es.server.address().port, origin = 'http://127.0.0.1:' + port;
  t.after(async () => { es.closeAll(); await new Promise((res) => es.server.close(res)); try { engine.close(); } catch (_) {} r.cleanup(); });
  const raw = (method, p, { headers = {}, body = null } = {}) => new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (s) => { const parts = []; s.on('data', (c) => parts.push(c)); s.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) {} res({ status: s.statusCode, json, text }); }); });
    q.on('error', rej); if (body != null) q.write(body); q.end();
  });
  const post = (p, body = {}, { headers = {} } = {}) => raw('POST', p, { headers: { 'content-type': 'application/json', origin, 'x-station-action': es.token, 'x-idempotency-key': crypto.randomUUID(), ...headers }, body: JSON.stringify(body) });
  return { r, engine, etsy, raw, post };
}

test('server: GET /api/etsy (status, never a token); connect start and finish with the pasted address; refresh listings; disconnect; the write checks apply', async (t) => {
  const s = await server(t);
  let g = await s.raw('GET', '/api/etsy');
  assert.equal(g.status, 200); assert.equal(g.json.available, true); assert.equal(g.json.mode, 'mock'); assert.equal(g.json.connected, false);
  assert.equal(g.json.notice, ENGINE.etsy.notice);
  // the usual write checks: same origin, the action token
  assert.equal((await s.post('/api/etsy/connect/start', {}, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await s.post('/api/etsy/connect/start', {}, { headers: { 'x-station-action': 'wrong' } })).status, 403);
  const st = await s.post('/api/etsy/connect/start', { at: 1 });
  assert.equal(st.status, 200, st.text); assert.match(st.json.result.authorizeUrl, /^https:\/\/www\.etsy\.com\/oauth\/connect\?/);
  const bad = await s.post('/api/etsy/connect/finish', { pasted: 'https://localhost/station/etsy-callback?code=x&state=nope' });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /state does not match/);
  const fin = await s.post('/api/etsy/connect/finish', { pasted: s.etsy.mockApi.approve(st.json.result.authorizeUrl) });
  assert.equal(fin.status, 200, fin.text); assert.equal(fin.json.result.connected, true); assert.equal(fin.json.result.shop.name, 'FixtureShopMock');
  g = await s.raw('GET', '/api/etsy');
  assert.deepEqual(g.json.listings.items.map((l) => l.id), MOCK_LISTINGS.map((l) => l.listing_id));
  for (const k of [...s.etsy.mockApi.access.keys(), ...s.etsy.mockApi.refresh.keys()]) { assert.ok(!g.text.includes(k)); assert.ok(!fin.text.includes(k)); }
  const snap = (await s.raw('GET', '/api/office/snapshot?fresh')).text;
  for (const k of [...s.etsy.mockApi.access.keys()]) assert.ok(!snap.includes(k));
  const ref = await s.post('/api/etsy/listings', { at: 2 }); assert.equal(ref.status, 200); assert.equal(ref.json.result.listings.items.length, 2);
  const etsyRows = s.engine.ledger.rows().filter((r) => r.kind === 'etsy');
  assert.ok(etsyRows.length >= 6 && etsyRows.every((r) => r.usd === 0 && r.provider === 'etsy-mock'));
  const dis = await s.post('/api/etsy/disconnect', { at: 3 }); assert.equal(dis.status, 200); assert.equal(dis.json.result.connected, false);
  assert.equal((await s.post('/api/etsy/listings', { at: 4 })).status, 400);
});

test('server without a usable Etsy client: GET says why; the actions refuse; the Station still runs', async (t) => {
  const r = tempRoot('e7a-none');
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  const es = createEngineServer({ engine, log: r.log, etsy: { unavailable: 'not set in the .env: ETSY_TOKEN_KEY' } });
  await new Promise((res) => es.server.listen(0, '127.0.0.1', res));
  t.after(async () => { es.closeAll(); await new Promise((res) => es.server.close(res)); try { engine.close(); } catch (_) {} r.cleanup(); });
  const port = es.server.address().port;
  const g = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/api/etsy' }, (s) => { let b = ''; s.on('data', (c) => { b += c; }); s.on('end', () => res(JSON.parse(b))); }));
  assert.equal(g.available, false); assert.match(g.reason, /ETSY_TOKEN_KEY/); assert.equal(g.notice, ENGINE.etsy.notice);
});

test('the page: the Etsy button and dialog builders (listing ids; mock marked; Connect on live only); the Terms\' notice in the footer, word for word', () => {
  const st = { available: true, mode: 'live', connected: true, shop: { id: 1, name: 'MyShop' }, scopes: ['shops_r', 'listings_r'], listings: { at: '2026-10-19T10:00:00Z', items: [{ id: 4321, title: 'A <b>pack</b>', price: { amount: 4.5, currency: 'USD' }, state: 'active' }] }, listingsTtlMin: 60, callsToday: 5, limits: { perDay: 1000 }, notice: ENGINE.etsy.notice };
  const h = etsyStatusHtml(st);
  assert.match(h, /<code>4321<\/code>/); assert.match(h, /A &lt;b&gt;pack&lt;\/b&gt;/); assert.match(h, /USD 4\.50/); assert.match(h, /read only/);
  assert.equal(etsyButtonLabel(st), 'Etsy: MyShop'); assert.equal(isLive(st), true);
  assert.equal(etsyButtonLabel({ ...st, mode: 'mock', connected: false }), 'Etsy: mock (dev)'); assert.equal(isLive({ ...st, mode: 'mock' }), false);
  assert.match(etsyStatusHtml({ ...st, mode: 'mock' }), /MOCK Etsy \(dev Station\)/);
  assert.equal(etsyButtonLabel({ available: false }), 'Etsy: unavailable');
  const c = connectStepsHtml({ authorizeUrl: 'https://www.etsy.com/oauth/connect?a=1&b=2', redirectUri: 'https://localhost/station/etsy-callback', scopes: ['shops_r', 'listings_r'], expiresInS: 600 });
  assert.match(c, /href="https:\/\/www\.etsy\.com\/oauth\/connect\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"/); assert.match(c, /whole address/);
  const html = fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'index.html'), 'utf8');
  assert.ok(html.includes('<span id="etsy-notice" class="muted etsy-notice">' + ENGINE.etsy.notice + '</span>'), 'the notice in the footer');
  assert.match(html, /<button id="etsy-btn"/);
  const ui = fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'ui', 'etsy.js'), 'utf8');
  assert.match(ui, /if \(!isLive\(st\)\) \{ await ctl\.dialog\(\{ title: 'Etsy', intro: etsyStatusHtml\(st\), confirm: 'Close' \}\); return; \}/, 'no Connect button off the live Station');
});

test('no Etsy listing search anywhere: the agents\' tools and the client offer none', () => {
  const cfg = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts') });
  for (const a of Object.values(cfg.agents)) assert.ok(!(a.tools || []).some((x) => /etsy/i.test(x)), a.key);
  const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'engine', 'providers', 'etsy.mjs'), 'utf8');
  assert.doesNotMatch(src, /listings\/active|findAllListingsActive|keywords=/, 'no public listing search endpoint');
  assert.doesNotMatch(src, /method: '(PUT|PATCH|DELETE)'/, 'no write');
});
