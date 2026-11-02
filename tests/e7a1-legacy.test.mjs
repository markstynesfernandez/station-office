// e7a1-legacy.test.mjs — E7a.1, owner decision 4 (20/10/2026; DECISIONS.md "E7a"): a job starts only from an indicative brief
// (origin genre-scout or research) or an owner brief. Any other brief, a legacy Etsy-format brief (verified before 19/10/2026, or
// carrying Etsy figures the owner recorded from a browser), is refused at Start line and at intake with the owner's reason, word
// for word; the Start line picker lists it as "legacy (refused)" and does not let it start; the line routine never picks it.
// Mock provider only, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { briefOptions } from '../src/web/ui/taskpanel.js';
import { isLegacyBrief, isIndicativeBrief, LEGACY_BRIEF_REASON } from '../src/engine/lib/scout-brief.mjs';
import { isOwnerBrief } from '../src/engine/lib/owner-brief.mjs';
import { createScoutScript, researchBrief, researchQuery } from '../fixtures/engine/scout-script.mjs';

const FIX = path.join(APP_ROOT, 'fixtures', 'engine');
const DAY = dublinDay();
const REASON = 'legacy Etsy-format brief: no Etsy data in the station until Etsy authorises it in writing (owner, 20/10/2026); restate it as an owner brief';
// the ported Etsy format as verified before 19/10/2026 (the dry run's old fixture), and the same with Etsy figures the owner recorded
const LEGACY = fs.readFileSync(path.join(FIX, 'legacy-etsy-brief.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\{\{TODAY\}\}/g, DAY);
const OWNER_RECORDED = LEGACY.replace(/2026-10-16--dry-run-mushroom-stickers/g, '2026-10-16--owner-recorded-mushroom-stickers').replace('search phrase: mushroom sticker png', 'recorded by owner, ' + DAY + '\nsearch phrase: mushroom sticker png');
const OWNER = fs.readFileSync(path.join(FIX, 'owner-brief.md'), 'utf8').replace(/\r\n/g, '\n');
const LOFI = { slug: 'lofi-study', genre: 'lofi study', segment: 'students who stream study sessions', props: 'a desk lamp, a stack of notebooks, a mug of tea, a cassette player, a potted fern and a sleeping cat bed', palette: 'dusty rose, cream and teal', price: 9 };
const research = (e, ...p) => path.join(e.J.dataRoot, 'research', ...p);
const idle = async (e) => { for (let i = 0; i < 400 && e.orchestrator.active().length; i++) await new Promise((r) => setTimeout(r, 25)); };

// the scout and the research line on the mock: DEMAND-RESEARCHER searches once, then writes the indicative LOFI research brief
function boot(t) {
  const r = tempRoot('e7a1'), base = createScoutScript();
  const script = (ctx, params) => {
    if (ctx.agentKey === 'demand-researcher') {
      const n = params.messages.filter((m) => m.role === 'assistant').length;
      return n === 0 ? { content: [{ type: 'tool_use', id: 'tu_s', name: 'web_search', input: { query: researchQuery(LOFI) } }] }
        : n === 1 ? { content: [{ type: 'tool_use', id: 'tu_d', name: 'fs_write', input: { path: 'drafts/' + DAY + '/' + DAY + '--genre-lofi-study-desk-props.md', content: researchBrief(DAY, LOFI) } }] } : { content: [{ type: 'text', text: 'done' }] };
    }
    return base(ctx, params);
  };
  script.web = base.web;
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, startScheduler: false });
  t.after(async () => { await idle(e); try { e.close(); } catch (_) {} r.cleanup(); });
  return { e, r };
}

test('decision 4: the reason word for word; a legacy brief is neither indicative nor an owner brief', () => {
  assert.equal(LEGACY_BRIEF_REASON, REASON);
  for (const b of [LEGACY, OWNER_RECORDED]) { assert.equal(isLegacyBrief(b), true); assert.equal(isIndicativeBrief(b), false); assert.equal(isOwnerBrief(b), false); }
  assert.match(OWNER_RECORDED, /^recorded by owner, \d{4}-\d{2}-\d{2}$/m);
  assert.equal(isLegacyBrief(OWNER), false);
  assert.equal(isLegacyBrief(researchBrief(DAY, LOFI)), false);
});

