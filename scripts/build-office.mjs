// build-office.mjs — R3a, R3b: builds the baked office with Blender, headless and reproducible. R3b: every area is baked
// (Research, Design and Office rooms, the lounge and the atrium) in four bake units, each with its own lightmap atlas:
// one per room, and one for the atrium with the lounge. A change to one room re-bakes only that room.
//   npm run build-office                          -> full build (every unit; 1024 samples, GPU)
//   npm run build-office -- --room design          -> one unit (research, design, office, atrium; 'lounge' = atrium);
//                                                    the others are kept as they are
//   node scripts/build-office.mjs --quick          -> a fast look (half the texel density, 128 samples)
// Steps per unit: (1) the area specs from the live floor plan (layout.js bakedRoomSpec) for the station's departments,
// and the shared look (bakedlook.js: the oak floor, themed colours, tints and textures from the palette, the decal atlas
// regions); (2) Blender runs scripts/blender/build-office.py, which builds the unit from the shared library
// (office_lib.py, office_rooms.py), packs its lightmap UVs into one atlas sized for one texel density across the office,
// bakes a day and an evening atlas in Cycles and exports <unit>.gltf + <unit>.bin + the textures it uses (textures/,
// one file per shared texture, the same bytes from every unit); (3) the atlases become WebP (sharp); (4) the manifest
// (per-area spec, per-unit lightmaps and build info, the look) and the sizes are written. A one-unit build refuses to
// run when the shared look or the bake settings changed since the last full build (they affect every unit).
// Blender writes into a staging folder; only a successful build replaces the published files. Every file this script
// writes goes through assetJail() (src/web/assets/office/ only); Blender writes only into the staging folder there (the
// Python checks). Blender: BLENDER_EXE, else the default install path. The pinned version is in ASSETS.md; another
// version is refused unless --any-blender is given. No network, no secrets, mock data only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import { computeLayout, bakedRoomSpec } from '../src/web/scene/layout.js';
import { BAKED_ROOMS, BAKE_UNITS, WARM_UNITS, unitOf, bakedLook } from '../src/web/scene/bakedlook.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSET_DIR = path.join(ROOT, 'src', 'web', 'assets', 'office');
// the only way this script writes: a path inside src/web/assets/office/
export function assetJail(p) { const f = path.resolve(ASSET_DIR, p); if (!f.startsWith(ASSET_DIR + path.sep)) throw new Error('refusing to write outside src/web/assets/office/: ' + p); return f; }
export const BLENDER_PIN = '5.2';                 // series pinned in ASSETS.md (5.2 LTS)
const DEFAULT_BLENDER = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
const TEXTURES = path.join(ROOT, 'assets-src', 'polyhaven');
const PY = path.join(ROOT, 'scripts', 'blender', 'build-office.py');
export const BUDGET_BYTES = 10 * 1000 * 1000;    // the whole office's baked assets, compressed (owner, R3a): 10 MB
// bake lighting (not shared with the page): day = sun + sky; evening = LED strips, desk and floor lamps and a cool sky
// fill. Evening fill raised from the spike's 0.8 so the rooms read at overview zoom (owner, R3a).
export const BAKE_LIGHT = { day: { sun: 2.6, sky: '#dfe6f0', skyStrength: 0.55 }, evening: { sky: '#8a90a4', skyStrength: 1.5, ledGain: 1.0, lamp: 25.0 } };
// lightmap texels per scene unit, the same in every unit's atlas (R3b; R3a's one 3072 px atlas for two rooms was ~100)
export const DENSITY = 100;
// R4a: units with their own atlas size instead of the density: the warm Office at 3072 px (R3b: 2176), baked at 6144 px
// for the high tier (high/, loaded only when the high tier is on); the default atlas is that bake halved (linear light)
export const UNIT_ATLAS = { office: { size: 3072, high: 6144 } };
export const HIGH_DIR = 'high';
// fixed seeds per area (the Design and Office seeds are R3a's), so a one-unit build gives the same room as a full one
const SEEDS = { design: 20261017, office: 20261118, research: 20261219, lounge: 20261320, atrium: 20261421 };

