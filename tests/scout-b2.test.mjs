// scout-b2.test.mjs — E6 step b2 on the MOCK provider (DECISIONS.md "E6 step b2: owner decisions", 17/10/2026):
//   D1 agents never construct URLs (a fetch names a URL a search in the job returned) and never fetch etsy.com (refused
//      by the engine before anything is reserved, while etsy.com search results still come back); a genre brief's
//      citations are checked against the job transcript; "indicative" evidence needs 3+ cited results for the keywords
//      and for the price range
//   D2 report_blocked(reason): the job ends incomplete with the reason, non-zero exit, nothing downstream, no nudge; an
//      agent that ends with neither its outputs nor report_blocked is nudged with exactly those two on offer
//   D3 the one genre brief schema, checked on write (an invalid draft gets the problems back, a valid rewrite passes)
//   D4 placeholders never go on the scouting blocklist; the b1 placeholder cleanup makes the customer-facing check clean
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createToolbox, ToolError } from '../src/engine/tools/index.mjs';
import { webSettings, buildRequest } from '../src/engine/providers/anthropic-web.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { addToBlocklist, readBlocklist, blocklistPlaceholders, customerFacingCheck, scoutRunExitCode, notNameReason } from '../src/engine/lib/scouting.mjs';
import { validateScoutBrief, checkScoutBrief, citationProblems } from '../src/engine/lib/scout-brief.mjs';
import { urlsIn, fetchRefusedDomains, blockedDomains } from '../src/engine/lib/web-sources.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { createScoutScript, genreBrief, GENRES, FIXTURE_GAMES } from '../fixtures/engine/scout-script.mjs';

const ENGINE = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'engine.json'), 'utf8'));
const DRAFTS_TURN = 5;   // the fixture scout's drafts turn (products, searches, fetches, one more search, notes, drafts)
const NUDGE = /^\[STATION: required outputs missing/;
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const nudged = (params) => { const l = params.messages[params.messages.length - 1]; return l.role === 'user' && typeof l.content === 'string' && NUDGE.test(l.content); };
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });

