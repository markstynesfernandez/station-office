// people-looks.test.mjs — E5 item 0c: no person's shirt is in the skin-tone range, and the shirts are distinct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKIN, SHIRTS, isSkinTone, colourDistance, shirtColours, MIN_SHIRT_DISTANCE } from '../src/web/scene/looks.js';
import { APP_ROOT } from '../src/engine/store/jail.mjs';

test('every skin tone is in the skin range; every spare shirt colour is outside it and away from every skin tone', () => {
  for (const s of SKIN) assert.ok(isSkinTone(s), s + ' should count as a skin tone');
  for (const c of SHIRTS) {
    assert.ok(!isSkinTone(c), c + ' is in the skin range');
    for (const s of SKIN) assert.ok(colourDistance(c, s) >= MIN_SHIRT_DISTANCE, c + ' is too close to skin ' + s);
  }
  // the agent colour that prompted the fix (a tan close to skin #d29e78) counts as skin; clear colours do not
  assert.ok(isSkinTone('#d99a5a'));
  for (const c of ['#7bc88a', '#a888c0', '#6fb3bf', '#ffd34a', '#4f7cc4']) assert.ok(!isSkinTone(c), c);
});

test('the shirts of the configured agents are off the skin range and pairwise distinct', () => {
  const dir = path.join(APP_ROOT, 'config', 'agents');
  // R1: the agents the office draws (a not-hired agent has no desk until its phase); R2: nor one hired before its floor is drawn (R7)
  const rooms = new Set(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'office.json'), 'utf8')).departments.map((d) => d.key));
  const agents = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((a) => a.status !== 'not-hired' && rooms.has(String(a.department).toLowerCase())).map((a) => ({ id: a.key, color: a.color }));
  const sets = [agents, [...agents].reverse(), [...agents, ...agents.map((a) => ({ id: a.id + '-2', color: a.color }))].slice(0, 10)];
  for (const list of sets) {
    const shirts = shirtColours(list), vals = list.map((a) => shirts[a.id]);
    for (const [i, v] of vals.entries()) {
      assert.ok(!isSkinTone(v), list[i].id + ' shirt ' + v + ' is skin-like');
      for (const s of SKIN) assert.ok(colourDistance(v, s) >= MIN_SHIRT_DISTANCE, list[i].id + ' shirt ' + v + ' near skin ' + s);
      for (let k = 0; k < i; k++) assert.ok(colourDistance(v, vals[k]) >= MIN_SHIRT_DISTANCE, list[i].id + ' and ' + list[k].id + ' shirts are too alike (' + v + ', ' + vals[k] + ')');
    }
  }
  // an agent whose colour is clear keeps it
  const s = shirtColours([{ id: 'x', color: '#6fb3bf' }]); assert.equal(s.x, '#6fb3bf');
  const t = shirtColours([{ id: 'y', color: '#d99a5a' }]); assert.notEqual(t.y, '#d99a5a');
});
