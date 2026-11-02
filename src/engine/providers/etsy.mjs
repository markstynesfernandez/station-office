// providers/etsy.mjs — E7a: the own-shop Etsy connection (owner decisions 2 and 3, 19/10/2026; DECISIONS.md "E7a").
// Seller App use for own-shop management only: the owner connects the shop with OAuth 2.0 (authorization code + PKCE,
// S256), read scopes only (config/engine.json etsy.scopes: shops_r, listings_r), and the Station reads the owner's own shop
// and its active listings to confirm the connection and list them with their ids. No listing search, no other shop, no
// write, and nothing here reaches an agent. Endpoints, OAuth and headers per developers.etsy.com (Authentication, Request
// Standards, Rate Limits) and Etsy's Dev MCP server (getMe, getShop, getListingsByShop, tokenScopes), read 19/10/2026.
//   - The callback: the redirect URI is registered in the Etsy app and starts with https:// (the docs refuse http); nothing
//     listens there. After approving on Etsy, the owner copies the browser's address (it carries code and state) into the
//     Station page, which finishes the exchange (finishConnect). The state must match a pending connect of this process
//     (single use, connectTtlMs); the PKCE verifier never leaves this process.
//   - Tokens (access 1 hour, refresh 90 days) are stored encrypted at rest (AES-256-GCM; the key derived by scrypt from
//     ETSY_TOKEN_KEY with a random salt per write) in <data root>/etsy/, refreshed before they expire, and never logged:
//     every token, code and verifier is registered with the logger's redaction (log.addSecret) and never put in a ledger
//     row, an error message or a result.
//   - Every HTTP call waits for the rate limiter (perSecond / perDay), writes one ledger row (kind etsy, USD 0, the
//     operation and the HTTP status), retries a 429 after its Retry-After (or a 5xx / network error) with backoff, and
//     refreshes once on a 401.
//   - Cache (API Terms section 5, "Display of Data"): in memory only; listings at most listingsTtlMs (at most 6 hours),
//     the shop at most shopTtlMs (at most 24 hours); an expired entry is not shown.
// createEtsyClient (the real client) builds only on the live instance (STATION_INSTANCE=live, instance.mjs), with
// ETSY_API_KEY, ETSY_SHARED_SECRET and ETSY_TOKEN_KEY set; the dev instance uses createMockEtsyClient (etsy-mock.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { liveInstanceProblem } from '../instance.mjs';

export const READ_SCOPES = ['shops_r', 'listings_r'];
export const MAX_LISTINGS_TTL_MS = 6 * 3600 * 1000, MAX_SHOP_TTL_MS = 24 * 3600 * 1000;
export const TOKEN_DIR = 'etsy';
const AAD = Buffer.from('station-etsy-token-v1');

export class EtsyError extends Error { constructor(msg, { code = 'ETSY', status = null } = {}) { super(msg); this.code = code; this.status = status; } }

