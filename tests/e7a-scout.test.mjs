// e7a-scout.test.mjs — E7a, owner decision 1 (19/10/2026; DECISIONS.md "E7a"): no Etsy data in the scout or the research
// line until Etsy authorises it in writing. Both lines write the one indicative brief schema (lib/scout-brief.mjs): non-Etsy
// results only, no etsy.com URL anywhere (refused on write), a result price as shown or "no price", and "owner sets price"
// when no row shows a price. The research line's drafts are validated on write and checked against the job transcript; an
// agent's ported Etsy-format draft is refused. The floor rule is unchanged (3+ cited prices at or above it; EUR at the
// station rate). The three prompts say it, within their caps, the IP-rule lines word for word. Mock provider only, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { buildAgentPrompt } from '../src/engine/prompts.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { evidenceBanner } from '../src/web/ui/evidence.js';
import { validateScoutBrief, checkScoutBrief, floorRows, ownerSetsPriceOf, isIndicativeBrief, OWNER_SETS_PRICE } from '../src/engine/lib/scout-brief.mjs';
import { urlsIn } from '../src/engine/lib/web-sources.mjs';
import { createScoutScript, genreBrief, researchBrief, researchQuery, GENRES, FIXTURE_PRODUCT_KEY } from '../fixtures/engine/scout-script.mjs';
import { dryRunScout } from '../scripts/dry-run-scout.mjs';

const CFG = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts') });
const PROMPTS = path.join(APP_ROOT, 'prompts');
const DAY = dublinDay();
const LOFI = { slug: 'lofi-study', genre: 'lofi study', segment: 'students who stream study sessions', props: 'a desk lamp, a stack of notebooks, a mug of tea, a cassette player, a potted fern and a sleeping cat bed', palette: 'dusty rose, cream and teal', price: 9 };
const research = (e, ...p) => path.join(e.J.dataRoot, 'research', ...p);

// the research line on the mock: DEMAND-RESEARCHER searches once, then writes `draft` (EVIDENCE-CHECKER marks it verified)
function boot(t, draft, { file = DAY + '--genre-lofi-study-desk-props.md' } = {}) {
  const r = tempRoot('e7a-scout'), base = createScoutScript(), writes = [];
  const script = (ctx, params) => {
    if (ctx.agentKey === 'demand-researcher') {
      const n = params.messages.filter((m) => m.role === 'assistant').length, last = params.messages[params.messages.length - 1];
      if (Array.isArray(last.content)) writes.push(...last.content.filter((b) => b.type === 'tool_result' && b.tool_use_id === 'tu_d'));
      return n === 0 ? { content: [{ type: 'tool_use', id: 'tu_s', name: 'web_search', input: { query: researchQuery(LOFI) } }] }
        : n === 1 ? { content: [{ type: 'tool_use', id: 'tu_d', name: 'fs_write', input: { path: 'drafts/' + DAY + '/' + file, content: draft } }] } : { content: [{ type: 'text', text: 'done' }] };
    }
    return base(ctx, params);
  };
  script.web = base.web;
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} r.cleanup(); });
  return { e, r, writes };
}
async function runResearch(e) { const c = e.orchestrator.createResearchJob({ by: 'test' }); await e.orchestrator.startJob(c.id); return e.store.getJob(c.id); }

test('decision 1: etsy.com is blocked for search and fetch for every agent; no Etsy URL anywhere in a brief (refused on write, with the reason)', () => {
  assert.ok(CFG.engine.webSources.blockedDomains.includes('etsy.com'), 'etsy.com in blockedDomains (sent to the API on both tools)');
  assert.deepEqual(CFG.engine.webSources.fetchRefusedDomains, ['etsy.com'], 'the engine-side refusal kept');
  const ok = genreBrief(DAY, GENRES[0]);
  assert.deepEqual(validateScoutBrief(ok, { day: DAY, agent: true }).problems, []);
  assert.equal(urlsIn(ok).filter((u) => /etsy\.com/.test(u)).length, 0, 'the FIXTURE results are non-Etsy');
  const etsy = ok.replace(/https:\/\/market\.example\.com\/listing\/candlelit-dark-fantasy-1/g, 'https://www.etsy.com/listing/123456');
  assert.match(validateScoutBrief(etsy, { day: DAY, agent: true }).problems.join(' '), /etsy\.com URL\(s\): https:\/\/www\.etsy\.com\/listing\/123456: no Etsy data in a brief until Etsy authorises it in writing/);
  // a subdomain counts too
  assert.match(validateScoutBrief(ok.replace('https://trends.example.com/genres/candlelit-dark-fantasy', 'https://shop.etsy.com/x'), { day: DAY }).problems.join(' '), /etsy\.com URL/);
});

