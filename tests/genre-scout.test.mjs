// genre-scout.test.mjs — the genre-trend scouting line (DECISIONS.md "Genre-trend scouting") on the mock provider with
// the FIXTURE scouting data (fixtures/engine/scout-script.mjs; invented game titles only): the scouting blocklist fills
// itself from the notes, a brief / design / listing / image prompt naming a scouted game fails, the notes never reach
// a later agent, and the engine enforces TREND-SCOUT's 12 web calls. Owner decisions of 17/10/2026 ("Scouting decisions"):
// whole-phrase derivative wording (no bare "fan"), one-letter misspellings of scouted names, common-word titles that
// warn on the bare word, 90-day retention of the notes, and the scout's own drafts folder (scout-drafts/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { runAgent } from '../src/engine/runtime.mjs';
import { createToolbox } from '../src/engine/tools/index.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { screenListing, screenDigitalSet, screenText } from '../src/engine/lib/originality.mjs';
import { validateNotes, readBlocklist, scoutingBriefProblems, commonWordWarnings, commonWords, SCOUTED, WORDING, DERIVATIVE_WORDING } from '../src/engine/lib/scouting.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { createScoutScript, genreBrief, researchBrief, researchQuery, FIXTURE_GAMES, COMMON_WORD_GAMES, BAD_BRIEF_GAME } from '../fixtures/engine/scout-script.mjs';

const ALL_NAMES = FIXTURE_GAMES.flatMap((g) => [g.game, g.studio, ...g.alsoBlock]);
const lower = (s) => String(s).toLowerCase();
const mentions = (s) => ALL_NAMES.filter((n) => lower(s).includes(lower(n)));
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

function boot(t, { script = createScoutScript(), J = null, log = null, root = null } = {}) {
  const r = root || tempRoot('scout');
  const e = createEngine({ archiveSandbox: true, J: J || r.J, log: log || r.log, script, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} if (!root) r.cleanup(); });
  return { e, r };
}
async function scout(e, opts = {}) {
  const c = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test', ...opts });
  await e.orchestrator.startJob(c.id);
  return e.store.getJob(c.id);
}
const research = (e, ...p) => path.join(e.J.dataRoot, 'research', ...p);

