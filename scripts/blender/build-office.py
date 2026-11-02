# build-office.py — R3a, R3b: one bake unit of the office, modelled from the shared library, lit and baked in Blender
# (headless). A unit is one department room, or the atrium together with the lounge (they light each other); each unit
# has its own lightmap atlas, so a change to one room re-bakes only that room. Run it through scripts/build-office.mjs,
# which passes the unit's area specs (layout.js bakedRoomSpec), where each area sits in the unit's frame, the shared
# look (floor, themed colours and textures, atlas regions; from the page's palette and textures.js) and the output folder:
#   blender -b --factory-startup --python scripts/blender/build-office.py -- --input I --out DIR --textures DIR
# Steps: each area is built from office_lib.py pieces by its recipe in office_rooms.py; the unit's lightmap UVs are
# packed into one atlas whose size follows the unit's surface area (one texel density for every unit); a day and an
# evening atlas are baked in Cycles; then <unit>.gltf, <unit>.bin and the shared textures it uses (textures/) are
# exported, each area as its own node at its own origin.
# Outputs (only into --out, checked): <unit>.gltf, <unit>.bin, textures/*.jpg, .build/lightmap-<unit>-day.png and
# .build/lightmap-<unit>-evening.png (8-bit, sRGB-encoded, scaled by 1/k; k in bake.json), .build/bake.json.
import bpy, sys, os, json, math, time, argparse
import numpy as np
from mathutils import Vector, Matrix

sys.dont_write_bytecode = True        # no __pycache__ next to the library
HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path: sys.path.insert(0, HERE)
import office_lib as lib
from office_rooms import RECIPES

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--input', required=True); ap.add_argument('--out', required=True); ap.add_argument('--textures', required=True)
ap.add_argument('--density', type=float, default=100.0)   # lightmap texels per scene unit (about a metre)
ap.add_argument('--max-size', type=int, default=4096); ap.add_argument('--samples', type=int, default=1024)
# R4a: a fixed atlas size for the unit (instead of the texel density), and a bigger bake for the high tier: the UVs are
# packed for --atlas, the lightmaps baked at --bake-size (a whole multiple); build-office.mjs makes both tiers from it
ap.add_argument('--atlas', type=int, default=0); ap.add_argument('--bake-size', type=int, default=0)
A = ap.parse_args(argv)
OUT = os.path.realpath(A.out)
def out_path(name):
    p = os.path.realpath(os.path.join(OUT, name))
    if not p.startswith(OUT + os.sep): raise RuntimeError('refusing to write outside ' + OUT + ': ' + name)
    return p
def log(*a): print('[blender]', *a, flush=True)
T0 = time.perf_counter(); PHASES = {}
def phase(name, t): PHASES[name] = round(time.perf_counter() - t, 2); log(name, PHASES[name], 's')

IN = json.load(open(A.input, encoding='utf-8'))
UNIT, LOOK, SPECS, PLACE, SEEDS = IN['unit'], IN['look'], IN['rooms'], IN['place'], IN['seeds']
lib.configure(LOOK)

# ---------------------------------------------------------------- model every area of the unit (pure Python)
kits = []
for spec in SPECS:
    if spec['kind'] not in RECIPES: raise RuntimeError('no recipe for area kind ' + spec['kind'])
    k = lib.Kit(spec, LOOK, SEEDS[spec['key']]); RECIPES[spec['kind']](k); kits.append(k)
    log('modelled', spec['key'], '|', len(k.room.f), 'faces |', len(k.leds), 'LED strips |', len(k.bulbs) + len(k.lights), 'lamps')
phase('model', T0)

# ---------------------------------------------------------------- Blender scene: textures, materials, objects
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
t = time.perf_counter()
TEXIMG = lib.load_textures(A.textures)
phase('textures', t)
# material -> colour (flat) or the colour a tinted texture should average; R4a: the warm look's themed materials too
THEMES = {m: {**LOOK['themed'][m], **(LOOK.get('warm') or {}).get('themed', {}).get(m, {})} for m in ('day', 'evening')}
THEMED = THEMES['day']
THEMED_TEX = LOOK.get('themedTex', {})             # material -> texture per mode (design_wood: oak by day, walnut by evening)
BASE = ['solid', 'leaf', 'oak', 'walnut', 'floor', 'fabric', 'upholstery', 'rug', 'design_wood', 'decal', 'concrete']
UNLIT = ('led', 'window')                          # drawn unlit on the page; no lightmap
used = set()
for k in kits: used |= set(k.room.m) | set(k.em.m) | set(k.occ.m) | set(k.win.m)
MAT_ORDER = [n for n in BASE if n in used] + sorted(n for n in used if n not in BASE and n not in UNLIT) + [n for n in UNLIT if n in used]
MATS = {n: lib.make_material(n, TEXIMG) for n in MAT_ORDER}

