// R3a, R3b: the baked areas (the Research, Design and Office rooms, the lounge and the atrium) match the live floor plan
// and the page's look, stay inside the office's 10 MB asset budget, share their textures, keep one lightmap atlas per
// bake unit (a room, or the atrium with the lounge) at one texel density, and carry what the page needs (a lightmap UV
// set, the unlit LED material, both atlases per unit). The baked lounge's cushions are where the walkers sit. The page
// draws the baked areas by default and falls back to the procedural one, one area at a time, when an area's spec no
// longer matches (office.js); these tests catch a layout, palette or atlas change that would make the committed bake
// stale, and check a one-room build keeps every other unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLayout, bakedRoomSpec } from '../src/web/scene/layout.js';
import { BAKED_ROOMS, BAKE_UNITS, bakedLook } from '../src/web/scene/bakedlook.js';
import { ASSET_DIR, BUDGET_BYTES, BAKE_LIGHT, DENSITY, UNIT_ATLAS, HIGH_DIR, officeSpecs, stationDepartments, assetJail, sizesOf, defaultBytes, mergeManifest, unitsFor, unitFiles } from '../scripts/build-office.mjs';
import { createOfficeServer } from '../src/server/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'manifest.json'), 'utf8'));
const gltfs = Object.fromEntries(Object.entries(manifest.units).map(([u, x]) => [u, JSON.parse(fs.readFileSync(path.join(ASSET_DIR, x.gltf), 'utf8'))]));
const SERVICES = (n) => Array.from({ length: n }, (_, i) => ({ id: 's' + i }));

test('the committed bake has every area, in its bake unit, and matches the engine office layout (config/agents)', () => {
  assert.equal(manifest.version, 3);
  assert.deepEqual(Object.keys(manifest.rooms), BAKED_ROOMS);
  assert.deepEqual(Object.keys(manifest.units), Object.keys(BAKE_UNITS));
  for (const [u, keys] of Object.entries(BAKE_UNITS)) { assert.deepEqual(manifest.units[u].rooms, keys); for (const k of keys) assert.equal(manifest.rooms[k].unit, u); }
  const specs = officeSpecs();
  for (const k of BAKED_ROOMS) assert.deepEqual(manifest.rooms[k].spec, specs[k], k);
});

// genre-trend scouting (17/10/2026): TREND-SCOUT's desk gives the engine's Research room a second desk row, which deepens
// the back row (Research and Design) and so the atrium. The bake follows the ENGINE layout; the legacy fixtures view still
// has the legacy roster's two research desks. The R3b captures run on the engine view (screenshots-r3b.mjs --engine) for that reason.
// B0 (owner, 21/10/2026): the bake is floor 1 (etsy-shop: OVERSEER's desk is on floor 0, the lounge corner is open floor). The legacy
// fixtures view has no floors (its old floor plan, with the lounge and OVERSEER in the Office), so every area of it is drawn
// procedurally, one area at a time, as office.js does for any stale area.
test('B0: the legacy fixtures layout (no floors) differs from the floor-1 bake in every area; each falls back on its own', async () => {
  const log = { read() {}, written() {}, info() {}, warn() {}, error() {}, counts: {} };
  const { server } = createOfficeServer({ fixtures: true, log });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const snap = await (await fetch('http://127.0.0.1:' + server.address().port + '/api/office/snapshot')).json();
    const L = computeLayout(snap.departments.map((d) => ({ key: d.key, agents: d.agents.slice() })), snap.services);
    const differs = BAKED_ROOMS.filter((k) => JSON.stringify(bakedRoomSpec(L, k)) !== JSON.stringify(manifest.rooms[k].spec));
    assert.deepEqual(differs.sort(), ['atrium', 'design', 'lounge', 'office', 'research']);
    assert.equal(L.rooms.find((r) => r.key === 'research').desks.length, 2, 'the legacy roster: two research desks');
    assert.equal(L.lounge.seats.length, 8, 'the legacy view keeps its lounge (no floors)');
  } finally { server.close(); }
});

