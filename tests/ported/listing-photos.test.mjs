// PORTED from Virtual-workers/station/tests/listing-photos.test.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment), source sha256 4a5d5146c2dfdb16089ead7ff81fd2e6a082119bf27bed52b19e21e53f3fdefe.
//   change: imports point at src/engine/lib (pure layout and in-memory rendering: no file writes, so no data jail is needed)
// Everything else is the source unchanged.
// OWNER exception 2026-10-17: Etsy listing-page photos composited from the approved set's PNGs (lib/listing-photos.mjs), deterministic, no model
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { gridLayout, sceneLayout, closeLayout, inside, trimProp, renderPhoto, HERO, CLOSE, WARM_BG } from '../../src/engine/lib/listing-photos.mjs';

const props = [[1516, 1760], [1205, 1759], [1760, 1429], [1760, 1464], [1243, 1760], [1326, 1759], [1697, 1760], [1260, 1760], [1760, 1603], [1232, 1759], [1516, 1760], [1760, 1360]]
  .map(([w, h], i) => ({ name: String(i + 1).padStart(2, '0') + '.png', w, h }));

test('listing photo layouts: the grid keeps one common scale, 4 x 3, every prop whole on the canvas and inside its cell; scene and close-ups fit inside the margin', () => {
  const g = gridLayout(props, HERO);
  assert.equal(g.length, 12); assert.ok(g.every((r) => inside(r, HERO.width, HERO.height) && r.left >= 150 && r.top >= 150 && r.left + r.width <= 2850 && r.top + r.height <= 2100));
  const s = g.map((r, i) => r.height / props[i].h); assert.ok(Math.max(...s) - Math.min(...s) < 0.002, 'one common scale');
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) { const a = g[i], b = g[j]; assert.ok(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top, 'grid cells do not overlap'); }
  assert.throws(() => gridLayout([...props, props[0]], HERO), /grid holds 12/);
  const sc = sceneLayout(props, [{ name: '01.png', cx: 0, base: 100, h: 900 }, { name: '03.png', cx: 5000, base: 1400, h: 300 }], HERO);
  assert.ok(sc.every((r) => r.left >= 149 && r.top >= 149 && r.left + r.width <= 2851 && r.top + r.height <= 2101), JSON.stringify(sc));
  assert.throws(() => sceneLayout(props, [{ name: 'xx.png', cx: 0, base: 0, h: 1 }], HERO), /not in the set/);
  const c = closeLayout(props[2], CLOSE)[0]; assert.equal(c.width, 1600); assert.ok(inside(c, 2000, 2000) && Math.abs(c.left - (2000 - c.left - c.width)) <= 1);
});

test('listing photo render: trimmed to visible pixels, exact canvas size, identical bytes on a second render, refused when a prop would be cropped', async () => {
  const png = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 60, height: 100, channels: 4, background: { r: 200, g: 120, b: 80, alpha: 1 } } }).png().toBuffer(), left: 70, top: 50 }]).png().toBuffer();
  const t = await trimProp(png); assert.deepEqual([t.w, t.h], [60, 100]);
  const trimmed = { 'a.png': t }, placements = closeLayout({ name: 'a.png', w: t.w, h: t.h }, { width: 400, height: 300 });
  const a = await renderPhoto({ width: 400, height: 300, background: WARM_BG, placements, trimmed }), b = await renderPhoto({ width: 400, height: 300, background: WARM_BG, placements, trimmed });
  assert.ok(a.equals(b)); const m = await sharp(a).metadata(); assert.deepEqual([m.format, m.width, m.height, m.exif, m.icc], ['jpeg', 400, 300, undefined, undefined]);
  await assert.rejects(renderPhoto({ width: 400, height: 300, background: WARM_BG, placements: [{ name: 'a.png', left: 380, top: 10, width: 60, height: 100 }], trimmed }), /would be cropped/);
});
