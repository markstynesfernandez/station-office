// scout-live.mjs — E6 step b: ONE genre-scout run on the live provider (Anthropic text + server-side web search), then
// exit. Run only with the owner's go-ahead, and only as a per-process override (.env keeps STATION_PROVIDER=mock):
//   PowerShell: $env:STATION_PROVIDER='live'; npm run scout:live; Remove-Item Env:STATION_PROVIDER
// - Refuses unless this process's own environment says live; refuses on the e-stop; needs the server stopped (the
//   engine lock). No scheduler, no resumed jobs, no routine: one genre-scout job, started here, run to its end.
// - Caps are the engine's own (config/engine.json): perJob[genre-scout] USD 0.50 for the whole run, the per-agent-run
//   cap, the daily caps, each agent's maxWebCalls; retries are live.retries. This script changes none of them; it
//   refuses to start if the scout run cap is not USD 0.50.
// - Before any model call it asks the Models API (free metadata, no tokens) whether the web relay model accepts the web
//   search tool, and refuses if it does not say yes.
// - Prints one pre-run line, then a key-free report: the briefs (verified, rejected, blocked by the scouting screen and
//   whether intake would refuse them; no blocked brief is offered to intake, so no job can be created), the web calls,
//   every ledger row of the run (request id, cost), the cost by model and in search fees, today's ledger total, the
//   names added to the internal scouting blocklist, and a check that no brief outside scouting/ names a scouted game or
//   hits the station's originality lists.
// The key is read from the environment by the provider only; .env is loaded without overriding the shell, and no value
// from it is printed.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/lib/legacy-readers/common.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { effectiveAgent, MAX_NUDGES } from '../src/engine/runtime.mjs';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { readBlocklist, scoutingBriefProblems, scoutRunExitCode, customerFacingCheck, SCOUT_DIR } from '../src/engine/lib/scouting.mjs';
import { fetchRefusedDomains } from '../src/engine/lib/web-sources.mjs';

const LINE = 'genre-scout', RUN_CAP_USD = 0.5;
// the product key is data (owner, 17/10/2026): `npm run scout:live -- --product-key <key>`, else the line's config default
// (config/lines/genre-scout.json productKey); the engine checks it against products.json before any call
const KEY_ARG = (() => { const i = process.argv.indexOf('--product-key'); return i >= 0 ? String(process.argv[i + 1] || '') : undefined; })();
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const field = (t, k) => (new RegExp('^' + k + ':[ \\t]*(.+)$', 'm').exec(t) || [])[1] || '';
const niche = (t) => (/^# Niche\s*\n(.+)$/m.exec(t) || [])[1] || '';
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

if (process.env.STATION_PROVIDER !== 'live') {
  console.error('scout-live refused: this process\'s STATION_PROVIDER is "' + (process.env.STATION_PROVIDER || 'unset') + '". Run it as: $env:STATION_PROVIDER=\'live\'; npm run scout:live; Remove-Item Env:STATION_PROVIDER');
  process.exit(2);
}
loadEnv(path.join(APP_ROOT, '.env'));   // fills only what the shell has not set; the logger redacts the key names' values
const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'scout-live', jail: J });
const out = (s) => console.log(log.redact(s));

