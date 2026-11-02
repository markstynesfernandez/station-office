// scouting.mjs — the genre-trend scouting line's IP fence (DECISIONS.md "Genre-trend scouting"). Station code, no model.
// TREND-SCOUT reads public popularity signals (top streamed categories, store charts) and writes two things into the
// research folder: internal scouting notes at scouting/<day>/<jobId>/notes.json (games, studios, evidence links: the ONLY
// place a game title may appear; one file per job, so a second run on the same day never overwrites the first's notes) and
// up to 4 genre briefs in its own drafts folder, scout-drafts/<day>/ (genre and aesthetic only, `origin: genre-scout`), so
// the research line and this line can run on the same day without sharing drafts.
//   - every title the scout records (plus its studio and any `alsoBlock` names: characters, locations, items) goes into
//     the scouting blocklist, scouting/blocklist.json, written by the engine only (never by an agent); entries stay for good.
//     E6 b3 (owner, 17/10/2026): this happens whenever a job ends, whatever the outcome (done, incomplete, report_blocked,
//     failed, cap, e-stop, restart recovery), not only when TREND-SCOUT finishes normally (blocklistFromNotes)
//   - the engine puts that list into the originality lists (category "scouted-games", exact plus the station's one-letter
//     misspelling match) together with extra derivative wording (whole phrases: "fan art", "fandom", "tribute", ...); so the
//     brief check, intake, the image-prompt screen, the design-set screen and the listing/package gates all refuse a
//     scouted name, wherever it appears
//   - a title the notes tag "common-word" (an ordinary dictionary word) is the exception: the bare word only WARNS (the
//     brief check and the listing report it; QA-LISTING judges the context), while the full title and "<word> game" still
//     hard-fail like any scouted name
//   - the notes (scouting/<day>/ with every job's folder, and scouting/blocked/<day>/) are deleted 90 days after their day, by an engine step at the
//     start of every scout run; the blocklist is never deleted
//   - a brief is screened WHOLE against the scouted names (not only its Design direction); a genre-scout brief is also
//     screened whole for derivative wording
//   - a genre-scout draft that fails that screen is moved to scouting/blocked/<day>/ (it names a game, so it stays there)
//   - scouting/ is invisible to every agent but TREND-SCOUT (tools/index.mjs: agent config `scoutingNotes: true`), and a
//     job folder only ever receives brief.md, so DESIGNER, LISTER and the QA agents never see the notes
import fs from 'node:fs';
import path from 'node:path';
import { screenText, screenFields, hitLine } from './originality.mjs';