// The baked floor's departments in the order the server gives them (research, design, office). tests/baked-room.test.mjs
// checks the fixtures and engine views give the same specs as the committed manifest.
// B0 (owner, 21/10/2026): the building has floors; the bake is floor 1 (BAKED_FLOOR), the business on it (config/businesses: etsy-shop),
// with its lounge corner open (the lounge is on floor 0, the shared floor, which is drawn procedurally)
export const BAKED_FLOOR = 1;
// R1: config/businesses/ is retired; the bake is the Etsy archive, the archived department with rooms in config/departments (B0's floor 1 on
// the page until R7 moves it to G)
export function bakedBusiness() {
  const dir = path.join(ROOT, 'config', 'departments');
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_')).sort()) { const d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (d.status === 'archived' && (d.rooms || []).length) return { id: d.product, floor: BAKED_FLOOR, departments: d.rooms }; }
  throw new Error('no archived department with rooms in config/departments (the baked floor)');
}
export function stationDepartments() {
  const dir = path.join(ROOT, 'config', 'agents'), byDept = {}, mine = bakedBusiness().departments;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) { const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); const k = String(a.department || 'office').toLowerCase(); (byDept[k] = byDept[k] || []).push(a.key); }
  return ['research', 'design', 'office'].filter((k) => mine.includes(k) && byDept[k]).map((k) => ({ key: k, agents: byDept[k] }));
}
export const officeLayout = () => computeLayout(stationDepartments(), [{ id: 's0' }, { id: 's1' }, { id: 's2' }, { id: 's3' }], { lounge: false });
export function officeSpecs(L = officeLayout()) { return Object.fromEntries(BAKED_ROOMS.map((k) => [k, bakedRoomSpec(L, k)])); }
// where each area of a unit sits in the unit's frame (the atrium's frame is the slab's; the lounge sits in it)
function placeIn(L, unit) {
  const o = unit === 'atrium' ? L.base : null;
  return Object.fromEntries(BAKE_UNITS[unit].map((k) => [k, o && k === 'lounge' ? [L.lounge.x0 - o.x0, L.lounge.z0 - o.z0] : [0, 0]]));
}

// which units a --room list names ('lounge' is in the atrium's unit); none: every unit
export function unitsFor(names) {
  if (!names || !names.length) return Object.keys(BAKE_UNITS);
  const out = [];
  for (const n of names) { const u = BAKE_UNITS[n] ? n : unitOf(n); if (!u) throw new Error('unknown room "' + n + '" (rooms: ' + [...Object.keys(BAKE_UNITS), 'lounge'].join(', ') + ')'); if (!out.includes(u)) out.push(u); }
  return out;
}

// the files a unit owns in the asset folder (its glTF, its buffer, its two lightmaps)
export function unitFiles(unit, gltfJson) { return [unit + '.gltf', ...((gltfJson && gltfJson.buffers) || []).map((b) => b.uri), 'lightmap-' + unit + '-day.webp', 'lightmap-' + unit + '-evening.webp', ...(UNIT_ATLAS[unit] && UNIT_ATLAS[unit].high ? ['day', 'evening'].map((m) => HIGH_DIR + '/lightmap-' + unit + '-' + m + '.webp') : [])]; }
// the look every unit shares (R4a: all but the warm part, which only WARM_UNITS use)
const sharedLook = (look) => { if (!look) return look; const { warm, ...rest } = look; return rest; };