function boot(t, script = createScoutScript({ bad: false })) {
  const r = tempRoot('b2');
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} r.cleanup(); });
  return { e, r };
}
async function scout(e) {
  const c = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test' });
  await e.orchestrator.startJob(c.id);
  return e.store.getJob(c.id);
}
const research = (e, ...p) => path.join(e.J.dataRoot, 'research', ...p);
const transcriptOf = (e, job) => fs.readFileSync(path.join(e.J.dataRoot, 'jobs', job.id, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// a researcher's toolbox on the mock for job `jobId` (counts reservations, so "refused before reserve" is checked)
function box(e, r, { agentKey = 'trend-scout', jobId = dublinDay() + '--genre-scout-9' } = {}) {
  let reserves = 0; const reserve = e.guard.reserve; e.guard.reserve = (c) => { reserves++; return reserve(c); };
  const b = createToolbox({ J: e.J, folder: research(e), agent: e.cfg.agents[agentKey], job: { id: jobId }, cfg: { ...e.cfg }, guard: e.guard, providers: e.providers, run: { runId: 'run_b2' }, halt: e.halt, log: r.log, bus: e.bus, line: 'genre-scout' });
  fs.mkdirSync(research(e), { recursive: true });
  return { b, reserves: () => reserves };
}

// ---- D1: URLs

test('D1: a constructed URL is refused before anything is reserved; a URL a search returned can be fetched, by any agent of the job', async (t) => {
  const { e, r } = boot(t);
  const { b, reserves } = box(e, r);
  for (const url of ['https://trends.example.com/genres/cozy-farming', 'https://news.example.com/made-up-roundup', 'https://www.etsy.com/search?q=cozy+farming+desk+props'.replace('etsy', 'example')]) {
    await assert.rejects(b.call('web_fetch', { url }), (x) => x instanceof ToolError && /was not returned by any web search in this job\. Never type, build or guess a URL/.test(x.message), url);
  }
  assert.equal(reserves(), 0, 'nothing reserved'); assert.equal(b.counters.web, 0, 'not counted'); assert.equal(e.ledger.rows().length, 0);
  // a search returns the trend pages; a fetch of one of them goes through (reserved, counted, priced at $0 on the mock)
  const out = await b.call('web_search', { query: 'trending indie games streaming' });
  assert.ok(out.includes('https://trends.example.com/genres/cozy-farming'));
  await b.call('web_fetch', { url: 'https://trends.example.com/genres/cozy-farming/' });   // the same URL, trailing slash
  assert.equal(reserves(), 2); assert.equal(b.counters.web, 2);
  // EVIDENCE-CHECKER, a new run in the same job: the URL is in the job transcript, so it may fetch it; a made-up one is refused
  const tf = path.join(e.J.dataRoot, 'jobs', dublinDay() + '--genre-scout-9', 'transcript.jsonl');
  e.J.add(tf, JSON.stringify({ agent: 'trend-scout', returnedUrls: urlsIn(out), searchUrls: urlsIn(out) }) + '\n');
  const c = box(e, r, { agentKey: 'evidence-checker' });
  await c.b.call('web_fetch', { url: 'https://trends.example.com/genres/neon-cyberpunk' });
  await assert.rejects(c.b.call('web_fetch', { url: 'https://trends.example.com/genres/made-up' }), /was not returned by any web search/);
});

// E7a (owner decision 1, 19/10/2026): etsy.com is a blocked domain on BOTH web tools (no Etsy result comes back) and the
// engine-side fetch refusal stays; the FIXTURE search results come from a non-Etsy marketplace
test('E7a: an etsy.com fetch is refused before anything is reserved; etsy.com is sent as blocked_domains on both tools and kept in the engine refusal', async (t) => {
  const { e, r } = boot(t);
  const { b, reserves } = box(e, r);
  const out = await b.call('web_search', { query: 'cozy farming desk props png' });
  assert.equal(urlsIn(out).filter((u) => /etsy\.com/i.test(u)).length, 0, 'no Etsy result in the scout\'s search results');
  assert.match(out, /FIXTURE listing 1 cozy farming desk props \| https:\/\/market\.example\.com\/listing\/cozy-farming-1 \| USD 8\.95/);
  const before = reserves();
  for (const url of ['https://www.etsy.com/listing/1', 'https://etsy.com/listing/1', 'https://WWW.ETSY.COM/search?q=x', 'https://shop.etsy.com/x']) {
    await assert.rejects(b.call('web_fetch', { url }), (x) => x instanceof ToolError && /etsy\.com pages are never fetched \(no Etsy data until Etsy authorises it in writing\)/.test(x.message), url);
  }
  assert.equal(reserves(), before, 'nothing reserved'); assert.equal(b.counters.web, 1, 'only the search counted');
  // a look-alike host is not the etsy rule (it is refused only as a URL no search returned)
  await assert.rejects(b.call('web_fetch', { url: 'https://notetsy.com/x' }), /was not returned by any web search/);
  // config: the engine-only list keeps etsy.com, and the API's blocked_domains carry it on both tools
  assert.deepEqual(fetchRefusedDomains(ENGINE), ['etsy.com']);
  const list = ['steampowered.com', 'itch.io', 'twitch.tv', 'youtube.com', 'etsy.com'];
  assert.deepEqual(blockedDomains(ENGINE), list);
  const W = webSettings(ENGINE);
  for (const name of ['web_search', 'web_fetch']) { const tl = buildRequest(W, name, name === 'web_search' ? { query: 'q' } : { url: 'https://news.example.com/x' }, 1).tools[0]; assert.deepEqual(tl.blocked_domains, list, name); }
});

// ---- D2: report_blocked and the nudge

function scripted({ atDrafts = null, onNudge = null } = {}) {
  const base = createScoutScript({ bad: false });
  const calls = { 'trend-scout': 0, 'evidence-checker': 0 }, toolChoices = [], inputs = { 'evidence-checker': [] };
  const script = (ctx, params) => {
    calls[ctx.agentKey] = (calls[ctx.agentKey] || 0) + 1;
    if (ctx.agentKey === 'evidence-checker') inputs['evidence-checker'].push(String(params.messages[0].content));
    if (ctx.agentKey !== 'trend-scout') return base(ctx, params);
    if (params.tool_choice) toolChoices.push(params.tool_choice);
    const draftsTurn = (p) => base(ctx, { ...p, messages: p.messages.slice(0, 1 + 2 * DRAFTS_TURN) });
    if (nudged(params) && onNudge) return onNudge(params, draftsTurn);
    if (atDrafts && turnOf(params) >= DRAFTS_TURN) { const r = atDrafts(params, turnOf(params) - DRAFTS_TURN, draftsTurn); if (r) return r; }
    return base(ctx, params);
  };
  script.web = base.web;
  return { script, calls, toolChoices, inputs };
}

test('D2: report_blocked with 0 drafts ends the job incomplete with the reason: non-zero exit, no downstream calls, no nudge', async (t) => {
  const reason = 'the searches returned no desk-props results with prices for any of the four genres';
  const s = scripted({ atDrafts: (p, k) => (k === 0 ? { content: [tool('rb', 'report_blocked', { reason })] } : { content: [{ type: 'text', text: 'should never be called' }] }) });
  const { e } = boot(t, s.script);
  const job = await scout(e);
  assert.equal(job.state, 'incomplete');
  assert.equal(job.reason, 'TREND-SCOUT reported blocked: ' + reason);
  assert.equal(scoutRunExitCode(job), 1);
  assert.deepEqual(job.data.reportedBlocked, { step: 'trend-scout', agent: 'trend-scout', reason });
  assert.equal(s.calls['trend-scout'], DRAFTS_TURN + 1, 'no model call after report_blocked');
  assert.equal(s.calls['evidence-checker'], 0, 'nothing downstream');
  assert.ok(!job.data.scouting, 'scout-notes did not run');
  assert.deepEqual(s.toolChoices, [], 'no nudge'); assert.equal(transcriptOf(e, job).filter((l) => l.nudge).length, 0);
  assert.equal(e.store.runsOf({ agentKey: 'trend-scout', limit: 1 })[0].status, 'incomplete');
  // the tool only appears for an agent with an output contract, and refuses an empty reason
  const r2 = tempRoot('b2-rb'); t.after(() => r2.cleanup());
  const e2 = createEngine({ archiveSandbox: true, J: r2.J, log: r2.log, script: createScoutScript(), startScheduler: false }); t.after(() => e2.close());
  const plain = createToolbox({ J: e2.J, folder: path.join(e2.J.dataRoot, 'research'), agent: e2.cfg.agents['trend-scout'], job: { id: 'x' }, cfg: { ...e2.cfg }, guard: e2.guard, providers: e2.providers, run: { runId: 'r' }, halt: e2.halt, log: r2.log, bus: e2.bus, line: 'genre-scout' });
  assert.ok(!plain.defs.some((d) => d.name === 'report_blocked'));
  let got = null;
  const withC = createToolbox({ J: e2.J, folder: path.join(e2.J.dataRoot, 'research'), agent: e2.cfg.agents['trend-scout'], job: { id: 'x' }, cfg: { ...e2.cfg }, guard: e2.guard, providers: e2.providers, run: { runId: 'r' }, halt: e2.halt, log: r2.log, bus: e2.bus, line: 'genre-scout', contract: {}, onBlocked: (x) => { got = x; } });
  assert.ok(withC.defs.some((d) => d.name === 'report_blocked'));
  await assert.rejects(withC.call('report_blocked', { reason: '  ' }), /at least 10 characters/); assert.equal(got, null);
});

test('D2: ending with neither the outputs nor report_blocked -> a nudge offering exactly fs_write or report_blocked; any other tool in the reply is refused', async (t) => {
  const s = scripted({
    atDrafts: (p, k) => (k === 0 ? { content: [{ type: 'text', text: 'no drafts today' }] } : null),
    onNudge: (p, draftsTurn) => ({ content: [tool('ws', 'web_search', { query: 'one more search' }), ...draftsTurn(p).content] })
  });
  const { e } = boot(t, s.script);
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.deepEqual(s.toolChoices, [{ type: 'any' }], 'Haiku tier: a forced choice');
  const lines = transcriptOf(e, job), n = lines.filter((l) => l.nudge);
  assert.equal(n.length, 1); assert.deepEqual(n[0].offered, ['fs_write', 'report_blocked']);
  assert.match(n[0].message, /Do exactly one of two things now: call fs_write .* or call report_blocked with the reason you cannot/);
  const reply = lines.find((l) => l.afterNudge === 1 && l.agent === 'trend-scout');
  const ws = reply.toolResults.find((x) => x.tool_use_id === 'tu_ws');
  assert.ok(ws.is_error); assert.match(ws.content, /web_search refused: answer the reminder with fs_write or report_blocked only/);
  assert.equal(e.ledger.rows().filter((x) => x.agentKey === 'trend-scout' && x.kind === 'web').length, 12, 'the refused search was not run');
  assert.equal(fs.readdirSync(research(e, 'briefs')).length, 4);
});

test('D2: a tier that refuses forced tool use (forcedToolChoice false) is nudged with auto and the same two-tool offer', async (t) => {
  const s = scripted({ atDrafts: (p, k) => (k === 0 ? { content: [{ type: 'text', text: 'no drafts today' }] } : null), onNudge: (p, draftsTurn) => draftsTurn(p) });
  const { e } = boot(t, s.script);
  e.cfg.engine.tiers[e.cfg.agents['trend-scout'].tier].forcedToolChoice = false;
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.deepEqual(s.toolChoices, [{ type: 'auto' }]);
  assert.deepEqual(transcriptOf(e, job).find((l) => l.nudge).offered, ['fs_write', 'report_blocked']);
});

// ---- D3: the schema on write

test('D3: an invalid draft is refused on write with the problems (one turn); the valid rewrite passes the screen and is verified', async (t) => {
  const day = dublinDay(), cozy = GENRES.find((g) => g.slug === 'cozy-farming');
  const path0 = 'scout-drafts/' + day + '/' + day + '--genre-cozy-farming-desk-props.md';
  // b1's shape: origin on the audience_segment line, a placeholder in the demand evidence
  const b1Shaped = genreBrief(day, cozy).replace('\norigin: genre-scout', ' origin: genre-scout').replace('evidence level: indicative', 'evidence level: UNKNOWN — needs owner check');
  const s = scripted({ atDrafts: (p, k, draftsTurn) => (k === 0 ? { content: [tool('bad', 'fs_write', { path: path0, content: b1Shaped })] } : k === 1 ? draftsTurn(p) : null) });
  const { e } = boot(t, s.script);
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  const bad = transcriptOf(e, job).flatMap((l) => l.toolResults || []).find((x) => x.tool_use_id === 'tu_bad');
  assert.ok(bad.is_error);
  assert.match(bad.content, /^brief schema: scout-drafts\/\d{4}-\d{2}-\d{2}\/\S+ was NOT written\. Fix every point and write it again: /);
  assert.match(bad.content, /front matter: origin missing/); assert.match(bad.content, /origin must be its own line/); assert.match(bad.content, /placeholder "UNKNOWN"/);
  assert.equal(e.store.runsOf({ agentKey: 'trend-scout', limit: 1 })[0].turns, DRAFTS_TURN + 3, 'the refused write cost one turn');
  assert.equal(job.data.scouting.drafts.filter((x) => /screened clear/.test(x)).length, 4);
  assert.equal((job.reason.match(/verified -> briefs\/ \(evidence indicative\)/g) || []).length, 4);
  const v = fs.readFileSync(research(e, 'briefs', day + '--genre-cozy-farming-desk-props.md'), 'utf8');
  assert.match(v, /^origin: genre-scout$/m); assert.match(v, /^- citations: \d+, all returned by web calls in job \S+ \(transcript\)$/m);
});

test('D3: the schema itself: naming, origin line, indicative evidence, 3+ results for keywords and price range, Sources', () => {
  const day = '2026-10-17', g = GENRES[0], ok = genreBrief(day, g);
  assert.deepEqual(validateScoutBrief(ok, { day, file: day + '--genre-' + g.slug + '-desk-props.md', agent: true }).problems, []);
  const bad = (t, re) => { const v = validateScoutBrief(t, { day, agent: true }); assert.equal(v.ok, false); assert.match(v.problems.join('; '), re); };
  bad(ok.replace(/^id: .*$/m, 'id: Genre_Brief'), /id must be YYYY-MM-DD--<slug>/);
  bad(ok.replace('competitor count: not measured', 'competitor count: 1,140'), /competitor count: not measured/);
  bad(ok.replace('evidence level: indicative', 'evidence level: proven'), /evidence level: indicative/);
  const urls = urlsIn(ok).filter((u) => /listing/.test(u));
  bad(ok.replace(/^(USD [\d.]+–[\d.]+) — .*$/m, '$1 — ' + urls.slice(0, 2).join(', ')), /Price range: supported by 2 distinct cited result\(s\), needs at least 3/);
  bad(ok.replace(/(## Keywords\n)([\s\S]*?)(\n\n)/, (m, a, b, c) => a + b.split('\n').map((l, i) => l.replace(/https:\S+$/, urls[i % 2])).join('\n') + c), /Keywords: supported by 2 distinct cited result/);
  bad(ok.replace(/^\| 3 \|.*\n\| 4 \|.*\n\| 5 \|.*\n/m, '').replace(/^\| 2 \|.*$/m, ''), /search-result row\(s\), needs at least 3/);
  bad(ok + '\nrecorded by owner, 2026-10-17\n', /owner's marker/);
  bad(ok + '\n## Station brief check\n- citations: 1, all returned by web calls in job x (transcript)\n', /written by the station only/);
  bad(ok.replace('## Sources\n', '## Sources\n').replace(/^- https:\/\/trends\.example\.com\S+ — FIXTURE genre trend roundup$/m, '- (listed elsewhere)'), /Sources: every cited URL must be listed/);
  // "an unknown land" in prose is not a placeholder; UNKNOWN is
  assert.equal(validateScoutBrief(ok.replace('Twelve original desk props', 'Twelve original desk props from an unknown land:'), { day }).ok, true);
  // a rejected brief needs only its front matter and its Evidence check (the checker can always record a rejection)
  assert.equal(validateScoutBrief('---\nid: ' + day + '--x\ndate: ' + day + '\nstatus: rejected\nproduct_type: p\naudience_segment: a\norigin: genre-scout\n---\n## Evidence check\n- Verdict: REJECTED — no evidence\n', { day, agent: true }).ok, true);
});

// ---- D1 at the checker: citations against the transcript; indicative evidence accepted with 3+ results

test('D1: a citation no web call of the job returned is rejected at brief-check; indicative evidence with 3+ supporting results is verified', async (t) => {
  const day = dublinDay(), made = 'https://market.example.com/listing/made-up-999';   // E7a: non-Etsy (an etsy.com URL is refused on write)
  const s = scripted({ atDrafts: (p, k, draftsTurn) => {
    if (k !== 0) return null;
    const c = draftsTurn(p).content.map((u) => (u.input && /cozy-farming/.test(u.input.path) ? { ...u, input: { ...u.input, content: u.input.content.replace(/^(- pngtuber props — )\S+$/m, '$1' + made).replace('## Sources\n', '## Sources\n- ' + made + ' — a result (not really returned)\n') } } : u));
    return { content: c };
  } });
  const { e } = boot(t, s.script);
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  // EVIDENCE-CHECKER was given the URLs the job's web calls returned (and the made-up one is not among them)
  const input = s.inputs['evidence-checker'][0];
  assert.match(input, /SOURCES RETURNED to this job's web calls so far/); assert.ok(input.includes('https://trends.example.com/genres/cozy-farming')); assert.ok(!input.includes(made));
  assert.match(job.reason, /--genre-cozy-farming-desk-props\.md: rejected -> citations not returned by any web call in this job: https:\/\/market\.example\.com\/listing\/made-up-999/);
  assert.equal((job.reason.match(/verified -> briefs\/ \(evidence indicative\)/g) || []).length, 3);
  assert.ok(fs.existsSync(research(e, 'rejected', day + '--genre-cozy-farming-desk-props.md')));
  // the same rule as a function
  const ok = genreBrief(day, GENRES[1]), returned = new Set(urlsIn(ok));
  assert.deepEqual(citationProblems(ok, returned), []);
  returned.delete(urlsIn(ok)[0]);
  assert.match(citationProblems(ok, returned)[0], /citations not returned by any web call in this job/);
  const c = checkScoutBrief(ok.replace('status: candidate', 'status: verified') + '\n## Evidence check\n- ok\n', { products: e.cfg.products, cfg: e.cfg.station, returned: new Set(urlsIn(ok)) });
  assert.equal(c.ok, true, (c.reasons || []).join('; ')); assert.equal(c.evidence.level, 'indicative'); assert.equal(c.evidence.competitorCount, 'not measured');
});

// ---- D4: the blocklist

test('D4: placeholders and non-names are refused and logged, never added; real names still are', async (t) => {
  const r = tempRoot('b2-bl'); t.after(() => r.cleanup());
  const rdir = path.join(r.J.dataRoot, 'research'); fs.mkdirSync(rdir, { recursive: true });
  const warned = []; const log = { warn: (m, d) => warned.push({ m, d }) };
  const terms = ['UNKNOWN — needs owner check', 'Unknown', 'TBD', 'N/A', 'n/a', 'none', '', '  ', 'ab', '???', '—', 'Gravemoor Interactive', 'Vex Ardent'].map((term) => ({ term, kind: 'studio' }));
  const added = addToBlocklist(r.J, rdir, terms, { day: '2026-10-17', jobId: 'j', log });
  assert.deepEqual(added.map((a) => a.term), ['Gravemoor Interactive', 'Vex Ardent']);
  assert.equal(added.refused.length, 11);
  assert.deepEqual(readBlocklist(rdir).terms.map((x) => x.term), ['Gravemoor Interactive', 'Vex Ardent']);
  assert.equal(warned.filter((w) => /refused a term that is not a name/.test(w.m)).length, 11);
  assert.equal(warned.filter((w) => /short name\(s\) put on the owner review list/.test(w.m)).length, 1, 'owner decision 4: "ab" goes to the review list');
  for (const x of ['UNKNOWN — needs owner check', 'TBD', 'N/A', '', 'ab']) assert.ok(notNameReason(x), x);
  for (const x of ['Ib Studio', 'Cinderpine', 'Lantern: Moss and Mile', '2091']) assert.equal(notNameReason(x), null, x);
  // in a scout run: a placeholder studio in the notes is refused (kind and reason on the job), the drafts still pass
  const games = FIXTURE_GAMES.map((g, i) => (i === 3 ? { ...g, studio: 'UNKNOWN — needs owner check' } : g));
  const { e } = boot(t, createScoutScript({ bad: false, games }));
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.ok(!readBlocklist(research(e)).terms.some((x) => /unknown/i.test(x.term)));
  assert.deepEqual(job.data.scouting.refusedNotNames, [{ kind: 'studio', reason: 'a placeholder, not a name' }]);
  assert.equal((job.reason.match(/verified -> briefs\//g) || []).length, 4);
});

test('D4: the b1 case: the placeholder entry is removed by the owner\'s hygiene step (idempotent), and the customer-facing check comes back clean', async (t) => {
  const { e } = boot(t);
  const rdir = research(e), day = '2026-10-17';
  // the b1 shape: the engine had added the placeholder (with 2 games); a rejected b1 draft carries the same placeholder
  e.J.put(path.join(rdir, 'scouting', 'blocklist.json'), JSON.stringify({ terms: [{ term: 'Cinderpine', kind: 'game', day, jobId: day + '--genre-scout-2' }, { term: 'Parsnip Hollow', kind: 'game', day, jobId: day + '--genre-scout-2' }, { term: 'UNKNOWN — needs owner check', kind: 'studio', day, jobId: day + '--genre-scout-2' }] }, null, 1) + '\n');
  const draft = genreBrief(day, GENRES[2]).replace('evidence level: indicative', 'evidence level: UNKNOWN — needs owner check').replace('status: candidate', 'status: rejected');
  e.J.put(path.join(rdir, 'rejected', day + '--cozy-fishing-stream-props.md'), draft);
  const files = [path.join(rdir, 'rejected', day + '--cozy-fishing-stream-props.md')];
  const before = customerFacingCheck(rdir, files, e.cfg.station);
  assert.equal(before.clean, false); assert.deepEqual(before.detail[0].scoutedNames, ['studio'], 'only the placeholder matched');
  // report only: nothing removed
  assert.deepEqual(blocklistPlaceholders(e.J, rdir).map((b) => b.term), ['UNKNOWN — needs owner check']);
  assert.equal(readBlocklist(rdir).terms.length, 3);
  // apply: removed; real names kept; a second run finds nothing
  assert.equal(blocklistPlaceholders(e.J, rdir, { apply: true }).length, 1);
  assert.deepEqual(readBlocklist(rdir).terms.map((x) => x.term), ['Cinderpine', 'Parsnip Hollow']);
  assert.deepEqual(blocklistPlaceholders(e.J, rdir, { apply: true }), []);
  const after = customerFacingCheck(rdir, files, e.cfg.station);
  assert.equal(after.clean, true, JSON.stringify(after.detail));
});