export const SCOUT_DIR = 'scouting';                       // inside data/research/
export const SCOUTED = 'scouted-games', WORDING = 'derivative-wording';
export const ORIGIN = 'genre-scout';
// on top of the station's own derivative list (in the style of, inspired by, dupe, fan art, homage to, unofficial, ...).
// Owner, 17/10/2026 ("Scouting decisions"): whole phrases only, no bare "fan" (it blocked a "desk fan" prop).
// "fan-made" and "fan made" read the same once punctuation is stripped; both are listed as the owner gave them.
export const DERIVATIVE_WORDING = ['fan art', 'fanart', 'fan-made', 'fan made', 'fandom', 'fanfic', 'inspired by', 'homage', 'tribute', 'dupe', 'knockoff', 'alternative to'];
export const NOTES_KINDS = { aaa: 2, indie: 2 };           // owner: 2 popular AAA titles and 2 indie titles per run
export const COMMON = 'scouted-common-word';               // warn-only: never put in the originality lists
export const NOTE_TAGS = ['common-word'];
export const RETENTION_DAYS = 90;                          // owner, 17/10/2026: notes go after 90 days; the blocklist stays
export const DRAFTS_DIR = 'drafts', SCOUT_DRAFTS_DIR = 'scout-drafts';
export const draftsDirOf = (line) => (line && line.drafts) || DRAFTS_DIR;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const norm = (s) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// the bare word of a "common-word" title: the title without a subtitle (after ":" or a dash) or a leading article
export const bareWordOf = (title) => clean(clean(title).split(/\s*[:\u2013\u2014]\s*|\s+-\s+/)[0].replace(/^(the|a|an)\s+/i, ''));
// E6 b3 (owner, 17/10/2026): one notes file per job, scouting/<day>/<jobId>/notes.json; before b3 a day had one shared
// scouting/<day>/notes.json (legacyNotesFile), which a second run overwrote
export const notesRel = (day, jobId) => SCOUT_DIR + '/' + day + '/' + jobId + '/notes.json';
export const notesFile = (researchDir, day, jobId) => path.join(researchDir, SCOUT_DIR, day, jobId, 'notes.json');
export const legacyNotesFile = (researchDir, day) => path.join(researchDir, SCOUT_DIR, day, 'notes.json');
// an earlier attempt's notes of the same job (a restart or a resume after an engine stop), moved aside, never overwritten
export const REPLACED_NOTES_RE = /^notes-replaced-[0-9TZ]+\.json$/;
// every scouting day folder (not blocked/)
export const notesDays = (researchDir) => { const d = path.join(researchDir, SCOUT_DIR); return fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && DAY_RE.test(e.name)).map((e) => e.name).sort() : []; };
// every notes file of a day, all jobs: -> [{ jobId (null for the pre-b3 shared file), rel, file, notes (parsed, or null), error }]
// sorted by job id, the pre-b3 file first. Anything that reads notes reads them all, never one job's alone.
export function readDayNotes(researchDir, day) {
  const dir = path.join(researchDir, SCOUT_DIR, day), out = [];
  if (!DAY_RE.test(String(day)) || !fs.existsSync(dir)) return out;
  const one = (jobId, file) => { const rel = path.relative(researchDir, file).split(path.sep).join('/'); try { return { jobId, rel, file, notes: JSON.parse(fs.readFileSync(file, 'utf8')), error: null }; } catch (e) { return { jobId, rel, file, notes: null, error: e.message }; } };
  if (fs.existsSync(legacyNotesFile(researchDir, day))) out.push(one(null, legacyNotesFile(researchDir, day)));
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    for (const f of fs.readdirSync(path.join(dir, e.name)).filter((x) => x === 'notes.json' || REPLACED_NOTES_RE.test(x)).sort()) out.push(one(e.name, path.join(dir, e.name, f)));
  }
  return out;
}
export const blocklistFile = (researchDir) => path.join(researchDir, SCOUT_DIR, 'blocklist.json');
export const isScoutPath = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0].toLowerCase() === SCOUT_DIR;

