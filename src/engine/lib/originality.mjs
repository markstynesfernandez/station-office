// PORTED from Virtual-workers/station/scripts/lib/originality.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, re-ported: it changed after 16/10 19:16), source sha256 8801bf7781f83e129f75c35fa4a7bc0fcbc4164b51feac65e84adfd39fa83294.
//   5th moment: the near-miss allow-list (config.sloganScreen.nearMissAllow, exact whole words) and the digital set screen (designDeliverableText,
//               screenDigitalSet, screenDigitalSetOnDisk) came from the source unchanged; hitLine labels a hit without a field "text" (port item 13)
//   change: SOFT_CATEGORIES is [] (owner Q5: the saturated list applies to all text; the source applied it to slogans only)
//   change: file writes go through the engine's data jail (dataJail from ../store/active.mjs)
//   change: job folders are data/jobs/<id>/ with outbox/ inside (were room1-etsy/work/<id>/ and outbox/<id>/)
//   change: FUZZY_CATEGORIES includes 'scouted-games' (owner 17/10/2026: scouted names match exact plus one-letter misspellings)
//   new: the owner's exact-phrase allow-list (config.sloganScreen.phraseAllow; owner, 18/10/2026: "apple cider", "apple" alone stays
//        blocked): a listed phrase found word for word inside an allowed phrase, word for word, is not a hit there
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// originality.mjs (lib) — the DETERMINISTIC originality screen. Pure functions over text + config (no model, no network).
// It hard-fails what a word list can know: trademarks and brand names, characters and franchises, real people, lyrics / film-TV-book quotes /
// well-known slogans, sports teams and leagues, named artists and "in the style of" wording, and "inspired by / dupe / copy of" wording.
// The lists live in config.sloganScreen.lists (one owner-edited source, plus rooms/etsy-digital/blocklist.txt passed in as extra terms).
// A clear result is NEVER clearance: QA DESIGN and QA LISTING still judge what the lists cannot know (the picture, new celebrities, new brands).
//
// Matching is on normalised text, so these all hit the same phrase:   Nike  NIKE  N.I.K.E  n i k e  n1ke  Nike's  nikes  Pokémon  spiderman  Spider-Man
//   - case, accents, punctuation, apostrophes, "&"
//   - plurals and possessives of the TEXT word (disneys -> disney); never the reverse, so "eagle" does not hit the team "eagles"
//   - spaced-out letters (a run of 3+ single letters is joined) and compounds (spiderman = spider man, either way round)
//   - digit/symbol swaps (0 3 4 5 7 @ $, and 1 as i or l)
//   - ONE edit (typo, swapped letters, doubled letter) in a single-word name of 6+ letters with the same first letter (addidas, starbuks)
// The 'saturated' list (stock tee slogans) is a quality list: it applies to slogans only, never to titles, tags or design notes.
import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig, STATION, BLOCKLIST_FILE } from './common.mjs';
import { dataJail } from '../store/active.mjs';