// The manifest after building some units: the built units and their areas replace the old ones, the others are kept.
// A one-unit build needs a previous full build with the same look and bake settings (they affect every unit).
export function mergeManifest(prev, built, { look, light, density, full }) {
  if (!full) {
    if (!prev || prev.version !== 3) throw new Error('no R3b manifest yet: run a full build first (npm run build-office)');
    if (!isDeepStrictEqual(sharedLook(prev.look), sharedLook(look))) throw new Error('the shared look (palette, textures, atlas) changed since the last build: run a full build');
    const stale = WARM_UNITS.filter((u) => !built.units[u] && !(built.pending || []).includes(u));
    if (!isDeepStrictEqual(prev.look.warm, look.warm) && stale.length) throw new Error('the warm look changed since the last build: build ' + stale.join(', ') + ' too (--room ' + WARM_UNITS.join(',') + ')');
    if (!isDeepStrictEqual(prev.build.light, light) || prev.build.density !== density) throw new Error('the bake settings changed since the last build: run a full build');
  }
  const units = {}, rooms = {};
  for (const u of Object.keys(BAKE_UNITS)) { const x = built.units[u] || (!full && prev.units[u]); if (x) units[u] = x; }
  for (const k of BAKED_ROOMS) { const x = built.rooms[k] || (!full && prev.rooms[k]); if (x) rooms[k] = x; }
  const textured = [...new Set(Object.values(units).flatMap((u) => u.materials))];
  return {
    version: 3, look, units, rooms,
    materials: { all: textured, themed: Object.keys(look.themed.day), themedTex: Object.keys(look.themedTex), decal: ['decal'], canvas: ['concrete'], unlit: ['led'] },
    build: { ...(prev && !full ? prev.build : {}), light, density, script: 'scripts/blender/build-office.py', library: 'scripts/blender/office_lib.py', last: built.last },
    sizes: prev && !full ? prev.sizes : null
  };
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r)); else out.push(r);
  }
  return out;
}
// compress: also what gzip and brotli would give (about 8 s for the whole folder; the budget counts bytes as served)
// R4a: the default tier's download is every file but high/ (the high tier's lightmaps load only when it is on)
export const isHighFile = (f) => f.startsWith(HIGH_DIR + '/');
export function defaultBytes(sizes) { return sizes.files.filter((r) => !isHighFile(r.file)).reduce((s, r) => s + r.bytes, 0); }
export function sizesOf(dir = ASSET_DIR, { compress = true } = {}) {
  const rows = listFiles(dir).filter((f) => f !== 'sizes.json').map((f) => { const buf = fs.readFileSync(path.join(dir, f)); return compress ? { file: f, bytes: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length, brotli: zlib.brotliCompressSync(buf).length } : { file: f, bytes: buf.length }; });
  const sum = (k, f = () => true) => rows.filter((r) => f(r.file)).reduce((s, r) => s + (r[k] || 0), 0), dflt = (f) => !isHighFile(f);
  return { files: rows, total: compress ? { bytes: sum('bytes'), gzip: sum('gzip'), brotli: sum('brotli') } : { bytes: sum('bytes') }, defaultTier: { bytes: sum('bytes', dflt), ...(compress ? { brotli: sum('brotli', dflt) } : {}) }, highTierOnly: { bytes: sum('bytes', isHighFile) }, budgetBytes: BUDGET_BYTES, budgetNote: '10 MB (10,000,000 bytes) for the whole baked office, compressed (owner, R3a); checked against bytes as served; R4a: the default tier\'s download (all but high/)', note: 'bytes = as served (JPEG textures, WebP lightmaps: already compressed; the glTF JSON and geometry are not); gzip/brotli = what HTTP compression would give' };
}