// -> { ok, problems: [], entries: [{ game, kind, genre, studio, alsoBlock, commonWord, evidence: [{ url, signal }], date }] }
// tags: ["common-word"] marks a title that is an ordinary dictionary word (commonWord is then its bare word, else null)
export function validateNotes(notes, { day } = {}) {
  const problems = [], entries = [];
  if (!notes || typeof notes !== 'object' || !Array.isArray(notes.entries)) return { ok: false, problems: ['notes.json must be { "day", "entries": [...] }'], entries };
  if (day && notes.day !== day) problems.push('notes.day must be ' + day);
  const count = { aaa: 0, indie: 0 };
  notes.entries.forEach((e, i) => {
    const at = 'entry ' + (i + 1), game = clean(e && e.game), kind = clean(e && e.kind).toLowerCase(), genre = clean(e && e.genre);
    if (!game || game.length < 2) problems.push(at + ': game is required');
    if (!(kind in NOTES_KINDS)) problems.push(at + ': kind must be "aaa" or "indie"'); else count[kind]++;
    if (!genre) problems.push(at + ': genre is required');
    const ev = Array.isArray(e && e.evidence) ? e.evidence : [];
    if (!ev.length) problems.push(at + ': at least one evidence link is required');
    for (const x of ev) if (!/^https:\/\/\S+$/.test(String(x && x.url))) problems.push(at + ': evidence url must be https: ' + (x && x.url));
    if (!DAY_RE.test(String(e && e.date))) problems.push(at + ': date must be YYYY-MM-DD');
    const also = Array.isArray(e && e.alsoBlock) ? e.alsoBlock.map(clean).filter(Boolean) : [];
    const tags = e && e.tags != null ? (Array.isArray(e.tags) ? e.tags.map(clean) : null) : [];
    if (!tags) problems.push(at + ': tags must be a list'); else for (const x of tags) if (!NOTE_TAGS.includes(x)) problems.push(at + ': unknown tag "' + x + '" (allowed: ' + NOTE_TAGS.join(', ') + ')');
    const commonWord = tags && tags.includes('common-word') ? bareWordOf(game) : null;
    if (commonWord !== null && norm(commonWord).replace(/ /g, '').length < 2) problems.push(at + ': a common-word title needs a bare word (the title without its article or subtitle)');
    entries.push({ game, kind, genre, studio: clean(e && e.studio) || null, alsoBlock: also, commonWord: commonWord || null, evidence: ev.map((x) => ({ url: String(x && x.url), signal: clean(x && x.signal) })), date: String(e && e.date) });
  });
  for (const [k, n] of Object.entries(NOTES_KINDS)) if (count[k] !== n) problems.push('needs exactly ' + n + ' ' + k + ' entries (has ' + count[k] + ')');
  return { ok: problems.length === 0, problems, entries };
}

// every name a run's notes put on the blocklist: the title, the studio, and the alsoBlock names (addToBlocklist keeps
// the name-like ones only)
export const termsOf = (entries) => entries.flatMap((e) => [{ term: e.game, kind: 'game', ...(e.commonWord ? { commonWord: e.commonWord } : {}) }, ...(e.studio ? [{ term: e.studio, kind: 'studio' }] : []), ...e.alsoBlock.map((t) => ({ term: t, kind: 'related' }))]);

// owner D4 (17/10/2026): only name-like strings are ever added automatically. A placeholder (UNKNOWN, TBD, TBA, N/A, none,
// "needs owner check", ...), an empty string, one under 3 characters or one with no letter or digit is not a name: it is
// refused and logged, never added (a placeholder on the list would match every brief that uses the same placeholder).
const PLACEHOLDER_TERM = /\b(?:unknown|tbd|tba|n\/?a|none|null|undefined|not known|not stated|unnamed|various|placeholder|to be confirmed|needs? (?:an? )?owner check|owner check)\b|\?{2,}/i;
export function notNameReason(term) {
  const t = clean(term);
  if (!t) return 'empty';
  if (t.length < 3) return 'under 3 characters';
  if (!/[\p{L}\p{N}]/u.test(t)) return 'no letter or digit';
  if (PLACEHOLDER_TERM.test(t)) return 'a placeholder, not a name';
  return null;
}
export const isNameLike = (term) => notNameReason(term) === null;

