// PORTED from Virtual-workers/station/scripts/lib/listing-fix.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, new in the source on 17/10/2026), source sha256 40ce12ea14b1c1d94271028f189c507001499501a219750af04013a4dc8aca8b.
//   change: none (pure functions; the engine step src/engine/owner.mjs fixListingText writes the files and the record)
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// listing-fix.mjs (lib) — deterministic owner text fixes to a Lister draft, no model call (OWNER exception to the station freeze, 2026-10-17:
// PNGTuber desk props r2, after QA LISTING's only finding was UK spelling for the US market). Three fixes, all the owner's decisions:
//   - US English on the public text only: listing.json title, description, altText and listing.md's "Title", "Description" and "Alt text"
//     sections. Whole words, exact case (the listing id, file paths and the ZIP name also contain "cosy" and are never touched).
//   - the reviewer note in listing.md that summarises the owner set approval is rebuilt from work/<id>/owner-set-approval.json (the record,
//     never the model's recollection).
//   - the "Owner to-do" section in listing.md is rebuilt from listing.json ownerTodo, so the two match (owner decision at approval,
//     2026-10-17: the md lacked "skim OpenRouter's terms of service before the first publish"). Left alone when the section holds anything
//     but "- " lines.
// Pure functions here; scripts/fix-listing-text.mjs writes the files and the record work/<id>/listing-fixes.json (chainFixRecord: one record,
// every round kept).

// the owner's list, 2026-10-17 (Cosy->Cozy, cosy->cozy, colour->color, colourway->colorway); \b keeps "colour" from matching inside "colourway"
export const US_SPELLING = [['Cosy', 'Cozy'], ['cosy', 'cozy'], ['colourway', 'colorway'], ['colour', 'color']];
export const JSON_FIELDS = ['title', 'description', 'altText'];
export const MD_SECTIONS = [/^## Title\b/, /^## Description\b/, /^## Alt text\b/];
const NOTE_SECTION = /^## Notes for the reviewer\b/, NOTE_LINE = /^- The owner-set approval records .*$/m, TODO_SECTION = /^## Owner to-do\b/;

export function usSpelling(text) {
  let out = String(text); const changes = [];
  for (const [uk, us] of US_SPELLING) {
    const re = new RegExp('\\b' + uk + '\\b', 'g'), n = (out.match(re) || []).length;
    if (n) { out = out.replace(re, us); changes.push({ from: uk, to: us, count: n }); }
  }
  return { text: out, changes };
}

// listing.md split on its "## " headings; fn(sectionText, heading) -> new text
function mapSections(md, pick, fn) {
  const parts = String(md).split(/(?=^## )/m);
  return parts.map((s) => (pick.some((re) => re.test(s)) ? fn(s) : s)).join('');
}

const nums = (files, status) => files.filter((f) => f.status === status).map((f) => f.name.slice(0, 2));
const list = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
export function approvalNote(record) {
  const ov = nums(record.files || [], 'owner-override'), fx = nums(record.files || [], 'deterministic-fix');
  return '- The owner-set approval records ' + (ov.length === 1 ? 'file ' : 'files ') + list(ov) + ' as owner overrides and ' + list(fx) + ' as deterministic fixes. The listing does not describe those internal records.';
}

// { listing, md, changes: [{ file, where, from, to, count }] }; unchanged inputs give no changes
export function fixListing({ listing, md, setApproval = null }) {
  const L = { ...listing }, changes = [];
  for (const k of JSON_FIELDS) {
    if (typeof L[k] !== 'string') continue;
    const r = usSpelling(L[k]); L[k] = r.text;
    for (const c of r.changes) changes.push({ file: 'listing.json', where: k, ...c });
  }
  let M = mapSections(md, MD_SECTIONS, (s) => {
    const head = s.split('\n', 1)[0], body = s.slice(head.length), r = usSpelling(body);
    for (const c of r.changes) changes.push({ file: 'listing.md', where: head.replace(/^## /, ''), ...c });
    return head + r.text;
  });
  if (setApproval) M = mapSections(M, [NOTE_SECTION], (s) => {
    const want = approvalNote(setApproval), m = NOTE_LINE.exec(s);
    if (!m || m[0] === want) return s;
    changes.push({ file: 'listing.md', where: 'Notes for the reviewer', from: m[0], to: want, count: 1 });
    return s.replace(NOTE_LINE, want);
  });
  if (Array.isArray(L.ownerTodo) && L.ownerTodo.every((t) => typeof t === 'string' && !t.includes('\n'))) M = mapSections(M, [TODO_SECTION], (s) => {
    const head = s.split('\n', 1)[0], body = s.slice(head.length), tail = body.match(/\n*$/)[0], lines = body.slice(0, body.length - tail.length).split('\n').filter((x) => x !== '');
    if (lines.some((x) => !x.startsWith('- '))) return s;
    const have = lines.map((x) => x.slice(2)), want = L.ownerTodo;
    if (have.length === want.length && have.every((x, i) => x === want[i])) return s;
    changes.push({ file: 'listing.md', where: 'Owner to-do', from: have, to: want, added: want.filter((x) => !have.includes(x)), removed: have.filter((x) => !want.includes(x)), count: 1 });
    return head + '\n' + want.map((x) => '- ' + x).join('\n') + (tail || '\n');
  });
  return { listing: L, md: M, changes };
}

// One record per listing, every round kept: the first round's "before" and backup, the latest "after" (what approve-listing.mjs ties to),
// changes and ownerWords across all rounds. A round only chains onto a record whose "after" is the listing it starts from: any other edit
// in between is refused, never folded in.
export function chainFixRecord(prev, round) {
  const same = (a, b) => !!a && !!b && a['listing.json'] === b['listing.json'] && a['listing.md'] === b['listing.md'];
  if (!prev) return { ok: true, record: { ...round.base, date: round.date, ownerWords: [round.ownerWords], before: round.before, after: round.after, backup: round.backup, changes: round.changes,
    rounds: [{ date: round.date, ownerWords: round.ownerWords, before: round.before, after: round.after, backup: round.backup, changes: round.changes }] } };
  if (prev.listingId !== round.base.listingId) return { ok: false, reason: 'listing-fixes.json is for ' + prev.listingId };
  if (!same(prev.after, round.before)) return { ok: false, reason: 'the listing changed after the last fix recorded in listing-fixes.json: not chained (check what changed first)' };
  const rounds = Array.isArray(prev.rounds) ? prev.rounds : [{ date: prev.date, ownerWords: prev.ownerWords, before: prev.before, after: prev.after, backup: prev.backup, changes: prev.changes }];
  const all = [...rounds, { date: round.date, ownerWords: round.ownerWords, before: round.before, after: round.after, backup: round.backup, changes: round.changes }];
  return { ok: true, record: { ...round.base, date: round.date, ownerWords: all.map((r) => r.ownerWords), before: rounds[0].before, after: round.after, backup: rounds[0].backup,
    changes: all.flatMap((r) => r.changes), rounds: all } };
}
