// providers/etsy-mock.mjs — E7a: the MOCK Etsy (dev instance and tests). No network, no real key, no real shop: an
// in-process fake of the Etsy endpoints the own-shop client uses (OAuth authorize and token with PKCE and state, getMe,
// getShop, getListingsByShop, tokenScopes), shaped as developers.etsy.com and Etsy's Dev MCP server describe them
// (19/10/2026). FIXTURE shop and listings only. failNext() injects a 429 (with Retry-After), a 5xx or a 401 for the tests.
//   createMockEtsyApi()     the fake API: { fetch, approve(authorizeUrl), failNext, calls, expireAccess, ... }
//   createMockEtsyClient()  the dev client: the shared client code (providers/etsy.mjs makeEtsyClient) on the fake API,
//                           mode "mock", fixed FIXTURE keys (not secrets), its own token file (token-mock.enc.json)
import crypto from 'node:crypto';
import { makeEtsyClient, etsySettings, b64url, READ_SCOPES } from './etsy.mjs';

export const MOCK_KEYS = { apiKey: 'mockkeystring0000fixture', sharedSecret: 'mocksharedsecret0000fixture', tokenKey: 'mock-token-key-for-the-dev-instance-only-0000' };
export const MOCK_SHOP = { shop_id: 90000001, shop_name: 'FixtureShopMock', url: 'https://www.etsy.com/shop/FixtureShopMock', currency_code: 'USD', listing_active_count: 2, is_vacation: false };
export const MOCK_USER_ID = 80000001;
export const MOCK_LISTINGS = [
  { listing_id: 1000000101, title: 'FIXTURE desk props pack (mock listing 1)', state: 'active', url: 'https://www.etsy.com/listing/1000000101', price: { amount: 450, divisor: 100, currency_code: 'USD' } },
  { listing_id: 1000000102, title: 'FIXTURE autumn props pack (mock listing 2)', state: 'active', url: 'https://www.etsy.com/listing/1000000102', price: { amount: 500, divisor: 100, currency_code: 'USD' } }
];