export function readBlocklist(researchDir) {
  try { const b = JSON.parse(fs.readFileSync(blocklistFile(researchDir), 'utf8')); return Array.isArray(b.terms) ? b : { terms: [] }; } catch (_) { return { terms: [] }; }
}
const BLOCKLIST_COMMENT = 'Scouting blocklist: written by the engine from TREND-SCOUT notes only. Every name here hard-fails the brief check, intake, image prompts, the design set and the listing. Internal: never shown to DESIGNER, LISTER or QA. An entry with commonWord is a title that is an ordinary word: the bare word only warns (QA-LISTING checks the context); the full title and <word> game hard-fail. Only name-like strings are added (owner D4: placeholders such as UNKNOWN, TBD, N/A or "needs owner check", and anything under 3 characters, are refused and logged). The owner may add names by hand; the engine never removes one (the notes are deleted after 90 days; this list stays).';
const writeBlocklist = (J, researchDir, terms) => J.put(blocklistFile(researchDir), JSON.stringify({ $comment: BLOCKLIST_COMMENT, terms }, null, 1) + '\n');
// idempotent: a term already listed (any case) is not added again (so a title first listed plain stays a hard fail even if
// a later run tags it common-word: fails closed); nothing is ever removed by the engine. A term that is not name-like is
// refused: logged (log.warn) and returned in `refused`, never written.
// -> the added entries (an array), with .refused = [{ term, kind, reason }]
// write: false (the owner's backfill, report only) works out the same result and writes nothing
export function addToBlocklist(J, researchDir, terms, { day, jobId, log = null, write = true }) {
  const cur = readBlocklist(researchDir), have = new Set(cur.terms.map((t) => t.term.toLowerCase())), added = [], refused = [];
  for (const t of terms) {
    const term = clean(t.term), why = notNameReason(term);
    if (why) { refused.push({ term, kind: t.kind, reason: why }); if (log) log.warn('scouting blocklist: refused a term that is not a name', { jobId, kind: t.kind, term, reason: why }); continue; }
    if (have.has(term.toLowerCase())) continue; have.add(term.toLowerCase()); added.push({ term, kind: t.kind, ...(t.commonWord ? { commonWord: clean(t.commonWord) } : {}), day, jobId });
  }
  if (added.length && write) writeBlocklist(J, researchDir, [...cur.terms, ...added].sort((a, b) => a.term.localeCompare(b.term)));
  // owner decision 4 (17/10/2026): a refused SHORT name (under 3 characters, perhaps a real title) goes to the owner's
  // review list, never onto the blocklist; the owner adds it by hand if it is a real name
  const short = refused.filter((r) => r.reason === SHORT_REASON);
  if (short.length) {
    const cur2 = readShortNames(researchDir), have2 = new Set(cur2.entries.map((x) => x.kind + '|' + x.term));
    const fresh = short.filter((r) => !have2.has(r.kind + '|' + r.term)).map((r) => ({ term: r.term, kind: r.kind, day, jobId }));
    if (fresh.length && write) { J.put(shortNamesFile(researchDir), JSON.stringify({ $comment: SHORT_COMMENT, entries: [...cur2.entries, ...fresh] }, null, 1) + '\n'); if (log) log.warn('scouting blocklist: short name(s) put on the owner review list, not the blocklist', { jobId, count: fresh.length }); }
  }
  added.refused = refused;
  return added;
}
// E6 b3 (owner, 17/10/2026): the one blocklist pass over one notes file, used at scout-notes, when a job ends (whatever
// the outcome), before a restarted scout step and by the owner's backfill. Fails closed: names are taken from the notes
// even when they fail validation (a wrong count, a missing link); only the name-like filter refuses a term (placeholders
// refused, short names to the review list). Idempotent (addToBlocklist). Unreadable notes add nothing and say why.
// -> { added: [...], refused: [...], problems: [validation problems], games, unreadable: reason | null }
export function blocklistFromNotes(J, researchDir, notes, { day, jobId, log = null, write = true }) {
  if (!notes || typeof notes !== 'object' || !Array.isArray(notes.entries)) {
    const why = 'notes are not { "day", "entries": [...] }';
    if (log) log.warn('scouting notes: no names could be read', { jobId, day, reason: why });
    return { added: [], refused: [], problems: [why], games: 0, unreadable: why };
  }
  const v = validateNotes(notes, { day });
  const added = addToBlocklist(J, researchDir, termsOf(v.entries), { day, jobId, log, write });
  return { added: [...added], refused: added.refused, problems: v.problems, games: v.entries.length, unreadable: null };
}

