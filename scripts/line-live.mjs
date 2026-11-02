// line-live.mjs — E6 step c: ONE job on one verified brief through the whole Room 1 line on the live provider (Anthropic text,
// OpenRouter images), then exit. Run only with the owner's go-ahead ("go line <brief id>"), only as a per-process override
// (.env keeps STATION_PROVIDER=mock):
//   PowerShell: $env:STATION_PROVIDER='live'; npm run line:live -- --brief <brief id>; Remove-Item Env:STATION_PROVIDER
//   after the owner's decision on file 1 (npm run owner -- style-ref <job id> '{"set":N,"status":"approved"}'):
//   PowerShell: $env:STATION_PROVIDER='live'; npm run line:live -- --resume <job id>; Remove-Item Env:STATION_PROVIDER
//   after npm run owner -- prepare-redraw <job id> '<plan>' (owner, 18/10/2026: a redraw-only set, $0):
//   PowerShell: $env:STATION_PROVIDER='live'; npm run line:live -- --redraw <job id>; Remove-Item Env:STATION_PROVIDER
//   the owner's run modes on a job (owner, 18/10/2026), each within the owner's cap:
//   PowerShell: $env:STATION_PROVIDER='live'; npm run line:live -- --listing-only <job id> --max-usd <USD>; Remove-Item Env:STATION_PROVIDER
//   PowerShell: $env:STATION_PROVIDER='live'; npm run line:live -- --qa-only <job id> --set <N> --max-usd <USD>; Remove-Item Env:STATION_PROVIDER
//   npm run line:live -- --plan          the pre-run line only: no engine, no key, no call (any provider setting)
// - Refuses unless this process's own environment says live (except --plan); refuses on the e-stop; needs the server stopped
//   (the engine lock); refuses without OPENROUTER_API_KEY (names only, never values). No scheduler, no resumed jobs, no routine.
// - Caps are the engine's own (config/engine.json): perJob USD 7.00 for the whole job, images included (owner, 21/10/2026, W4; was 6.00, W2; 5.00 before), the per-agent-run cap,
//   the daily caps; OpenRouter's own key limit (USD 2 a day) applies outside the engine. This script changes none of them and
//   refuses to start if the job cap is not USD 7.00. Nothing is published: the line ends in the approval queue.
// - The brief: data/research/briefs/<id>.md, else the engine's legacy import (data/legacy/research/briefs/<id>.md). Intake checks
//   it as for any job (a refused brief creates no job and spends nothing). An owner brief (npm run owner-brief) runs the same way.
// - Prints one pre-run line, then a key-free report (stages, QA verdicts, images, cost by stage, model and images, every ledger
//   row with its request or generation id, today's ledger total, the listing draft, originality and IP checks, where the
//   package and the approval item are). Exit 0 when the job is waiting for the owner or in the approval queue, else 1.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/lib/legacy-readers/common.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { effectiveAgent } from '../src/engine/runtime.mjs';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { ownerFloor } from '../src/engine/lib/etsy-fees.mjs';
import { listingSpellingProblems } from '../src/engine/lib/spelling.mjs';
import { screenText, listingFields } from '../src/engine/lib/originality.mjs';
import { evidenceLevelOf } from '../src/engine/lib/scout-brief.mjs';

const JOB_CAP_USD = 7, LINE = 'room1-digital';
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? String(process.argv[i + 1] || '') : null; };
const BRIEF = arg('--brief'), RESUME = arg('--resume'), REDRAW = arg('--redraw'), LISTING = arg('--listing-only'), QAONLY = arg('--qa-only'), PLAN = process.argv.includes('--plan');
const SET = arg('--set'), MAX_USD = arg('--max-usd');
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const rj = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };

// the pre-run line: models, thinking and effort per agent, the image model and its reservation, caps, retries, the run modes
export function planLine(cfg, { agentOf = (k) => cfg.agents[k] } = {}) {
  const L = cfg.lines[LINE], e = cfg.engine, img = e.image, pack = (cfg.products || []).find((p) => p.styleReference && p.styleReference.ownerOk);
  const agents = [...new Set(Object.values(L.steps).filter((s) => s.kind === 'agent').map((s) => s.agent))].map((k) => { const a = agentOf(k), t = e.tiers[a.tier], th = a.thinking === 'off' ? ((e.thinking.off[t.model] || {}).type || 'NO SETTING') : 'default';
    return k + ':' + t.model + '/effort ' + a.effort + '/thinking ' + th + '/tool_choice ' + (t.forcedToolChoice === false ? 'auto' : 'forced') + (a.limits.maxImages ? '/maxImages ' + a.limits.maxImages : ''); });
  const of = pack ? ownerFloor(pack, cfg.station) : null, n = pack ? pack.deliverables.files.length : 0, chunk = Math.max(1, ((cfg.agents.designer || {}).limits || {}).maxImages - 2);
  return 'line-live: line=' + LINE + ' agents=' + agents.join(',') + ' image=' + img.allowedModels.join('+') + ' (reserve USD ' + e.pricing.openrouter.models[img.allowedModels[0]].perImage.toFixed(2) + '/image, settle to OpenRouter usage.cost, retries=' + (e.live.retries ?? 0) + ', timeout ' + img.timeoutMs + ' ms)'
    + ' vision=' + Object.keys(e.vision.models).join('+') + ' (ceil(w/28)*ceil(h/28), max ' + Object.values(e.vision.models)[0].maxVisualTokens + ' tokens)'
    + (pack ? ' style_ref=' + pack.key + ' (file 1 alone -> QA DESIGN -> owner decision -> files 02-' + String(n).padStart(2, '0') + ' in ' + Math.ceil((n - 1) / chunk) + ' batch(es) of <=' + chunk + ' with file 1 as reference)' : '')
    + ' upscale=realesrgan (pinned, local, $0) floor=' + (of ? 'USD ' + of.floorUsd.toFixed(2) + ' / EUR ' + of.floorEur.toFixed(2) + ' (owner D1)' : 'fee model')
    + ' job_cap_usd=' + e.caps.perJobUsd.toFixed(2) + ' agent_run_cap_usd=' + e.caps.perRunUsd.toFixed(2) + ' day_cap_usd=' + e.caps.perDayUsd.toFixed(2) + ' (OpenRouter key limit USD 2/day outside the engine)'
    + ' design_loop=' + (L.steps['qa-design'].onRevise.max) + ' listing_loop=' + L.steps['qa-listing'].onRevise.max + ' ends=approval queue (nothing is published)';
}

if (PLAN) {
  const cfg = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts') });
  console.log(planLine(cfg));
  process.exit(0);
}
if (process.env.STATION_PROVIDER !== 'live') {
  console.error('line-live refused: this process\'s STATION_PROVIDER is "' + (process.env.STATION_PROVIDER || 'unset') + '". Run it as: $env:STATION_PROVIDER=\'live\'; npm run line:live -- --brief <id>; Remove-Item Env:STATION_PROVIDER');
  process.exit(2);
}
if ([BRIEF, RESUME, REDRAW, LISTING, QAONLY].filter(Boolean).length !== 1) { console.error('line-live: give exactly one of --brief <brief id>, --resume <job id>, --redraw <job id>, --listing-only <job id> --max-usd <cap> or --qa-only <job id> --set <N> --max-usd <cap>'); process.exit(2); }
if ((LISTING || QAONLY) && !(Number(MAX_USD) > 0)) { console.error('line-live: --listing-only and --qa-only need the owner\'s cap for the run: --max-usd <USD>'); process.exit(2); }
if (QAONLY && !(Number.isInteger(Number(SET)) && Number(SET) > 0)) { console.error('line-live: --qa-only needs --set <N>'); process.exit(2); }
loadEnv(path.join(APP_ROOT, '.env'));   // fills only what the shell has not set; no value is printed
const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'line-live', jail: J });
const out = (s) => console.log(log.redact(s));