rooms = []
for k in kits:
    dx, dz = PLACE[k.key]
    off = Vector(lib.to_bl((dx, 0, dz)))
    ob = lib.make_object(scene, 'room_' + k.key, k.room, MATS, True); ob.location = off
    em = lib.make_object(scene, 'leds_' + k.key, k.em, MATS, False) if k.em.f else None
    if em: em.location = off
    oc = lib.make_object(scene, 'occ_' + k.key, k.occ, MATS, False) if k.occ.f else None
    if oc: oc.location = off
    wn = lib.make_object(scene, 'win_' + k.key, k.win, MATS, False) if k.win.f else None   # R4a: window panes
    if wn: wn.location = off; wn.hide_render = True                                      # (light passes in the bake)
    rooms.append({'kit': k, 'ob': ob, 'em': em, 'occ': oc, 'win': wn, 'off': (dx, dz)})
TRIS = {r['kit'].key: sum(lib.triangles(o) for o in (r['ob'], r['em'], r['win']) if o) for r in rooms}
log('triangles (exported):', TRIS)

# ---------------------------------------------------------------- lightmap UVs: the unit's lit areas in one atlas,
# sized so every unit has the same texel density (texels per unit length): size = density * sqrt(area / UV coverage)
def mesh_area(ob): return sum(p.area for p in ob.data.polygons)
def uv_coverage(obs):
    tot = 0.0
    for ob in obs:
        uv = ob.data.uv_layers['LightMap'].data
        for p in ob.data.polygons:
            pts = [uv[i].uv for i in p.loop_indices]
            tot += abs(sum(pts[i].x * pts[(i + 1) % len(pts)].y - pts[(i + 1) % len(pts)].x * pts[i].y for i in range(len(pts)))) / 2
    return tot
def unwrap_and_pack(margin_frac, project):
    bpy.ops.object.select_all(action='DESELECT')
    for r in rooms:
        r['ob'].data.uv_layers.active = r['ob'].data.uv_layers['LightMap']; r['ob'].select_set(True)
    bpy.context.view_layer.objects.active = rooms[0]['ob']
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    if project: bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    try: bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, margin_method='FRACTION', margin=margin_frac, shape_method='CONCAVE')
    except TypeError: bpy.ops.uv.pack_islands(rotate=True, margin=margin_frac)
    bpy.ops.object.mode_set(mode='OBJECT')
    for r in rooms: r['ob'].data.uv_layers.active = r['ob'].data.uv_layers['UVMap']
t = time.perf_counter()
AREA = sum(mesh_area(r['ob']) for r in rooms)
unwrap_and_pack(4.0 / 2048, True)
COVER = uv_coverage([r['ob'] for r in rooms])
SIZE = A.atlas or int(min(A.max_size, max(512, math.ceil(A.density * math.sqrt(AREA / max(COVER, 1e-3)) / 64) * 64)))
BAKE = A.bake_size or SIZE                         # R4a: the high tier's bake (a whole multiple of the atlas)
if BAKE % SIZE: raise RuntimeError('--bake-size must be a whole multiple of the atlas size')
MARGIN = 6 * BAKE // SIZE
unwrap_and_pack(4.0 / SIZE, False)                 # re-pack with a 4-texel margin at the final size
COVER = uv_coverage([r['ob'] for r in rooms])
DENSITY = SIZE * math.sqrt(COVER / AREA)
phase('uv', t)
log('unit', UNIT, '| surface', round(AREA, 1), 'units^2 | UV coverage', round(COVER, 3), '| atlas', SIZE, 'px |', round(DENSITY, 1), 'texels per unit')

# ---------------------------------------------------------------- lights: day (sun + sky), evening (LEDs, lamps, fill)
def add_light(name, kind, loc3, energy, color, **kw):
    li = bpy.data.lights.new(name, kind); li.energy = energy; li.color = color
    for key, v in kw.items(): setattr(li, key, v)
    ob = bpy.data.objects.new(name, li); scene.collection.objects.link(ob); ob.location = lib.to_bl(loc3); return ob
def aim(ob, emit3, along3=None):     # a light emits along its local -Z; along: its local X (area light length)
    z = -Vector(lib.to_bl(emit3)).normalized()
    x = Vector(lib.to_bl(along3)).normalized() if along3 else z.orthogonal().normalized()
    x = (x - z * x.dot(z)).normalized(); y = z.cross(x)
    ob.rotation_euler = Matrix((x, y, z)).transposed().to_euler()

