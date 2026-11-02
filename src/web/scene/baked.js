// scene/baked.js — the baked areas (R3 spike: Design; R3a: Design and Office; R3b: every area — the three department
// rooms, the lounge and the atrium — the default scene; ?scene=procedural turns them off). Loads one glTF per bake unit
// (a room, or the atrium with the lounge), which scripts/build-office.mjs made in Blender from the shared library, and
// each unit's two lightmap atlases (day for light mode, evening for dark mode). Every lit surface becomes an unlit
// MeshBasicMaterial: albedo (shared texture, vertex colour or themed colour) x the unit's lightmap on the second UV set,
// so the areas cost no real-time lights, shadows or PBR. Shared textures are loaded once whichever unit uses them.
// Themed materials take the manifest's colour for the theme (walls, caps, skirting, the slab, its concrete, the plinth,
// the closet, the Design room's backing and credenza); tinted ones (task-chair fabric, sofas, rugs) multiply their
// shared texture by the colour over the texture's average; design_wood swaps its texture (oak by day, walnut by
// evening). The decals (mood board, whiteboard, pictures) take the page's own procedural atlas and the atrium's
// concrete the page's own concrete texture. The LED strips and lamp bulbs stay unlit and real-time: dim profiles in
// light mode, bright HDR warm light in dark mode (above 1.0, so the half-resolution glow pass in office.js picks them
// out). People, monitors, keyboards, status lights, server cabinets and the memory core are not in the glTF: office.js
// draws them.
// R4a: the warm Office (config/warm-office.js): its themed materials come from the manifest's look.warm (walls, caps, the
// chairs' and the rug's tints, the window panes, which are unlit like the LEDs). Quality tiers: a unit with a high-tier
// lightmap set (manifest units.<u>.high, in high/) loads it only when the high tier is on, and only the current theme's
// map; until it has loaded, and in the default tier, the unit uses its default atlas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FLOOR_OAK } from './bakedlook.js';

export const BAKED_BASE = '/assets/office/';
const LED = { light: { colour: '#efeae2', gain: 1 }, dark: { colour: '#ffd394', gain: 2.6 } };   // light: palette.led (light)
// lightmap brightness per theme on top of the baked scale: the evening areas are lifted so desks, people and screens
// read at overview zoom, and no area is darker overall than its procedural version (R3a: 1.15; R3b: 1.35, after the
// owner's dark grey rugs; measured, see DECISIONS)
export const LM_GAIN = { light: 1.0, dark: 1.35 };

// the shared oak floor, also used by the procedural rooms (one wood across the office)
export function loadFloorTexture(base = BAKED_BASE) {
  return new THREE.TextureLoader().loadAsync(base + FLOOR_OAK.texture).then((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true; return t; });
}