test('the scout line runs on the mock: 4 genre briefs verified, the brief naming a game blocked before EVIDENCE-CHECKER', async (t) => {
  const { e } = boot(t);
  const j = await scout(e), day = dublinDay();
  assert.equal(j.state, 'research-done', j.reason);
  const briefs = fs.readdirSync(research(e, 'briefs')).sort();
  assert.deepEqual(briefs, ['candlelit-dark-fantasy', 'cozy-farming', 'neon-cyberpunk', 'survival-camp'].map((s) => day + '--genre-' + s + '-desk-props.md'));
  for (const f of briefs) { const b = fs.readFileSync(research(e, 'briefs', f), 'utf8'); assert.match(b, /^status: verified$/m); assert.match(b, /^origin: genre-scout$/m); assert.deepEqual(mentions(b), [], f + ' names no scouted game, studio or related name'); }
  const bad = day + '--genre-cozy-farming-named-desk-props.md';
  assert.ok(fs.existsSync(research(e, 'scout-drafts', day)), 'the scout writes to its own drafts folder');
  assert.ok(!fs.existsSync(research(e, 'scout-drafts', day, bad)), 'moved out of scout-drafts/');
  assert.ok(!fs.existsSync(research(e, 'drafts', day)) || !fs.readdirSync(research(e, 'drafts', day)).length, 'nothing in the research line\'s drafts/');
  assert.ok(!fs.existsSync(research(e, 'briefs', bad)));
  assert.ok(!fs.existsSync(research(e, 'rejected', bad)), 'not in rejected/: it names a game, so it stays in scouting/');
  // outside scouting/, nothing in the research folder names a scouted game
  for (const f of walk(research(e)).filter((x) => !path.relative(research(e), x).startsWith('scouting'))) assert.deepEqual(mentions(fs.readFileSync(f, 'utf8')), [], path.relative(research(e), f));
  const rej = fs.readFileSync(research(e, 'scouting', 'blocked', day, bad), 'utf8');
  assert.match(rej, /## Station scouting screen/);
  assert.match(rej, /"parsnip hollow" matches scouted-games "Parsnip Hollow"/i);
  assert.match(rej, /^status: candidate$/m, 'blocked before EVIDENCE-CHECKER could verify it');
  assert.match(e.store.getJob(j.id).data.scouting.drafts.join(' | '), /named-desk-props\.md: BLOCKED/);
  // the job record (shown on the office page) never carries a scouted name, even from a file name
  assert.deepEqual(mentions(JSON.stringify(e.store.getJob(j.id)) + JSON.stringify(e.store.listJobs())), []);
});

test('a blocked draft whose FILE NAME names a game is masked in the job record the office page shows', async (t) => {
  const { e } = boot(t, { script: createScoutScript({ badSlug: 'parsnip-hollow' }) });
  const j = await scout(e), day = dublinDay();
  assert.equal(j.state, 'research-done', j.reason);
  assert.ok(fs.existsSync(research(e, 'scouting', 'blocked', day, day + '--genre-parsnip-hollow-desk-props.md')));
  assert.match(j.data.scouting.drafts.join(' | '), /\(a draft whose file name names a scouted game\): BLOCKED/);
  assert.deepEqual(mentions(JSON.stringify(e.store.listJobs()) + JSON.stringify(e.store.stagesOf(j.id))), []);
});

test('every name the scout records is added to the scouting blocklist automatically, once', async (t) => {
  const { e } = boot(t);
  await scout(e);
  const bl = readBlocklist(research(e));
  assert.deepEqual(bl.terms.map((x) => x.term).sort(), ALL_NAMES.slice().sort());
  assert.deepEqual(bl.terms.filter((x) => x.kind === 'game').map((x) => x.term).sort(), FIXTURE_GAMES.map((g) => g.game).sort());
  const before = fs.readFileSync(research(e, 'scouting', 'blocklist.json'), 'utf8');
  const j2 = await scout(e);
  assert.equal(j2.state, 'research-done', j2.reason);
  assert.equal(j2.data.scouting.added, 0, 'a re-run adds nothing');
  assert.equal(fs.readFileSync(research(e, 'scouting', 'blocklist.json'), 'utf8'), before);
  // the engine's originality lists now carry them (every screen reads cfg.station)
  assert.deepEqual(e.cfg.station.sloganScreen.lists[SCOUTED].slice().sort(), ALL_NAMES.slice().sort());
  assert.ok(!e.cfg.station.sloganScreen.lists[WORDING].includes('fan'), 'no bare "fan" (owner 17/10/2026)');
  assert.ok(e.cfg.station.sloganScreen.lists[WORDING].includes('fan art'));
});

test('scouting notes are refused unless they hold 2 AAA + 2 indie entries with https evidence and dates', () => {
  const day = '2026-10-17', ok = { day, entries: FIXTURE_GAMES.map((g) => ({ ...g, evidence: [{ url: 'https://x.example/a', signal: 's' }], date: day })) };
  assert.equal(validateNotes(ok, { day }).ok, true);
  assert.match(validateNotes({ ...ok, entries: ok.entries.slice(1) }, { day }).problems.join(';'), /2 aaa entries \(has 1\)/);
  assert.match(validateNotes({ ...ok, entries: ok.entries.map((x, i) => (i ? x : { ...x, evidence: [{ url: 'http://x' }] })) }, { day }).problems.join(';'), /https/);
  assert.match(validateNotes({ day }, { day }).problems.join(';'), /entries/);
});

test('a brief naming a scouted game, studio or related name fails the brief check and intake; a clean genre brief passes', async (t) => {
  const { e } = boot(t);
  await scout(e);
  const day = dublinDay();
  // E6 b2 (owner D1): a verified genre brief from the run, with the station's citation record from brief-check
  const clean = fs.readFileSync(research(e, 'briefs', day + '--genre-cozy-farming-desk-props.md'), 'utf8');
  assert.match(clean, /^- citations: \d+, all returned by web calls in job \S+ \(transcript\)$/m);
  const variants = {
    'game in the buyer persona': clean.replace('who buys transparent PNG props', 'who streams ' + 'Chromehold 2091' + ' and buys transparent PNG props'),
    'studio in the keywords': clean.replace('- pngtuber props —', '- gravemoor interactive props —'),
    'character in the design direction': clean.replace('a potted sprout', 'a statue of the Ashen Warden'),
    'game in the id (and file name)': clean.replace(/^id: (\S+)$/m, 'id: ' + day + '--cinderpine-desk-props'),
    '"fan art" wording in a genre brief': clean.replace('FIXTURE: a streamer', 'FIXTURE: a buyer of fan art and a streamer'),
    'a one-letter misspelling of a scouted game': clean.replace('a potted sprout', 'a Parsnip Holow seed tin')
  };
  for (const [what, b] of Object.entries(variants)) {
    const c = e.orchestrator.createJob({ briefText: b, by: 'test' });
    assert.equal(c.ok, false, what + ' must fail');
    assert.match(c.reasons.join('; '), /originality: brief/, what);
  }
  // without the station's citation record, an indicative genre brief is refused at intake (fails closed)
  const noRecord = e.orchestrator.createJob({ briefText: clean.replace(/\n## Station brief check[\s\S]*$/, '\n'), by: 'test' });
  assert.equal(noRecord.ok, false); assert.match(noRecord.reasons.join('; '), /citations: no transcript to check them against/);
  const ok = e.orchestrator.createJob({ briefText: clean, by: 'test' });
  assert.equal(ok.ok, true, (ok.reasons || []).join('; '));
});

test('a listing, a design and an image prompt naming a scouted game fail the originality gate', async (t) => {
  const { e, r } = boot(t);
  await scout(e);
  const cfg = e.cfg.station, id = dublinDay() + '--genre-cozy-farming-desk-props';
  const listing = { title: 'Cozy farming desk props for streamers, 12 PNG', tags: ['cozy desk props', 'pngtuber props'], description: 'Twelve original props.', altText: 'A watering can and a jar of jam.' };
  assert.equal(screenListing({ listing, id, cfg }).result, 'clear');
  for (const [field, v] of [['title', 'Parsnip Hollow desk props'], ['tags', ['cozy desk props', 'parsnip hollow']], ['description', 'Perfect for Lanternfall Requiem streams.'], ['altText', 'Old Mabel\'s watering can']]) {
    const s = screenListing({ listing: { ...listing, [field]: v }, id, cfg });
    assert.equal(s.result, 'hit', field); assert.equal(s.hits[0].category, SCOUTED, field);
  }
  for (const w of ['Fan art props for farming streams.', 'A tribute to farm life.', 'Inspired by your favourite farm game.', 'A dupe of the classic set.', 'A knockoff of the classic set.', 'An alternative to the big farm game.']) assert.equal(screenListing({ listing: { ...listing, description: w }, id, cfg }).result, 'hit', w);
  assert.equal(screenDigitalSet({ designMd: '# set-v1\n\n## 01-mug.png\nImage prompt (exact): a mug with the Vigil Keep crest\n', fileNames: ['01-mug.png'], cfg }).result, 'hit', 'design.md');
  assert.equal(screenDigitalSet({ designMd: '# set-v1\n', fileNames: ['01-chromehold-2091-can.png'], cfg }).result, 'hit', 'a file name');
  // the image tool refuses the prompt before any call (the same screen image_generate runs)
  const job = { id }, folder = path.join(e.J.dataRoot, 'jobs', id); fs.mkdirSync(folder, { recursive: true });
  const box = createToolbox({ J: e.J, folder, agent: e.cfg.agents.designer, job, cfg: { ...e.cfg }, guard: e.guard, providers: e.providers, run: { runId: 'run_t' }, halt: e.halt, log: r.log, bus: e.bus, line: 'room1-digital' });
  await assert.rejects(box.call('image_generate', { path: 'set-v1/files/01-can.png', prompt: 'a soda can from Chromehold 2091', transparent: true }), /ORIGINALITY HARD FAIL/);
  assert.equal(e.providers.image.calls, 0, 'no image call was made');
  assert.equal(screenText('a dented watering can, soft sage palette', cfg).result, 'clear');
});

test('the scouting notes never reach EVIDENCE-CHECKER, DESIGNER, LISTER or the QA agents; only brief.md goes to a job', async (t) => {
  const seen = [];
  const base = createScoutScript();
  const script = (ctx, params) => { if (ctx.agentKey !== 'trend-scout') seen.push({ agent: ctx.agentKey, text: JSON.stringify(params.system) + JSON.stringify(params.messages) }); return base(ctx, params); };
  script.web = base.web;
  const { e, r } = boot(t, { script });
  await scout(e);
  const day = dublinDay();
  // EVIDENCE-CHECKER tried: its listing hides scouting/ and its read was refused
  const ec = seen.filter((s) => s.agent === 'evidence-checker').map((s) => s.text).join('\n');
  assert.match(ec, /the scouting notes are internal to TREND-SCOUT/);
  assert.deepEqual(mentions(ec), [], 'EVIDENCE-CHECKER saw no scouted name');
  // the tool fence, for every agent but TREND-SCOUT
  const rdir = research(e);
  for (const key of ['evidence-checker', 'demand-researcher', 'designer', 'lister', 'qa-design', 'qa-listing']) {
    const box = createToolbox({ J: e.J, folder: rdir, agent: e.cfg.agents[key], job: { id: day + '--genre-scout-1' }, cfg: { ...e.cfg }, guard: e.guard, providers: e.providers, run: { runId: 'run_f' }, halt: e.halt, log: r.log, bus: e.bus, line: 'genre-scout' });
    const tools = e.cfg.agents[key].tools;
    if (tools.includes('fs_read')) await assert.rejects(box.call('fs_read', { path: 'scouting/' + day + '/notes.json' }), /internal to TREND-SCOUT/, key);
    if (tools.includes('fs_read')) await assert.rejects(box.call('fs_read', { path: 'Scouting/blocklist.json' }), /internal to TREND-SCOUT/, key + ' (case)');
    if (tools.includes('fs_list')) { await assert.rejects(box.call('fs_list', { path: 'scouting' }), /internal/, key); assert.doesNotMatch(await box.call('fs_list', { path: '.' }), /scouting/, key); }
  }
  // a job from a verified genre brief: its folder holds the brief only, and no later agent's prompt carries a scouted name
  const brief = day + '--genre-cozy-farming-desk-props.md';
  const { jobId } = e.orchestrator.startBrief(brief, { by: 'test' });
  for (let i = 0; i < 200 && e.orchestrator.isActive(jobId); i++) await new Promise((res) => setTimeout(res, 25));
  const jdir = path.join(e.J.dataRoot, 'jobs', jobId);
  for (const f of walk(jdir)) if (/\.(md|json|txt)$/.test(f)) assert.deepEqual(mentions(fs.readFileSync(f, 'utf8')), [], path.relative(jdir, f));
  const job = e.store.getJob(jobId);
  for (const key of ['lister', 'qa-design', 'qa-listing']) await runAgent(e, { agentKey: key, job, step: key, pass: 1, folder: jdir, folderLabel: 'the job folder of ' + jobId, input: 'Review.\n```\nLISTING_ID: ' + jobId + '\n```', line: 'room1-digital' });
  const later = seen.filter((s) => ['designer', 'lister', 'qa-design', 'qa-listing'].includes(s.agent));
  assert.deepEqual([...new Set(later.map((s) => s.agent))].sort(), ['designer', 'lister', 'qa-design', 'qa-listing']);
  for (const s of later) { assert.deepEqual(mentions(s.text), [], s.agent); assert.doesNotMatch(s.text, /scouting\/|notes\.json|blocklist\.json/, s.agent); }
});

test('TREND-SCOUT gets 12 web calls a run, enforced by the engine (the 13th is refused, not priced)', async (t) => {
  const results = [];
  const base = createScoutScript();
  const script = (ctx, params) => { if (ctx.agentKey === 'trend-scout') { const last = params.messages[params.messages.length - 1]; if (Array.isArray(last.content)) results.push(...last.content.filter((b) => b.type === 'tool_result')); } return base(ctx, params); };
  script.web = base.web;
  const { e } = boot(t, { script });
  assert.equal(e.cfg.agents['trend-scout'].limits.maxWebCalls, 12);
  assert.deepEqual(e.cfg.agents['trend-scout'].tools.filter((x) => x.startsWith('web_')).sort(), ['web_fetch', 'web_search']);
  const j = await scout(e);
  assert.equal(j.state, 'research-done', j.reason);
  const web = e.ledger.rows().filter((x) => x.agentKey === 'trend-scout' && x.kind === 'web');
  assert.equal(web.length, 12, '12 web calls reached the ledger');
  const refused = results.find((x) => x.tool_use_id === 'tu_x');
  assert.ok(refused && refused.is_error, 'the 13th call came back as an error');
  assert.match(refused.content, /web call limit for this run reached \(12, enforced by the engine\)/);
});

test('"Weekly genre scout" is seeded disabled, once; a deleted seed stays deleted; it runs the genre-scout line', async (t) => {
  const r = tempRoot('scout-routine');
  t.after(() => r.cleanup());
  let { e } = { e: createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createScoutScript(), startScheduler: false }) };
  const id = 'rt_seed_weekly-genre-scout';
  let rt = e.store.getRoutine(id);
  assert.ok(rt, 'seeded');
  assert.equal(rt.name, 'Weekly genre scout'); assert.equal(rt.enabled, false); assert.equal(rt.target, 'line:genre-scout');
  assert.ok(e.routineTargets.some((x) => x.id === 'line:genre-scout'));
  const fired = await e.scheduler.fire(rt);
  assert.match(fired.skipped, /disabled/);
  const out = await e.runRoutine(rt);
  assert.equal(out.state, 'research-done', out.reason);
  assert.equal(out.line, 'genre-scout');
  e.close();
  e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  assert.equal(e.store.listRoutines().filter((x) => x.id === id).length, 1, 'not seeded twice');
  e.routines.remove(id, { expectedVersion: e.store.getRoutine(id).version });
  e.close();
  e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  assert.equal(e.store.getRoutine(id), null, 'a deleted seed is not brought back');
  e.close();
});

test('TREND-SCOUT has a desk in the Research room, wired like the others', async (t) => {
  const { e } = boot(t);
  const snap = buildEngineSnapshot(e);
  const dept = snap.departments.find((d) => d.key === 'research');
  assert.deepEqual(dept.agents.slice().sort(), ['demand-researcher', 'evidence-checker', 'trend-scout']);
  const a = snap.agents.find((x) => x.id === 'trend-scout' || x.key === 'trend-scout');
  assert.ok(a, 'in the snapshot');
  assert.equal(a.desk.roomId, 'research');
  assert.ok(!JSON.stringify(snap.warnings || []).includes('TREND-SCOUT has no desk'));
});

// ---- owner decisions, 17/10/2026 ("Scouting decisions")

test('derivative wording is whole phrases: "desk fan" passes, "fan art" fails; every listed phrase fails', async (t) => {
  const { e } = boot(t);
  await scout(e);
  const cfg = e.cfg.station, day = dublinDay();
  assert.deepEqual(DERIVATIVE_WORDING, ['fan art', 'fanart', 'fan-made', 'fan made', 'fandom', 'fanfic', 'inspired by', 'homage', 'tribute', 'dupe', 'knockoff', 'alternative to']);
  assert.equal(screenText('A desk fan, a mug and a lamp.', cfg).result, 'clear', 'desk fan');
  assert.equal(screenText('Twelve props for fans of cozy games, with a little desk fan.', cfg).result, 'clear', 'bare "fan" / "fans"');
  assert.equal(screenText('Fan art desk props.', cfg).result, 'hit', 'fan art');
  for (const w of DERIVATIVE_WORDING) assert.equal(screenText('Desk props, ' + w + ' set.', cfg).result, 'hit', w);
  // the whole-brief screen of a genre-scout brief
  const g = { slug: 'lofi-study', genre: 'lofi study', segment: 'streamers who play relaxing puzzle games', props: 'a desk lamp, a stack of notebooks, a mug of tea, a cassette player, a potted fern and a desk fan', palette: 'dusty rose, cream and teal', price: 9 };
  const b = genreBrief(day, g);
  assert.deepEqual(scoutingBriefProblems(b, cfg), [], 'a genre brief with a desk fan passes');
  assert.match(scoutingBriefProblems(b.replace('and a desk fan', 'and some fan art'), cfg).join('; '), /derivative-wording "fan art"|derivative "fan art"/);
});

test('scouted names match exactly and with one-letter misspellings (the station\'s near-miss rule)', async (t) => {
  const { e } = boot(t);
  await scout(e);
  const cfg = e.cfg.station;
  for (const w of ['Parsnip Holow props', 'a Cinderpyne mug', 'Chromhold 2091 can', 'Gravemor Interactive', 'Kesselwrigth Games']) {
    const r = screenText(w, cfg);
    assert.equal(r.result, 'hit', w); assert.equal(r.hits[0].category, SCOUTED, w); assert.equal(r.hits[0].via, 'near-miss-spelling', w);
  }
  assert.equal(screenText('Parsnip Hollow', cfg).hits[0].via, 'exact');
  assert.equal(screenText('a Parsnep Holow tin', cfg).result, 'clear', 'two letters off is not a near miss');
  assert.equal(screenText('a cinder block and a pine cone', cfg).result, 'clear', 'ordinary words');
});

test('a common-word title warns on the bare word (QA-LISTING checks the context); the full title and "<word> game" still fail', async (t) => {
  const qaInputs = [];
  const base = createScoutScript({ games: COMMON_WORD_GAMES });
  const script = (ctx, params) => { if (ctx.agentKey === 'qa-listing') qaInputs.push(String(params.messages[0].content)); return base(ctx, params); };
  script.web = base.web;
  const { e } = boot(t, { script });
  const j = await scout(e), day = dublinDay();
  assert.equal(j.state, 'research-done', j.reason);
  // the notes' tag reaches the blocklist; the bare word is not a hard-fail name
  const bl = readBlocklist(research(e));
  assert.deepEqual(bl.terms.filter((x) => x.commonWord).map((x) => [x.term, x.commonWord]), [['Lantern: Moss and Mile', 'Lantern']]);
  const hard = e.cfg.station.sloganScreen.lists[SCOUTED];
  assert.ok(hard.includes('Lantern: Moss and Mile') && hard.includes('Lantern game') && !hard.includes('Lantern'), hard.join(', '));
  assert.deepEqual(commonWords(research(e)), ['Lantern']);
  // the survival-camp brief has "a hand-crank lantern": verified, with the warning in the step notes
  const survival = day + '--genre-survival-camp-desk-props.md';
  assert.ok(fs.existsSync(research(e, 'briefs', survival)), 'not blocked by the bare word');
  assert.match(j.data.scouting.drafts.join(' | '), /survival-camp-desk-props\.md: screened clear \(common-word warning, not a fail: brief: "lantern"\)/);
  assert.match(j.reason, /survival-camp-desk-props\.md: verified -> briefs\/ \(evidence indicative\) \(common-word warning, not a fail: brief: "lantern"\)/);
  // listing screens: bare word clear (and reported), full title and "<word> game" hard-fail
  const cfg = e.cfg.station, id = day + '--genre-survival-camp-desk-props';
  const listing = { title: 'Survival camp desk props for streamers, 12 PNG', tags: ['camp desk props', 'pngtuber props'], description: 'Twelve original props, with a hand-crank lantern and a camp mug.', altText: 'An enamel mug and a lantern.' };
  assert.equal(screenListing({ listing, id, cfg }).result, 'clear');
  assert.deepEqual(commonWordWarnings({ description: listing.description, altText: listing.altText }, commonWords(research(e))), ['description: "lantern"', 'altText: "lantern"']);
  for (const w of ['Lantern game desk props', 'Props for lantern games', 'Lantern: Moss and Mile props', 'Lantern Moss and Mile props', 'Lanturn: Moss and Mile props']) {
    const s = screenListing({ listing: { ...listing, title: w }, id, cfg });
    assert.equal(s.result, 'hit', w); assert.equal(s.hits[0].category, SCOUTED, w);
  }
  assert.deepEqual(scoutingBriefProblems('A lantern on the desk.', cfg), [], 'the brief screen does not fail the bare word');
  assert.ok(scoutingBriefProblems('Props for the lantern game.', cfg).length, 'the brief screen fails "<word> game"');
  // QA-LISTING is told to check the context (and is not told the game's full title)
  const c = e.orchestrator.createJob({ briefText: fs.readFileSync(research(e, 'briefs', survival), 'utf8'), by: 'test' });
  assert.equal(c.ok, true, (c.reasons || []).join('; '));
  const jdir = path.join(e.J.dataRoot, 'jobs', c.id);
  e.J.put(path.join(jdir, 'outbox', 'listing.json'), JSON.stringify({ listingId: c.id, ...listing }, null, 2) + '\n');
  e.store.updateJob(c.id, { step: 'qa-listing' });
  await e.orchestrator.startJob(c.id);
  assert.equal(qaInputs.length, 1, 'QA-LISTING ran once');
  assert.match(qaInputs[0], /\[STATION — common-word check, not a fail\] The listing uses description: "lantern"; altText: "lantern"/);
  assert.match(qaInputs[0], /Check the context/);
  assert.doesNotMatch(qaInputs[0], /Moss and Mile/);
  // notes: tags must be known
  const nd = { day, entries: COMMON_WORD_GAMES.map((g) => ({ ...g, evidence: [{ url: 'https://x.example/a', signal: 's' }], date: day })) };
  assert.equal(validateNotes(nd, { day }).ok, true);
  assert.match(validateNotes({ ...nd, entries: nd.entries.map((x, i) => (i ? x : { ...x, tags: ['popular'] })) }, { day }).problems.join(';'), /unknown tag "popular"/);
  assert.match(validateNotes({ ...nd, entries: nd.entries.map((x, i) => (i ? x : { ...x, tags: 'common-word' })) }, { day }).problems.join(';'), /tags must be a list/);
});

test('retention: the first step of a scout run deletes notes more than 90 days old, logs it, and keeps the blocklist', async (t) => {
  const { e, r } = boot(t);
  const day = dublinDay(), ago = (n) => new Date(Date.parse(day + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  const old = ago(91), edge = ago(90), rdir = research(e);
  e.J.put(path.join(rdir, 'scouting', old, 'notes.json'), '{"day":"' + old + '","entries":[]}\n');
  e.J.put(path.join(rdir, 'scouting', old, old + '--genre-scout-1', 'notes.json'), '{"day":"' + old + '","entries":[]}\n');   // E6 b3: one notes file per job
  e.J.put(path.join(rdir, 'scouting', 'blocked', old, old + '--genre-x-desk-props.md'), 'FIXTURE blocked draft\n');
  e.J.put(path.join(rdir, 'scouting', edge, 'notes.json'), '{"day":"' + edge + '","entries":[]}\n');
  e.J.put(path.join(rdir, 'scouting', 'blocklist.json'), JSON.stringify({ terms: [{ term: 'Oldhallow Quarry', kind: 'game', day: old, jobId: 'x' }] }) + '\n');
  e.J.put(path.join(rdir, 'scouting', 'README.txt'), 'not a day folder\n');
  const j = await scout(e);
  assert.equal(j.state, 'research-done', j.reason);
  assert.ok(!fs.existsSync(path.join(rdir, 'scouting', old)), 'notes 91 days old deleted');
  assert.ok(!fs.existsSync(path.join(rdir, 'scouting', 'blocked', old)), 'blocked drafts 91 days old deleted');
  assert.ok(fs.existsSync(path.join(rdir, 'scouting', edge, 'notes.json')), 'day 90 kept');
  assert.ok(fs.existsSync(path.join(rdir, 'scouting', day, j.id, 'notes.json')), 'today kept (this job\'s own notes file)');
  assert.ok(fs.existsSync(path.join(rdir, 'scouting', 'README.txt')));
  assert.ok(readBlocklist(rdir).terms.some((x) => x.term === 'Oldhallow Quarry'), 'blocklist entries stay');
  assert.equal(screenText('Oldhallow Quarry props', e.cfg.station).result, 'hit', 'and still block');
  const stage = e.store.stagesOf(j.id).find((s) => s.step === 'scout-retention');
  assert.ok(stage, 'retention is a step of the run');
  assert.match(stage.reason, new RegExp('deleted scouting/' + old + ', scouting/blocked/' + old));
  const logs = fs.readdirSync(r.logs).map((f) => fs.readFileSync(path.join(r.logs, f), 'utf8')).join('\n');
  assert.match(logs, new RegExp('scouting notes deleted \\(retention 90 days\\).*research/scouting/' + old));
  assert.match(logs, new RegExp('scouting notes deleted \\(retention 90 days\\).*research/scouting/blocked/' + old));
  // idempotent: a second run the same day deletes nothing
  const j2 = await scout(e);
  assert.match(e.store.stagesOf(j2.id).find((s) => s.step === 'scout-retention').reason, /nothing to delete/);
});

test('the scout has its own drafts folder: the research line and the scout line run on the same day without touching each other\'s drafts', async (t) => {
  const day = dublinDay(), lofi = { slug: 'lofi-study', genre: 'lofi study', segment: 'students who stream study sessions', props: 'a desk lamp, a stack of notebooks, a mug of tea, a cassette player, a potted fern and a sleeping cat bed', palette: 'dusty rose, cream and teal', price: 9 };
  const researchDraft = researchBrief(day, lofi);   // E7a (owner, 19/10/2026): the research line writes the indicative format too
  const checkerDirs = [];
  const base = createScoutScript();
  const script = (ctx, params) => {
    if (ctx.agentKey === 'evidence-checker') checkerDirs.push((/Drafts for this batch: (\S+)/.exec(String(params.messages[0].content)) || [])[1]);
    if (ctx.agentKey === 'demand-researcher') {
      const n = params.messages.filter((m) => m.role === 'assistant').length;
      return n === 0 ? { content: [{ type: 'tool_use', id: 'tu_s', name: 'web_search', input: { query: researchQuery(lofi) } }] }
        : n === 1 ? { content: [{ type: 'tool_use', id: 'tu_d', name: 'fs_write', input: { path: 'drafts/' + day + '/' + day + '--genre-lofi-study-desk-props.md', content: researchDraft } }] } : { content: [{ type: 'text', text: 'one draft' }] };
    }
    return base(ctx, params);
  };
  script.web = base.web;
  const { e } = boot(t, { script });
  const rj = await e.orchestrator.createResearchJob({ by: 'test' }); await e.orchestrator.startJob(rj.id);
  const sj = await scout(e);
  const rjob = e.store.getJob(rj.id);
  assert.equal(rjob.state, 'research-done', rjob.reason); assert.equal(sj.state, 'research-done', sj.reason);
  assert.deepEqual([...new Set(checkerDirs)], ['drafts/' + day + '/.', 'scout-drafts/' + day + '/.'], 'each EVIDENCE-CHECKER run was given its own line\'s folder');
  assert.deepEqual(fs.readdirSync(research(e, 'drafts', day)), [day + '--genre-lofi-study-desk-props.md']);
  assert.ok(fs.readdirSync(research(e, 'scout-drafts', day)).every((f) => !/lofi/.test(f)), 'no research draft in scout-drafts/');
  assert.match(rjob.reason, /lofi-study-desk-props\.md: verified -> briefs\//);
  assert.doesNotMatch(rjob.reason, /candlelit|cyberpunk|cozy-farming|survival/, 'the research line handled only its own drafts');
  assert.doesNotMatch(sj.reason, /lofi/, 'the scout line handled only its own drafts');
  assert.equal((sj.reason.match(/verified -> briefs\//g) || []).length, 4);
});