export function createMockEtsyApi({ keys = MOCK_KEYS, redirectUri = 'https://localhost/station/etsy-callback', now = Date.now, grant = READ_SCOPES } = {}) {
  const codes = new Map(), access = new Map(), refresh = new Map(), fails = [], calls = [];
  const rnd = () => b64url(crypto.randomBytes(30));
  const res = (status, body, headers = {}) => ({ status, headers: { get: (n) => headers[String(n).toLowerCase()] ?? null }, json: async () => body });
  const keyOk = (h) => h['x-api-key'] === keys.apiKey + ':' + keys.sharedSecret;
  const bearer = (h, scope) => {
    const m = /^Bearer (\S+)$/.exec(h.authorization || ''), a = m && access.get(m[1]);
    if (!a || a.exp <= now()) return { err: res(401, { error: 'invalid_token' }) };
    if (scope && !a.scopes.includes(scope)) return { err: res(403, { error: 'insufficient scope' }) };
    return { a };
  };
  function issue(scopes) {
    const at = MOCK_USER_ID + '.' + rnd(), rt = MOCK_USER_ID + '.' + rnd();
    access.set(at, { exp: now() + 3600 * 1000, scopes }); refresh.set(rt, { scopes });
    return { access_token: at, token_type: 'Bearer', expires_in: 3600, refresh_token: rt };
  }
  const api = {
    calls, codes, access, refresh,
    // the owner's "Allow access" on Etsy: checks the authorize request as Etsy would, returns the redirect address
    approve(authorizeUrl, { deny = false } = {}) {
      const u = new URL(authorizeUrl), q = u.searchParams;
      if (u.origin + u.pathname !== 'https://www.etsy.com/oauth/connect') throw new Error('mock: not the Etsy authorize URL');
      if (q.get('response_type') !== 'code' || q.get('client_id') !== keys.apiKey || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) throw new Error('mock: malformed authorize request');
      if (q.get('redirect_uri') !== redirectUri) throw new Error('mock: redirect_uri is not the registered one');
      const asked = String(q.get('scope') || '').split(' ').filter(Boolean);
      if (deny) return redirectUri + '?error=access_denied&state=' + encodeURIComponent(q.get('state'));
      const code = rnd();
      codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), scopes: asked.filter((s) => grant.includes(s)), used: false, exp: now() + 10 * 60000 });
      return redirectUri + '?code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(q.get('state'));
    },
    // the next calls fail: { status, retryAfter }
    failNext(...list) { fails.push(...list); },
    expireAccess() { for (const v of access.values()) v.exp = now() - 1; },
    async fetch(url, opts = {}) {
      const u = new URL(url), h = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), method = opts.method || 'GET';
      calls.push({ method, path: u.pathname, query: u.search, headers: Object.keys(h), apiKey: 'x-api-key' in h, bearer: 'authorization' in h });
      if (fails.length) { const f = fails.shift(); return res(f.status, { error: 'mock failure' }, f.retryAfter != null ? { 'retry-after': String(f.retryAfter) } : {}); }
      const form = opts.body ? Object.fromEntries(new URLSearchParams(String(opts.body))) : {};
      if (method === 'POST' && u.pathname === '/v3/public/oauth/token') {
        if (form.client_id !== keys.apiKey) return res(400, { error: 'invalid_client' });
        if (form.grant_type === 'authorization_code') {
          const c = codes.get(form.code);
          if (!c || c.used || c.exp <= now()) return res(400, { error: 'invalid_grant' });
          if (form.redirect_uri && form.redirect_uri !== c.redirectUri) return res(400, { error: 'redirect_uri mismatch' });
          if (b64url(crypto.createHash('sha256').update(String(form.code_verifier || '')).digest()) !== c.challenge) return res(400, { error: 'code_verifier does not match' });
          c.used = true; return res(200, issue(c.scopes));
        }
        if (form.grant_type === 'refresh_token') {
          const r = refresh.get(form.refresh_token);
          if (!r) return res(400, { error: 'invalid_grant' });
          refresh.delete(form.refresh_token); return res(200, issue(r.scopes));
        }
        return res(400, { error: 'unsupported_grant_type' });
      }
      if (!keyOk(h)) return res(401, { error: 'invalid api key' });
      const lim = { 'x-limit-per-second': '10', 'x-remaining-this-second': '9', 'x-limit-per-day': '10000', 'x-remaining-today': '9990' };
      if (method === 'POST' && u.pathname === '/v3/application/scopes') { const a = access.get(form.token); return res(200, { scopes: a ? a.scopes : [] }, lim); }
      if (method === 'GET' && u.pathname === '/v3/application/users/me') { const b = bearer(h, 'shops_r'); return b.err || res(200, { user_id: MOCK_USER_ID, shop_id: MOCK_SHOP.shop_id }, lim); }
      if (method === 'GET' && u.pathname === '/v3/application/shops/' + MOCK_SHOP.shop_id) return res(200, MOCK_SHOP, lim);
      if (method === 'GET' && u.pathname === '/v3/application/shops/' + MOCK_SHOP.shop_id + '/listings') { const b = bearer(h, 'listings_r'); return b.err || res(200, { count: MOCK_LISTINGS.length, results: MOCK_LISTINGS.filter((l) => !u.searchParams.get('state') || l.state === u.searchParams.get('state')) }, lim); }
      return res(404, { error: 'mock: no such endpoint ' + method + ' ' + u.pathname });
    }
  };
  return api;
}

// the dev instance's Etsy: the client code on the mock API (never a network call, never a real key)
export function createMockEtsyClient({ engineCfg, J, ledger, log, now, sleep, api = null, tokenFile, businessId = null } = {}) {
  const settings = etsySettings(engineCfg, {});
  const mock = api || createMockEtsyApi({ redirectUri: settings.redirectUri, now });
  const client = makeEtsyClient({ mode: 'mock', settings, keys: MOCK_KEYS, J, ledger, log, fetchImpl: mock.fetch, now, sleep, tokenFile, businessId });
  client.mockApi = mock;
  return client;
}