let engine;
try { engine = openScriptEngine({ J, log, purpose: 'line:live', startsJobs: true }); }
catch (e) { console.error(log.redact('line-live: the engine did not start: ' + e.message + (e.code === 'LOCKED' ? ' (the Station server holds the engine lock: stop it first)' : ''))); process.exit(1); }
try {
  const { cfg, providers, halt, ledger, store, orchestrator } = engine;
  if (providers.mode !== 'live') throw new Error('the engine is not on the live provider (' + providers.mode + ')');
  if (providers.image.id !== 'openrouter') throw new Error('the image provider is not built (OPENROUTER_API_KEY not set): no call made');
  if (halt.isHalted()) throw new Error('e-stop is on: no call made');
  if (cfg.engine.caps.perJobUsd !== JOB_CAP_USD) throw new Error('config/engine.json caps.perJobUsd is ' + cfg.engine.caps.perJobUsd + ', not ' + JOB_CAP_USD.toFixed(2) + ': refused (caps change only with the owner)');
  if (JSON.stringify(cfg.engine.image.allowedModels) !== JSON.stringify(['openai/gpt-5-image-mini'])) throw new Error('image.allowedModels is not exactly openai/gpt-5-image-mini: refused');
  const L = cfg.lines[LINE], off = [...new Set(Object.values(L.steps).filter((s) => s.kind === 'agent').map((s) => s.agent))].filter((k) => !effectiveAgent(engine, k).enabled);
  if (off.length) throw new Error('agent(s) off duty: ' + off.join(', '));
  if (orchestrator.active().length) throw new Error('a job is already running: ' + orchestrator.active().join(', '));
  out(planLine(cfg, { agentOf: (k) => effectiveAgent(engine, k) }));
  const t0 = Date.now();
  let id;
  if (BRIEF) {
    if (!/^\d{4}-\d{2}-\d{2}--[a-z0-9-]+$/.test(BRIEF)) throw new Error('not a brief id: ' + BRIEF);
    const f = [path.join(J.dataRoot, 'research', 'briefs', BRIEF + '.md'), path.join(J.dataRoot, 'legacy', 'research', 'briefs', BRIEF + '.md')].find((x) => fs.existsSync(x));
    if (!f) throw new Error('no verified brief ' + BRIEF + ' in data/research/briefs/ or data/legacy/research/briefs/');
    out('line-live: brief ' + path.relative(J.dataRoot, f).split(path.sep).join('/'));
    const c = orchestrator.createJob({ briefText: fs.readFileSync(f, 'utf8'), by: 'owner (scripts/line-live.mjs, E6 step c)', idempotencyKey: 'line-live:' + BRIEF });
    if (!c.ok) throw new Error('intake refused the brief (no job, nothing spent): ' + c.reasons.join('; '));
    id = c.id;
    await orchestrator.startJob(id);
  } else if (LISTING || QAONLY) {
    // the owner's run modes, live (owner, 18/10/2026): listing-only = LISTER, the price fill and QA LISTING on the design sign-off (QA
    // DESIGN's approval or the owner's set approval), never the package step; qa-only = one QA DESIGN pass on set N. Each within --max-usd
    id = LISTING || QAONLY; const j = store.getJob(id); if (!j) throw new Error('no such job: ' + id);
    const r = LISTING ? orchestrator.listingOnly(id, { maxUsd: Number(MAX_USD), expectedVersion: j.version, by: 'owner (scripts/line-live.mjs --listing-only)' })
      : orchestrator.qaOnly(id, { set: Number(SET), maxUsd: Number(MAX_USD), expectedVersion: j.version, by: 'owner (scripts/line-live.mjs --qa-only)' });
    out('line-live: ' + (LISTING ? 'listing-only' : 'qa-only on set-v' + SET) + ', owner cap USD ' + Number(MAX_USD).toFixed(2));
    if (r.run) await r.run;
  } else if (REDRAW) {
    // the redraw-only run of a prepared set (npm run owner -- prepare-redraw ...): the named files, then prep, QA DESIGN and the line on
    id = REDRAW; const j = store.getJob(id); if (!j) throw new Error('no such job: ' + id);
    const r = orchestrator.redrawOnly(id, { expectedVersion: j.version, by: 'owner (scripts/line-live.mjs --redraw)' });
    out('line-live: redraw-only set-v' + r.set + ': files ' + r.files.map((k) => String(k).padStart(2, '0')).join(', ') + ' (design loop ' + r.designLoop + ')');
    if (r.run) await r.run;
  } else {
    id = RESUME; const j = store.getJob(id); if (!j) throw new Error('no such job: ' + id);
    if (j.data && j.data.waitingFor) throw new Error('job ' + id + ' still waits for ' + j.data.waitingFor + ': the owner decides first (npm run owner -- style-ref ...)');
    const r = orchestrator.restartJob(id, { expectedVersion: j.version, by: 'owner (scripts/line-live.mjs --resume)' });
    if (r.run) await r.run;
  }
  out(JSON.stringify(report(engine, id, t0), null, 1));
  const job = store.getJob(id);
  const modeFinished = job.state === 'stopped' && /^(listing-only|QA-only) run finished: .*approved/.test(job.reason || '');
  if (!['approval'].includes(job.state) && !(job.state === 'queued' && job.data.waitingFor === 'owner-style-ref') && !modeFinished) process.exitCode = 1;
} catch (e) {
  console.error(log.redact('line-live failed (no rerun): ' + (e.message || e) + (e.status ? ' [status ' + e.status + ']' : '') + (e.requestId ? ' [request ' + e.requestId + ']' : '')));
  process.exitCode = 1;
} finally { engine.close(); }