test('a layout change makes only the changed area stale; up to five services keep the one baked atrium', () => {
  const depts = stationDepartments().map((d) => (d.key === 'office' ? { ...d, agents: [...d.agents, 'extra-agent'] } : d));   // B0: three Office desks; a fourth keeps its two rows
  const L = computeLayout(depts, SERVICES(4), { lounge: false });   // B0: the bake is floor 1 (no lounge furniture)
  assert.notDeepEqual(bakedRoomSpec(L, 'office'), manifest.rooms.office.spec, 'four Office desks instead of three change the Office spec');
  for (const k of BAKED_ROOMS.filter((x) => x !== 'office')) assert.deepEqual(bakedRoomSpec(L, k), manifest.rooms[k].spec, k + ' is unaffected');
  for (const n of [0, 3, 4, 5]) assert.deepEqual(bakedRoomSpec(computeLayout(stationDepartments(), SERVICES(n), { lounge: false }), 'atrium'), manifest.rooms.atrium.spec, n + ' services: the same closet');
  assert.notDeepEqual(bakedRoomSpec(computeLayout(stationDepartments(), SERVICES(6), { lounge: false }), 'atrium'), manifest.rooms.atrium.spec, 'six services lengthen the closet');
  assert.notDeepEqual(bakedRoomSpec(computeLayout(stationDepartments(), SERVICES(4)), 'lounge'), manifest.rooms.lounge.spec, 'a floor with the lounge (floor 0) is not the baked floor');
  const office = fs.readFileSync(path.join(ROOT, 'src', 'web', 'scene', 'office.js'), 'utf8');
  assert.match(office, /JSON\.stringify\(br\.spec\) === JSON\.stringify\(bakedRoomSpec\(L, key\)\)/, 'office.js compares each area on its own');
});