async function buildUnit(unit, { blender, version, L, specs, look, density, samples }) {
  const t0 = Date.now(), dir = '.build/' + unit;
  fs.mkdirSync(assetJail(dir + '/stage/.build'), { recursive: true });
  const input = { unit, look: { ...look, ...BAKE_LIGHT }, rooms: BAKE_UNITS[unit].map((k) => specs[k]), place: placeIn(L, unit), seeds: SEEDS };
  fs.writeFileSync(assetJail(dir + '/input.json'), JSON.stringify(input, null, 2) + '\n');
  console.log('[build] unit', unit.padEnd(8), BAKE_UNITS[unit].map((k) => k + ' ' + specs[k].w + ' x ' + specs[k].d).join(', '));
  const ua = UNIT_ATLAS[unit], scale = density / DENSITY;          // --quick halves the density, and these sizes with it
  const sizeArgs = ua ? ['--atlas', String(Math.round(ua.size * scale)), ...(ua.high ? ['--bake-size', String(Math.round(ua.high * scale))] : [])] : [];
  const run = spawnSync(blender, ['-b', '--factory-startup', '--python-exit-code', '3', '--python', PY, '--', '--input', assetJail(dir + '/input.json'), '--out', assetJail(dir + '/stage'), '--textures', TEXTURES, '--density', String(density), '--samples', String(samples), ...sizeArgs], { stdio: 'inherit' });
  const blenderSeconds = (Date.now() - t0) / 1000;
  if (run.status !== 0) throw new Error('Blender exited with ' + run.status + ' for unit ' + unit);
  const stage = assetJail(dir + '/stage');
  const bake = JSON.parse(fs.readFileSync(path.join(stage, '.build', 'bake.json'), 'utf8'));
  const lightmaps = {}, high = bake.bakeSize > bake.size ? { size: bake.bakeSize } : null;
  if (high) fs.mkdirSync(assetJail(dir + '/stage/' + HIGH_DIR), { recursive: true });
  for (const [mode, lm] of Object.entries(bake.lightmaps)) {
    const file = 'lightmap-' + unit + '-' + mode + '.webp', png = path.join(stage, '.build', lm.png);
    // R4a: a bigger bake gives the high tier's map as baked and the default map halved in linear light (gamma 2.2)
    if (high) {
      await sharp(png).webp({ quality: 88, effort: 6 }).toFile(assetJail(dir + '/stage/' + HIGH_DIR + '/' + file));
      high[mode] = { file: HIGH_DIR + '/' + file };
      await sharp(png).gamma(2.2).resize(bake.size, bake.size, { kernel: 'mitchell' }).webp({ quality: 90, effort: 6 }).toFile(assetJail(dir + '/stage/' + file));
    } else await sharp(png).webp({ quality: 90, effort: 6 }).toFile(assetJail(dir + '/stage/' + file));
    lightmaps[mode] = { file, scale: lm.scale, coverage: lm.coverage, p995: lm.p995, max: lm.max };
  }
  fs.rmSync(assetJail(dir + '/stage/.build'), { recursive: true, force: true });
  const seconds = +((Date.now() - t0) / 1000).toFixed(1);
  const info = { gltf: unit + '.gltf', rooms: BAKE_UNITS[unit], lightmaps, ...(high ? { high } : {}), materials: bake.materials, atlas: { size: bake.size, density: bake.density, surface: bake.surface, uvCoverage: bake.uvCoverage }, build: { at: new Date().toISOString(), blender: version, device: bake.device, samples, blenderSeconds: +blenderSeconds.toFixed(1), seconds, phases: bake.phases } };
  const rooms = Object.fromEntries(BAKE_UNITS[unit].map((k) => [k, { unit, spec: specs[k], node: bake.rooms[k].node, leds: bake.rooms[k].leds, ...(bake.rooms[k].windows ? { windows: bake.rooms[k].windows } : {}), strips: bake.rooms[k].strips, ...(bake.rooms[k].cushions.length ? { cushions: bake.rooms[k].cushions } : {}), triangles: bake.triangles[k] }]));
  console.log('[build] unit', unit, 'done in', seconds + ' s |', bake.size + ' px atlas,', bake.density + ' texels per unit');
  return { stage, info, rooms };
}