test('decision 4: a legacy brief is refused at intake and at Start line with that reason; no job, nothing in jobs/; the picker shows it as "legacy (refused)"; the line routine skips it', async (t) => {
  const { e } = boot(t);
  for (const b of [LEGACY, OWNER_RECORDED]) {
    const id = /^id: (\S+)$/m.exec(b)[1];
    // intake (research-to-design: every brief becomes a job through createJob)
    assert.deepEqual(e.orchestrator.createJob({ briefText: b, by: 'test' }), { ok: false, id, reasons: [REASON] });
    // Start line on brief
    e.J.put(research(e, 'briefs', id + '.md'), b);
    assert.throws(() => e.orchestrator.startBrief(id + '.md', { by: 'test' }), (err) => err.code === 'INTAKE' && err.message === 'the brief was refused at intake: ' + REASON);
    assert.ok(!e.store.getJob(id), 'no job for ' + id);
    assert.ok(!fs.existsSync(path.join(e.J.dataRoot, 'jobs', id)), 'nothing written for ' + id);
  }
  // the brief files are left as they were
  assert.equal(fs.readFileSync(research(e, 'briefs', '2026-10-16--dry-run-mushroom-stickers.md'), 'utf8'), LEGACY);
  // the picker: listed, disabled, labelled; no brief can start, so the Start button stays disabled (taskpanel renderBox)
  const snap = buildEngineSnapshot(e).briefs;
  assert.deepEqual(snap.map((b) => [b.id, b.legacy]), [['2026-10-16--dry-run-mushroom-stickers', true], ['2026-10-16--owner-recorded-mushroom-stickers', true]]);
  const opts = briefOptions(snap);
  assert.deepEqual(opts.startable, []);
  assert.equal((opts.html.match(/<option value="[^"]+" disabled>legacy \(refused\) · /g) || []).length, 2);
  assert.match(opts.html, /<option value="2026-10-16--dry-run-mushroom-stickers\.md" disabled>legacy \(refused\) · Cozy woodland mushroom stickers for planners and journals \(FIXTURE brief\)<\/option>/);
  // the line routine picks the oldest verified brief: never a legacy one
  assert.deepEqual(await e.runRoutine({ id: 'rt-test', target: 'line:room1-digital' }), { skipped: 'no verified brief is waiting' });
  assert.equal(e.store.listJobs({}).filter((j) => j.kind === 'line').length, 0);
});

test('decision 4: indicative briefs (origin genre-scout and research) and owner briefs still start at Start line; the picker lists them first, enabled', async (t) => {
  const { e } = boot(t);
  const scout = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test' }); await e.orchestrator.startJob(scout.id);
  assert.equal(e.store.getJob(scout.id).state, 'research-done', e.store.getJob(scout.id).reason);
  const rs = e.orchestrator.createResearchJob({ by: 'test' }); await e.orchestrator.startJob(rs.id);
  assert.equal(e.store.getJob(rs.id).state, 'research-done', e.store.getJob(rs.id).reason);
  const saved = e.orchestrator.saveOwnerBrief({ text: OWNER, by: 'test' }); assert.equal(saved.ok, true, (saved.reasons || []).join('; '));
  e.J.put(research(e, 'briefs', '2026-10-16--dry-run-mushroom-stickers.md'), LEGACY);
  const files = { 'genre-scout': DAY + '--genre-cozy-farming-desk-props.md', research: DAY + '--genre-lofi-study-desk-props.md', owner: '2026-10-17--cozy-autumn-desk-props.md' };
  // the picker before any start: the three startable briefs (among the scout's others), the legacy one last and disabled
  const opts = briefOptions(buildEngineSnapshot(e).briefs);
  for (const f of Object.values(files)) { assert.ok(opts.startable.some((b) => b.file === f), f); assert.match(opts.html, new RegExp('<option value="' + f.replace(/\./g, '\\.') + '">')); }
  assert.match(opts.html, /<option value="2026-10-16--dry-run-mushroom-stickers\.md" disabled>legacy \(refused\) · [^<]*<\/option>$/);
  assert.match(opts.html, /<option value="2026-10-17--cozy-autumn-desk-props\.md">OWNER · /);
  for (const [origin, f] of Object.entries(files)) {
    const text = fs.readFileSync(research(e, 'briefs', f), 'utf8');
    assert.match(text, new RegExp('^origin: ' + origin + '$', 'm'));
    const { jobId } = e.orchestrator.startBrief(f, { by: 'test' });
    assert.equal(jobId, f.replace(/\.md$/, ''));
    const job = e.store.getJob(jobId);
    assert.ok(job && job.kind === 'line', origin + ': a line job was created');
    assert.match(e.store.stagesOf(jobId)[0].reason, origin === 'owner' ? /^owner brief checked/ : /^brief checked/);
    await idle(e);
  }
});