// E6 b3 (owner, 17/10/2026): the owner's backfill (scripts/blocklist-hygiene.mjs --backfill), run by hand:
//   1. a pre-b3 shared notes file (scouting/<day>/notes.json) moves into the folder of the job that wrote it: the job
//      whose transcript (jobsDir/<id>/transcript.jsonl) has the LAST fs_write to that path, with content byte for byte
//      the file. No such job, or that job already has its own notes: left where it is and reported (never guessed).
//   2. every notes file of every day goes through the blocklist pass (blocklistFromNotes).
// Report only unless apply (writes nothing then). Idempotent: a second apply moves nothing and adds nothing.
// Internal only: the result names the added and refused terms; it goes to the owner, never into customer-facing text.
// -> { migrated: [{ from, to, jobId }], unmatched: [{ file, reason }], files: [{ rel, jobId, games, notesProblems, unreadable,
//      added: [{ term, kind }], refused: [{ term, kind, reason }] }], added: n, refused: n }
export function backfillScouting(J, researchDir, { jobsDir, apply = false, log = null } = {}) {
  const migrated = [], unmatched = [], files = [];
  const rel = (f) => path.relative(researchDir, f).split(path.sep).join('/');
  // every fs_write of a notes file in every job transcript, oldest first
  const writes = [];
  for (const id of fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).sort() : []) {
    const tf = path.join(jobsDir, id, 'transcript.jsonl'); if (!fs.existsSync(tf)) continue;
    for (const line of fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean)) {
      let l; try { l = JSON.parse(line); } catch (_) { continue; }
      for (const c of l.toolCalls || []) if (c.name === 'fs_write' && c.input && typeof c.input.content === 'string') writes.push({ jobId: id, at: String(l.at || ''), path: String(c.input.path || '').replace(/\\/g, '/').replace(/^\.\//, ''), content: c.input.content });
    }
  }
  writes.sort((a, b) => a.at.localeCompare(b.at));
  for (const day of notesDays(researchDir)) {
    const lf = legacyNotesFile(researchDir, day); if (!fs.existsSync(lf)) continue;
    const last = writes.filter((w) => w.path === SCOUT_DIR + '/' + day + '/notes.json').pop();
    if (!last) { unmatched.push({ file: rel(lf), reason: 'no job transcript wrote it' }); continue; }
    if (last.content !== fs.readFileSync(lf, 'utf8')) { unmatched.push({ file: rel(lf), reason: 'the last write to it (job ' + last.jobId + ') differs from the file' }); continue; }
    const to = notesFile(researchDir, day, last.jobId);
    if (fs.existsSync(to)) { unmatched.push({ file: rel(lf), reason: 'job ' + last.jobId + ' already has its own notes file' }); continue; }
    if (apply) J.move(lf, to);
    migrated.push({ from: rel(lf), to: rel(to), jobId: last.jobId });
    if (log) log.info(apply ? 'scouting notes moved into the job that wrote them (E6 b3)' : 'scouting notes would move into the job that wrote them (report only)', { from: rel(lf), to: rel(to), jobId: last.jobId });
  }
  // the pass over every notes file (in report-only mode a migrating file is read where it is now)
  const seen = new Set();
  for (const day of notesDays(researchDir)) {
    for (const n of readDayNotes(researchDir, day)) {
      const m = !apply && n.jobId === null ? migrated.find((x) => x.from === n.rel) : null, jobId = m ? m.jobId : n.jobId;
      const r = n.notes ? blocklistFromNotes(J, researchDir, n.notes, { day, jobId, log, write: apply }) : { added: [], refused: [], problems: ['unreadable: ' + n.error], games: 0, unreadable: n.error };
      // report only: the same new term from two files is reported once (an apply would add it once)
      const added = r.added.filter((a) => !seen.has(a.term.toLowerCase())).map((a) => (seen.add(a.term.toLowerCase()), { term: a.term, kind: a.kind }));
      files.push({ rel: m ? m.to : n.rel, jobId, games: r.games, notesProblems: r.problems.length, unreadable: r.unreadable, added, refused: r.refused.map((x) => ({ term: x.term, kind: x.kind, reason: x.reason })) });
    }
  }
  return { apply, migrated, unmatched, files, added: files.reduce((s, f) => s + f.added.length, 0), refused: files.reduce((s, f) => s + f.refused.length, 0) };
}

const SHORT_REASON = 'under 3 characters';
const SHORT_COMMENT = 'Owner review list (owner decision 4, 17/10/2026): names under 3 characters that TREND-SCOUT recorded. They are never added to the scouting blocklist automatically; add one to blocklist.json by hand if it is a real game, studio or related name. Internal: inside scouting/, never shown to any agent but TREND-SCOUT.';
export const shortNamesFile = (researchDir) => path.join(researchDir, SCOUT_DIR, 'short-names-review.json');
export function readShortNames(researchDir) {
  try { const b = JSON.parse(fs.readFileSync(shortNamesFile(researchDir), 'utf8')); return Array.isArray(b.entries) ? b : { entries: [] }; } catch (_) { return { entries: [] }; }
}
// the owner's one-off hygiene (D4, scripts/blocklist-hygiene.mjs): the entries that are not name-like, removed only with
// apply (the engine itself never removes a name). Idempotent: a second run finds nothing.
// -> [{ term, kind, reason, day, jobId }]
export function blocklistPlaceholders(J, researchDir, { apply = false } = {}) {
  const cur = readBlocklist(researchDir), bad = cur.terms.filter((t) => notNameReason(t.term)).map((t) => ({ term: t.term, kind: t.kind, reason: notNameReason(t.term), day: t.day || null, jobId: t.jobId || null }));
  if (apply && bad.length) { const drop = new Set(bad.map((b) => b.term)); writeBlocklist(J, researchDir, cur.terms.filter((t) => !drop.has(t.term))); }
  return bad;
}

// the scouted names, re-read when the file changes (the engine reads this on every screen):
//   hard   every name that fails a gate; for a common-word title only its full title (when it differs from the bare
//          word) and "<bare word> game" (plural "games" matches too)
//   common the bare words of common-word titles: warn only
const termCache = new Map();
function blocklistLists(researchDir) {
  const f = blocklistFile(researchDir);
  let m = 0; try { m = fs.statSync(f).mtimeMs; } catch (_) { return { hard: [], common: [] }; }
  const c = termCache.get(f); if (c && c.m === m) return c.lists;
  const hard = [], common = [];
  for (const t of readBlocklist(researchDir).terms) {
    const term = clean(t.term), w = clean(t.commonWord); if (!term) continue;
    if (!w) { hard.push(term); continue; }
    if (norm(term) !== norm(w)) hard.push(term);
    hard.push(w + ' game'); common.push(w);
  }
  const lists = { hard, common };
  termCache.set(f, { m, lists });
  return lists;
}
export const scoutedTerms = (researchDir) => blocklistLists(researchDir).hard;
export const commonWords = (researchDir) => blocklistLists(researchDir).common;

// the warn-only screen for common-word titles (exact whole words, plurals, compounds; no misspelling match).
// fields: { name: text | [text] } -> ['title: "lantern"', ...]
export function commonWordWarnings(fields, words) {
  if (!words || !words.length) return [];
  return screenFields(fields, { sloganScreen: { lists: { [COMMON]: words } } }).hits.map((h) => h.field + ': "' + h.matched + '"');
}
// what QA-LISTING is told when the listing uses one (the bare word is already in the listing; the game is not named)
export const commonWordNote = (warnings) => '[STATION — common-word check, not a fail] The listing uses ' + warnings.join('; ') + '. ' + (warnings.length > 1 ? 'Each is' : 'It is') + ' an ordinary word that is also the title of a game on the station\'s scouting list. Check the context: it passes only in its everyday sense (an object, a mood, a colour). Ask for a revise if it reads as the game in any way: written as a title, next to "game", or with that game\'s characters, places, items or look.';

// retention (owner, 17/10/2026): scouting/<day>/ and scouting/blocked/<day>/ go once their day is more than 90 days
// before `today` (day 90 is kept); folders that are not a day, and blocklist.json, are never touched.
// -> [{ folder: 'scouting/<day>' | 'scouting/blocked/<day>', day }]
export function pruneScouting(J, researchDir, today, { days = RETENTION_DAYS } = {}) {
  if (!DAY_RE.test(String(today))) throw new Error('retention needs today as YYYY-MM-DD: ' + today);
  const cutoff = Date.parse(today + 'T00:00:00Z') - days * 86400000, out = [];
  for (const base of [[SCOUT_DIR], [SCOUT_DIR, 'blocked']]) {
    const dir = path.join(researchDir, ...base);
    for (const d of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (!d.isDirectory() || !DAY_RE.test(d.name) || !(Date.parse(d.name + 'T00:00:00Z') < cutoff)) continue;
      J.remove(path.join(dir, d.name));
      out.push({ folder: [...base, d.name].join('/'), day: d.name });
    }
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

// the station config with the scouting lists added to the originality lists (memoised per term list, so the
// originality module's compile cache, keyed by the sloganScreen object, still works)
const stationCache = new WeakMap();
export function withScouting(station, terms) {
  const key = terms.join('\u0001');
  let per = stationCache.get(station); if (!per) { per = new Map(); stationCache.set(station, per); }
  if (per.has(key)) return per.get(key);
  const ss = station.sloganScreen || {};
  const out = { ...station, sloganScreen: { ...ss, lists: { ...(ss.lists || {}), [SCOUTED]: terms.slice(), [WORDING]: DERIVATIVE_WORDING.slice() } } };
  per.clear(); per.set(key, out);
  return out;
}

// the customer-facing check (scout-live's report, scripts/blocklist-hygiene.mjs): each file (absolute paths, outside
// scouting/) against the scouted names on the blocklist (any case, anywhere), the scouting screen and the station's
// originality lists (brands, characters, people, derivative wording). Names are reported by kind only.
export function customerFacingCheck(researchDir, files, station) {
  const terms = readBlocklist(researchDir).terms, lower = (s) => String(s).toLowerCase();
  const detail = files.map((f) => { const t = fs.readFileSync(f, 'utf8'); return { file: path.relative(researchDir, f).split(path.sep).join('/'), scoutedNames: terms.filter((x) => lower(t).includes(lower(x.term))).map((x) => x.kind), scoutingScreen: scoutingBriefProblems(t, station).length, originality: screenText(t, station).hits.map((h) => h.category + ': ' + h.phrase) }; });
  return { files: detail.length, clean: detail.every((f) => !f.scoutedNames.length && !f.scoutingScreen && !f.originality.length), detail };
}

// the whole-brief screen: scouted names anywhere in the brief; derivative wording too when the brief is a genre-scout one
// E6 b1: a scout run exits 0 only when its job reached research-done (incomplete, blocked or stopped exit 1)
export const scoutRunExitCode = (job) => (job && job.state === 'research-done' ? 0 : 1);
export const isScoutBrief = (t) => new RegExp('^origin:[ \\t]*' + ORIGIN + '[ \\t]*$', 'm').test(String(t || ''));
// for the SCREEN only, fail closed (E6 b2): "origin: genre-scout" anywhere counts (b1's drafts had it on the
// audience_segment line and were skipped), and the caller can say the text is a scout brief whatever it says (scout: true,
// every draft in a genre-scout drafts folder)
const mentionsScoutOrigin = (t) => new RegExp('\\borigin:[ \\t]*' + ORIGIN + '\\b', 'i').test(String(t || ''));
export function scoutingBriefProblems(text, station, { scout = false } = {}) {
  const lists = (station && station.sloganScreen && station.sloganScreen.lists) || {};
  const only = { [SCOUTED]: lists[SCOUTED] || [], ...(scout || mentionsScoutOrigin(text) ? { [WORDING]: lists[WORDING] || [], derivative: lists.derivative || [] } : {}) };
  const sc = screenText(text, { sloganScreen: { lists: only, nearMissAllow: (station.sloganScreen || {}).nearMissAllow } });
  return sc.hits.map((h) => 'originality: brief ' + hitLine({ field: 'text', ...h }) + (h.category === SCOUTED ? ' (a scouted game: game names stay in the internal scouting notes)' : ''));
}
