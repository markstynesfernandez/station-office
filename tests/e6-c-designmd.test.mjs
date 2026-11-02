// e6-c-designmd.test.mjs — design.md comes from the CURRENT spec and brief (owner, 18/10/2026; DECISIONS.md "E6 step c: design.md from
// the current spec and brief"). The bug: a note set-v1's DESIGNER wrote under the old spec ("files 11-12 are colour variants") was carried
// into set-v2 by DESIGNER and into set-v4 by the redraw's copy of design.md, and QA DESIGN read it as the spec. Station code, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { stationPlan, withStationPlan, keptSections, STATION_PLAN } from '../src/engine/lib/design-plan.mjs';

const CFG = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts') });
const PACK = CFG.products.find((p) => p.key === 'pngtuber-prop-pack');
const OWNER = fs.readFileSync(path.join(APP_ROOT, 'fixtures', 'engine', 'owner-brief.md'), 'utf8').replace(/\r\n/g, '\n');
// set-v4's design.md as the live run left it (abridged): DESIGNER's notes carry the stale spec note from set-v1
const STALE = ['# Design plan, set-v4 (set-v2 plan, with files 02, 04, 07, 08, 09, 10 redrawn in design loop 2)', '', 'Notes:',
  '- Spec mismatch (flagged in set-v1): products.json files 11-12 are "colour variant of props 1-10", the brief lists ghost plush and desk lamp. Plan follows the brief.', '',
  '## Plan', '1. 01-small-pumpkin: owner-approved style reference.', '', '## Prompts', '### 03-cider-mug (unchanged)', 'A chunky ceramic mug of hot spiced cider.', 'Analysis: cream mug, no text.', '',
  '### 11-ghost-plush (unchanged)', 'A small original round ghost plush.', 'Analysis: no text.', '', '## Originality self-check', '- original'].join('\n');

test('the station plan is the current spec\'s format and the brief\'s subjects, file by file; never a colour variant', () => {
  const p = stationPlan({ briefText: OWNER, product: PACK });
  assert.ok(p.startsWith(STATION_PLAN + ' (written by the station from the current products.json and brief.md'));
  assert.match(p, /gives the FORMAT only: 12 file\(s\), PNG 2000x2000, transparent, delivered as one zip\. Each file's SUBJECT comes from the brief\./);
  assert.match(p, /^- 01: A small pumpkin\. \(png 2000x2000\)$/m);
  assert.match(p, /^- 04: A beeswax candle with a lit flame; the warmth is painted into the flame and wax, with no glow, halo or light around it\. \(png 2000x2000\)$/m);
  assert.match(p, /^- 11: A small original ghost plush/m); assert.match(p, /^- 12: A cozy desk lamp\. \(png 2000x2000\)$/m);
  assert.equal((p.match(/^- \d\d: /gm) || []).length, 12);
  assert.doesNotMatch(p, /colour variant/i);
  // a brief that does not number the spec's files: subjects from its Design direction, still the format from the spec
  assert.match(stationPlan({ briefText: '# Niche\nx\n\n## Design direction\nprose only\n', product: PACK }), /^- Subjects: as the brief's Design direction describes them \(it does not number 12 files\)\.$/m);
});

test('withStationPlan writes the current plan under the title, replaces an older one, and is idempotent; keptSections carries prompts, never notes', () => {
  const plan = stationPlan({ briefText: OWNER, product: PACK }), a = withStationPlan(STALE, plan);
  assert.ok(a.startsWith('# Design plan, set-v4') && a.indexOf(STATION_PLAN) < a.indexOf('Notes:'), 'the plan comes first, under the title');
  assert.equal(withStationPlan(a, plan), a, 'idempotent');
  const old = withStationPlan(STALE, STATION_PLAN + ' (old)\n- 11: colour variant 1 of 2\n');
  const b = withStationPlan(old, plan);
  assert.equal(b.split(STATION_PLAN).length - 1, 1, 'one station plan'); assert.doesNotMatch(b, /colour variant 1 of 2/);
  assert.match(b, /### 03-cider-mug \(unchanged\)\nA chunky ceramic mug/, 'DESIGNER\'s sections stay');
  assert.ok(withStationPlan('no title here\n', plan).startsWith(STATION_PLAN));
  const kept = keptSections(STALE, [3, 11]);
  assert.deepEqual(kept, ['### 03-cider-mug (unchanged)\nA chunky ceramic mug of hot spiced cider.\nAnalysis: cream mug, no text.', '### 11-ghost-plush (unchanged)\nA small original round ghost plush.\nAnalysis: no text.']);
  assert.doesNotMatch(kept.join('\n'), /colour variant|Spec mismatch|self-check/);
  assert.deepEqual(keptSections(STALE, [5]), []);
});

test('the orchestrator: the redraw writes design.md from the plan and the kept prompts; prep rewrites the plan; DESIGNER gets it at every run start', () => {
  const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'engine', 'orchestrator.mjs'), 'utf8');
  assert.doesNotMatch(src, /J\.copy\(path\.join\(jobDir\(id\), 'set-v' \+ src, 'design\.md'\)/, 'the redraw no longer copies the earlier design.md');
  assert.match(src, /const carried = keptSections\(oldMd, \[\.\.\.keep, \.\.\.cleanN\]\);/);
  assert.match(src, /now = withStationPlan\(was, stationPlan\(\{ briefText: readBrief\(job\.id\), product \}\)\); if \(now !== was\) J\.put\(dm, now\);/);
  assert.match(src, /if \(product\) input \+= designPlanNote\(job, product\);/);
  assert.match(src, /Carry no notes from an earlier set\\'s design\.md, only each file\\'s own prompt and analysis/);
});