test('the bake used the page\'s current look: one oak floor, palette colours, tints, the Design room\'s light-mode materials', () => {
  assert.deepEqual(manifest.look, bakedLook());
  assert.ok(fs.existsSync(path.join(ASSET_DIR, manifest.look.floor.texture)), 'the shared floor texture the procedural rooms load');
  const day = manifest.look.themed.day, eve = manifest.look.themed.evening;
  for (const k of ['research', 'design', 'office', 'atrium']) assert.ok(lum(day['wall_' + k]) > 0.7 && lum(eve['wall_' + k]) < 0.35, k + ': warm-white walls by day, dark by evening');
  for (const k of ['design_backing', 'design_credenza']) assert.ok(lum(day[k]) > 0.7 && lum(eve[k]) < 0.2, k + ': pale by day (R3b), dark by evening (as R3a)');
  assert.deepEqual(manifest.look.themedTex.design_wood, { day: 'oak', evening: 'walnut' });
  for (const t of ['day', 'evening']) assert.ok(lum(manifest.look.themed[t].rug) < 0.45 && Math.max(...rgb(manifest.look.themed[t].rug)) - Math.min(...rgb(manifest.look.themed[t].rug)) < 16, t + ': a dark grey rug');
  for (const name of Object.values(manifest.look.themedTex).flatMap((x) => Object.values(x))) assert.ok(fs.existsSync(path.join(ASSET_DIR, 'textures', name + '.jpg')), name + '.jpg for a themed texture');
});
const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const lum = (h) => { const [r, g, b] = rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

// R4a: units with their own atlas size (UNIT_ATLAS: the warm Office) are denser than the shared density, and their
// high-tier set (high/) is outside the default download the budget counts
test('one lightmap atlas pair per bake unit, one texel density (R4a: the warm Office denser), the default download under the 10 MB budget', () => {
  const s = sizesOf(ASSET_DIR, { compress: false });
  assert.ok(defaultBytes(s) <= BUDGET_BYTES, 'default-tier assets ' + defaultBytes(s) + ' bytes > ' + BUDGET_BYTES);
  assert.equal(BUDGET_BYTES, 10 * 1000 * 1000);
  const dens = [];
  for (const [u, x] of Object.entries(manifest.units)) {
    for (const m of ['day', 'evening']) { assert.ok(x.lightmaps[m].scale > 0, u + ' ' + m + ' scale'); assert.equal(x.lightmaps[m].file, 'lightmap-' + u + '-' + m + '.webp'); assert.ok(fs.existsSync(path.join(ASSET_DIR, x.lightmaps[m].file))); }
    assert.match(x.build.blender, /Blender 5\.2\.\d+/, u + ' built with the pinned Blender series');
    assert.ok(x.atlas.size >= 512 && x.atlas.size <= 4096, u + ' atlas ' + x.atlas.size);
    if (UNIT_ATLAS[u]) { assert.equal(x.atlas.size, UNIT_ATLAS[u].size, u + ' atlas'); assert.ok(x.atlas.density > DENSITY * 1.2, u + ': higher lightmap resolution than R3b (' + x.atlas.density + ')'); }
    else dens.push(x.atlas.density);
  }
  assert.ok(Math.max(...dens) / Math.min(...dens) < 1.15, 'one texel density in every other unit: ' + dens.join(', '));
  assert.equal(manifest.build.density, DENSITY); assert.deepEqual(manifest.build.light, BAKE_LIGHT);
  const lightmaps = s.files.filter((f) => /^lightmap-/.test(f.file)).map((f) => f.file).sort();
  assert.deepEqual(lightmaps, Object.keys(BAKE_UNITS).flatMap((u) => ['lightmap-' + u + '-day.webp', 'lightmap-' + u + '-evening.webp']).sort(), 'no stray lightmaps');
});

test('the glTFs: lightmap UVs on every lit primitive, shared textures written once, no bake-only occluders', () => {
  const uris = new Set();
  for (const [u, g] of Object.entries(gltfs)) {
    const names = g.materials.map((m) => m.name);
    assert.equal(new Set(names).size, names.length, u + ': one material per name');
    for (const mesh of g.meshes) for (const p of mesh.primitives) {
      if (['led', 'window'].includes(g.materials[p.material].name)) continue;   // unlit on the page (R4a: window panes)
      assert.ok('TEXCOORD_1' in p.attributes, u + ': ' + mesh.name + '/' + g.materials[p.material].name + ' has no lightmap UVs');
    }
    for (const i of g.images || []) { assert.match(i.uri, /^textures\/[a-z]+\.jpg$/); assert.ok(fs.existsSync(path.join(ASSET_DIR, i.uri)), i.uri); uris.add(i.uri); }
    const nodes = g.nodes.map((n) => n.name);
    for (const k of BAKE_UNITS[u]) { assert.ok(nodes.includes(manifest.rooms[k].node), k + ' node'); if (manifest.rooms[k].leds) assert.ok(nodes.includes(manifest.rooms[k].leds), k + ' LED node'); if (manifest.rooms[k].windows) assert.ok(nodes.includes(manifest.rooms[k].windows), k + ' window node'); }
    assert.ok(!nodes.some((n) => /^occ_/.test(n)), u + ': bake-only occluders are not exported');
    assert.ok(g.buffers.every((b) => b.uri === u + '.bin'), u + ': its own buffer');
  }
  const files = fs.readdirSync(path.join(ASSET_DIR, 'textures'));
  assert.deepEqual(files.map((f) => 'textures/' + f).sort(), [...uris].sort(), 'every texture file is used, none outside textures/');
  const bytes = files.map((f) => fs.readFileSync(path.join(ASSET_DIR, 'textures', f)).toString('base64'));
  assert.equal(new Set(bytes).size, bytes.length, 'no duplicated texture');
  for (const g of Object.values(gltfs)) for (const n of g.materials.map((m) => m.name)) assert.ok(manifest.materials.all.includes(n), n);
});

// B0 (owner, 21/10/2026): the lounge is on floor 0 (the shared floor, drawn procedurally: tests/scene-layout.test.mjs checks its seats sit
// on their cushions). The baked floor 1 keeps the lounge corner as open floor: no furniture, no seats, nobody walks there.
test('B0: the baked lounge corner of floor 1 is open floor: no furniture, no seats, no cushions; every floor-1 agent stays at its desk', () => {
  const L = computeLayout(stationDepartments(), SERVICES(4), { lounge: false }), spec = manifest.rooms.lounge.spec;
  assert.equal(spec.open, true); assert.deepEqual([spec.seats, spec.plants, spec.furniture], [[], [], undefined]);
  assert.ok(!manifest.rooms.lounge.cushions || manifest.rooms.lounge.cushions.length === 0, 'no cushions modelled');
  assert.equal(L.lounge.seats.length, 0); assert.ok(Object.values(L.paths).every((p) => p.seat === null && p.toLounge === null));
  assert.ok(!stationDepartments().some((d) => d.agents.includes('overseer')), 'OVERSEER is on floor 0');
});

test('a one-room build replaces only its unit, and refuses when the look or the bake settings changed', () => {
  assert.deepEqual(unitsFor([]), Object.keys(BAKE_UNITS));
  assert.deepEqual(unitsFor(['design']), ['design']);
  assert.deepEqual(unitsFor(['lounge', 'atrium']), ['atrium'], 'the lounge is baked with the atrium');
  assert.throws(() => unitsFor(['kitchen']), /unknown room/);
  assert.deepEqual(unitFiles('design', { buffers: [{ uri: 'design.bin' }] }), ['design.gltf', 'design.bin', 'lightmap-design-day.webp', 'lightmap-design-evening.webp']);
  const look = bakedLook(), opts = { look, light: BAKE_LIGHT, density: DENSITY, full: false };
  const fresh = { units: { design: { ...manifest.units.design, build: { at: 'now' } } }, rooms: { design: { ...manifest.rooms.design } }, last: { units: ['design'] } };
  const m = mergeManifest(manifest, fresh, opts);
  assert.deepEqual(Object.keys(m.units), Object.keys(BAKE_UNITS)); assert.deepEqual(Object.keys(m.rooms), BAKED_ROOMS);
  assert.equal(m.units.design.build.at, 'now');
  for (const u of ['research', 'office', 'atrium']) assert.deepEqual(m.units[u], manifest.units[u], u + ' kept as it was');
  assert.throws(() => mergeManifest(null, fresh, opts), /full build first/);
  assert.throws(() => mergeManifest({ ...manifest, version: 2 }, fresh, opts), /full build first/);
  assert.throws(() => mergeManifest(manifest, fresh, { ...opts, look: { ...look, floor: { ...look.floor, tile: 3 } } }), /look .* changed/);
  assert.throws(() => mergeManifest(manifest, fresh, { ...opts, density: DENSITY + 1 }), /bake settings changed/);
  // R4a: the warm look is not shared: changing it needs the warm units in the build, and nothing else
  const warmer = { ...look, warm: { ...look.warm, band: look.warm.band + 0.1 } };
  assert.throws(() => mergeManifest(manifest, fresh, { ...opts, look: warmer }), /warm look changed/);
  const office = { units: { office: { ...manifest.units.office } }, rooms: { office: { ...manifest.rooms.office } }, last: { units: ['office'] } };
  assert.deepEqual(mergeManifest(manifest, office, { ...opts, look: warmer }).look, warmer);
  assert.deepEqual(unitFiles('office', { buffers: [{ uri: 'office.bin' }] }).filter((f) => f.startsWith(HIGH_DIR + '/')), ['high/lightmap-office-day.webp', 'high/lightmap-office-evening.webp']);
  const full = mergeManifest(manifest, fresh, { ...opts, full: true });
  assert.deepEqual(Object.keys(full.units), ['design'], 'a full build keeps nothing from before');
});

test('the page draws the baked areas by default; ?scene=procedural turns them off', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'web', 'main.js'), 'utf8'), office = fs.readFileSync(path.join(ROOT, 'src', 'web', 'scene', 'office.js'), 'utf8');
  assert.match(main, /scene: q\.get\('scene'\) === 'procedural' \? 'procedural' : 'baked'/);
  assert.match(office, /want: options\.scene !== 'procedural'/);
  assert.match(office, /if \(baked\.want\) loadBakedOffice\(/);
});

test('the build script writes only inside src/web/assets/office/', () => {
  assert.throws(() => assetJail('../x.txt'), /refusing to write/);
  assert.throws(() => assetJail(path.join(ROOT, 'data', 'x')), /refusing to write/);
  assert.ok(assetJail('manifest.json').startsWith(ASSET_DIR + path.sep));
});
