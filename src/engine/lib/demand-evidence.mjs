// PORTED from Virtual-workers/station/scripts/lib/demand-evidence.mjs (the owner's own code) at 16/10/2026 19:58 Irish time (re-ported: it changed after 19:42), source sha256 2ccf471ac9c3a99ae7ae88d42db9c18d4d7a3460e69c8f4ea90930ae83aff010.
//   change: none
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// demand-evidence.mjs (lib) — the deterministic check that a research brief carries PROVEN demand (owner, 2026-10-16): the Etsy search
// phrase, the date, the search URL, the competitor count, a saturation verdict with its reason, and the top five competitors with price,
// review count and Bestseller badge, each with its listing URL. Any missing, blank, UNKNOWN or malformed item fails the brief. Pure.
// Format: skills/demand-evidence.md.
// OWNER-RECORDED evidence (owner, 2026-10-16: Etsy refuses automated reads): a line "recorded by owner, YYYY-MM-DD" in the section marks
// figures the owner read in a browser. The same items are required; the Evidence Checker does not re-open them. An optional 8th table
// column "notes" (ad, sale, rating) is allowed. An owner price decision in "## Price range" ("owner price: EUR a–b (recorded by owner,
// YYYY-MM-DD)", optionally "owner price point: EUR p (recorded by owner, YYYY-MM-DD)") is read by ownerPrice(). Agents never write any
// owner marker (skills/demand-evidence.md).
export const SATURATION = ['low', 'medium', 'high', 'very high'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OWNER_LINE = /^recorded by owner\b(.*)$/mi;

// the owner's price decision for a brief: { currency: 'EUR', min, max, date, point, pointDate } or null. A malformed owner line returns { problem }.
export function ownerPrice(briefText) {
  const t = String(briefText || '').replace(/\r\n/g, '\n'), i = t.search(/^## Price range\s*$/m);
  if (i < 0) return null;
  const rest = t.slice(i).split('\n').slice(1).join('\n'), j = rest.search(/^## /m), sec = j < 0 ? rest : rest.slice(0, j);
  const line = /^owner price:(.*)$/mi.exec(sec);
  if (!line) return null;
  const m = /^\s*EUR\s*(\d+(?:\.\d{1,2})?)\s*(?:[–—-]|to)\s*(?:EUR\s*)?(\d+(?:\.\d{1,2})?)\s*\(recorded by owner,\s*(\d{4}-\d{2}-\d{2})\)\s*$/i.exec(line[1]);
  if (!m) return { problem: 'owner price must read "owner price: EUR <min>–<max> (recorded by owner, YYYY-MM-DD)"' };
  const out = { currency: 'EUR', min: Number(m[1]), max: Number(m[2]), date: m[3], point: null, pointDate: null };
  if (out.min > out.max) return { problem: 'owner price minimum is above its maximum' };
  // the owner's exact price within the range (owner, 2026-10-16): the price fill lists at it; without it, at the range's low end
  const pl = /^owner price point:(.*)$/mi.exec(sec);
  if (pl) {
    const pm = /^\s*EUR\s*(\d+(?:\.\d{1,2})?)\s*\(recorded by owner,\s*(\d{4}-\d{2}-\d{2})\)\s*$/i.exec(pl[1]);
    if (!pm) return { problem: 'owner price point must read "owner price point: EUR <price> (recorded by owner, YYYY-MM-DD)"' };
    out.point = Number(pm[1]); out.pointDate = pm[2];
    if (out.point < out.min || out.point > out.max) return { problem: 'owner price point EUR ' + out.point.toFixed(2) + ' is outside the owner price EUR ' + out.min.toFixed(2) + '–' + out.max.toFixed(2) };
  }
  return out;
}

const section = (briefText, heading) => {
  const t = String(briefText || '').replace(/\r\n/g, '\n'), i = t.search(new RegExp('^## ' + heading + '\\s*$', 'm'));
  if (i < 0) return null;
  const rest = t.slice(i).split('\n').slice(1).join('\n'), j = rest.search(/^## /m);
  return j < 0 ? rest : rest.slice(0, j);
};
export const evidenceSection = (briefText) => section(briefText, 'Demand evidence');

// KEYWORD SOURCES (owner, 2026-10-16: a brief with fewer than MIN_SOURCED_KEYWORDS sourced keywords fails). One phrase per bullet in
// "## Keywords": "- <phrase> — <source>" (em or en dash). A source counts if it is an owner Etsy search ("recorded by owner, YYYY-MM-DD")
// or names a URL or file path that is listed in "## Sources" (the Evidence Checker re-opens those). A bullet without a source is unsourced.
// Returns { ok, problems[], keywords: [{ phrase, source, sourced }], sourced }.
export const MIN_SOURCED_KEYWORDS = 5;
export function keywordSourceProblems(briefText, { min = MIN_SOURCED_KEYWORDS } = {}) {
  const sec = section(briefText, 'Keywords');
  if (sec === null) return { ok: false, problems: ['no "## Keywords" section'], keywords: [], sourced: 0 };
  const refs = (s) => (s.match(/https:\/\/[^\s,;)]+|[\w.-]+(?:\/[\w.-]+)+\.\w+/g) || []).map((r) => r.replace(/[.:]+$/, ''));
  const listed = new Set(refs(section(briefText, 'Sources') || ''));
  const keywords = sec.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => {
    const m = /^\s*[-*]\s+(.+?)\s+[—–]\s+(.+)$/.exec(l), phrase = (m ? m[1] : l.replace(/^\s*[-*]\s+/, '')).trim(), source = m ? m[2].trim() : '';
    const owner = /recorded by owner,\s*\d{4}-\d{2}-\d{2}\b/i.test(source);
    return { phrase, source, sourced: owner || refs(source).some((r) => listed.has(r)) };
  });
  const sourced = keywords.filter((k) => k.sourced).length, problems = [];
  if (sourced < min) problems.push(sourced + ' of ' + keywords.length + ' keyword(s) sourced, needs at least ' + min + ' ("- <phrase> — <source>": a URL or file listed under ## Sources, or an owner Etsy search "recorded by owner, YYYY-MM-DD")');
  return { ok: problems.length === 0, problems, keywords, sourced };
}

const field = (sec, name) => { const m = new RegExp('^' + name + ':[ \\t]*(.*)$', 'mi').exec(sec); return m ? m[1].trim() : null; };
const isUrl = (s, host) => { try { const u = new URL(s); return u.protocol === 'https:' && (!host || u.hostname === host || u.hostname.endsWith('.' + host)); } catch (_) { return false; } };

// returns { ok, problems[], evidence } — evidence holds the parsed values when present
export function demandEvidenceProblems(briefText, { today = new Date(), maxAgeDays = 30 } = {}) {
  const sec = evidenceSection(briefText), problems = [];
  if (sec === null) return { ok: false, problems: ['no "## Demand evidence" section'], evidence: null };
  if (/\bUNKNOWN\b/i.test(sec)) problems.push('demand evidence contains UNKNOWN: every item must be what Etsy showed');
  const ev = { phrase: field(sec, 'search phrase'), checked: field(sec, 'checked'), url: field(sec, 'search URL'), count: field(sec, 'competitor count'), saturation: field(sec, 'saturation'), recordedBy: 'researcher', rows: [] };
  const own = OWNER_LINE.exec(sec);
  if (own) {
    const d = /^,\s*(\S+)\s*$/.exec(own[1]);
    if (!d || !DATE.test(d[1])) problems.push('owner marker must read "recorded by owner, YYYY-MM-DD"');
    else { ev.recordedBy = 'owner'; ev.recordedOn = d[1]; }
  }
  if (!ev.phrase) problems.push('search phrase missing');
  if (!ev.checked || !DATE.test(ev.checked)) problems.push('checked date missing or not YYYY-MM-DD');
  else { const age = (today - new Date(ev.checked + 'T00:00:00Z')) / 86400000; if (age > maxAgeDays) problems.push('demand evidence is ' + Math.floor(age) + ' days old (max ' + maxAgeDays + ')'); if (age < -1) problems.push('checked date is in the future'); }
  if (!ev.url || !isUrl(ev.url, 'etsy.com') || !/\/search\b/.test(ev.url)) problems.push('search URL missing or not an https etsy.com search URL');
  // digits as Etsy shows them; Etsy caps large counts as e.g. "1,000+ items": kept as a lower bound (countIsLowerBound)
  const cm = ev.count && /^(\d[\d,]*)(\+)?(?:\s+(?:items?|results?))?$/i.exec(ev.count);
  if (!cm) problems.push('competitor count missing or not a number (digits as Etsy shows them, e.g. 4,812 or 1,000+ items)');
  else { ev.count = Number(cm[1].replace(/,/g, '')); ev.countIsLowerBound = !!cm[2]; }
  const sm = ev.saturation && /^(very high|high|medium|low)\s*[—–-]\s*(\S.*)$/i.exec(ev.saturation);
  if (!sm) problems.push('saturation must be "low | medium | high | very high — <reason>"');
  else ev.saturation = { verdict: sm[1].toLowerCase(), reason: sm[2].trim() };
  // the top-five table: | # | listing | shop | price | reviews | bestseller | URL |
  const rows = sec.split('\n').filter((l) => /^\s*\|\s*\d+\s*\|/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  if (rows.length < 5) problems.push('top-5 table has ' + rows.length + ' row(s), needs 5');
  for (const [k, r] of rows.slice(0, 5).entries()) {
    const n = k + 1, [, title, shop, price, reviews, badge, url, notes] = r;
    if (r.length < 7) { problems.push('top-5 row ' + n + ' has ' + r.length + ' cells, needs 7 (#, listing, shop, price, reviews, bestseller, URL)'); continue; }
    if (!title) problems.push('row ' + n + ': listing title missing');
    if (!shop) problems.push('row ' + n + ': shop missing');
    const pm = /^(USD|EUR|GBP|CAD|AUD)\s*(\d+(?:\.\d{1,2})?)\b/i.exec(price || '');
    if (!pm) problems.push('row ' + n + ': price must be a currency code and a number (e.g. USD 4.99), got "' + price + '"');
    if (!/^\d[\d,]*$/.test(reviews || '')) problems.push('row ' + n + ': review count must be digits, got "' + reviews + '"');
    if (!/^(yes|no)$/i.test(badge || '')) problems.push('row ' + n + ': bestseller must be yes or no, got "' + badge + '"');
    if (!isUrl(url, 'etsy.com') || !/\/listing\/\d+/.test(url)) problems.push('row ' + n + ': URL must be an https etsy.com/listing/<id> URL');
    ev.rows.push({ title, shop, price: pm ? { currency: pm[1].toUpperCase(), amount: Number(pm[2]) } : null, reviews: Number(String(reviews).replace(/,/g, '')), bestseller: /^yes$/i.test(badge || ''), url, notes: notes || null });
  }
  return { ok: problems.length === 0, problems, evidence: ev };
}