// the key-free report of one job (E6 step c item 10)
function report(engine, id, t0) {
  const { store, ledger, cfg, J } = engine, job = store.getJob(id), dir = path.join(J.dataRoot, 'jobs', id);
  const rows = ledger.rowsForJob(id), runs = store.runsOf({ jobId: id, limit: 200 }).reverse(), stepOf = new Map(runs.map((r) => [r.run_id, r.step || r.agent_key]));
  const sum = (xs) => r6(xs.reduce((s, r) => s + r.usd, 0));
  const group = (key) => { const o = {}; for (const r of rows) { const k = key(r); o[k] = r6((o[k] || 0) + r.usd); } return o; };
  const qa = (d) => (fs.existsSync(path.join(dir, d)) ? fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.json')).sort().map((f) => { const x = rj(path.join(dir, d, f)) || {}; return { file: d + '/' + f, stage: x.stage, set: x.set, verdict: x.verdict, checks: x.checks, reasons: x.reasons }; }) : []);
  const images = rows.filter((r) => r.kind === 'image'), attempts = (job.data && job.data.imageAttempts) || {};
  const L = rj(path.join(dir, 'outbox', 'listing.json')), product = (cfg.products || []).find((p) => p.key === job.product_key), of = product ? ownerFloor(product, cfg.station) : null;
  const tl = fs.existsSync(path.join(dir, 'transcript.jsonl')) ? fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const lastReply = (agent) => { const x = tl.filter((l) => l.agent === agent && !l.nudge).pop(); return x ? { stop_reason: x.stop_reason, text: String(x.text || '').slice(0, 600), toolErrors: (x.toolResults || []).filter((r) => r.is_error).map((r) => r.content.slice(0, 300)) } : null; };
  const set = (cfg.station.digital || {}), ai = set.aiDisclosure && set.aiDisclosure.text;
  const listing = L ? { title: L.title, tags: L.tags, priceProposal: L.priceProposal || null, listingPriceEur: L.listingPriceEur, variantPricesEur: L.variantPricesEur, floor: of ? { usd: of.floorUsd, eur: of.floorEur } : null, atOrAboveFloor: of && Array.isArray(L.variantPricesEur) ? L.variantPricesEur.every((v) => v.priceEur >= of.floorEur - 1e-9) : null, aiDisclosureWordForWord: !!(ai && String(L.description || '').includes(ai)), usEnglishProblems: listingSpellingProblems(L, cfg.station), marginEstimate: L.marginEstimate } : null;
  const ogListing = rj(path.join(dir, 'derived', 'listing.originality.json')), n = Number((/set-v(\d+)/.exec((rj(path.join(dir, 'outbox', 'qa-design.json')) || {}).designFile || '') || [])[1]) || null;
  const ogSet = n ? rj(path.join(dir, 'set-v' + n, 'originality.json')) : null;
  const listingScreen = L ? screenText(Object.values(listingFields(L)).join('\n'), cfg.station, { extra: cfg.blocklist || [] }) : null;
  const today = dublinDay(Date.now());
  return {
    job: { id, state: job.state, step: job.step, evidenceLevel: evidenceLevelOf(fs.existsSync(path.join(dir, 'brief.md')) ? fs.readFileSync(path.join(dir, 'brief.md'), 'utf8') : ''), reason: job.reason, loops: job.loops, hops: job.hops, minutes: r6((Date.now() - t0) / 60000), waitingFor: job.data.waitingFor || null },
    stages: store.stagesOf(id).map((s) => ({ step: s.step, pass: s.pass, status: s.status, note: s.reason })),
    runs: runs.map((r) => ({ agent: r.agent_key, step: r.step, pass: r.pass, model: r.model, status: r.status, turns: r.turns, usd: r.usd, endReason: r.end_reason })),
    qa: { file1: qa('qa').filter((x) => /file1-/.test(x.file)), design: qa('qa').filter((x) => !/file1-/.test(x.file)), listing: qa('qa-listing') },
    images: { generated: images.length, withStyleReference: images.filter((r) => /^style reference /.test(r.note || '')).length, failedAttempts: attempts, estimatedRows: images.filter((r) => r.estimated).length },
    cost: { totalUsd: sum(rows), capUsd: JOB_CAP_USD, byStage: group((r) => stepOf.get(r.runId) || r.agentKey || 'none'), byModel: group((r) => r.model), imagesUsd: sum(images), estimatedRows: rows.filter((r) => r.estimated).map((r) => r.entryId) },
    ledgerRows: rows.map((r) => ({ entryId: r.entryId, agent: r.agentKey, kind: r.kind, model: r.model, requestId: r.requestId || null, generationId: r.generationId || null, size: r.size || null, tokens: r.tokens, usd: r.usd, estimated: !!r.estimated, note: r.note || null })),
    ledgerToday: { day: today, usd: ledger.spent.day(today), rows: ledger.rows().filter((r) => dublinDay(r.ts) === today).length },
    listing,
    originality: { set: ogSet ? { result: ogSet.result, hits: (ogSet.hits || []).length } : null, listing: ogListing ? { result: ogListing.result, hits: (ogListing.hits || []).length } : null, listingScreenNow: listingScreen ? { result: listingScreen.result, hits: listingScreen.hits.length } : null },
    where: { job: 'data/jobs/' + id + '/', package: fs.existsSync(path.join(dir, 'package')) ? 'data/jobs/' + id + '/package/' : null, approval: store.getApproval(id) || null, review: job.data.styleRef && job.data.styleRef.awaiting ? 'data/jobs/' + id + '/set-v' + job.data.styleRef.awaiting.set + '/review/' : null },
    lastReplies: ['designer', 'qa-design', 'lister', 'qa-listing', 'rejects-desk'].map((a) => [a, lastReply(a)]).filter(([, v]) => v)
  };
}