DAYL, EVEL = LOOK['day'], LOOK['evening']
sun_dir = Vector((22, 17, 11)).normalized()       # office.js SUN_POS (R2): the same light direction as the live scene
sun = add_light('sun', 'SUN', (0, 0, 0), DAYL['sun'], lib.lin('#ffefd8'), angle=math.radians(4))
aim(sun, tuple(-sun_dir))
DAY, EVE = [sun], []
for r in rooms:
    k, ox = r['kit'], Vector((r['off'][0], 0, r['off'][1]))
    for s in k.leds:
        if lib.LED_W_PER_M[s['kind']] <= 0: continue
        a, b = Vector(s['a']) + ox, Vector(s['b']) + ox; L = (b - a).length; e = Vector(s['emit'])
        ob = add_light('led_' + k.key + '_' + s['kind'], 'AREA', tuple((a + b) / 2 + e * 0.01), lib.LED_W_PER_M[s['kind']] * L * EVEL['ledGain'], lib.lin('#ffb466'), shape='RECTANGLE', size=L, size_y=0.025)
        ob.data.spread = math.radians(150)
        aim(ob, tuple(e), tuple(b - a)); EVE.append(ob)
    for i, bp in enumerate(k.bulbs):
        ob = add_light('lamp_' + k.key + '_%d' % i, 'SPOT', tuple(Vector(bp) + ox), EVEL['lamp'], lib.lin('#ffc684'), spot_size=math.radians(115), spot_blend=0.6, shadow_soft_size=0.04)
        aim(ob, (0.12, -1, -0.25)); EVE.append(ob)
    # the area's other lights: evening energy 'energy'; R4a: an optional day energy 'day' (pendants, wall lamps, the
    # daylight behind the windows), one light object per mode that uses it
    for i, li in enumerate(k.lights):
        for mode, energy, into in (('evening', li.get('energy', 0.0), EVE), ('day', li.get('day', 0.0), DAY)):
            if energy <= 0: continue
            name = k.key + '_%d_' % i + mode
            if li['type'] == 'SPOT':
                ob = add_light('spot_' + name, 'SPOT', tuple(Vector(li['pos']) + ox), energy, lib.lin(li['colour']), spot_size=math.radians(li['size']), spot_blend=li['blend'], shadow_soft_size=li['radius'])
                aim(ob, tuple(li['aim']))
            else:
                a, b = Vector(li['a']) + ox, Vector(li['b']) + ox; L = (b - a).length
                ob = add_light('strip_' + name, 'AREA', tuple((a + b) / 2), energy, lib.lin(li['colour']), shape='RECTANGLE', size=L, size_y=li.get('size_y', 0.03))
                ob.data.spread = math.radians(li.get('spread', 150)); aim(ob, tuple(li['aim']), tuple(b - a))
            into.append(ob)

world = bpy.data.worlds.new('world'); scene.world = world
try: world.use_nodes = True
except Exception: pass
bg = world.node_tree.nodes.get('Background')
MODES = {'day': {'world': (lib.lin(DAYL['sky']), DAYL['skyStrength']), 'on': DAY}, 'evening': {'world': (lib.lin(EVEL['sky']), EVEL['skyStrength']), 'on': EVE}}
def tint_of(name, mode):
    """a tinted texture's colour factor: the themed colour over the texture's average, per channel, in linear light"""
    t = lib.tex_of(name); mean = lib.lin(lib.TEX[t][2]); c = lib.lin(THEMES[mode][name])
    return tuple(c[i] / max(mean[i], 1e-4) for i in range(3))
def set_mode(mode):
    m = MODES[mode]
    bg.inputs['Color'].default_value = (*m['world'][0], 1); bg.inputs['Strength'].default_value = m['world'][1]
    for ob in DAY + EVE: ob.hide_render = ob not in m['on']
    for name in MAT_ORDER:
        if name in THEMED:        # warm-white walls by day, dark by evening; tinted textures (rugs, upholstery)
            if lib.tex_of(name): lib.set_tint(MATS[name], tint_of(name, mode))
            else: lib.set_colour(MATS[name], THEMES[mode][name])
        if name in THEMED_TEX: lib.set_image(MATS[name], TEXIMG[THEMED_TEX[name][mode]])

# ---------------------------------------------------------------- Cycles on the GPU (OptiX, else CUDA, else CPU)
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
DEVICE = 'CPU'
for kind in ('OPTIX', 'CUDA'):
    try:
        prefs.compute_device_type = kind; prefs.refresh_devices()
        devs = [d for d in prefs.devices if d.type == kind]
        if devs:
            for d in prefs.devices: d.use = d.type == kind
            DEVICE = kind + ': ' + ', '.join(d.name for d in devs); break
    except Exception as e: log('device', kind, 'unavailable:', e)