export async function loadBakedOffice({ base = BAKED_BASE, decalMap = null, concreteMap = null } = {}) {
  const res = await fetch(base + 'manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('manifest.json: HTTP ' + res.status);
  const manifest = await res.json();
  if (manifest.version !== 3) throw new Error('manifest.json: version ' + manifest.version + ', expected 3 (rebuild: npm run build-office)');
  const look = manifest.look, tl = new THREE.TextureLoader(), loader = new GLTFLoader();
  const units = await Promise.all(Object.entries(manifest.units).map(async ([key, u]) => {
    const [gltf, day, evening] = await Promise.all([loader.loadAsync(base + u.gltf), tl.loadAsync(base + u.lightmaps.day.file), tl.loadAsync(base + u.lightmaps.evening.file)]);
    for (const t of [day, evening]) { t.flipY = false; t.channel = 1; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true; }
    return { key, gltf, maps: { light: { tex: day, scale: u.lightmaps.day.scale }, dark: { tex: evening, scale: u.lightmaps.evening.scale } }, lit: [] };
  }));
  // shared textures: one texture per file across every unit (each glTF loads its own copy; the first one is kept)
  const textures = new Map();
  const keep = (uri, t) => { t.anisotropy = 4; textures.set(uri, t); return t; };
  function shared(gltf, tex) {
    const a = gltf.parser.associations.get(tex), j = gltf.parser.json, ti = a && a.textures;
    const uri = ti != null && j.textures[ti] ? j.images[j.textures[ti].source].uri : null;
    if (!uri) return tex;
    if (textures.has(uri)) { if (textures.get(uri) !== tex) tex.dispose(); return textures.get(uri); }
    return keep(uri, tex);
  }
  const textureFile = (name) => 'textures/' + name + '.jpg';
  async function byName(name) {   // a shared texture by name (design_wood's day and evening images), loaded if no glTF used it
    const uri = textureFile(name); if (textures.has(uri)) return textures.get(uri);
    const t = await tl.loadAsync(base + uri); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
    return textures.has(uri) ? (t.dispose(), textures.get(uri)) : keep(uri, t);
  }
  // R4a: the warm look's themed materials and texture means join the shared ones
  const warm = look.warm || { themed: { day: {}, evening: {} }, textures: {} };
  const themes = { day: { ...look.themed.day, ...warm.themed.day }, evening: { ...look.themed.evening, ...warm.themed.evening } };
  const means = { ...(look.textures || {}), ...(warm.textures || {}) };
  const themedColour = themes.day, themed = [], swapped = [];
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffffff }); winMat.name = 'window';
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }); ledMat.name = 'led';
  const rooms = {};
  for (const u of units) {
    const cache = new Map();          // one page material per glTF material of the unit (its lightmap is the unit's)
    const pageMaterial = (src) => {
      if (cache.has(src)) return cache.get(src);
      const name = src.name || '';
      let m;
      if (name === 'led') m = ledMat;
      else if (name === 'window') m = winMat;
      else {
        const map = name === 'decal' ? decalMap : name === 'concrete' ? concreteMap : src.map ? shared(u.gltf, src.map) : null;
        m = new THREE.MeshBasicMaterial({ map, color: src.color ? src.color.clone() : 0xffffff, vertexColors: !!src.vertexColors, side: src.side, lightMap: u.maps.light.tex, lightMapIntensity: 1 });
        m.name = name; u.lit.push(m);
        if (name in themedColour) {     // a tinted texture divides by its texture's average (bakedlook.js TEXTURE_MEANS)
          const file = src.map && Object.keys(means).find((t) => textures.get(textureFile(t)) === map);
          m.userData.mean = file ? means[file].mean : null; themed.push(m);
        }
        if (look.themedTex && look.themedTex[name]) swapped.push(m);
      }
      cache.set(src, m); return m;
    };
    for (const key of manifest.units[u.key].rooms) {
      const r = manifest.rooms[key]; if (!r) continue;
      const group = new THREE.Group(); group.name = 'baked:' + key;
      const node = u.gltf.scene.getObjectByName(r.node), ledNode = r.leds ? u.gltf.scene.getObjectByName(r.leds) : null, winNode = r.windows ? u.gltf.scene.getObjectByName(r.windows) : null;
      if (!node) throw new Error(u.key + '.gltf has no node ' + r.node);
      group.add(node); if (ledNode) group.add(ledNode); if (winNode) group.add(winNode);
      const ledMeshes = [];
      group.traverse((o) => {
        if (!o.isMesh) return;
        const src = o.material; o.material = pageMaterial(src);
        if (src !== o.material) src.dispose();   // the glTF material (its textures live on in the page material)
        o.castShadow = o.material !== ledMat && o.material !== winMat; o.receiveShadow = false;
        if (o.material === ledMat) ledMeshes.push(o);
      });
      rooms[key] = { key, unit: u.key, spec: r.spec, group, ledMeshes };
    }
  }
  const swapTex = {};                 // design_wood: the day and evening textures, ready before the first theme change
  for (const [name, by] of Object.entries(look.themedTex || {})) swapTex[name] = { light: await byName(by.day), dark: await byName(by.evening) };
  // R4a: the high tier's lightmaps, per unit and theme, loaded on first use (the same scale as the default map: one bake)
  let tier = 'default', current = 'light', onHigh = null;
  const highOf = (u, t) => { const h = manifest.units[u.key].high; return h ? h[t === 'dark' ? 'evening' : 'day'] : null; };
  function wantHigh(u, t) {
    const h = highOf(u, t); if (!h) return;
    u.high = u.high || {}; if (u.high[t]) return;
    u.high[t] = { tex: null, state: 'loading' };
    tl.loadAsync(base + h.file).then((tex) => {
      tex.flipY = false; tex.channel = 1; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.needsUpdate = true;
      u.high[t] = { tex, state: 'loaded' }; if (tier === 'high' && current === t) applyMaps(); if (onHigh) onHigh();
    }).catch((e) => { u.high[t] = { tex: null, state: 'failed' }; console.warn('office: the high-tier lightmap ' + h.file + ' did not load; keeping the default one:', e && e.message); if (onHigh) onHigh(); });
  }
  function applyMaps() {
    const t = current;
    for (const u of units) {
      const hi = tier === 'high' && u.high && u.high[t] && u.high[t].tex, m = u.maps[t], k = Math.PI * m.scale * LM_GAIN[t];
      for (const mat of u.lit) { mat.lightMap = hi || m.tex; mat.lightMapIntensity = k; }   // basic material: albedo x lightmap x intensity / PI
    }
  }
  // the high tier's state for the current theme: 'none' (no unit has a high set), 'loading', 'loaded' or 'failed'
  function highState() {
    const s = units.filter((u) => highOf(u, current)).map((u) => (u.high && u.high[current] ? u.high[current].state : 'pending'));
    return !s.length ? 'none' : s.includes('failed') ? 'failed' : s.every((x) => x === 'loaded') ? 'loaded' : 'loading';
  }
  function setTier(t, { onLoaded = null } = {}) {
    tier = t === 'high' ? 'high' : 'default'; onHigh = onLoaded;
    if (tier === 'high') for (const u of units) wantHigh(u, current);
    applyMaps(); setLeds();
  }
  function setLeds() { const l = LED[current]; ledMat.color.set(l.colour).multiplyScalar(l.gain); }
  const c = new THREE.Color(), mc = new THREE.Color();
  function setTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light'; current = t;
    if (tier === 'high') for (const u of units) wantHigh(u, t);
    applyMaps();
    const colours = themes[t === 'dark' ? 'evening' : 'day'];
    for (const mat of themed) {
      c.set(colours[mat.name] || '#888888');
      if (mat.userData.mean) { mc.set(mat.userData.mean); mat.color.setRGB(c.r / mc.r, c.g / mc.g, c.b / mc.b); } else mat.color.copy(c);
    }
    for (const mat of swapped) mat.map = swapTex[mat.name][t];
    winMat.color.set(colours.window || '#dddddd');
    setLeds();
  }
  function dispose() {
    for (const r of Object.values(rooms)) r.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    for (const u of units) { for (const m of u.lit) m.dispose(); u.maps.light.tex.dispose(); u.maps.dark.tex.dispose(); for (const h of Object.values(u.high || {})) if (h.tex) h.tex.dispose(); }
    for (const t of textures.values()) t.dispose();
    ledMat.dispose(); winMat.dispose();
  }
  return { manifest, rooms, setTheme, setTier, highState, dispose };
}