async function main() {
  const argv = process.argv.slice(2), has = (f) => argv.includes(f), arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const roomArgs = argv.flatMap((a, i) => (argv[i - 1] === '--room' ? a.split(',') : [])).map((s) => s.trim()).filter(Boolean);
  const units = unitsFor(roomArgs), full = !roomArgs.length;
  const quick = has('--quick');
  const density = Number(arg('--density', quick ? DENSITY / 2 : DENSITY)), samples = Number(arg('--samples', quick ? 128 : 1024));
  const blender = process.env.BLENDER_EXE || DEFAULT_BLENDER;
  if (!fs.existsSync(blender)) throw new Error('Blender not found at ' + blender + ' (set BLENDER_EXE)');
  const ver = spawnSync(blender, ['--version'], { encoding: 'utf8' });
  const version = (((ver.stdout || '').match(/Blender\s+(\d+\.\d+\.\d+)[^\r\n]*/) || [])[0] || 'unknown').trim();
  console.log('[build] blender:', version, '|', blender);
  if (!version.includes(' ' + BLENDER_PIN + '.') && !has('--any-blender')) throw new Error('Blender ' + BLENDER_PIN + '.x is pinned (ASSETS.md); found ' + version + ' (pass --any-blender to override)');

  const tStart = Date.now();
  const L = officeLayout(), specs = officeSpecs(L), look = bakedLook();
  const manifestPath = path.join(ASSET_DIR, 'manifest.json');
  const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  // a one-unit build checks first that it can merge (same look and bake settings as the published build)
  if (!full) mergeManifest(prev, { units: {}, rooms: {}, last: null, pending: units }, { look, light: BAKE_LIGHT, density, full: false });
  console.log('[build]', full ? 'full build: every unit' : 'units: ' + units.join(', ') + ' (the others are kept)', '|', density, 'texels per unit,', samples, 'samples');
  fs.rmSync(assetJail('.build'), { recursive: true, force: true });
  const built = { units: {}, rooms: {}, stages: {} };
  for (const u of units) { const r = await buildUnit(u, { blender, version, L, specs, look, density, samples }); built.units[u] = r.info; Object.assign(built.rooms, r.rooms); built.stages[u] = r.stage; }

  // publish. Full: replace everything (but .build). One unit: replace that unit's files only. Shared textures: one file
  // each; a unit's copy must be the same bytes as the published one (a library texture change needs a full build)
  const warnings = [];
  if (full) { for (const e of fs.readdirSync(ASSET_DIR)) if (e !== '.build') fs.rmSync(assetJail(e), { recursive: true, force: true }); }
  else for (const u of units) {
    const old = prev.units[u]; if (!old) continue;
    const g = fs.existsSync(path.join(ASSET_DIR, old.gltf)) ? JSON.parse(fs.readFileSync(path.join(ASSET_DIR, old.gltf), 'utf8')) : null;
    for (const f of unitFiles(u, g)) fs.rmSync(assetJail(f), { force: true });
  }
  fs.mkdirSync(assetJail('textures'), { recursive: true });
  for (const u of units) {
    const stage = built.stages[u];
    for (const e of fs.readdirSync(stage)) if (e !== 'textures' && e !== HIGH_DIR) fs.renameSync(path.join(stage, e), assetJail(e));
    if (fs.existsSync(path.join(stage, HIGH_DIR))) { fs.mkdirSync(assetJail(HIGH_DIR), { recursive: true }); for (const e of fs.readdirSync(path.join(stage, HIGH_DIR))) fs.renameSync(path.join(stage, HIGH_DIR, e), assetJail(HIGH_DIR + '/' + e)); }
    for (const t of fs.readdirSync(path.join(stage, 'textures'))) {
      const src = path.join(stage, 'textures', t), dst = assetJail('textures/' + t);
      if (!fs.existsSync(dst)) fs.renameSync(src, assetJail('textures/' + t));
      else if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) { warnings.push('texture ' + t + ' from ' + u + ' differs from the published one; kept the published one (run a full build after a library texture change)'); }
    }
  }
  const last = { units, full, at: new Date().toISOString(), seconds: +((Date.now() - tStart) / 1000).toFixed(1), blender: version };
  const manifest = mergeManifest(prev, { ...built, last }, { look, light: BAKE_LIGHT, density, full });
  manifest.build.blender = version;
  if (full) manifest.build.full = { at: last.at, seconds: last.seconds, units };
  // the areas a one-unit build left alone but whose layout changed since their last bake
  for (const [k, r] of Object.entries(manifest.rooms)) if (!units.includes(r.unit) && !isDeepStrictEqual(r.spec, specs[k])) warnings.push('the ' + k + ' area no longer matches the floor plan (the page draws it procedurally): build it with --room ' + r.unit);
  // the manifest records the folder's total, its own size included (quick passes settle it)
  for (let i = 0; i < 3; i++) { fs.writeFileSync(assetJail('manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); const z = sizesOf(ASSET_DIR, { compress: false }); manifest.sizes = { total: z.total, defaultTier: z.defaultTier, highTierOnly: z.highTierOnly, budgetBytes: BUDGET_BYTES }; }
  const sizes = sizesOf(), s = sizes.total;
  fs.writeFileSync(assetJail('sizes.json'), JSON.stringify(sizes, null, 2) + '\n');
  fs.rmSync(assetJail('.build'), { recursive: true, force: true });
  const d = sizes.defaultTier.bytes;
  console.log('[build] done in', last.seconds + ' s (' + units.map((u) => u + ' ' + built.units[u].build.seconds + ' s').join(', ') + ') | default tier', (d / 1e6).toFixed(2) + ' MB as served,', d <= BUDGET_BYTES ? 'within' : 'OVER', 'the 10 MB budget | high tier adds', (sizes.highTierOnly.bytes / 1e6).toFixed(2) + ' MB');
  for (const r of sizes.files) console.log('   ', r.file.padEnd(34), (r.bytes / 1024).toFixed(0).padStart(6) + ' KB');
  for (const w of warnings) console.warn('[build] warning:', w);
  if (d > BUDGET_BYTES) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('[build] failed:', e.message); process.exit(1); });