scene.cycles.device = 'GPU' if DEVICE != 'CPU' else 'CPU'
scene.cycles.samples = A.samples
scene.cycles.max_bounces = 6; scene.cycles.diffuse_bounces = 4; scene.cycles.glossy_bounces = 1
scene.render.bake.margin = MARGIN; scene.render.bake.margin_type = 'EXTEND'
log('device:', DEVICE, '| samples:', A.samples)

def bake(mode):
    set_mode(mode)
    img = bpy.data.images.new('lm_' + mode, BAKE, BAKE, alpha=True, float_buffer=True)
    img.generated_color = (0, 0, 0, 0)
    nodes = []
    for name in MAT_ORDER:
        if name in UNLIT: continue
        m = MATS[name]; n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img; m.node_tree.nodes.active = n; nodes.append((m, n))
    bpy.ops.object.select_all(action='DESELECT')
    for r in rooms: r['ob'].select_set(True)
    bpy.context.view_layer.objects.active = rooms[0]['ob']
    t = time.perf_counter()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, uv_layer='LightMap', margin=MARGIN, margin_type='EXTEND', use_clear=True, target='IMAGE_TEXTURES')
    phase('bake_' + mode, t)
    for m, n in nodes: m.node_tree.nodes.remove(n)
    px = np.empty(BAKE * BAKE * 4, np.float32); img.pixels.foreach_get(px)
    return px.reshape(-1, 4)

def write_lightmap(mode, px):
    cov = px[:, 3] > 0.5
    lum = (px[:, :3] * np.array([0.2126, 0.7152, 0.0722], np.float32)).sum(axis=1)
    p995 = float(np.percentile(lum[cov], 99.5)) if cov.any() else 1.0
    k = max(1e-4, p995 / 0.92)                      # stored = light / k, so 99.5% of texels keep headroom below white
    v = np.clip(px[:, :3] / k, 0, 1)
    v = np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)   # sRGB-encode: more steps in the dark
    out = np.ones((px.shape[0], 4), np.float32); out[:, :3] = v
    img = bpy.data.images.new('lm8_' + mode, BAKE, BAKE, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    name = 'lightmap-' + UNIT + '-' + mode + '.png'
    img.pixels.foreach_set(out.ravel()); img.filepath_raw = out_path('.build/' + name); img.file_format = 'PNG'; img.save()
    return {'png': name, 'scale': round(k, 6), 'p995': round(p995, 5), 'max': round(float(lum.max()), 4), 'coverage': round(float(cov.mean()), 4)}

LM = {}
for mode in ('day', 'evening'): LM[mode] = write_lightmap(mode, bake(mode))

# ---------------------------------------------------------------- export: each area's lit mesh and LED mesh at its own
# origin (the page places each area at its corner of the floor plan); occluders and lights stay behind. Tinted textures
# go out untinted and themed textures with whichever image is current: the page sets both per theme from the manifest.
t = time.perf_counter()
for name in MAT_ORDER: lib.untint(MATS[name])
bpy.ops.object.select_all(action='DESELECT')
for r in rooms:
    for ob in (r['ob'], r['em'], r['win']):
        if ob: ob.location = (0, 0, 0); ob.select_set(True)
for ob in DAY + EVE: ob.hide_render = True
opts = dict(filepath=out_path(UNIT + '.gltf'), export_format='GLTF_SEPARATE', export_texture_dir='textures', use_selection=True,
            export_image_format='JPEG', export_image_quality=82, export_jpeg_quality=82, export_texcoords=True, export_normals=True,
            export_materials='EXPORT', export_vertex_color='MATERIAL', export_lights=False, export_cameras=False, export_yup=True,
            export_apply=False, export_extras=False)
bpy.ops.export_scene.gltf(**opts)
phase('export', t)

info = {'unit': UNIT, 'device': DEVICE, 'samples': A.samples, 'size': SIZE, 'bakeSize': BAKE, 'surface': round(AREA, 2), 'uvCoverage': round(COVER, 4), 'density': round(DENSITY, 2),
        'lightmaps': LM, 'triangles': TRIS, 'phases': PHASES,
        'rooms': {r['kit'].key: {'node': 'room_' + r['kit'].key, 'leds': 'leds_' + r['kit'].key if r['em'] else None, 'windows': 'win_' + r['kit'].key if r['win'] else None, 'strips': r['kit'].leds, 'cushions': r['kit'].cushions} for r in rooms},
        'materials': MAT_ORDER, 'seconds': round(time.perf_counter() - T0, 2)}
with open(out_path('.build/bake.json'), 'w', encoding='utf-8') as f: json.dump(info, f, indent=2)
log('done in', info['seconds'], 's')
