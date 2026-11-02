// e6-c-spec.test.mjs — the owner decision of 18/10/2026 (DECISIONS.md "E6 step c: product spec defines format, brief defines
// files"): for pngtuber-prop-pack, products.json defines the format only (12 transparent PNGs, sizes, naming, alpha, packaging); the
// file list and subjects come from the brief. Station code and prompt text only, no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { briefFileList, briefFileProblems } from '../src/engine/lib/brief-files.mjs';
import { buildAgentPrompt } from '../src/engine/prompts.mjs';

const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
const CFG = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const PACK = CFG.products.find((p) => p.key === 'pngtuber-prop-pack');
const OWNER = fs.readFileSync(path.join(APP_ROOT, 'fixtures', 'engine', 'owner-brief.md'), 'utf8').replace(/\r\n/g, '\n');
// the file names of the owner brief's set as DESIGNER drew it (set-v2 of 2026-10-17--cozy-autumn-desk-props)
const SET = ['01-small-pumpkin', '02-book-stack', '03-cider-mug', '04-beeswax-candle', '05-maple-leaf-scatter', '06-knitted-throw', '07-brass-lantern', '08-cinnamon-jar', '09-acorn-pinecone', '10-teapot', '11-ghost-plush', '12-desk-lamp'].map((n) => n + '.png');

test('the product spec is format only: a brief with 12 distinct props passes; no file is a "colour variant" in products.json', () => {
  assert.equal(PACK.deliverables.files.length, 12);
  for (const [i, f] of PACK.deliverables.files.entries()) {
    assert.deepEqual([f.format, f.widthPx, f.heightPx], ['png', 2000, 2000]);
    assert.match(f.purpose, new RegExp('its subject is the brief\'s item ' + (i + 1) + '$'));
  }
  assert.doesNotMatch(JSON.stringify(PACK), /colour variant|second colourway/i);
  assert.equal(PACK.transparent, true); assert.deepEqual(PACK.deliverables.package, { kind: 'zip', preview: true });
  assert.equal(briefFileList(OWNER).length, 12);
  assert.deepEqual(briefFileProblems(OWNER, PACK, SET), { checked: true, problems: [], note: 'all 12 files match the brief\'s file list' });
});

test('a set that does not match its brief\'s list fails: a colour variant in place of a brief item, a missing file, a wrong subject', () => {
  const variant = SET.map((n) => (n.startsWith('11-') ? '11-cider-mug-colour-variant.png' : n.startsWith('12-') ? '12-candle-colour-variant.png' : n));
  const v = briefFileProblems(OWNER, PACK, variant);
  assert.equal(v.checked, true); assert.equal(v.problems.length, 2);
  assert.match(v.problems[0], /^file 11-cider-mug-colour-variant\.png does not match the brief's item 11: "A small original ghost plush/);
  assert.match(v.problems[1], /^file 12-candle-colour-variant\.png does not match the brief's item 12: "A cozy desk lamp\."/);
  assert.match(briefFileProblems(OWNER, PACK, SET.filter((n) => !n.startsWith('07-'))).problems.join(' '), /^file 07 is missing \(the brief's item 7: "A brass lantern\."\)/);
  assert.match(briefFileProblems(OWNER, PACK, SET.map((n) => (n.startsWith('05-') ? '05-pine-wreath.png' : n))).problems.join(' '), /05-pine-wreath\.png does not match the brief's item 5: "A maple leaf scatter\."/);
  // plural and singular match (books / book-stack, leaves / leaf)
  assert.deepEqual(briefFileProblems(OWNER.replace('5. A maple leaf scatter.', '5. Maple leaves.'), PACK, SET).problems, []);
  // a brief that does not number as many files as the spec has is not checked by the station (DESK-PROPS-01: 10 props + 2 variants in prose)
  const desk = '# Niche\nDesk props\n\n## Design direction\nThe 10 props:\n' + [...Array(10).keys()].map((i) => (i + 1) + '. Prop ' + (i + 1) + '.').join('\n') + '\n\nThe 2 colour variants: the mug and the cushion.\n';
  const d = briefFileProblems(desk, PACK, []);
  assert.equal(d.checked, false); assert.match(d.note, /the brief lists 10 files, the product spec has 12: subjects not checked by the station/);
  assert.equal(briefFileProblems('# Niche\nx\n\n## Design direction\nno list\n', PACK, SET).checked, false);
});

test('the check fails closed at prep and before a QA-only run; DESIGNER and QA-DESIGN take subjects from the brief, format from the spec', () => {
  const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'engine', 'orchestrator.mjs'), 'utf8');
  assert.match(src, /const bf = briefFilesCheck\(job\.id, n, product\); filesNote = bf\.note; if \(bf\.problems\.length\) reason = 'the set does not match the brief\\'s file list: '/);
  assert.match(src, /if \(bf\.problems\.length\) throw new Error\('QA-only run refused: the set does not match the brief\\'s file list: '/);
  const qa = buildAgentPrompt(CFG.agents['qa-design'], { promptsDir: PROMPTS, budgets: CFG.station.promptBudgetChars });
  assert.ok(qa.chars <= 12000, 'qa-design is ' + qa.chars + ' chars');
  assert.match(qa.text, /complete: every file the brief lists is there, by subject \(the spec sets only the format\)/);
  assert.match(qa.text, /matchesSpec: `deliverables\.json` matches the spec's format exactly \(count, format, pixel size per file; never subjects\)/);
  assert.doesNotMatch(qa.text, /every file the product spec lists is there/);
  const de = buildAgentPrompt(CFG.agents.designer, { promptsDir: PROMPTS }).text;
  assert.match(de, /Its `deliverables\.files` list is the exact format: how many files, each one's format and pixel size\. Each file's subject comes from the brief's file list/);
});
