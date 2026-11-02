// dry-run-scout.mjs — the genre-trend scouting dry run (DECISIONS.md "Genre-trend scouting"): the engine on the MOCK
// provider ($0, no keys read) on its own data root (office-agents/dry-run/scout/), with the FIXTURE scouting data
// (fixtures/engine/scout-script.mjs: invented game titles, FIXTURE pages). One genre-scout batch: TREND-SCOUT makes 12
// web calls (a 13th is refused by the engine), writes its internal notes and five drafts — four genre briefs and one
// that deliberately names a scouted game. The scout-notes step fills the scouting blocklist and blocks the bad brief;
// EVIDENCE-CHECKER verifies the four; brief-check files them. Then the bad brief is offered to intake as well (refused).
// Writes dry-run/scout/REPORT.md. Re-running starts from an empty root (the old one is kept as dry-run/scout-previous/).
//   npm run dry-run:scout
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { readBlocklist } from '../src/engine/lib/scouting.mjs';
import { createScoutScript, BAD_BRIEF_GAME } from '../fixtures/engine/scout-script.mjs';

const DRY = path.join(APP_ROOT, 'dry-run');
const field = (t, k) => (new RegExp('^' + k + ':[ \\t]*(.+)$', 'm').exec(t) || [])[1] || '';

export async function dryRunScout({ quiet = false } = {}) {
  if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('the dry run uses the mock provider only');
  const P = createJail({ dataRoot: DRY, extraRoots: [] });
  if (fs.existsSync(path.join(DRY, 'scout-previous'))) P.remove(path.join(DRY, 'scout-previous'));
  if (fs.existsSync(path.join(DRY, 'scout'))) P.move(path.join(DRY, 'scout'), path.join(DRY, 'scout-previous'));
  const J = createJail({ dataRoot: path.join(DRY, 'scout') });
  const log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'dry-run-scout', jail: J, quiet });
  const tools = [];
  const base = createScoutScript({ bad: true });
  const script = (ctx, params) => { const last = params.messages[params.messages.length - 1]; if (ctx.agentKey === 'trend-scout' && Array.isArray(last.content)) tools.push(...last.content.filter((b) => b.type === 'tool_result')); return base(ctx, params); };
  script.web = base.web;
  const engine = openScriptEngine({ archiveSandbox: true, J, log, script, purpose: 'dry-run:scout', startsJobs: true });
  try {
    if (engine.providers.mode !== 'mock') throw new Error('not on the mock provider');
    const rdir = path.join(J.dataRoot, 'research');
    const c = engine.orchestrator.createResearchJob({ line: 'genre-scout', by: 'dry run (as the owner\'s Run click)' });
    await engine.orchestrator.startJob(c.id);
    const job = engine.store.getJob(c.id), day = job.data.day;
    const briefs = fs.readdirSync(path.join(rdir, 'briefs')).sort().map((f) => { const t = fs.readFileSync(path.join(rdir, 'briefs', f), 'utf8'); return { file: f, status: field(t, 'status'), segment: field(t, 'audience_segment'), niche: (/^# Niche\s*\n(.+)$/m.exec(t) || [])[1] }; });
    const bdir = path.join(rdir, 'scouting', 'blocked', day);
    const rejected = fs.existsSync(bdir) ? fs.readdirSync(bdir).sort().map((f) => ({ file: f, reasons: fs.readFileSync(path.join(bdir, f), 'utf8').split('\n').filter((l) => /^- originality/.test(l)).map((l) => l.slice(2)) })) : [];
    // the bad brief offered to intake as if verified (the gate a hand-edited brief would meet)
    const badFile = rejected[0] && rejected[0].file;
    const badText = badFile ? fs.readFileSync(path.join(bdir, badFile), 'utf8').replace(/^status: candidate$/m, 'status: verified').replace(/\n## Station scouting screen[\s\S]*$/, '\n') : '';
    const intake = badFile ? engine.orchestrator.createJob({ briefText: badText, by: 'dry run (intake check)' }) : null;
    const bl = readBlocklist(rdir);
    const webRows = engine.ledger.rows().filter((r) => r.agentKey === 'trend-scout' && r.kind === 'web');
    const refused = tools.find((x) => x.tool_use_id === 'tu_x');
    const result = {
      dataRoot: J.dataRoot, job: { id: job.id, state: job.state, reason: job.reason }, day,
      briefs, blocked: rejected, intakeOfBadBrief: intake && { ok: intake.ok, reasons: intake.reasons },
      blocklist: { file: 'research/scouting/blocklist.json', names: bl.terms.length, games: bl.terms.filter((t) => t.kind === 'game').length },
      notes: 'research/scouting/' + day + '/' + job.id + '/notes.json (internal; TREND-SCOUT only; one file per job)',
      web: { calls: webRows.length, thirteenth: refused ? (refused.is_error ? 'refused: ' + refused.content : 'NOT refused') : 'not attempted' },
      ledger: { rows: engine.ledger.totals.rows, usd: engine.ledger.totals.usd, allMock: engine.ledger.rows().every((r) => r.provider === 'mock') }, textCalls: engine.providers.text.calls
    };
    const md = ['# Genre-trend scouting dry run (mock provider, FIXTURE data)', '', 'Run ' + new Date().toISOString() + ' · job `' + job.id + '` · ' + job.state + ' · ledger ' + result.ledger.rows + ' rows, USD ' + result.ledger.usd.toFixed(2) + (result.ledger.allMock ? ' (all mock)' : ''), '',
      '## Genre briefs verified (research/briefs/)', '', '| file | status | audience segment |', '|---|---|---|', ...briefs.map((b) => '| ' + b.file + ' | ' + b.status + ' | ' + b.segment + ' |'), '',
      '## Blocked (research/scouting/blocked/' + day + '/: it names a game, so it stays in the scout-only folder)', '', ...rejected.flatMap((r) => ['- `' + r.file + '` — the deliberately bad brief (it names the FIXTURE game "' + BAD_BRIEF_GAME + '"):', ...r.reasons.map((x) => '  - ' + x)]), '',
      '- The same brief offered to intake as verified: ' + (intake ? (intake.ok ? 'ACCEPTED (wrong)' : 'refused — ' + intake.reasons.filter((x) => /scouted/.test(x)).join('; ')) : 'n/a'), '',
      '## Scouting blocklist', '', result.blocklist.names + ' names (' + result.blocklist.games + ' games, plus studios and related names) in `' + result.blocklist.file + '`, added automatically from the notes. Internal: the list is not repeated here.', '',
      '## Web-call cap', '', 'TREND-SCOUT: ' + result.web.calls + ' web calls reached the ledger; the 13th: ' + result.web.thirteenth, '', 'Scout-notes step: ' + (engine.store.getJob(job.id).data.scouting || {}).drafts.join(' · '), ''].join('\n');
    J.put(path.join(J.dataRoot, 'REPORT.md'), md);
    if (!quiet) console.log(md);
    return result;
  } finally { engine.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dryRunScout().then((r) => { console.log(JSON.stringify(r, null, 2)); if (r.briefs.length !== 4 || r.blocked.length !== 1 || (r.intakeOfBadBrief && r.intakeOfBadBrief.ok) || r.web.calls !== 12) { console.error('dry run did not show the expected result'); process.exitCode = 1; } }).catch((e) => { console.error('dry run failed:', e.stack || e.message); process.exitCode = 1; });
}