// the settings, checked: read scopes only (no *_w or *_d), the cache within the Terms' limits, positive limits
export function etsySettings(engineCfg, env = process.env) {
  const e = (engineCfg && engineCfg.etsy) || null;
  if (!e) throw new EtsyError('config/engine.json has no etsy section', { code: 'CONFIG' });
  const bad = [];
  const scopes = Array.isArray(e.scopes) ? e.scopes : [];
  if (!scopes.length || scopes.some((s) => !READ_SCOPES.includes(s))) bad.push('scopes must be read scopes from ' + READ_SCOPES.join(', ') + ' (E7a reads only; writing comes later)');
  for (const k of ['perSecond', 'perDay', 'backoffMs', 'backoffMaxMs', 'timeoutMs', 'connectTtlMs', 'listingsTtlMs', 'shopTtlMs', 'listingsLimit']) if (!(Number.isFinite(e[k]) && e[k] > 0)) bad.push(k + ' must be a number above 0');
  if (!(Number.isInteger(e.retries) && e.retries >= 0 && e.retries <= 5)) bad.push('retries must be 0 to 5');
  if (e.listingsTtlMs > MAX_LISTINGS_TTL_MS) bad.push('listingsTtlMs is over 6 hours (API Terms: listing content at most 6 hours old)');
  if (e.shopTtlMs > MAX_SHOP_TTL_MS) bad.push('shopTtlMs is over 24 hours (API Terms: other content at most 24 hours old)');
  const redirectUri = env.ETSY_REDIRECT_URI || e.redirectUri;
  if (!/^https:\/\/[^\s?#]+$/.test(String(redirectUri || ''))) bad.push('the redirect URI must start with https:// and carry no query or fragment (Etsy docs)');
  for (const k of ['apiBase', 'authorizeUrl', 'tokenUrl']) if (!/^https:\/\/[a-z0-9.-]*etsy\.com\//.test(String(e[k] || ''))) bad.push(k + ' must be an https etsy.com URL');
  if (!e.notice) bad.push('notice (the API Terms\' required statement) is missing');
  if (bad.length) throw new EtsyError('config/engine.json etsy: ' + bad.join('; '), { code: 'CONFIG' });
  return { ...e, scopes: [...scopes], redirectUri };
}

export const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// PKCE (RFC 7636; Etsy: 43-128 characters of [A-Za-z0-9._~-], challenge = URL-safe base64 of the SHA256 of the verifier)
export function pkcePair(rand = crypto.randomBytes) {
  const verifier = b64url(rand(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

// ---- tokens encrypted at rest
export function createTokenStore({ J, file, secret }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new EtsyError('ETSY_TOKEN_KEY is not set (at least 32 characters) in the .env: Etsy tokens are stored only encrypted, so nothing can connect', { code: 'NO_TOKEN_KEY' });
  const keyFor = (salt) => crypto.scryptSync(secret, salt, 32);
  return {
    file,
    exists: () => fs.existsSync(file),
    save(obj) {
      const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyFor(salt), iv);
      c.setAAD(AAD);
      const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      J.makeDir(path.dirname(file));
      J.put(file, JSON.stringify({ v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n', { fsync: true });
    },
    load() {
      if (!fs.existsSync(file)) return null;
      try {
        const r = JSON.parse(fs.readFileSync(file, 'utf8'));
        const d = crypto.createDecipheriv('aes-256-gcm', keyFor(Buffer.from(r.salt, 'base64')), Buffer.from(r.iv, 'base64'));
        d.setAAD(AAD); d.setAuthTag(Buffer.from(r.tag, 'base64'));
        return JSON.parse(Buffer.concat([d.update(Buffer.from(r.data, 'base64')), d.final()]).toString('utf8'));
      } catch (_) { throw new EtsyError('the stored Etsy token cannot be decrypted (ETSY_TOKEN_KEY changed, or the file is damaged): disconnect and connect again', { code: 'TOKEN_DECRYPT' }); }
    },
    clear() { if (fs.existsSync(file)) J.remove(file); }
  };
}

// ---- the rate limiter: at most perSecond calls in any second and perDay in any 24 hours (a sliding window, as Etsy
// counts); block(ms) holds every call after a 429
export function createRateLimiter({ perSecond, perDay, now = Date.now, sleep }) {
  const sec = [], day = [];
  let heldUntil = 0;
  const prune = (a, before) => { while (a.length && a[0] <= before) a.shift(); };
  return {
    async acquire() {
      for (;;) {
        const t = now();
        if (t < heldUntil) { await sleep(heldUntil - t); continue; }
        prune(sec, t - 1000); prune(day, t - 86400000);
        if (day.length >= perDay) throw new EtsyError('the Etsy call budget of ' + perDay + ' a day (config/engine.json etsy.perDay) is used up; try again later', { code: 'DAY_LIMIT' });
        if (sec.length < perSecond) { sec.push(t); day.push(t); return; }
        await sleep(Math.max(1, sec[0] + 1000 - t));
      }
    },
    block(ms) { heldUntil = Math.max(heldUntil, now() + ms); },
    get today() { prune(day, now() - 86400000); return day.length; }
  };
}

// Retry-After in seconds (Etsy: "the estimated time (in seconds) the client should wait"), or an HTTP date
export function retryAfterMs(v, now = Date.now()) {
  if (v == null || v === '') return null;
  const n = Number(v); if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  const d = Date.parse(v); return Number.isFinite(d) ? Math.max(0, d - now) : null;
}

// the address the owner pastes: the full redirect URL (code and state, or error), or "code=...&state=..."
export function parseCallback(pasted, redirectUri) {
  const s = String(pasted || '').trim();
  if (!s) throw new EtsyError('paste the whole address from your browser after approving on Etsy', { code: 'BAD_REQUEST' });
  let q;
  try {
    if (/^https:\/\//i.test(s)) {
      const u = new URL(s), want = new URL(redirectUri);
      if (u.origin + u.pathname !== want.origin + want.pathname) throw new EtsyError('that address is not the Etsy redirect (' + want.origin + want.pathname + ')', { code: 'BAD_REQUEST' });
      q = u.searchParams;
    } else q = new URLSearchParams(s.replace(/^\?/, ''));
  } catch (e) { if (e instanceof EtsyError) throw e; throw new EtsyError('that is not the address Etsy sent you to', { code: 'BAD_REQUEST' }); }
  if (q.get('error')) throw new EtsyError('Etsy did not grant access (' + String(q.get('error')).slice(0, 60) + ')', { code: 'DENIED' });
  const code = q.get('code'), state = q.get('state');
  if (!code || !state) throw new EtsyError('the address has no code and state: copy it from the browser after you approve on Etsy', { code: 'BAD_REQUEST' });
  return { code, state };
}

// ---- the client. mode: live (the real client) or mock (dev). keys: { apiKey, sharedSecret, tokenKey }
export function makeEtsyClient({ mode, settings, keys, J, ledger, log, fetchImpl, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tokenFile = null, businessId = null }) {
  const S = settings, secret = (s) => { if (log && log.addSecret) log.addSecret(s); };
  for (const k of [keys.apiKey, keys.sharedSecret, keys.tokenKey]) secret(k);
  const store = createTokenStore({ J, file: tokenFile || path.join(J.dataRoot, TOKEN_DIR, mode === 'live' ? 'token.enc.json' : 'token-mock.enc.json'), secret: keys.tokenKey });
  const limiter = createRateLimiter({ perSecond: S.perSecond, perDay: S.perDay, now, sleep });
  const pending = new Map();   // state -> { verifier, at }: this process only, single use
  const cache = new Map();     // key -> { at, value }: in memory only (API Terms section 5)
  let tok = null, refreshing = null, lastLimits = null;
  try { tok = store.load(); } catch (e) { log && log.warn('etsy: stored token unreadable', { code: e.code }); tok = { unreadable: true }; }
  if (tok) for (const k of ['access', 'refresh']) secret(tok[k]);
  // scrub every known secret from a text that may leave this module (an error, a log line)
  const scrub = (t) => { let s = String(t == null ? '' : t); for (const k of [keys.apiKey, keys.sharedSecret, keys.tokenKey, tok && tok.access, tok && tok.refresh]) if (k && k.length > 8) s = s.split(k).join('<redacted>'); return s.replace(/\b\d{3,}\.[A-Za-z0-9_-]{20,}/g, '<redacted-token>').slice(0, 300); };

  function ledgerRow(op, status, attempt) {
    try { ledger.append({ jobId: null, runId: null, agentKey: null, line: null, ...(businessId ? { businessId } : {}), kind: 'etsy', provider: mode === 'live' ? 'etsy' : 'etsy-mock', model: op, usd: 0, count: 1, httpStatus: status, attempt, priceSource: 'Etsy Open API: no charge (E7a, own shop read only)' }); }
    catch (e) { log && log.error('etsy: ledger row refused', { op, error: e.message }); throw new EtsyError('the ledger refused the Etsy call record: ' + e.message, { code: 'LEDGER' }); }
  }

  // one HTTP call: rate limiter, ledger row, retry on 429 (Retry-After) / 5xx / network, one refresh on a 401
  async function call(op, { method = 'GET', url, form = null, auth = false, apiKey = true }) {
    let attempt = 0, refreshed = false;
    for (;;) {
      await limiter.acquire();
      const headers = { accept: 'application/json' };
      if (apiKey) headers['x-api-key'] = keys.apiKey + ':' + keys.sharedSecret;
      if (auth) headers.authorization = 'Bearer ' + (await accessToken());
      if (form) headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
      let res = null, body = null, err = null;
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), S.timeoutMs);
      try { res = await fetchImpl(url, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined, signal: ac.signal }); body = await res.json().catch(() => null); }
      catch (e) { err = e; }
      finally { clearTimeout(timer); }
      const status = res ? res.status : 0;
      ledgerRow(op, status, attempt);
      if (res && status >= 200 && status < 300) {
        const h = (n) => (res.headers && res.headers.get ? res.headers.get(n) : null);
        if (h('x-limit-per-second') || h('x-limit-per-day')) lastLimits = { perSecond: Number(h('x-limit-per-second')) || null, perDay: Number(h('x-limit-per-day')) || null, remainingToday: Number(h('x-remaining-today')) || null, at: now() };
        log && log.info('etsy call', { op, status, attempt });
        return body;
      }
      if (status === 401 && auth && !refreshed) { refreshed = true; log && log.warn('etsy: 401, refreshing the token once', { op }); await refresh(); continue; }
      const retryable = !!err || status === 429 || status >= 500;
      const why = err ? 'network error (' + scrub(err.name === 'AbortError' ? 'timed out after ' + S.timeoutMs + ' ms' : err.message) + ')' : 'HTTP ' + status + (body && body.error ? ' (' + scrub(body.error) + ')' : '');
      if (!retryable || attempt >= S.retries) {
        log && log.warn('etsy call failed', { op, status, attempt, why });
        throw new EtsyError('Etsy ' + op + ' failed: ' + why, { code: status === 429 ? 'RATE_LIMITED' : status === 401 || status === 403 ? 'AUTH' : 'HTTP', status });
      }
      const ra = status === 429 ? retryAfterMs(res.headers && res.headers.get ? res.headers.get('retry-after') : null, now()) : null;
      const wait = Math.min(S.backoffMaxMs, ra != null ? Math.max(ra, 1) : S.backoffMs * 2 ** attempt);
      if (status === 429) limiter.block(wait);
      log && log.warn('etsy: retrying', { op, status, attempt: attempt + 1, waitMs: wait, retryAfter: ra != null });
      await sleep(wait); attempt++;
    }
  }

  function keep(t) { tok = t; for (const k of ['access', 'refresh']) secret(t[k]); store.save(t); }
  const tokenFields = (r, at) => {
    if (!r || typeof r.access_token !== 'string' || typeof r.refresh_token !== 'string') throw new EtsyError('Etsy returned no token', { code: 'AUTH' });
    return { access: r.access_token, refresh: r.refresh_token, expiresAt: at + (Number(r.expires_in) || 3600) * 1000, refreshExpiresAt: at + 90 * 86400000, userId: String(r.access_token).split('.')[0] };
  };
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!tok || !tok.refresh) throw new EtsyError('Etsy is not connected', { code: 'NOT_CONNECTED' });
      try {
        const r = await call('oauth-refresh', { method: 'POST', url: S.tokenUrl, form: { grant_type: 'refresh_token', client_id: keys.apiKey, refresh_token: tok.refresh }, apiKey: false });
        keep({ ...tok, ...tokenFields(r, now()), needsReconnect: false });
        log && log.info('etsy: token refreshed', { shopId: tok.shopId });
      } catch (e) {
        if (e.status === 400 || e.status === 401) { keep({ ...tok, needsReconnect: true }); throw new EtsyError('the Etsy connection has expired or was revoked: connect Etsy again', { code: 'RECONNECT', status: e.status }); }
        throw e;
      }
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }
  async function accessToken() {
    if (!tok || !tok.access || tok.unreadable) throw new EtsyError('Etsy is not connected', { code: 'NOT_CONNECTED' });
    if (tok.needsReconnect) throw new EtsyError('the Etsy connection has expired: connect Etsy again', { code: 'RECONNECT' });
    if (tok.expiresAt - now() < 60000) await refresh();
    return tok.access;
  }
  const cached = (key, ttl) => { const c = cache.get(key); if (c && now() - c.at <= ttl) return c; if (c) cache.delete(key); return null; };

  const api = {
    mode,
    notice: S.notice,
    redirectUri: S.redirectUri,
    // step 1: the authorize URL for the owner's browser (state and the PKCE challenge; the verifier stays here)
    startConnect() {
      for (const [s, p] of pending) if (now() - p.at > S.connectTtlMs) pending.delete(s);
      const { verifier, challenge } = pkcePair(), state = b64url(crypto.randomBytes(24));
      secret(verifier);
      pending.set(state, { verifier, at: now() });
      const q = new URLSearchParams({ response_type: 'code', client_id: keys.apiKey, redirect_uri: S.redirectUri, scope: S.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' });
      log && log.info('etsy: connect started', { scopes: S.scopes, redirectUri: S.redirectUri });
      return { authorizeUrl: S.authorizeUrl + '?' + q.toString().replace(/\+/g, '%20'), redirectUri: S.redirectUri, scopes: [...S.scopes], expiresInS: Math.round(S.connectTtlMs / 1000) };
    },
    // step 2: the pasted address -> the token exchange, then the shop it belongs to and the scopes granted
    async finishConnect(pasted) {
      const { code, state } = parseCallback(pasted, S.redirectUri);
      secret(code);
      const p = pending.get(state);
      if (!p || now() - p.at > S.connectTtlMs) { pending.delete(state); throw new EtsyError('this connect request is unknown or expired (the state does not match): press Connect Etsy again', { code: 'STATE' }); }
      pending.delete(state);   // single use
      const at = now();
      const r = await call('oauth-token', { method: 'POST', url: S.tokenUrl, form: { grant_type: 'authorization_code', client_id: keys.apiKey, redirect_uri: S.redirectUri, code, code_verifier: p.verifier }, apiKey: false });
      const t = tokenFields(r, at);
      keep({ ...t, connectedAt: at, shopId: null, shopName: null, shopUrl: null, scopes: [] });
      const granted = await api.grantedScopes();
      if (granted.some((s) => !READ_SCOPES.includes(s))) { api.disconnect(); throw new EtsyError('Etsy granted more than read access (' + granted.join(', ') + '): disconnected; E7a keeps read scopes only', { code: 'SCOPES' }); }
      const me = await call('getMe', { url: S.apiBase + '/application/users/me', auth: true });
      if (!me || !me.shop_id) { api.disconnect(); throw new EtsyError('this Etsy account has no shop', { code: 'NO_SHOP' }); }
      const shop = await api.shop({ force: true, shopId: me.shop_id });
      keep({ ...tok, userId: String(me.user_id || tok.userId), shopId: me.shop_id, shopName: shop.name, shopUrl: shop.url, scopes: granted });
      log && log.info('etsy: connected', { shopId: me.shop_id, shopName: shop.name, scopes: granted });
      await api.listings({ force: true }).catch((e) => log && log.warn('etsy: listings not read after connect', { code: e.code }));
      return api.status();
    },
    async grantedScopes() {
      const r = await call('tokenScopes', { method: 'POST', url: S.apiBase + '/application/scopes', form: { token: tok.access } });
      return Array.isArray(r && r.scopes) ? r.scopes.map(String) : [];
    },
    async shop({ force = false, shopId = tok && tok.shopId } = {}) {
      if (!shopId) throw new EtsyError('Etsy is not connected', { code: 'NOT_CONNECTED' });
      const c = !force && cached('shop', S.shopTtlMs); if (c) return c.value;
      const r = await call('getShop', { url: S.apiBase + '/application/shops/' + encodeURIComponent(shopId) });
      const v = { id: r.shop_id, name: r.shop_name, url: r.url || null, currency: r.currency_code || null, activeListings: r.listing_active_count ?? null, vacation: !!r.is_vacation };
      cache.set('shop', { at: now(), value: v }); return v;
    },
    // the owner's own active listings: id, title, state, price as Etsy shows it (amount / divisor), url
    async listings({ force = false } = {}) {
      if (!tok || !tok.shopId) throw new EtsyError('Etsy is not connected', { code: 'NOT_CONNECTED' });
      const c = !force && cached('listings', S.listingsTtlMs); if (c) return { at: c.at, items: c.value, cached: true };
      const r = await call('getListingsByShop', { url: S.apiBase + '/application/shops/' + encodeURIComponent(tok.shopId) + '/listings?state=active&limit=' + S.listingsLimit, auth: true });
      const items = (Array.isArray(r && r.results) ? r.results : []).map((l) => ({ id: l.listing_id, title: String(l.title || ''), state: l.state || null, url: l.url || null,
        price: l.price && Number.isFinite(l.price.amount) && l.price.divisor ? { amount: l.price.amount / l.price.divisor, currency: l.price.currency_code || null } : null }));
      const at = now(); cache.set('listings', { at, value: items });
      return { at, items, cached: false, count: r && r.count != null ? r.count : items.length };
    },
    // what the page shows: never a token
    status() {
      const c = cache.get('listings'), fresh = c && now() - c.at <= S.listingsTtlMs;
      if (c && !fresh) cache.delete('listings');
      return {
        mode, connected: !!(tok && tok.access && !tok.unreadable), needsReconnect: !!(tok && (tok.needsReconnect || tok.unreadable)),
        shop: tok && tok.shopId ? { id: tok.shopId, name: tok.shopName, url: tok.shopUrl } : null, scopes: tok && tok.scopes ? [...tok.scopes] : [],
        connectedAt: tok && tok.connectedAt ? new Date(tok.connectedAt).toISOString() : null, accessExpiresAt: tok && tok.expiresAt ? new Date(tok.expiresAt).toISOString() : null,
        listings: fresh ? { at: new Date(c.at).toISOString(), items: c.value } : null, listingsTtlMin: Math.round(S.listingsTtlMs / 60000),
        callsToday: limiter.today, limits: { perSecond: S.perSecond, perDay: S.perDay, etsy: lastLimits }, redirectUri: S.redirectUri, requestedScopes: [...S.scopes], notice: S.notice
      };
    },
    // the token file is deleted and the cache dropped (the connection can also be removed on Etsy's side by the owner)
    disconnect() { store.clear(); tok = null; cache.clear(); pending.clear(); log && log.info('etsy: disconnected (token deleted)'); return api.status(); }
  };
  return api;
}

// the real client: live instance only, the three keys from the environment (names only; values never logged)
export function createEtsyClient({ engineCfg, env = process.env, J, ledger, log, fetchImpl = globalThis.fetch, now, sleep, tokenFile, businessId = null } = {}) {
  const live = liveInstanceProblem(env);
  if (live) throw new EtsyError('the real Etsy client ' + live.replace('the live provider runs', 'runs'), { code: 'NOT_LIVE' });
  const missing = ['ETSY_API_KEY', 'ETSY_SHARED_SECRET', 'ETSY_TOKEN_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new EtsyError('not set in the .env: ' + missing.join(', ') + ' (Etsy stays disconnected; no call was made)', { code: 'NO_KEY' });
  return makeEtsyClient({ mode: 'live', settings: etsySettings(engineCfg, env), keys: { apiKey: env.ETSY_API_KEY, sharedSecret: env.ETSY_SHARED_SECRET, tokenKey: env.ETSY_TOKEN_KEY }, J, ledger, log, fetchImpl, now, sleep, tokenFile, businessId });
}