// owner, 16/10/2026 (DECISIONS.md Q5): the saturated list applies to ALL text, so no category is soft any more
export const SOFT_CATEGORIES = [];
// typo-tolerant matching only for names people misspell on purpose; generic words (cowboys, eagles, giants) must match exactly
// change (owner, 17/10/2026, "Scouting decisions"): 'scouted-games' (the engine's scouting blocklist) gets the same one-letter match
const FUZZY_CATEGORIES = new Set(['brands', 'characters', 'franchises', 'people', 'artists', 'scouted-games']);
const LEET = { 0: 'o', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

const strip = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘`']/g, '').replace(/&/g, ' and ');
const letters = (s) => s.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// 3+ consecutive single letters are one spaced-out word ("n i k e")
function joinSingles(tokens) {
  const out = []; let run = [];
  const flush = () => { if (run.length >= 3) out.push(run.join('')); else out.push(...run); run = []; };
  for (const t of tokens) { if (/^[a-z]$/.test(t)) run.push(t); else { flush(); out.push(t); } }
  flush();
  return out;
}

// the token lists to match: the plain reading, plus the digit/symbol-swap readings when the text has any
export function readings(text) {
  const s = strip(text), plain = joinSingles(letters(s)), out = [{ via: 'exact', tokens: plain }];
  if (/[a-z][0-9@$!|]|[0-9@$!|][a-z]/.test(s)) {
    const swap = (one) => s.split(/\s+/).map((w) => /[a-z]/.test(w) ? w.replace(/[03457@$]/g, (c) => LEET[c] || c).replace(/1/g, one).replace(/(?<=[a-z])[!|](?=[a-z])/g, 'i') : w).join(' ');
    for (const one of ['i', 'l']) { const t = joinSingles(letters(swap(one))); if (t.join(' ') !== plain.join(' ')) out.push({ via: 'symbol-swap', tokens: t }); }
  }
  return out;
}

// text token -> the forms it may stand for (itself, without a plural/possessive s or es)
const forms = (t) => { const f = new Set([t]); if (t.length > 3 && t.endsWith('s')) f.add(t.slice(0, -1)); if (t.length > 4 && t.endsWith('es')) f.add(t.slice(0, -2)); return f; };

// optimal-string-alignment distance (one swap = 1 edit), stops early past `max`
function distance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}

const cache = new WeakMap();
function compile(cfg, extra) {
  const key = cfg.sloganScreen || cfg;
  let base = cache.get(key);
  if (!base) {
    const lists = (cfg.sloganScreen && cfg.sloganScreen.lists) || {}, entries = [];
    // known false positives of the near-miss match (owner, 2026-10-17: "chunky" is not "Chucky"): listed phrase -> ordinary words it must not catch
    const allowCfg = (cfg.sloganScreen && cfg.sloganScreen.nearMissAllow) || {}, allowOf = {};
    for (const [phrase, words] of Object.entries(allowCfg)) if (Array.isArray(words)) allowOf[letters(strip(phrase)).join('')] = new Set(words.map((w) => letters(strip(w)).join(' ')));
    // owner-approved exact phrases (owner, 18/10/2026): listed phrase -> phrases it may stand inside, word for word
    const phraseCfg = (cfg.sloganScreen && cfg.sloganScreen.phraseAllow) || {}, phrasesOf = {};
    for (const [phrase, within] of Object.entries(phraseCfg)) if (Array.isArray(within)) phrasesOf[letters(strip(phrase)).join('')] = within.map((w) => letters(strip(w))).filter((w) => w.length);
    for (const [category, phrases] of Object.entries(lists)) for (const phrase of phrases) { const sq = letters(strip(phrase)).join(''), a = allowOf[sq], w = phrasesOf[sq]; entries.push({ phrase, category, ...(a ? { nearMissAllow: a } : {}), ...(w ? { phraseAllow: w } : {}) }); }
    base = entries; cache.set(key, base);
  }
  const all = [...base, ...(extra || []).map((t) => ({ phrase: t, category: 'blocklist.txt' }))];
  return all.map((e) => { const q = letters(strip(e.phrase)); return q.length ? { ...e, q, squashed: q.join('') } : null; }).filter(Boolean);
}

// is tokens[i..i+m) inside one of the entry's owner-approved phrases, every word exact (no plural, no compound)?
function inAllowedPhrase(e, tokens, i, m) {
  if (!e.phraseAllow) return false;
  const span = tokens.slice(i, i + m).join(' ');
  for (const ap of e.phraseAllow) for (let o = 0; o + m <= ap.length; o++) {
    if (ap.slice(o, o + m).join(' ') !== span || i - o < 0 || i - o + ap.length > tokens.length) continue;
    if (tokens.slice(i - o, i - o + ap.length).join(' ') === ap.join(' ')) return true;
  }
  return false;
}

// every hit of one phrase entry in one token list, or null
function matchEntry(e, tokens, via) {
  const k = e.q.length, n = tokens.length;
  for (let i = 0; i + k <= n; i++) {   // the phrase word for word (text words may be plural / possessive)
    let ok = true, plural = false;
    for (let j = 0; j < k && ok; j++) { const t = tokens[i + j]; if (t === e.q[j]) continue; if (forms(t).has(e.q[j])) plural = true; else ok = false; }
    if (ok && !plural && inAllowedPhrase(e, tokens, i, k)) continue;
    if (ok) return { via: via === 'exact' ? (plural ? 'plural-or-possessive' : 'exact') : via, matched: tokens.slice(i, i + k).join(' ') };
  }
  if (e.squashed.length >= 6) {   // compounds: "spiderman" for "spider man" and "spider man" for "spiderman"
    for (let i = 0; i < n; i++) { let acc = ''; for (let m = 1; m <= k + 1 && i + m <= n; m++) { acc += tokens[i + m - 1]; if (acc === e.squashed || (acc.endsWith('s') && acc.slice(0, -1) === e.squashed)) { if (m !== k) return { via: via === 'exact' ? 'compound' : via, matched: tokens.slice(i, i + m).join(' ') }; } } }
  }
  if (!FUZZY_CATEGORIES.has(e.category)) return null;
  // a known ordinary word, never a misspelling of this name: the exact whole word as listed (after case and punctuation), no plural
  // stripping and no fuzzy match, so every form the owner allows is listed ("channel" and "channels"; owner, 2026-10-17)
  const allowed = (w) => !!(e.nearMissAllow && e.nearMissAllow.has(w));
  if (k === 1 && e.squashed.length >= 6) {   // one typo in a single long name
    for (const t of tokens) if (t.length >= 5 && t[0] === e.squashed[0] && t !== e.squashed && !allowed(t) && [...forms(t)].some((f) => f !== e.squashed && distance(f, e.squashed) <= 1)) return { via: 'near-miss-spelling', matched: t };
  } else if (k > 1 && e.squashed.length >= 10) {
    for (let i = 0; i < n; i++) { let acc = ''; for (let m = 1; m <= k + 1 && i + m <= n; m++) { acc += tokens[i + m - 1]; if (acc[0] === e.squashed[0] && acc !== e.squashed && !allowed(tokens.slice(i, i + m).join(' ')) && distance(acc, e.squashed) <= 1) return { via: 'near-miss-spelling', matched: tokens.slice(i, i + m).join(' ') }; } }
  }
  return null;
}

// screenText(text, cfg?, { extra: [terms from blocklist.txt], ignore: [categories] }) -> { result: 'hit'|'clear', hits: [{ phrase, category, via, matched }] }
export function screenText(text, cfg = defaultConfig, { extra = [], ignore = [] } = {}) {
  const reads = readings(text), skip = new Set(ignore), hits = [], seen = new Set();
  for (const e of compile(cfg, extra)) {
    if (skip.has(e.category)) continue;
    for (const r of reads) { const m = matchEntry(e, r.tokens, r.via); if (m) { const key = e.category + '|' + e.phrase; if (!seen.has(key)) { seen.add(key); hits.push({ phrase: e.phrase, category: e.category, via: m.via, matched: m.matched }); } break; } }
  }
  return { result: hits.length ? 'hit' : 'clear', hits };
}

// screenFields({ name: text|[text] }, cfg, { extra, ignoreByField: { name: [categories] } }) -> { result, hits: [{ field, ...hit }], screened: [names] }
export function screenFields(fields, cfg = defaultConfig, { extra = [], ignoreByField = {}, ignore = [] } = {}) {
  const hits = [], screened = [];
  for (const [name, value] of Object.entries(fields)) {
    const parts = Array.isArray(value) ? value.map((v, i) => [name + '[' + (i + 1) + ']', v]) : [[name, value]];
    for (const [label, text] of parts) {
      if (!String(text || '').trim()) continue;
      screened.push(label);
      const r = screenText(text, cfg, { extra, ignore: [...ignore, ...(ignoreByField[name] || [])] });
      for (const h of r.hits) hits.push({ field: label, ...h });
    }
  }
  return { result: hits.length ? 'hit' : 'clear', hits, screened };
}
// a hit without a field (screenText's) is labelled "text", never "undefined" (legacy bug, owner 2026-10-17, port item 13)
export const hitLine = (h) => (h.field || 'text') + ': "' + h.matched + '" matches ' + h.category + ' "' + h.phrase + '"' + (h.via !== 'exact' ? ' (' + h.via + ')' : '');

export { BLOCKLIST_FILE };   // the owner's listing-text blocklist (common.mjs)
export const defaultExtra = () => loadExtraTerms(BLOCKLIST_FILE);
export function loadExtraTerms(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// ---- what a design and a listing say, as screenable fields ----
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
// the exact image prompt written by the Designer in design-vN.md ("## Image prompt (exact)" up to the next heading). The self-check section is NOT screened: it says "no trademarks".
export function imagePromptOf(md) {
  const m = /^#{1,4}\s*(?:exact\s+)?image prompt[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(String(md || '').replace(/\r\n/g, '\n'));
  return m ? m[1].trim() : '';
}
export function latestDesignN(roomDir, id, workDir) {
  const dir = workDir || path.join(roomDir, 'jobs', id); if (!fs.existsSync(dir)) return 0;
  return Math.max(0, ...fs.readdirSync(dir).map((f) => /^design-v(\d+)\.(?:md|slogan\.json)$/.exec(f)).filter(Boolean).map((m) => Number(m[1])));
}
// the listing whose design files changed most recently (the one QA DESIGN is about to review)
export function newestDesignId(roomDir) {
  const root = path.join(roomDir, 'jobs'); if (!fs.existsSync(root)) return null;
  let best = null;
  for (const id of fs.readdirSync(root)) {
    const n = /^\d{4}-\d{2}-\d{2}--/.test(id) ? latestDesignN(roomDir, id) : 0; if (!n) continue;
    const t = Math.max(...['md', 'slogan.json'].map((x) => { try { return fs.statSync(path.join(root, id, 'design-v' + n + '.' + x)).mtimeMs; } catch (_) { return 0; } }));
    if (!best || t > best.t) best = { id, t };
  }
  return best && best.id;
}
export function designFields(roomDir, id, n, workDir) {
  const dir = workDir || path.join(roomDir, 'jobs', id), rec = readJson(path.join(dir, 'design-v' + n + '.slogan.json')) || {}, fields = {}, ignoreByField = { picture: SOFT_CATEGORIES, imagePrompt: SOFT_CATEGORIES };
  if (Array.isArray(rec.options)) fields.sloganOptions = rec.options;
  if (rec.chosen) fields.chosenSlogan = rec.chosen;
  if (rec.ownerPick && rec.ownerPick.slogan) fields.ownerSlogan = rec.ownerPick.slogan;
  if (rec.picture) fields.picture = rec.picture;
  const mdFile = path.join(dir, 'design-v' + n + '.md');
  if (fs.existsSync(mdFile)) { const p = imagePromptOf(fs.readFileSync(mdFile, 'utf8')); if (p) fields.imagePrompt = p; }
  return { fields, ignoreByField, hasPrompt: !!fields.imagePrompt, hasSlogans: !!fields.sloganOptions };
}
export function listingFields(L) {
  const f = {}; if (!L || typeof L !== 'object') return f;
  if (L.title) f.title = L.title; if (Array.isArray(L.tags)) f.tags = L.tags.map(String); if (L.description) f.description = L.description; if (L.altText) f.altText = L.altText;
  return f;
}
// saturated (stock slogan templates) is judged for slogans only; every other category applies to every field
export const SLOGAN_FIELDS = ['sloganOptions', 'chosenSlogan', 'ownerSlogan'];

// design text is screened against the config lists only: rooms/etsy-digital/blocklist.txt is the owner's LISTING-text backstop (title, tags, description, alt text)
export function screenDesign({ roomDir, id, n, cfg = defaultConfig, workDir }) {
  const v = n || latestDesignN(roomDir, id, workDir), d = designFields(roomDir, id, v, workDir);
  const r = screenFields(d.fields, cfg, { ignoreByField: d.ignoreByField });
  return { stage: 'design-originality', listingId: id, n: v, result: r.hits.length ? 'hit' : 'clear', hits: r.hits, screened: r.screened, note: 'local deterministic screen: a clear result is not clearance, judge the picture and anything the lists cannot know' };
}
export function screenListing({ listing, id, cfg = defaultConfig, extra = [] }) {
  const r = screenFields(listingFields(listing), cfg, { extra, ignore: SOFT_CATEGORIES });
  return { stage: 'listing-originality', listingId: id, result: r.hits.length ? 'hit' : 'clear', hits: r.hits, screened: r.screened, note: 'local deterministic screen: a clear result is not clearance' };
}

// a digital set's design.md without the Designer's SELF-CHECK section (OWNER exception to the station freeze, 2026-10-17: the screen failed
// set-v3 on "copy of" in the Designer's own notes). The skip is narrow (owner, 2026-10-17): only a section whose heading says self-check, to the
// next heading of the same or a higher level. Everything else in design.md (the design description, every image prompt, every per-file note)
// is screened. Returns { text, skipped: { sections } }.
export function designDeliverableText(md) {
  const keep = [], skipped = { sections: [] };
  let skipLevel = 0;
  for (const l of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h && skipLevel && h[1].length <= skipLevel) skipLevel = 0;
    if (h && !skipLevel && /self[- ]?check/i.test(h[2])) { skipLevel = h[1].length; skipped.sections.push(h[2].trim()); continue; }
    if (skipLevel) continue;
    keep.push(l);
  }
  return { text: keep.join('\n'), skipped };
}
// the originality screen of a DIGITAL set (digital-prep, run-line --first-file): everything except the Designer's self-check section —
// design.md (description and prompts), the deliverables' file names, the whole brief, and the listing text when there is one (title, tags,
// description, alt text; also screened against the owner's blocklist, as at the listing stage).
export function screenDigitalSet({ designMd = '', fileNames = [], briefText = '', listing = null, cfg = defaultConfig, extra = [] }) {
  const d = designDeliverableText(designMd);
  const fields = { 'design.md': d.text, 'file names': fileNames.map((f) => String(f).replace(/\.[a-z0-9]+$/i, '')), 'brief.md': briefText };
  const r = screenFields(fields, cfg, { ignore: SOFT_CATEGORIES });
  const lf = Object.fromEntries(Object.entries(listingFields(listing)).map(([k, v]) => ['listing ' + k, v]));
  const l = screenFields(lf, cfg, { extra, ignore: SOFT_CATEGORIES });
  const hits = [...r.hits, ...l.hits];
  return { result: hits.length ? 'hit' : 'clear', hits, screened: [...r.screened, ...l.screened], skipped: d.skipped };
}
// the same, read from disk: set-vN/design.md, jobs/<id>/brief.md, jobs/<id>/outbox/listing.json (when written)
export function screenDigitalSetOnDisk({ roomDir, id, n, fileNames = [], cfg = defaultConfig, extra = defaultExtra() }) {
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const designMd = read(path.join(roomDir, 'jobs', id, 'set-v' + n, 'design.md'));
  return { designMd, ...screenDigitalSet({ designMd, fileNames, briefText: read(path.join(roomDir, 'jobs', id, 'brief.md')), listing: readJson(path.join(roomDir, 'jobs', id, 'outbox', 'listing.json')), cfg, extra }) };
}

// idempotent record files under work/<id>/derived/ (same inputs -> same bytes -> nothing written)
function writeRecord(file, rec) {
  const text = JSON.stringify(rec, null, 1) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return 'unchanged';
  fs.mkdirSync(dataJail(path.dirname(file), { allowRoot: true }), { recursive: true }); fs.writeFileSync(dataJail(file), text); return 'written';
}
export function recordDesignOriginality({ roomDir, id, n, cfg = defaultConfig, log }) {
  const rec = screenDesign({ roomDir, id, n, cfg });
  if (!rec.n) return { ok: false, reason: 'no design version found for ' + id };
  const file = path.join(roomDir, 'jobs', id, 'derived', 'design-v' + rec.n + '.originality.json'), action = writeRecord(file, rec);
  if (log) (rec.result === 'hit' ? log.warn : log.info)('design originality screen ' + rec.result, { id, n: rec.n, action, hits: rec.hits.map(hitLine) });
  return { ok: true, action, file, ...rec };
}
export function recordListingOriginality({ roomDir, id, cfg = defaultConfig, extra = defaultExtra(), log }) {
  const lf = path.join(roomDir, 'jobs', id, 'outbox', 'listing.json'), L = readJson(lf);
  if (!L) return { ok: false, reason: 'jobs/' + id + '/outbox/listing.json is missing or unreadable' };
  const rec = screenListing({ listing: L, id, cfg, extra }), file = path.join(roomDir, 'jobs', id, 'derived', 'listing.originality.json'), action = writeRecord(file, rec);
  if (log) (rec.result === 'hit' ? log.warn : log.info)('listing originality screen ' + rec.result, { id, action, hits: rec.hits.map(hitLine) });
  return { ok: true, action, file, ...rec };
}