test('decision 1: the research line writes indicative briefs: validated on write, checked against the job transcript, verified with the citation record, accepted at intake, "indicative" on the approval card', async (t) => {
  const { e, writes } = boot(t, researchBrief(DAY, LOFI));
  const j = await runResearch(e);
  assert.equal(j.state, 'research-done', j.reason);
  assert.equal(writes.length, 1); assert.ok(!writes[0].is_error, String(writes[0].content));
  assert.match(j.reason, /lofi-study-desk-props\.md: verified -> briefs\/ \(evidence indicative\)/);
  const b = fs.readFileSync(research(e, 'briefs', DAY + '--genre-lofi-study-desk-props.md'), 'utf8');
  assert.match(b, /^origin: research$/m); assert.ok(isIndicativeBrief(b));
  assert.match(b, new RegExp('^- citations: \\d+, all returned by web calls in job ' + j.id + ' \\(transcript\\)$', 'm'));
  assert.match(b, /evidence level: indicative \(non-Etsy web search results only; competitor count not measured\)/);
  const c = e.orchestrator.createJob({ briefText: b, by: 'test' });
  assert.equal(c.ok, true, (c.reasons || []).join('; '));
  const snap = buildEngineSnapshot(e).jobs.find((x) => x.id === c.id);
  assert.equal(snap.evidenceLevel, 'indicative'); assert.equal(snap.ownerSetsPrice, false);
});

test('decision 1: a research brief citing a URL its job never returned is rejected at brief-check (the same rule as the scout)', async (t) => {
  const made = 'https://market.example.com/listing/made-up-1';
  const d = researchBrief(DAY, LOFI).replace(/^(- pngtuber props — )\S+$/m, '$1' + made).replace('## Sources\n', '## Sources\n- ' + made + ' — not really returned\n');
  const { e } = boot(t, d);
  const j = await runResearch(e);
  assert.match(j.reason, /lofi-study-desk-props\.md: rejected -> citations not returned by any web call in this job: https:\/\/market\.example\.com\/listing\/made-up-1/);
});

test('decision 1: an agent\'s ported Etsy demand-evidence draft is refused on write in drafts/; a non-indicative verified draft is rejected at brief-check', async (t) => {
  const etsyDraft = ['---', 'id: ' + DAY + '--etsy-format', 'date: ' + DAY, 'status: candidate', 'product_type: ' + FIXTURE_PRODUCT_KEY, 'audience_segment: streamers', '---', '# Niche', 'x', '', '## Demand evidence', 'search phrase: x', 'checked: ' + DAY, 'search URL: https://www.etsy.com/search?q=x', 'competitor count: 1,000', ''].join('\n');
  const { e, writes } = boot(t, etsyDraft, { file: DAY + '--etsy-format.md' });
  const j = await runResearch(e);
  assert.equal(writes.length, 1); assert.equal(writes[0].is_error, true);
  assert.match(String(writes[0].content), /brief schema: drafts\/.*was NOT written/);
  assert.match(String(writes[0].content), /front matter: origin missing/); assert.match(String(writes[0].content), /etsy\.com URL/);
  assert.match(validateScoutBrief(researchBrief(DAY, LOFI).replace('origin: research', 'origin: genre-scout'), { origin: 'research' }).problems.join(' '), /origin must be "research"/);
  assert.ok(!fs.existsSync(research(e, 'drafts', DAY, DAY + '--etsy-format.md')));
  assert.match(j.reason, /no drafts|not moved|^$/);
  // a verified Etsy-format file placed in drafts/ by hand: the research brief-check rejects it (agents write no Etsy evidence)
  e.J.put(research(e, 'drafts', DAY, DAY + '--etsy-format.md'), etsyDraft.replace('status: candidate', 'status: verified'));
  const j2 = await runResearch(e);
  assert.match(j2.reason, /etsy-format\.md: rejected -> not an indicative brief .*agents write no Etsy demand evidence until Etsy authorises it in writing/);
});

test('decision 1: "owner sets price" when no cited result shows a price: verified, on the approval card; refused while a row shows a price or with a figure', async (t) => {
  const np = researchBrief(DAY, LOFI, { noPrice: true });
  assert.deepEqual(validateScoutBrief(np, { day: DAY, agent: true, origin: 'research' }).problems, []);
  assert.equal(ownerSetsPriceOf(np), true);
  const { e } = boot(t, np);
  const j = await runResearch(e);
  assert.match(j.reason, /lofi-study-desk-props\.md: verified -> briefs\/ \(evidence indicative; owner sets price\)/);
  const b = fs.readFileSync(research(e, 'briefs', DAY + '--genre-lofi-study-desk-props.md'), 'utf8');
  assert.match(b, /^- price: owner sets price \(no cited result shows a price\)$/m);
  const c = e.orchestrator.createJob({ briefText: b, by: 'test' });
  assert.equal(c.ok, true, (c.reasons || []).join('; '));
  const snap = buildEngineSnapshot(e).jobs.find((x) => x.id === c.id);
  assert.equal(snap.ownerSetsPrice, true);
  assert.match(evidenceBanner(snap.evidenceLevel, { ownerSetsPrice: snap.ownerSetsPrice }), /Price: OWNER SETS PRICE/);
  // with a priced row it is refused (the floor rule then applies), and the marker carries no figure
  const priced = np.replace(/\| 1 \| (FIXTURE listing 1 [^|]+)\| no price \|/, '| 1 | $1| USD 9.00 |');
  assert.match(validateScoutBrief(priced, { day: DAY }).problems.join(' '), /"owner sets price" is only for a brief whose result rows show no price; 1 row\(s\) show one/);
  assert.match(validateScoutBrief(np.replace('owner sets price — no cited result shows a price', 'owner sets price — about USD 5'), { day: DAY }).problems.join(' '), /carries no price figure/);
  assert.equal(OWNER_SETS_PRICE, 'owner sets price');
});