let engine;
try { engine = openScriptEngine({ J, log, purpose: 'scout:live', startsJobs: true }); }
catch (e) { console.error(log.redact('scout-live: the engine did not start: ' + e.message + (e.code === 'LOCKED' ? ' (the Station server holds the engine lock: stop it first)' : ''))); process.exit(1); }
try {
  const { cfg, providers, halt, ledger, store, orchestrator } = engine;
  if (providers.mode !== 'live') throw new Error('the engine is not on the live provider (' + providers.mode + ')');
  if (halt.isHalted()) throw new Error('e-stop is on: no call made');
  const L = cfg.lines[LINE]; if (!L) throw new Error('no ' + LINE + ' line in config');
  const capUsd = (cfg.engine.caps.perJobUsdByLine || {})[LINE];
  if (capUsd !== RUN_CAP_USD) throw new Error('config/engine.json perJobUsdByLine.' + LINE + ' is ' + capUsd + ', not ' + RUN_CAP_USD.toFixed(2) + ': refused (caps change only with the owner)');
  const W = providers.web.settings;
  const agents = Object.values(L.steps).filter((s) => s.kind === 'agent').map((s) => { const a = effectiveAgent(engine, s.agent), t = cfg.engine.tiers[a.tier]; return { key: a.key, enabled: a.enabled, model: t.model, effort: a.effort, maxWebCalls: a.limits.maxWebCalls || 0, maxTurns: a.limits.maxTurns, maxOutputTokens: a.limits.maxOutputTokens }; });
  const off = agents.filter((a) => !a.enabled); if (off.length) throw new Error('agent(s) off duty: ' + off.map((a) => a.key).join(', '));
  const sup = await providers.text.webSearchSupported(W.model);
  if (!sup.supported) throw new Error('the Models API does not report web search support for ' + W.model + (sup.reported ? ' (supported: false)' : ' (field missing)') + ': no model call made');
  const productKey = KEY_ARG !== undefined ? KEY_ARG : L.productKey, keyKnown = (cfg.products || []).some((p) => p.key === productKey);
  const pre = 'scout-live: line=' + LINE + ' product_key=' + (productKey || '(none)') + ' (' + (KEY_ARG !== undefined ? '--product-key' : 'line config default') + ', ' + (keyKnown ? 'in products.json' : 'NOT in products.json: the engine ends the job at USD 0') + ') agents=' + agents.map((a) => a.key + ':' + a.model + '/effort ' + a.effort).join(',') + ' web_relay=' + W.model + '/effort ' + (W.effort || 'default') + ' (' + W.tools.web_search + ', ' + W.tools.web_fetch + ', max_uses=' + W.maxUsesPerRequest + ', blocked_domains=' + W.blockedDomains.length + ' on both; fetch_refused=' + fetchRefusedDomains(cfg.engine).join('+') + ' engine-only, not sent)' +
    ' web_call_cap=' + agents.map((a) => a.key + ' ' + a.maxWebCalls).join(',') + ' run_cap_usd=' + capUsd.toFixed(2) + ' agent_run_cap_usd=' + cfg.engine.caps.perRunUsd.toFixed(2) + ' retries=' + (cfg.engine.live.retries ?? 0) + ' max_nudges=' + MAX_NUDGES + ' (offer: fs_write or report_blocked) draft_schema=on-write web_search_supported=yes';
  log.info('scout-live: one run', { line: LINE, productKey: productKey || null, agents, webRelay: W.model, maxUses: W.maxUsesPerRequest, runCapUsd: capUsd, retries: cfg.engine.live.retries });
  out(pre);

  const rdir = path.join(J.dataRoot, 'research');
  const before = new Set(readBlocklist(rdir).terms.map((t) => t.kind + '|' + t.term));
  const t0 = Date.now();
  const c = orchestrator.createResearchJob({ line: LINE, by: 'owner (scripts/scout-live.mjs, E6 step b)', ...(KEY_ARG !== undefined ? { productKey: KEY_ARG } : {}) });
  await orchestrator.startJob(c.id);
  const job = store.getJob(c.id), day = job.data.day || dublinDay(t0);

  const fresh = (f) => fs.statSync(f).mtimeMs >= t0 - 1000;
  // E6 b2: a genre brief is one whose front matter says origin: genre-scout (b1's report looked for a "--genre-" file name)
  const genre = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith(day + '--') && f.endsWith('.md') && fresh(path.join(d, f)) && /^origin:[ \t]*genre-scout\b/mi.test(fs.readFileSync(path.join(d, f), 'utf8'))).sort() : []);
  const level = (t) => field(t, 'evidence level') || '(none)';
  const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
  const verified = genre(path.join(rdir, 'briefs')).map((f) => { const t = read(path.join(rdir, 'briefs'), f); return { file: f, status: field(t, 'status'), niche: niche(t), segment: field(t, 'audience_segment'), evidence: level(t), priceRange: ((/^## Price range\s*\n(.+)$/m.exec(t) || [])[1] || '').split(' — ')[0], stationCheck: (t.split('## Station brief check')[1] || '').split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2)) }; });
  const rejected = genre(path.join(rdir, 'rejected')).map((f) => { const t = read(path.join(rdir, 'rejected'), f); return { file: f, status: field(t, 'status'), niche: niche(t), evidence: level(t), reasons: (t.split('## Station brief schema')[1] || t.split('## Station brief check')[1] || t.split('## Evidence check')[1] || '').split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2)).slice(0, 6) }; });
  // drafts left in the drafts folder (not verified: rejected by EVIDENCE-CHECKER, or never checked)
  const ddir = path.join(rdir, L.drafts || 'drafts', day);
  const leftInDrafts = genre(ddir).map((f) => { const t = read(ddir, f); return { file: f, status: field(t, 'status'), niche: niche(t), evidence: level(t), verdict: ((t.split('## Evidence check')[1] || '').match(/Verdict:.*$/m) || [''])[0] }; });
  const bdir = path.join(rdir, SCOUT_DIR, 'blocked', day);
  const blocked = genre(bdir).map((f) => { const t = read(bdir, f); const asVerified = t.replace(/^status: .*$/m, 'status: verified').replace(/\n## Station scouting screen[\s\S]*$/, '\n'); return { file: f, reasons: t.split('\n').filter((l) => /^- originality/.test(l)).map((l) => l.slice(2)), intakeWouldRefuse: scoutingBriefProblems(asVerified, cfg.station) }; });

  // customer-facing check: every file this run wrote outside scouting/ (the briefs and drafts), against the scouted names
  // and the station's originality lists (brands, characters, people, derivative wording)
  const outside = walk(rdir).filter((f) => !path.relative(rdir, f).split(path.sep)[0].toLowerCase().startsWith(SCOUT_DIR) && fresh(f) && /\.(md|json|txt)$/.test(f));
  const facing = customerFacingCheck(rdir, outside, cfg.station);
  // the transcript (internal, data/ only): nudges and what followed, schema refusals, refused fetches, report_blocked
  const tf = path.join(J.dataRoot, 'jobs', job.id, 'transcript.jsonl');
  const tl = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const errs = (re) => tl.flatMap((l) => (l.toolResults || []).filter((r) => r.is_error && re.test(r.content)).map((r) => ({ agent: l.agent, turn: l.turn, error: r.content.slice(0, 400) })));

  const rows = ledger.rows().filter((r) => r.jobId === job.id);
  const byModel = {}; let searchFees = 0, searches = 0, fetches = 0;
  for (const r of rows) {
    if (r.kind === 'web') { const fee = r6((r.searches || 0) * W.fees.web_search + (r.fetches || 0) * W.fees.web_fetch); searchFees = r6(searchFees + fee); searches += r.searches || 0; fetches += r.fetches || 0; const m = (r.via || r.model) + ' (web relay tokens)'; byModel[m] = r6((byModel[m] || 0) + r.usd - fee); }
    else byModel[r.model] = r6((byModel[r.model] || 0) + r.usd);
  }
  const added = readBlocklist(rdir).terms.filter((t) => !before.has(t.kind + '|' + t.term)).map((t) => ({ term: t.term, kind: t.kind }));
  const today = dublinDay(Date.now());
  out(JSON.stringify({
    job: { id: job.id, productKey: job.product_key || null, productKeySource: job.data.productKeySource || null, state: job.state, reason: job.reason, day, minutes: r6((Date.now() - t0) / 60000), shortfalls: job.data.shortfalls || [] },
    steps: (job.data.scouting || {}).drafts || [],
    reportedBlocked: job.data.reportedBlocked || null,
    nudges: tl.filter((l) => l.nudge).map((n) => ({ agent: n.agent, nudge: n.nudge, toolChoice: n.tool_choice && n.tool_choice.type, offered: n.offered || null, after: tl.filter((l) => l.afterNudge === n.nudge && l.agent === n.agent).map((l) => ({ stop: l.stop_reason, tools: l.toolCalls.map((c) => c.name + (c.input && c.input.path ? ' ' + c.input.path : '')) })) })),
    schemaErrors: errs(/^brief schema:/),
    refusedFetches: errs(/^web_fetch refused/),
    otherToolErrors: errs(/^(?!brief schema:|web_fetch refused)/),
    briefs: { verified, rejected, blocked, leftInDrafts, refusedNotNames: ((job.data.scouting || {}).refusedNotNames) || [] },
    web: { requests: rows.filter((r) => r.kind === 'web').length, searches, fetches, byAgent: Object.fromEntries(agents.map((a) => [a.key, { rows: rows.filter((r) => r.kind === 'web' && r.agentKey === a.key).length, cap: a.maxWebCalls }])) },
    cost: { totalUsd: r6(rows.reduce((s, r) => s + r.usd, 0)), byModel, searchFeesUsd: searchFees, capUsd, estimatedRows: rows.filter((r) => r.estimated).length },
    ledgerRows: rows.map((r) => ({ entryId: r.entryId, requestId: r.requestId || null, agent: r.agentKey, kind: r.kind, model: r.model, ...(r.kind === 'web' ? { via: r.via, searches: r.searches, fetches: r.fetches } : {}), tokens: r.tokens, usd: r.usd, estimated: !!r.estimated })),
    ledgerToday: { day: today, usd: ledger.spent.day(today), rows: ledger.rows().filter((r) => dublinDay(r.ts) === today).length },
    blocklistAdded: { file: 'research/scouting/blocklist.json (internal)', names: added },
    customerFacingCheck: facing
  }, null, 1));
  // E6 b1: anything but research-done (incomplete, blocked, stopped) exits non-zero; the transcript is internal (data/ only)
  if (scoutRunExitCode(job) !== 0) { console.error(log.redact('scout-live: the job ended ' + job.state + ': ' + (job.reason || '') + ' (transcript: data/jobs/' + job.id + '/transcript.jsonl)')); process.exitCode = scoutRunExitCode(job); }
  else if (!verified.length) console.error(log.redact('scout-live: research-done with no verified genre brief'));
} catch (e) {
  console.error(log.redact('scout-live failed (no rerun): ' + (e.message || e) + (e.status ? ' [status ' + e.status + ']' : '') + (e.requestId ? ' [request ' + e.requestId + ']' : '')));
  process.exitCode = 1;
} finally { engine.close(); }
