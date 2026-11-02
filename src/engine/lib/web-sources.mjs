// lib/web-sources.mjs — the v1 scout source rule (owner, 17/10/2026; DECISIONS.md "E6 step b0: owner decisions"): store
// chart, browse and streaming sites are out. config/engine.json webSources.blockedDomains lists them as bare domains.
//   - The live web relay sends the list as blocked_domains on BOTH web_search and web_fetch (providers/anthropic-web.mjs),
//     for every agent with web tools (they share the relay).
//   - The engine refuses a web_fetch to a listed host or any of its subdomains before anything is reserved or sent
//     (tools/index.mjs), on the mock as on the live provider.
// E6 b2 (owner D1, 17/10/2026): webSources.fetchRefusedDomains (etsy.com) is refused for web_fetch the same way, but is
// never sent as blocked_domains, so search results from those sites still come back. E7a (owner decision 1, 19/10/2026):
// etsy.com is now in blockedDomains too (sent to the API, so no Etsy result comes back), and stays in fetchRefusedDomains.
// And agents never construct URLs:
// a web_fetch must name a URL that a web call of the same job already returned (returnedUrls / urlsIn below; the job
// transcript keeps every returned URL in full).
// Domain format follows the API's domain filtering rules (platform docs, server tools, read 17/10/2026): no scheme, ASCII
// only, no wildcard in the domain (the API rejects "*.example.com" with a 400), and a bare domain covers its subdomains.
import fs from 'node:fs';

export class WebSourceError extends Error { constructor(msg) { super(msg); this.code = 'CONFIG'; } }

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function domainList(engineCfg, key) {
  const ws = engineCfg && engineCfg.webSources;
  const list = ws && ws[key];
  if (list == null) return [];
  if (!Array.isArray(list)) throw new WebSourceError('config/engine.json webSources.' + key + ' must be a list');
  for (const d of list) if (typeof d !== 'string' || !DOMAIN_RE.test(d)) throw new WebSourceError('config/engine.json webSources.' + key + ': "' + d + '" is not a bare lower-case ASCII domain (no scheme, path or wildcard)');
  if (new Set(list).size !== list.length) throw new WebSourceError('config/engine.json webSources.' + key + ' has a duplicate');
  return [...list];
}
// the configured list, checked (a malformed entry refuses: the API would reject it, and a typo would silently not block)
export const blockedDomains = (engineCfg) => domainList(engineCfg, 'blockedDomains');
// engine-only: refused for web_fetch, never sent to the API (search results from these sites still come back)
export const fetchRefusedDomains = (engineCfg) => domainList(engineCfg, 'fetchRefusedDomains');

// the listed domain a URL's host falls under (the host itself or a subdomain), or null. An unparsable URL counts as
// blocked (fail closed). The URL parser lower-cases the host and turns non-ASCII into punycode, so a look-alike
// Unicode host never equals a listed domain.
export function blockedBy(url, domains) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase().replace(/\.+$/, ''); } catch (_) { return '(unparsable URL)'; }
  for (const d of domains) if (host === d || host.endsWith('.' + d)) return d;
  return null;
}

// ---- returned URLs (owner D1): the URLs a web call actually returned, compared in one canonical form (no fragment, no
// trailing slash on the path, lower-case host); a citation or a fetch must match one of them exactly in that form
export function canonicalUrl(u) {
  try { const x = new URL(String(u).trim()); if (!/^https?:$/.test(x.protocol)) return null; x.hash = ''; const s = x.href; return !x.search && s.endsWith('/') ? s.slice(0, -1) : s; } catch (_) { return null; }
}
// every http(s) URL in a text (a web result, a brief), canonical, de-duplicated, in order. The live relay writes a result
// as "- title | url | date" and a citation as "- url — "quote"", so a URL ends at whitespace, "|", a bracket or a quote.
export function urlsIn(text) {
  const out = [], seen = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s|<>"'`\])}]+/g)) {
    const c = canonicalUrl(m[0].replace(/[.,;:!?]+$/, ''));
    if (c && !seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out;
}
// E6 c (owner, 17/10/2026, "prices as shown"): the price figures a web result showed, normalised to 2 decimals: every number
// after a currency code or sign (USD 4.99, $4.99, €7, £3.50), the far end of a range after one ("$4.50 to 18.75",
// "USD 4.50–18.75"), an original price after "was" ("(was $9.99)"), and any number with exactly 2 decimals. A brief's price
// string is checked against these: every number in it must be one a web call of the job returned (the transcript keeps them).
const CUR_TOKEN = '(?:USD|EUR|GBP|CAD|AUD|US\\$|\\$|€|£)';
const PRICE_NUM = '(\\d{1,5}(?:[.,]\\d{1,2})?)';
const priceKey = (n) => { const v = Number(String(n).replace(',', '.')); return Number.isFinite(v) ? v.toFixed(2) : null; };
export function pricesIn(text) {
  const t = String(text || ''), out = new Set(), add = (n) => { const k = priceKey(n); if (k) out.add(k); };
  for (const m of t.matchAll(new RegExp(CUR_TOKEN + '\\s?' + PRICE_NUM + '(?:\\s*(?:–|—|-|to)\\s*' + CUR_TOKEN + '?\\s?' + PRICE_NUM + ')?', 'gi'))) { add(m[1]); if (m[2]) add(m[2]); }
  for (const m of t.matchAll(new RegExp('\\bwas\\s*' + CUR_TOKEN + '?\\s?' + PRICE_NUM, 'gi'))) add(m[1]);
  for (const m of t.matchAll(/(?<![\d.])(\d{1,5}\.\d{2})(?![\d.])/g)) add(m[1]);
  return [...out];
}
// the price figures the web calls of a job returned (transcript `returnedPrices`, written in full by runtime.mjs); a missing
// transcript, or one written before E6 c, returns an empty set (no price can be confirmed: fails closed)
export function returnedPrices(transcriptFile) {
  const set = new Set();
  let t = ''; try { t = fs.readFileSync(transcriptFile, 'utf8'); } catch (_) { return set; }
  for (const l of t.split('\n')) { if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; } for (const p of r.returnedPrices || []) set.add(p); }
  return set;
}
// the price figures each web_search of a job returned, with its query (transcript `searchPrices`): [{ query, prices }]
export function searchPrices(transcriptFile) {
  const out = [];
  let t = ''; try { t = fs.readFileSync(transcriptFile, 'utf8'); } catch (_) { return out; }
  for (const l of t.split('\n')) { if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; } for (const s of r.searchPrices || []) out.push({ query: String(s.query || ''), prices: Array.isArray(s.prices) ? s.prices : [] }); }
  return out;
}
// the URLs the web calls of a job returned, from its transcript (data/jobs/<id>/transcript.jsonl: `returnedUrls` on each
// line, written in full by runtime.mjs, with `searchUrls` the part that web_search returned). searchOnly: only the URLs
// search results gave (what may be fetched); otherwise every returned URL (what may be cited). A missing or unreadable
// transcript returns an empty set (nothing can be fetched or cited).
export function returnedUrls(transcriptFile, { searchOnly = false } = {}) {
  const set = new Set();
  let t = ''; try { t = fs.readFileSync(transcriptFile, 'utf8'); } catch (_) { return set; }
  for (const l of t.split('\n')) { if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; } for (const u of (searchOnly ? r.searchUrls : r.returnedUrls) || []) set.add(u); }
  return set;
}