test('decision 1: "own shop:" lines are the owner\'s only (recorded by owner); an agent never writes them', () => {
  const base = researchBrief(DAY, LOFI), add = (l) => base.replace('competitor count: not measured\n', 'competitor count: not measured\n' + l + '\n');
  assert.match(validateScoutBrief(add('own shop: DESK-PROPS-01 sold 3 in 30 days'), { day: DAY }).problems.join(' '), /an "own shop:" line is the owner's own shop result/);
  const owner = add('own shop: DESK-PROPS-01 sold 3 in 30 days (recorded by owner, ' + DAY + ')');
  assert.deepEqual(validateScoutBrief(owner, { day: DAY }).problems, [], 'the owner\'s own line');
  assert.match(validateScoutBrief(owner, { day: DAY, agent: true }).problems.join(' '), /"recorded by owner" is the owner's marker: an agent never writes it/);
});

test('decision 1: the prompts say it (no Etsy data; non-Etsy sources; owner sets price), within their caps, the IP-rule lines word for word', () => {
  const budgets = CFG.station.promptBudgetChars;
  const P = Object.fromEntries(['trend-scout', 'demand-researcher', 'evidence-checker'].map((k) => [k, buildAgentPrompt(CFG.agents[k], { promptsDir: PROMPTS, budgets })]));
  assert.ok(P['trend-scout'].chars <= 16000 && P['demand-researcher'].chars <= 16000, 'within the 16,000-char clamp');
  assert.ok(P['evidence-checker'].chars <= 14000, 'evidence-checker at most 14,000');
  for (const [k, p] of Object.entries(P)) {
    assert.match(p.text, /no Etsy data|NO ETSY DATA/i, k);
    assert.ok(p.skills.includes('originality-rules'), k + ' keeps the originality rules');
    assert.doesNotMatch(p.text, /It is the ONE place you may open etsy\.com/, k + ': the ported DEMAND EVIDENCE skill is gone');
  }
  assert.match(P['trend-scout'].text, /non-Etsy web search results show it \(other marketplaces, editorial roundups, community discussion\)/);
  assert.match(P['demand-researcher'].soul, /public, non-Etsy sources — trend articles, editorial roundups, community discussion and other marketplaces/);
  assert.match(P['demand-researcher'].text, /No result shows a price: `owner sets price`/);
  assert.match(P['evidence-checker'].text, /any etsy\.com URL in a brief: REJECTED/);
  // the IP rule lines, word for word
  const dr = fs.readFileSync(path.join(PROMPTS, 'agents', 'demand-researcher.md'), 'utf8');
  assert.ok(dr.includes('   - Design direction = ORIGINAL concepts in plain words: no reference to protected IP (brands, logos, characters, franchises, teams, celebrities, lyrics, quotes, well-known slogans, a named artist\'s style, or "inspired by" a product or listing). A brief that fails this is rejected by a station script.'));
  const ts = fs.readFileSync(path.join(PROMPTS, 'agents', 'trend-scout.md'), 'utf8');
  for (const l of ['The notes are the ONLY place a game title, studio, character, logo, UI element, signature item, named location, distinctive art style or quote may appear.', 'Never record a streamer\'s or any other person\'s name, handle or channel: aggregate figures only.', 'No game, studio, character, place, item, logo, UI or art-style names; no "fan art", "fan-made", "fandom", "fanfic", "inspired by", "homage", "tribute", "dupe", "knockoff", "alternative to", "in the style of" or similar wording anywhere.']) assert.ok(ts.includes(l), l);
});

test('decision 1: the mock scout dry run: 4 indicative briefs, none citing Etsy; 1 blocked; 12 web calls; $0', async () => {
  const r = await dryRunScout({ quiet: true });
  assert.equal(r.briefs.length, 4); assert.equal(r.blocked.length, 1); assert.equal(r.web.calls, 12);
  assert.equal(r.ledger.usd, 0); assert.ok(r.ledger.allMock);
  for (const b of r.briefs) {
    const t = fs.readFileSync(path.join(r.dataRoot, 'research', 'briefs', b.file), 'utf8');
    assert.match(t, /^evidence level: indicative$/m); assert.doesNotMatch(t, /etsy\.com/i, b.file);
  }
});
