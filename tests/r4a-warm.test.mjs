// R4a: the warm Office prototype and the quality tiers. The baked Office uses the warm look (config/warm-office.js) as
// committed, has one rug under its department's whole desk cluster, its window panes and LEDs unlit; the high tier's
// lightmaps sit in high/ outside the default download (<= 10 MB); the tier choice defaults to 'default' whenever the GPU
// is unknown; the default tier draws without post-processing; AgX tone mapping; the readability changes are in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { computeLayout } from '../src/web/scene/layout.js';
import { WARM_UNITS } from '../src/web/scene/bakedlook.js';
import { warmLook, TONE } from '../src/web/config/warm-office.js';
import { pickTier, resolveTier, TIER, QUALITY_KEY } from '../src/web/scene/quality.js';
import { ASSET_DIR, BUDGET_BYTES, UNIT_ATLAS, HIGH_DIR, sizesOf, defaultBytes, stationDepartments } from '../scripts/build-office.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'manifest.json'), 'utf8'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('the Office is baked with the committed warm look; only the warm units use it', () => {
  assert.deepEqual(WARM_UNITS, ['office']);
  assert.deepEqual(manifest.look.warm, warmLook());
  const mats = manifest.units.office.materials;
  for (const m of ['tile', 'lightwood', 'wall_warm', 'cap_warm', 'rug_warm', 'fabric_warm', 'window', 'led']) assert.ok(mats.includes(m), 'office material ' + m);
  for (const u of ['research', 'design', 'atrium']) assert.ok(!manifest.units[u].materials.some((m) => /warm|tile|lightwood|window/.test(m)), u + ' keeps its R3b look');
  for (const t of ['tile', 'lightwood', 'plaster']) assert.ok(fs.existsSync(path.join(ASSET_DIR, 'textures', t + '.jpg')), t + '.jpg');
});

test('one dark charcoal rug per department: the Office rug covers its whole desk cluster (both rows)', () => {
  const g = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'office.gltf'), 'utf8'));
  const ri = g.materials.findIndex((m) => m.name === 'rug_warm');
  const prims = g.meshes.flatMap((m) => m.primitives).filter((p) => p.material === ri);
  assert.equal(prims.length, 1, 'one rug field in the room mesh');
  const a = g.accessors[prims[0].attributes.POSITION];
  const L = computeLayout(stationDepartments(), []), r = L.rooms.find((x) => x.key === 'office');
  const xs = r.desks.map((d) => d.x - r.x0), zs = r.desks.map((d) => d.z - r.z0);
  assert.ok(new Set(zs).size >= 2, 'the Office has two desk rows');
  assert.ok(a.min[0] < Math.min(...xs) - 1 && a.max[0] > Math.max(...xs) + 1, 'the rug spans every desk column');
  assert.ok(a.min[2] < Math.min(...zs) - 0.5 && a.max[2] > Math.max(...zs) + 1, 'the rug spans every desk row');
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
  for (const t of ['day', 'evening']) assert.ok(lum(manifest.look.warm.themed[t].rug_warm) < 0.25, 'charcoal rug ' + t);
});

test('quality tiers: the high-tier lightmaps live in high/, twice the default atlas, outside the 10 MB default download', () => {
  const u = manifest.units.office, ua = UNIT_ATLAS.office;
  assert.equal(u.atlas.size, ua.size); assert.equal(u.high.size, ua.high); assert.equal(ua.high, ua.size * 2);
  for (const m of ['day', 'evening']) { assert.ok(u.high[m].file.startsWith(HIGH_DIR + '/')); assert.ok(fs.existsSync(path.join(ASSET_DIR, u.high[m].file)), u.high[m].file); }
  const s = sizesOf(ASSET_DIR, { compress: false });
  assert.ok(defaultBytes(s) <= BUDGET_BYTES, 'default tier ' + defaultBytes(s));
  assert.ok(s.files.some((f) => f.file.startsWith(HIGH_DIR + '/')) && defaultBytes(s) < s.total.bytes, 'the high set is not in the default count');
  const baked = read('src', 'web', 'scene', 'baked.js');
  assert.match(baked, /if \(tier === 'high'\) for \(const u of units\) wantHigh\(u, current\)/, 'high-tier maps load only when the high tier is on');
});

test('the tier choice: high only for a recognised discrete GPU; default whenever unsure; a manual choice wins', () => {
  const nv = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Laptop GPU (0x00002D59) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const intel = 'ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  assert.equal(pickTier({ renderer: nv, maxTextureSize: 16384 }).tier, 'high');
  assert.equal(pickTier({ renderer: 'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', maxTextureSize: 16384 }).tier, 'high');
  for (const r of [intel, 'AMD Radeon(TM) Graphics', 'Mali-G78', 'Adreno (TM) 740', 'Apple GPU', 'Google SwiftShader', 'webgl (renderer hidden)', '', null]) assert.equal(pickTier({ renderer: r, maxTextureSize: 16384 }).tier, 'default', String(r));
  assert.equal(pickTier({ renderer: nv, maxTextureSize: 4096 }).tier, 'default', 'too small a texture limit for the high lightmaps');
  assert.equal(pickTier({ renderer: nv, maxTextureSize: 16384, mobile: true }).tier, 'default');
  assert.equal(pickTier().tier, 'default');
  assert.deepEqual(resolveTier('high', { renderer: intel }), { tier: 'high', reason: 'chosen', auto: false });
  assert.equal(resolveTier('default', { renderer: nv, maxTextureSize: 16384 }).tier, 'default');
  assert.equal(resolveTier('auto', { renderer: intel }).tier, 'default');
  assert.deepEqual(TIER.default, { post: false, msaa: 0, ao: false, bloom: false, maxDpr: 1.5 });
  assert.ok(TIER.high.post && TIER.high.msaa > 0 && TIER.high.bloom);
});

test('the page: default tier without post-processing, AgX, the Quality control remembered, ?quality= for one page', () => {
  const office = read('src', 'web', 'scene', 'office.js'), main = read('src', 'web', 'main.js'), html = read('src', 'web', 'index.html');
  assert.match(office, /if \(!tierCfg\.post\) return;/, 'no composer in the default tier');
  assert.match(office, /if \(composer\) composer\.render\(\); else renderer\.render\(scene, camera\);/);
  assert.match(office, /THREE\.AgXToneMapping/); assert.equal(TONE.mapping, 'agx'); assert.ok(THREE.AgXToneMapping, 'three 0.186 has AgX');
  for (const t of ['light', 'dark']) assert.ok(TONE.exposure[t] > 0.8 && TONE.exposure[t] < 2, 'exposure ' + t);
  assert.match(html, /<select id="quality"[^>]*>.*value="auto".*value="default".*value="high"/);
  assert.equal(QUALITY_KEY, 'office-quality');
  assert.match(main, /store\.set\(QUALITY_KEY, qualityChoice\)/); assert.match(main, /quality: qualityChoice/);
  assert.match(main, /if \(!qualityParam\) store\.set/, '?quality= does not overwrite the remembered choice');
});

test('readability: a dark ring under every status light; the phone layout gives the stage the full width', () => {
  const office = read('src', 'web', 'scene', 'office.js'), css = read('src', 'web', 'styles.css');
  assert.match(office, /lightBase = makeInst\('lightBase', G\.lightBase, M\.lightBase, n/);
  assert.match(office, /setInst\(lightBase, i, x \+ 0\.9, onTop, z \+ 0\.34\)/, 'the ring sits under the status light');
  const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
  assert.ok(phone.length > 20, 'a phone media query');
  assert.match(phone, /#app \{ grid-template-columns: minmax\(0, 1fr\);/);
});
