# office_lib.py — R3a, R3b: the shared Blender library for the baked office. Every baked area (office_rooms.py: the
# three department rooms, the lounge and the atrium) is built from these pieces, so a desk, a chair or a plant is the
# same model everywhere, and every area uses the same few materials and textures (one oak floor for the whole office).
# Nothing here is area-specific.
#   materials  solid / leaf (vertex colour), oak, walnut, floor, fabric, upholstery, rug (shared photo textures; fabric
#              and upholstery share one), decal (the page's canvas atlas: mood board, whiteboard, framed pictures),
#              concrete (the page's canvas concrete), themed colours (walls, caps, skirting, the slab, the plinth, the
#              closet, the Design room's backing and credenza: one colour per theme, from the look), themed tints
#              (fabric, upholstery, rug: the shared texture times a colour per theme), a themed texture (design_wood:
#              oak by day, walnut by evening), led (unlit, real-time on the page)
#   furniture  desk (with drawer pedestals, optional L return), task chair, desk lamp, rug, shelves with binders, a
#              wall shelf with books and a trailing plant, a library bookcase, lockers, credenza, meeting table with
#              stools, easel, sofa, armchair, coffee table, side table, arc floor lamp, bench, printer, water cooler
#   plants     fiddle-leaf fig (tall), small pot plant, trailing shelf plant
#   wall items slat panel, mood board, whiteboard, framed picture (decals from the page's atlas), clock, LED strips
#   structure  room shell, wall runs, the slab, the core plinth, the services closet
# Coordinates: an area's own frame as in layout.js bakedRoomSpec (x along the back wall, y up, z towards the open front;
# a room's two back walls are the planes x = 0 and z = 0, inner faces at WT). Converted to Blender's z-up only when
# vertices are written. Seeded throughout, so a rebuild gives the same rooms. Licence of the outputs: this project;
# textures CC0 (ASSETS.md).
import bpy, math, os, random
import numpy as np
from mathutils import Vector, Matrix

# ---------------------------------------------------------------- colours and transforms
def srgb(h): return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
def lin1(x): return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
def lin(h): return tuple(lin1(c) for c in srgb(h))
def T(x=0, y=0, z=0, ry=0, rx=0, rz=0):         # translation * Ry * Rx * Rz (three.js Euler 'YXZ')
    return Matrix.Translation((x, y, z)) @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X') @ Matrix.Rotation(rz, 4, 'Z')
def to_bl(p): return (p[0], -p[2], p[1])        # three (x, y, z) -> Blender (x, -z, y)

# shared photo textures: file, real-world tile size (scene units ~ metres), target average colour (None: as photographed).
# The floor's tile size and colour, and the fabric's and rug's averages, come from the look (build-office.mjs), because
# the page draws the same textures (the procedural floors) and tints them (bakedlook.js).
TEX = {
    'oak':    ['oak_veneer_01_diff_1k.jpg', 1.2, None],              # slats, shelves, frames, easel, bookcase, desk tops
    'walnut': ['walnut_veneer_diff_1k.jpg', 1.6, None],              # drawer fronts, Design desk tops by evening
    'floor':  ['wood_floor_diff_1k.jpg', 2.2, '#a47f58'],            # one mid-tone oak floor for the whole office
    'fabric': ['poly_wool_herringbone_diff_1k.jpg', 0.4, '#c8c3ba'], # upholstery (a light neutral; tinted per material)
    'rug':    ['hessian_230_diff_1k.jpg', 0.45, '#a9a6a1'],          # rugs (a light neutral; tinted dark grey)
    # R4a, the warm Office: a light wood (the oak photo shifted), and two textures made here (seeded; no file, no download)
    'lightwood': ['oak_veneer_01_diff_1k.jpg', 1.2, '#cfb08a'],      # desks, shelving, bookcase, the floor band and deck
    'tile':   [None, 1.8, None],                                     # large-format floor tile with grout (gen_tile)
    'plaster': [None, 2.0, '#e9e2d6'],                               # low-contrast wall plaster, tinted per theme (gen_plaster)
}
GEN_PX = {'tile': 1024, 'plaster': 512}                              # generated textures' sizes (the grout needs the pixels)
WARM = None                                                          # the look's warm part (configure())
MAT_TEX = {'upholstery': 'fabric', 'design_wood': 'walnut', 'wall_warm': 'plaster', 'rug_warm': 'rug', 'fabric_warm': 'fabric'}           # materials drawing a shared texture under another name
UV_SCALE = {'concrete': 6.4}                                         # the page's canvas concrete, at the procedural scale
def tex_of(mat): return MAT_TEX.get(mat, mat if mat in TEX else None)
def uv_scale(mat):
    t = tex_of(mat)
    return TEX[t][1] if t else UV_SCALE.get(mat, 1.0)
TEX_PX = 512
C = {
    'backing': '#141416', 'pedestal': '#2a2b2f', 'metal': '#1b1c1f', 'handle': '#8d8a84', 'pot': '#38342f', 'potRim': '#4a443d',
    'soil': '#2f261e', 'trunk': '#5f4a38', 'potSmall': '#c9b8a3', 'lamp': '#1c1c1f', 'canvas': '#ece6da', 'label': '#ece6da',
    'rugBorder': '#3d3c3b', 'caster': '#111113', 'frame': '#2a2a2d', 'mat': '#ece6da', 'locker': '#8e9096', 'seam': '#3a3b3f',
    'whiteboardFrame': '#b9bcc1', 'credenza': '#2e2f33', 'leather': '#6b4a35', 'mug': '#d8d2c8', 'box': '#c9bfae', 'vase': '#c2b8a8',
    'armchair': '#a2694a', 'shade': '#2b2b2e', 'inlay': '#a8916f', 'printer': '#d8d6d1', 'printerTop': '#c6c4bf', 'printerLid': '#55575d',
    'paper': '#f4f2ee', 'cooler': '#e4e2dd', 'water': '#8fc0e2', 'clockRim': '#2f3034', 'clockFace': '#f3f0ea', 'caseBack': '#6e5a47',
}
BINDERS = ['#1f3b5c', '#3a3a3c', '#8c2f2f', '#4a6a8a', '#e3ddd2', '#2f5d50', '#b5533c', '#d9b26f']
BOOKS = ['#7b2d26', '#2f4858', '#3d5a40', '#8c6d46', '#5b5f97', '#b5533c', '#d9b26f', '#e8e1d4', '#3b3b3b', '#6b4e71', '#9a8f7a', '#2e5e6e', '#a3473a', '#c9c1b1']
LEAVES = ['#36612f', '#2f5a2b', '#3e6d35', '#2b5126']
TRAIL = ['#4f7f45', '#3e6d35', '#5d8c4f']
LED_W_PER_M = {'shelf': 16.0, 'cove': 14.0, 'board': 18.0, 'case': 7.0, 'ring': 0.0}
# faces the isometric camera (from +x, +y, +z) can never see, for boxes on each wall: left out to save geometry
HIDDEN = {'z': ('nx', 'ny', 'nz'), 'x': ('px', 'ny', 'nz')}       # local names (an 'x'-wall item is turned a quarter turn)

# ---------------------------------------------------------------- mesh builder (three.js-style frame)
class MB:
    def __init__(s, rng): s.v = []; s.f = []; s.m = []; s.uv = []; s.col = []; s.rng = rng
    def face(s, pts, mat, col='#ffffff', uvoff=(0, 0), uvs=None):
        pts = [Vector(p) for p in pts]
        n = (pts[1] - pts[0]).cross(pts[2] - pts[0])
        if n.length < 1e-12: return
        if uvs is None:      # planar UVs on the dominant axis, in tile units; the grain runs up walls and along x on floors
            n.normalize(); ax = max(range(3), key=lambda i: abs(n[i]))
            scale = uv_scale(mat)
            uvs = []
            for p in pts:
                u, v = (p.z, p.y) if ax == 0 else ((p.x, -p.z) if ax == 1 else (p.x, p.y))
                uvs.append((u / scale + uvoff[0], v / scale + uvoff[1]))
        base = len(s.v); s.v.extend(pts); s.f.append(list(range(base, base + len(pts)))); s.m.append(mat); s.uv.append(uvs)
        s.col.append(lin(col) if isinstance(col, str) else col)
    # an axis box centred at the local origin, transformed by M; skip: faces left out ('px','nx','py','ny','pz','nz')
    def box(s, w, h, d, M, mat, col='#ffffff', skip=(), uvoff=None):
        x, y, z = w / 2, h / 2, d / 2
        P = lambda a, b, c: tuple(M @ Vector((a, b, c)))
        faces = {'px': [(x, -y, z), (x, -y, -z), (x, y, -z), (x, y, z)], 'nx': [(-x, -y, -z), (-x, -y, z), (-x, y, z), (-x, y, -z)],
                 'py': [(-x, y, z), (x, y, z), (x, y, -z), (-x, y, -z)], 'ny': [(-x, -y, -z), (x, -y, -z), (x, -y, z), (-x, -y, z)],
                 'pz': [(-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)], 'nz': [(x, -y, -z), (-x, -y, -z), (-x, y, -z), (x, y, -z)]}
        off = uvoff if uvoff is not None else (s.rng.random(), s.rng.random())
        for k, q in faces.items():
            if k not in skip: s.face([P(*c) for c in q], mat, col, off)
    # a box with chamfered edges and corners (r: the chamfer), for upholstery and soft furniture; skip as box() (a part
    # is left out when its outward normal points mostly that way)
    def rbox(s, w, h, d, r, M, mat, col='#ffffff', skip=()):
        r = min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)
        H, A = (w / 2, h / 2, d / 2), (w / 2 - r, h / 2 - r, d / 2 - r)
        off = (s.rng.random(), s.rng.random())
        dirs = {'px': (1, 0, 0), 'nx': (-1, 0, 0), 'py': (0, 1, 0), 'ny': (0, -1, 0), 'pz': (0, 0, 1), 'nz': (0, 0, -1)}
        def emit(pts, nrm):
            nv = Vector(nrm).normalized()
            if any(nv.dot(Vector(dirs[k])) > 0.6 for k in skip): return
            p = [Vector(q) for q in pts]
            if (p[1] - p[0]).cross(p[2] - p[0]).dot(nv) < 0: p.reverse()
            s.face([tuple(M @ q) for q in p], mat, col, off)
        for ax in range(3):                                  # the six flat faces
            b, c = [i for i in range(3) if i != ax]
            for sg in (1, -1):
                pts = []
                for (u, v) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    q = [0, 0, 0]; q[ax] = sg * H[ax]; q[b] = u * A[b]; q[c] = v * A[c]; pts.append(q)
                n = [0, 0, 0]; n[ax] = sg; emit(pts, n)
        for ax in range(3):                                  # the twelve edge chamfers (along axis ax)
            b, c = [i for i in range(3) if i != ax]
            for sb in (1, -1):
                for sc in (1, -1):
                    pts = []
                    for (t, onb) in ((-1, True), (1, True), (1, False), (-1, False)):
                        q = [0, 0, 0]; q[ax] = t * A[ax]
                        q[b] = sb * (H[b] if onb else A[b]); q[c] = sc * (A[c] if onb else H[c]); pts.append(q)
                    n = [0, 0, 0]; n[b] = sb; n[c] = sc; emit(pts, n)
        for sx in (1, -1):                                   # the eight corner triangles
            for sy in (1, -1):
                for sz in (1, -1):
                    S = (sx, sy, sz)
                    pts = [[S[i] * (H[i] if i == j else A[i]) for i in range(3)] for j in range(3)]
                    emit(pts, S)
    # a cylinder along local y, centred at the origin (r0 bottom, r1 top), n sides
    def cyl(s, r0, r1, h, n, M, mat, col='#ffffff', caps=(True, True), outer=True):
        P = lambda a, b, c: tuple(M @ Vector((a, b, c)))
        ring = lambda r, y: [(math.cos(2 * math.pi * i / n) * r, y, -math.sin(2 * math.pi * i / n) * r) for i in range(n)]
        lo, hi = ring(r0, -h / 2), ring(r1, h / 2)
        for i in range(n):
            j = (i + 1) % n; q = [P(*lo[i]), P(*lo[j]), P(*hi[j]), P(*hi[i])]
            s.face(q if outer else list(reversed(q)), mat, col)
        if caps[1]: s.face([P(*p) for p in hi], mat, col)
        if caps[0]: s.face([P(*p) for p in reversed(lo)], mat, col)
    def sphere(s, r, M, mat, col, ws=8, hs=6):
        P = lambda a, b, c: tuple(M @ Vector((a, b, c)))
        pt = lambda i, j: (math.sin(math.pi * j / hs) * math.cos(2 * math.pi * i / ws) * r, math.cos(math.pi * j / hs) * r, -math.sin(math.pi * j / hs) * math.sin(2 * math.pi * i / ws) * r)
        for j in range(hs):
            for i in range(ws):
                q = [pt(i, j), pt(i, j + 1), pt(i + 1, j + 1), pt(i + 1, j)]
                if j == 0: q = [q[0], q[1], q[2]]
                elif j == hs - 1: q = [q[0], q[1], q[3]]
                s.face([P(*p) for p in q], mat, col)
    # a flat ring (annulus) in the local xz plane facing +y, n segments
    def ring(s, r0, r1, n, M, mat, col='#ffffff', phase=0.0):
        P = lambda a, c: tuple(M @ Vector((a, 0, c)))
        at = lambda r, i: (math.cos(phase + 2 * math.pi * i / n) * r, -math.sin(phase + 2 * math.pi * i / n) * r)
        for i in range(n):
            a0, a1, b1, b0 = at(r0, i), at(r0, i + 1), at(r1, i + 1), at(r1, i)
            s.face([P(*a0), P(*b0), P(*b1), P(*a1)], mat, col)
    # a quad facing local +z (w x h, centred), with UVs from a region of the page's atlas (three.js convention, v up);
    # Blender's v is flipped here because the glTF exporter flips it back, so the page samples the region as drawn
    def decal(s, w, h, M, region):
        u0, v0, u1, v1 = region; x, y = w / 2, h / 2
        P = lambda a, b: tuple(M @ Vector((a, b, 0)))
        s.face([P(-x, -y), P(x, -y), P(x, y), P(-x, y)], 'decal', '#ffffff', uvs=[(u0, 1 - v0), (u1, 1 - v0), (u1, 1 - v1), (u0, 1 - v1)])

# ---------------------------------------------------------------- an area being built: its meshes, LEDs and lights
class Kit:
    """one baked area: room (baked), em (unlit LED strips and bulbs), occ (bake-only occluders: the real-time monitors
    and keyboards, the walls round the atrium). S: the area spec (layout.js bakedRoomSpec), look: the shared look
    (build-office.mjs). role: material per role (the Design room uses themed ones), lights: the evening bake's other
    lights (floor lamps, the closet strip), cushions: the seat cushions as modelled (the seat-bounds test reads them)."""
    def __init__(s, spec, look, seed):
        s.S, s.look, s.key = spec, look, spec['key']
        s.rng = random.Random(seed)
        s.room, s.em, s.occ = MB(s.rng), MB(s.rng), MB(s.rng)
        s.win = MB(s.rng)                        # R4a: window panes (unlit on the page, left out of the bake so light comes in)
        s.bevel = 0.0                            # R4a: furniture edge chamfer for fbox (0: plain boxes, as every R3 area)
        s.leds, s.bulbs, s.lights, s.cushions = [], [], [], []
        s.W, s.D, s.FLOOR = spec['w'], spec['d'], spec['floor']
        s.WH, s.WT = spec.get('wallH', 2.7), spec.get('wallT', 0.18)
        s.PT = s.FLOOR + 0.02                    # top of the wood floor (office.js PT)
        s.DESK_Y = s.PT + 0.73                   # desk top centre (office.js deskY)
        s.wall = 'wall_' + s.key
        s.role = {'deskTop': 'oak', 'drawer': 'walnut', 'credenza': 'solid', 'credenzaTop': 'walnut', 'backing': 'solid', 'wood': 'oak', 'fabric': 'fabric', 'rug': 'rug'}
        # R4a: colours and book/binder colours per area (the warm Office overrides them; every other area keeps the defaults)
        s.C, s.BOOKS, s.BINDERS = dict(C), list(BOOKS), list(BINDERS)
    # placement on a back wall: 'z' (the back wall, faces +z) or 'x' (the left wall, faces +x); u along the wall, v out
    def fbox(s, w, h, d, M, mat, col='#ffffff', skip=(), uvoff=None):
        """a furniture box: chamfered edges when the area sets a bevel (R4a), else a plain box (the same random draws)"""
        if s.bevel > 0: s.room.rbox(w, h, d, s.bevel, M, mat, col, skip)
        else: s.room.box(w, h, d, M, mat, col, skip, uvoff)
    def on_wall(s, axis, u, y, v, rz=0):
        return T(u, y, s.WT + v, 0, 0, rz) if axis == 'z' else T(s.WT + v, y, u, math.pi / 2, 0, rz)

def led(k, a, b, emit, kind, thick=(0.014, 0.012)):
    """an LED strip from a to b (room frame), emitting along emit; drawn as a thin unlit box, lit in the evening bake"""
    a, b = Vector(a), Vector(b); d = b - a; L = d.length; mid = (a + b) / 2
    ry = math.atan2(-d.z, d.x) if abs(d.x) + abs(d.z) > 1e-6 else 0
    k.em.box(L, thick[0], thick[1], T(mid.x, mid.y, mid.z, ry), 'led', '#ffffff', skip=('ny',))
    k.leds.append({'a': [round(v, 4) for v in a], 'b': [round(v, 4) for v in b], 'emit': [round(v, 4) for v in Vector(emit).normalized()], 'kind': kind})

def spot(k, pos, aim, energy, colour='#ffc684', size=115, blend=0.6, radius=0.05):
    """an evening-bake spot light (a floor lamp's bulb), aimed along aim"""
    k.lights.append({'type': 'SPOT', 'pos': [round(v, 4) for v in pos], 'aim': list(aim), 'energy': energy, 'colour': colour, 'size': size, 'blend': blend, 'radius': radius})

# ---------------------------------------------------------------- shell: floor, walls (themed), caps, skirting, coves
def shell(k):
    W, D, PT, FLOOR, WH, WT = k.W, k.D, k.PT, k.FLOOR, k.WH, k.WT
    for w in k.S['walls']:
        if abs(w['at']) > 1e-6: raise RuntimeError(k.key + ': the room shell expects the back walls at x = 0 and z = 0')
    k.room.face([(0, PT, D), (W, PT, D), (W, PT, 0), (0, PT, 0)], 'floor', uvoff=(0.13, 0.41))
    k.room.face([(0, FLOOR, D), (W, FLOOR, D), (W, PT, D), (0, PT, D)], 'skirting')     # floor edge, front
    k.room.face([(W, FLOOR, D), (W, FLOOR, 0), (W, PT, 0), (W, PT, D)], 'skirting')     # floor edge, right
    for w in k.S['walls']:
        L, mid = w['to'] - w['from'], (w['from'] + w['to']) / 2
        if w['axis'] == 'x':   # the left wall (plane x = 0), inner face +x; its front end is open (a cut, in the cap colour)
            k.room.box(WT, WH, L, T(WT / 2, FLOOR + WH / 2, mid), k.wall, skip=('nx', 'nz', 'ny', 'py', 'pz'))
            k.room.box(WT + 0.04, WH, 0.04, T(WT / 2, FLOOR + WH / 2, w['to'] - 0.02), 'cap', skip=('nx', 'ny', 'py', 'nz'))
            k.room.box(WT + 0.04, 0.05, L, T(WT / 2, FLOOR + WH + 0.025, mid), 'cap', skip=('nx', 'ny', 'nz'))
            k.room.box(0.03, 0.1, L - WT, T(WT + 0.015, PT + 0.05, mid + WT / 2), 'skirting', skip=('nx', 'ny', 'nz'))
        else:                  # the back wall (plane z = 0), inner face +z; its right end is open (a cut)
            k.room.box(L, WH, WT, T(mid, FLOOR + WH / 2, WT / 2), k.wall, skip=('nz', 'nx', 'ny', 'py', 'px'))
            k.room.box(0.04, WH, WT + 0.04, T(w['to'] - 0.02, FLOOR + WH / 2, WT / 2), 'cap', skip=('nz', 'ny', 'py', 'nx'))
            k.room.box(L, 0.05, WT + 0.04, T(mid, FLOOR + WH + 0.025, WT / 2), 'cap', skip=('nz', 'ny', 'nx'))
            k.room.box(L - WT, 0.1, 0.03, T(mid + WT / 2, PT + 0.05, WT + 0.015), 'skirting', skip=('nz', 'ny', 'nx'))
    # cove LEDs where the floor meets both back walls (they wash up the walls in the evening)
    zb = xl = WT + 0.045
    led(k, (WT + 0.05, PT + 0.012, zb), (W - 0.05, PT + 0.012, zb), (0, 1, -0.35), 'cove')
    led(k, (xl, PT + 0.012, WT + 0.05), (xl, PT + 0.012, D - 0.05), (-0.35, 1, 0), 'cove')

def wall_run(k, w, mat, base_y):
    """a wall from an area spec (axis, at, from, to, h, open ends) on a floor at base_y: the wall (inner face towards +x
    or +z), its cap, its skirting and a cap on each open end"""
    WT, FLOOR, h = k.WT, k.FLOOR, w['h']
    L, mid = w['to'] - w['from'], (w['from'] + w['to']) / 2
    if w['axis'] == 'x':
        x = w['at'] + WT / 2
        k.room.box(WT, h, L, T(x, FLOOR + h / 2, mid), mat, skip=('nx', 'ny', 'py', 'nz'))
        k.room.box(WT + 0.04, 0.05, L, T(x, FLOOR + h + 0.025, mid), 'cap', skip=('nx', 'ny', 'nz'))
        k.room.box(0.03, 0.1, L, T(w['at'] + WT + 0.015, base_y + 0.05, mid), 'skirting', skip=('nx', 'ny', 'nz'))
        for e, open_ in zip((w['from'], w['to']), w['open']):
            if open_: k.room.box(WT + 0.04, h, 0.04, T(x, FLOOR + h / 2, e + (0.02 if e == w['from'] else -0.02)), 'cap', skip=('nx', 'ny', 'py', 'nz'))
    else:
        z = w['at'] + WT / 2
        k.room.box(L, h, WT, T(mid, FLOOR + h / 2, z), mat, skip=('nz', 'ny', 'py', 'nx'))
        k.room.box(L, 0.05, WT + 0.04, T(mid, FLOOR + h + 0.025, z), 'cap', skip=('nz', 'ny', 'nx'))
        k.room.box(L, 0.1, 0.03, T(mid, base_y + 0.05, w['at'] + WT + 0.015), 'skirting', skip=('nz', 'ny', 'nx'))
        for e, open_ in zip((w['from'], w['to']), w['open']):
            if open_: k.room.box(0.04, h, WT + 0.04, T(e + (0.02 if e == w['from'] else -0.02), FLOOR + h / 2, z), 'cap', skip=('nz', 'ny', 'py', 'nx'))

def occluder_wall(k, w):
    """a bake-only wall (it shades the area in the bake and is not exported): a neighbouring room's wall"""
    L, mid, h, WT = w['to'] - w['from'], (w['from'] + w['to']) / 2, w['h'], k.WT
    if w['axis'] == 'x': k.occ.box(WT, h + 0.05, L, T(w['at'] + WT / 2, k.FLOOR + h / 2, mid), 'solid', '#d0ccc4')
    else: k.occ.box(L, h + 0.05, WT, T(mid, k.FLOOR + h / 2, w['at'] + WT / 2), 'solid', '#d0ccc4')

# ---------------------------------------------------------------- wall pieces
def slat_panel(k, x0, x1, h=2.42):
    """a warm oak slat panel on the back wall from x0 to x1, on a backing (role 'backing': dark, or themed)"""
    zf, PT = k.WT, k.PT
    k.room.box(x1 - x0, h, 0.02, T((x0 + x1) / 2, PT + h / 2 + 0.04, zf + 0.01), k.role['backing'], k.C['backing'], skip=('nz', 'ny'))
    SLAT, GAPW = 0.046, 0.024
    for i in range(int((x1 - x0 - 0.02) / (SLAT + GAPW))):
        x = x0 + 0.035 + i * (SLAT + GAPW) + SLAT / 2
        k.fbox(SLAT, h, 0.03, T(x, PT + h / 2 + 0.04, zf + 0.035), k.role['wood'], skip=('nz', 'ny'), uvoff=(k.rng.random() * 4, k.rng.random() * 4))
    return zf + 0.05                                            # the panel's front face

def binders(k, x0, x1, y, depth_z, seed):
    r = random.Random(seed); x = x0
    while x < x1 - 0.1:
        roll = r.random()
        if roll < 0.12: x += 0.1 + r.random() * 0.15; continue
        if roll < 0.22 and x1 - x > 0.34:                  # a flat stack
            for i in range(2 + int(r.random() * 3)):
                k.room.box(0.28 - i * 0.015, 0.045, 0.22, T(x + 0.15, y + 0.0225 + i * 0.047, depth_z), 'solid', r.choice(k.BINDERS), skip=('ny',))
            x += 0.34; continue
        if roll < 0.3:                                        # a small vase
            k.room.cyl(0.05, 0.045, 0.16, 10, T(x + 0.07, y + 0.08, depth_z), 'solid', k.C['vase'], caps=(False, True)); x += 0.16; continue
        c = r.choice(k.BINDERS)
        for i in range(2 + int(r.random() * 4)):              # a run of binders, spines out, with blank label patches (no text)
            if x > x1 - 0.1: break
            h = 0.3 if r.random() < 0.7 else 0.24
            k.room.box(0.072, h, 0.24, T(x + 0.036, y + h / 2, depth_z), 'solid', c, skip=('ny', 'nz'))
            k.room.box(0.045, 0.06, 0.004, T(x + 0.036, y + h * 0.3, depth_z + 0.122), 'solid', k.C['label'], skip=('nz',))
            x += 0.076
        x += 0.02

def binder_shelf(k, x0, x1, y, z_wall, seed, depth=0.27):
    """an oak shelf on the back wall with binders, stacks and vases, and an LED strip under its front edge"""
    zc = z_wall + depth / 2
    k.fbox(x1 - x0, 0.045, depth, T((x0 + x1) / 2, y, zc), k.role['wood'], skip=('nz',))
    led(k, (x0 + 0.05, y - 0.03, z_wall + depth - 0.035), (x1 - 0.05, y - 0.03, z_wall + depth - 0.035), (0, -1, -0.45), 'shelf')
    binders(k, x0 + 0.06, x1 - 0.06, y + 0.0225, zc - 0.005, seed)

def bookcase(k, x0, x1, seed, depth=0.38, height=2.3):
    """the library wall: a tall oak bookcase on the back wall from x0 to x1, in bays and five levels, with procedural
    book spines (plain colours, no titles), runs of binders with blank labels, lying stacks, and an LED strip under each
    shelf (Research room)"""
    r, PT, zw, hid = random.Random(seed), k.PT, k.WT, HIDDEN['z']
    D, Hc, L, um, y0 = depth, height, x1 - x0, (x0 + x1) / 2, k.PT
    k.room.box(L, Hc, 0.03, T(um, y0 + Hc / 2, zw + 0.015), 'solid', k.C['caseBack'], skip=hid)
    k.fbox(L, 0.08, D, T(um, y0 + 0.04, zw + D / 2), k.role['wood'], skip=hid)
    k.fbox(L, 0.05, D, T(um, y0 + Hc - 0.025, zw + D / 2), k.role['wood'], skip=('nx', 'nz'))
    bays = max(1, round(L / 1.05)); bw = L / bays
    for b in range(bays + 1): k.fbox(0.04, Hc, D, T(x0 + b * bw, y0 + Hc / 2, zw + D / 2), k.role['wood'], skip=('ny', 'nz'))
    levels = 5; lh = (Hc - 0.13) / levels
    for lv in range(1, levels): k.fbox(L, 0.03, D, T(um, y0 + 0.08 + lv * lh, zw + D / 2), k.role['wood'], skip=('nx', 'nz'))
    zf = zw + D                                                # the bookcase's front plane
    for lv in range(levels):
        base, maxH = y0 + 0.08 + lv * lh + 0.015, lh - 0.06
        if lv > 0: led(k, (x0 + 0.04, base + lh - 0.035, zf - 0.03), (x1 - 0.04, base + lh - 0.035, zf - 0.03), (0, -1, -0.3), 'case')
        for b in range(bays):
            cu, end = x0 + b * bw + 0.04, x0 + (b + 1) * bw - 0.04
            while cu < end - 0.04:
                roll = r.random()
                if roll < 0.05: cu += 0.08 + r.random() * 0.14; continue                     # a gap
                if roll < 0.11 and end - cu > 0.3:                                             # a stack lying flat
                    for i in range(2 + int(r.random() * 3)):
                        k.room.box(0.26 - i * 0.015, 0.045, 0.21, T(cu + 0.14, base + 0.0225 + i * 0.047, zf - 0.13), 'solid', r.choice(k.BOOKS), skip=hid)
                    cu += 0.32; continue
                if roll < 0.3:                                                                  # a run of binders, blank labels
                    c = r.choice(k.BINDERS)
                    for i in range(2 + int(r.random() * 3)):
                        if cu >= end - 0.08: break
                        h = min(maxH, 0.32)
                        k.room.box(0.075, h, 0.27, T(cu + 0.0375, base + h / 2, zf - 0.135), 'solid', c, skip=hid)
                        k.room.box(0.045, 0.06, 0.004, T(cu + 0.0375, base + h * 0.3, zf + 0.001), 'solid', k.C['label'], skip=('nz', 'nx', 'ny'))
                        cu += 0.079
                    continue
                w, h, d = 0.03 + r.random() * 0.045, min(maxH, 0.2 + r.random() * 0.15), 0.19 + r.random() * 0.08
                k.room.box(w, h, d, T(cu + w / 2, base + h / 2, zf - d / 2), 'solid', r.choice(k.BOOKS), skip=hid)
                cu += w + 0.003

def trailing_plant(k, M):
    """a trailing plant in a small pot (M: the pot's base): a leafy crown and strands hanging forward (local +z)"""
    r = k.rng
    k.room.cyl(0.075, 0.058, 0.13, 10, M @ T(0, 0.065, 0), 'solid', k.C['potSmall'], caps=(False, True))
    k.room.sphere(0.11, M @ T(0, 0.17, 0), 'leaf', LEAVES[2], 6, 4)
    for du, n in ((-0.07, 4), (0.05, 6), (0.11, 3)):
        for i in range(n):
            k.room.sphere(0.045 + r.random() * 0.02, M @ T(du + (r.random() - 0.5) * 0.04, 0.1 - i * 0.075, 0.1 + min(i, 2) * 0.012), 'leaf', TRAIL[(i + n) % len(TRAIL)], 5, 3)

def wall_shelf(k, axis, u, length, y, seed):
    """a short oak wall shelf with upright books, a box and a trailing plant, and an LED strip under it"""
    r = random.Random(seed)
    k.fbox(length, 0.04, 0.26, k.on_wall(axis, u, y, 0.13), k.role['wood'], skip=('nz',))
    a = k.on_wall(axis, u - length / 2 + 0.04, y - 0.026, 0.235).to_translation(); b = k.on_wall(axis, u + length / 2 - 0.04, y - 0.026, 0.235).to_translation()
    out = k.on_wall(axis, u, 0, 0).to_3x3() @ Vector((0, -1, 0.45))
    led(k, tuple(a), tuple(b), tuple(out), 'shelf')
    cu = u - length / 2 + 0.12
    for i in range(4 + int(r.random() * 4)):
        w, h = 0.035 + r.random() * 0.035, 0.18 + r.random() * 0.1
        k.room.box(w, h, 0.18, k.on_wall(axis, cu + w / 2, y + 0.02 + h / 2, 0.14), 'solid', r.choice(k.BOOKS[:12]), skip=('ny', 'nz')); cu += w + 0.004
    k.room.box(0.22, 0.12, 0.16, k.on_wall(axis, u + length * 0.12, y + 0.08, 0.13), 'solid', k.C['box'], skip=('ny', 'nz'))
    trailing_plant(k, k.on_wall(axis, u + length / 2 - 0.2, y + 0.02, 0.14))

def frame(k, axis, u, y, w, h, region):
    """a framed picture: dark frame, a pale mat and the picture (a decal from the page's atlas: abstract, no text)"""
    k.fbox(w, h, 0.04, k.on_wall(axis, u, y, 0.02), 'solid', k.C['frame'], skip=('nz',))
    k.room.box(w - 0.07, h - 0.07, 0.004, k.on_wall(axis, u, y, 0.042), 'solid', k.C['mat'], skip=('nz', 'nx', 'px', 'ny', 'py'))
    k.room.decal(w - 0.24, h - 0.24, k.on_wall(axis, u, y, 0.046), region)

def clock(k, axis, u, y):
    """a wall clock: rim, face, twelve ticks and two hands (it shows no particular time)"""
    M = k.on_wall(axis, u, y, 0)
    k.room.cyl(0.21, 0.21, 0.04, 24, M @ T(0, 0, 0.02, 0, math.pi / 2), 'solid', k.C['clockRim'], caps=(False, True))
    k.room.cyl(0.185, 0.185, 0.004, 24, M @ T(0, 0, 0.042, 0, math.pi / 2), 'solid', k.C['clockFace'], caps=(False, True))
    for i in range(12):
        a = i * math.pi / 6
        k.room.box(0.012, 0.025 if i % 3 else 0.045, 0.004, M @ T(math.sin(a) * 0.155, math.cos(a) * 0.155, 0.046, 0, 0, -a), 'solid', k.C['clockRim'], skip=('nz',))
    k.room.box(0.016, 0.11, 0.006, M @ T(0, 0, 0.05, 0, 0, -2.1) @ T(0, 0.045, 0), 'solid', k.C['clockRim'], skip=('nz',))
    k.room.box(0.011, 0.15, 0.006, M @ T(0, 0, 0.054, 0, 0, -0.5) @ T(0, 0.065, 0), 'solid', k.C['clockRim'], skip=('nz',))

def mood_board(k, axis, u, y, w, h, region, v0=0.0):
    """a pinboard / mood board in an oak frame (its content is the page's procedural board: swatches, sketches, cards)"""
    k.fbox(w + 0.1, h + 0.1, 0.05, k.on_wall(axis, u, y, v0 + 0.025), k.role['wood'], skip=('nz',))
    k.room.decal(w, h, k.on_wall(axis, u, y, v0 + 0.052), region)

def whiteboard(k, axis, u, y, w, h, region):
    """a whiteboard with an aluminium frame and a marker tray (its content: the page's procedural whiteboard)"""
    k.room.box(w + 0.08, h + 0.08, 0.04, k.on_wall(axis, u, y, 0.02), 'solid', k.C['whiteboardFrame'], skip=('nz',))
    k.room.decal(w, h, k.on_wall(axis, u, y, 0.042), region)
    k.room.box(w * 0.6, 0.04, 0.08, k.on_wall(axis, u, y - h / 2 - 0.1, 0.06), 'solid', k.C['whiteboardFrame'])
    for i, c in enumerate(('#2f5d8a', '#b5533c', '#3d5a40')):
        k.room.box(0.12, 0.018, 0.018, k.on_wall(axis, u - w * 0.2 + i * 0.16, y - h / 2 - 0.07, 0.07), 'solid', c, skip=('ny',))

def board_light(k, axis, u, y, length, v=0.09):
    """a warm LED strip along the top of a board (v out from the wall), washing down over it"""
    a = k.on_wall(axis, u - length / 2, y, v).to_translation(); b = k.on_wall(axis, u + length / 2, y, v).to_translation()
    out = k.on_wall(axis, u, 0, 0).to_3x3() @ Vector((0, -1, -0.7))
    led(k, tuple(a), tuple(b), tuple(out), 'board')

def locker(k, axis, u, w=0.9, h=1.9):
    """a tall two-door locker against a wall"""
    PT = k.PT
    k.room.box(w, h, 0.5, k.on_wall(axis, u, PT + h / 2, 0.25), 'solid', k.C['locker'], skip=('ny', 'nz'))
    k.room.box(0.01, h - 0.08, 0.004, k.on_wall(axis, u, PT + h / 2, 0.502), 'solid', k.C['seam'], skip=('nz',))
    for s in (-1, 1): k.room.box(0.02, 0.16, 0.02, k.on_wall(axis, u + s * 0.06, PT + h * 0.55, 0.51), 'solid', k.C['handle'], skip=('nz',))
    for i in range(1, 4): k.room.box(w - 0.06, 0.006, 0.004, k.on_wall(axis, u, PT + h * i / 4, 0.502), 'solid', k.C['seam'], skip=('nz',))
    for i in range(3):    # vent slots near the top of each door
        for s in (-1, 1): k.room.box(0.22, 0.008, 0.004, k.on_wall(axis, u + s * 0.22, PT + h - 0.12 - i * 0.03, 0.502), 'solid', k.C['seam'], skip=('nz',))

def credenza(k, axis, u, length, seed):
    """a low credenza (role 'credenza': dark, or themed) with a wooden top, a few books, a small vase and a plant"""
    PT, r = k.PT, random.Random(seed)
    k.fbox(length, 0.62, 0.45, k.on_wall(axis, u, PT + 0.33, 0.24), k.role['credenza'], k.C['credenza'], skip=('ny', 'nz'))
    k.room.box(length + 0.04, 0.04, 0.48, k.on_wall(axis, u, PT + 0.66, 0.24), k.role['credenzaTop'], skip=('nz',))
    n = max(2, round(length / 0.6))
    for i in range(1, n): k.room.box(0.008, 0.54, 0.004, k.on_wall(axis, u - length / 2 + length * i / n, PT + 0.33, 0.466), 'solid', k.C['seam'], skip=('nz',))
    for i in range(3): k.room.box(0.3 - i * 0.02, 0.05, 0.22, k.on_wall(axis, u - length * 0.28, PT + 0.705 + i * 0.05, 0.22), 'solid', r.choice(k.BOOKS[:12]), skip=('ny',))
    k.room.cyl(0.06, 0.05, 0.24, 10, k.on_wall(axis, u + length * 0.05, PT + 0.8, 0.2), 'solid', k.C['vase'], caps=(False, True))
    small_plant(k, k.on_wall(axis, u + length * 0.3, PT + 0.68, 0.22), r.randint(1, 10 ** 6), scale=0.6)

# ---------------------------------------------------------------- floor pieces
def rug(k, x0, x1, z0, z1, y=None):
    """a rug: a dark border and the tinted rug texture (dark grey in every area; the tint is themed)"""
    y = k.PT if y is None else y
    k.room.box(x1 - x0, 0.012, z1 - z0, T((x0 + x1) / 2, y + 0.006, (z0 + z1) / 2), 'solid', k.C['rugBorder'], skip=('ny',))
    k.room.box(x1 - x0 - 0.2, 0.01, z1 - z0 - 0.2, T((x0 + x1) / 2, y + 0.017, (z0 + z1) / 2), k.role['rug'], skip=('ny',), uvoff=(0.3, 0.7))

def drawers(k, M, w, h, d, face):          # a drawer pedestal; face: the local side the drawers open to ('pz' or 'nx')
    k.fbox(w, h, d, M, 'solid', k.C['pedestal'], skip=('ny',))
    n = 3; gap = 0.012; fh = (h - 0.04 - gap * (n + 1)) / n
    for i in range(n):
        y = -h / 2 + 0.02 + gap + fh / 2 + i * (fh + gap)
        if face == 'pz':
            k.room.box(w - 0.03, fh, 0.016, M @ T(0, y, d / 2 + 0.008), k.role['drawer'], skip=('nz',))
            k.room.box(0.16, 0.014, 0.022, M @ T(0, y + fh * 0.28, d / 2 + 0.027), 'solid', k.C['handle'], skip=('nz',))
        else:
            k.room.box(0.016, fh, d - 0.03, M @ T(-w / 2 - 0.008, y, 0), k.role['drawer'], skip=('px',))
            k.room.box(0.022, 0.014, 0.16, M @ T(-w / 2 - 0.027, y + fh * 0.28, 0), 'solid', k.C['handle'], skip=('px',))

def desk_lamp(k, x, z):
    M = T(x - 0.82, k.DESK_Y + 0.03, z - 0.12, -0.5)
    k.room.cyl(0.095, 0.1, 0.025, 16, M @ T(0, 0.0125, 0), 'solid', k.C['lamp'], caps=(False, True))
    k.room.cyl(0.012, 0.012, 0.42, 6, M @ T(0, 0.21, 0.07, 0, 0.35), 'solid', k.C['lamp'], caps=(False, False))
    k.room.cyl(0.012, 0.012, 0.32, 6, M @ T(0, 0.46, 0.0, 0, -1.0), 'solid', k.C['lamp'], caps=(False, False))
    k.room.cyl(0.085, 0.03, 0.14, 14, M @ T(0, 0.5, -0.17, 0, 0.5), 'solid', k.C.get('deskShade', k.C['lamp']), caps=(False, True))
    bulb = M @ T(0, 0.45, -0.19)
    k.em.sphere(0.034, bulb, 'led', '#ffffff')
    k.bulbs.append(bulb.to_translation())

def chair(k, x, z):                     # an ergonomic task chair facing the desk (local -z); seat top at PT + 0.49
    M = T(x, k.PT, z)
    for i in range(5):
        R = M @ T(0, 0, 0, i * 2 * math.pi / 5)
        k.room.box(0.05, 0.035, 0.31, R @ T(0, 0.075, 0.155), 'solid', k.C['metal'], skip=('ny',))
        k.room.sphere(0.03, R @ T(0, 0.03, 0.3), 'solid', k.C['caster'], 6, 4)
    k.room.cyl(0.05, 0.05, 0.06, 10, M @ T(0, 0.08, 0), 'solid', k.C['metal'], caps=(False, True))
    k.room.cyl(0.028, 0.028, 0.3, 8, M @ T(0, 0.25, 0), 'solid', '#8f8f93', caps=(False, False))
    k.room.box(0.22, 0.05, 0.22, M @ T(0, 0.405, 0.02), 'solid', k.C['metal'], skip=('py',))
    k.fbox(0.52, 0.07, 0.5, M @ T(0, 0.455, 0), k.role['fabric'])
    k.room.box(0.06, 0.46, 0.04, M @ T(0, 0.62, 0.29, 0, 0.12), 'solid', k.C['metal'])                     # spine
    B = M @ T(0, 0.93, 0.31, 0, 0.15)                                                              # back, leaning back
    k.fbox(0.47, 0.6, 0.03, B, k.role['fabric'])
    for sx in (-1, 1): k.room.box(0.03, 0.62, 0.045, B @ T(sx * 0.245, 0, 0), 'solid', k.C['metal'])
    k.room.box(0.5, 0.03, 0.045, B @ T(0, 0.31, 0), 'solid', k.C['metal']); k.room.box(0.5, 0.03, 0.045, B @ T(0, -0.31, 0), 'solid', k.C['metal'])
    k.fbox(0.4, 0.11, 0.04, B @ T(0, -0.16, -0.03), k.role['fabric'])                                 # lumbar pad
    k.fbox(0.3, 0.12, 0.05, M @ T(0, 1.36, 0.36, 0, 0.15), k.role['fabric'])                          # headrest
    k.room.box(0.03, 0.14, 0.03, M @ T(0, 1.25, 0.35, 0, 0.15), 'solid', k.C['metal'])
    for sx in (-1, 1):
        k.room.box(0.035, 0.2, 0.035, M @ T(sx * 0.27, 0.56, 0.06), 'solid', k.C['metal'])
        k.room.box(0.075, 0.03, 0.27, M @ T(sx * 0.27, 0.675, 0.03), 'solid', '#2a2a2d')

def desk(k, dk):
    """a desk at the spec's desk position (top 2.1 x 0.95 in the room's 'deskTop' material, drawer pedestal, modesty
    panel; L return on the first desk of a row), its lamp, its chair and the bake-only occluders of the real-time
    monitor and keyboard"""
    x, z, PT, DY, top = dk['x'], dk['z'], k.PT, k.DESK_Y, k.role['deskTop']
    k.room.box(2.1, 0.06, 0.95, T(x, DY, z), top)
    drawers(k, T(x - 0.74, PT + 0.35, z + 0.02), 0.46, 0.68, 0.82, 'pz')
    k.room.box(0.04, 0.7, 0.84, T(x + 0.98, PT + 0.35, z), 'solid', k.C['metal'], skip=('ny',))
    k.room.box(1.4, 0.34, 0.02, T(x + 0.15, PT + 0.5, z - 0.4), 'solid', k.C['metal'])
    if dk['lshape']:
        k.room.box(0.6, 0.06, 0.95, T(x + 0.75, DY, z + 0.95), top)
        drawers(k, T(x + 0.79, PT + 0.35, z + 1.0), 0.48, 0.68, 0.8, 'nx')
    desk_lamp(k, x, z)
    chair(k, dk['chair']['x'], dk['chair']['z'])
    k.occ.box(1.3, 0.82, 0.05, T(x, DY + 0.03 + 0.72, z - 0.24, 20 * math.pi / 180), 'solid', '#202022')
    k.occ.box(0.46, 0.04, 0.26, T(x, DY + 0.05, z - 0.24, 20 * math.pi / 180), 'solid', '#202022')
    k.occ.box(0.56, 0.025, 0.18, T(x - 0.05, DY + 0.045, z + 0.14), 'solid', '#202022')

def meeting(k, pr):
    """the round meeting table with two stools (layout.js prop 'meeting'), a few papers and a mug"""
    PT, M = k.PT, T(pr['x'], k.PT, pr['z'], pr['yaw'])
    k.room.cyl(0.5, 0.5, 0.04, 28, M @ T(0, 0.74, 0), k.role['wood'])
    k.room.cyl(0.035, 0.035, 0.7, 8, M @ T(0, 0.37, 0), 'solid', k.C['metal'], caps=(False, False))
    k.room.cyl(0.26, 0.28, 0.025, 16, M @ T(0, 0.013, 0), 'solid', k.C['metal'], caps=(False, True))
    for sx in (-0.8, 0.8):
        k.room.cyl(0.19, 0.19, 0.05, 16, M @ T(sx, 0.48, 0.05), 'solid', k.C['leather'])
        k.room.cyl(0.025, 0.025, 0.45, 8, M @ T(sx, 0.23, 0.05), 'solid', k.C['metal'], caps=(False, False))
        k.room.cyl(0.16, 0.17, 0.02, 14, M @ T(sx, 0.01, 0.05), 'solid', k.C['metal'], caps=(False, True))
    k.room.box(0.3, 0.012, 0.22, M @ T(-0.12, 0.766, 0.05, 0.3), 'solid', k.C['label'], skip=('ny',))
    k.room.cyl(0.04, 0.035, 0.09, 10, M @ T(0.2, 0.805, -0.1), 'solid', k.C['mug'], caps=(False, True))

def easel(k, pr, region):
    """the easel (layout.js prop 'easel') with an abstract picture from the page's atlas"""
    M = T(pr['x'], k.PT, pr['z'], pr['yaw'])
    for sx in (-0.28, 0.28): k.fbox(0.035, 1.6, 0.035, M @ T(sx, 0.8, 0, 0, -0.08, -0.1 if sx > 0 else 0.1), k.role['wood'])
    k.fbox(0.035, 1.5, 0.035, M @ T(0, 0.75, 0.32, 0, 0.35), k.role['wood'])
    k.fbox(0.7, 0.035, 0.08, M @ T(0, 0.62, -0.06), k.role['wood'])
    Bd = M @ T(0, 0.93, -0.03, 0, -0.08)
    k.room.box(0.7, 0.55, 0.03, Bd, 'solid', k.C['canvas'])
    k.room.decal(0.64, 0.49, Bd @ T(0, 0, -0.017, math.pi), region)

def frame_of(o, y0):
    """the transform of a furniture item that faces local -z, turned by its yaw (layout.js), standing at height y0"""
    return T(o['x'], y0, o['z'], o.get('yaw', 0))

def cushion_rect(k, M, cw, cd, top):
    """record a seat cushion's top as modelled (room frame: x/z extents and height) for the seat-bounds test"""
    pts = [M @ Vector((sx * cw / 2, 0, sz * cd / 2)) for sx in (-1, 1) for sz in (-1, 1)]
    k.cushions.append({'x0': round(min(p.x for p in pts), 4), 'x1': round(max(p.x for p in pts), 4), 'z0': round(min(p.z for p in pts), 4), 'z1': round(max(p.z for p in pts), 4), 'top': round(top, 4)})

def sofa(k, o, SOFA, mat='upholstery'):
    """a three-seat sofa from the layout's SOFA dimensions (the cushions are the seats people sit on)"""
    F, L, arm, n = k.FLOOR, o['len'], SOFA['arm'], SOFA['cushions']
    M = frame_of(o, 0)
    k.room.rbox(L, 0.24, SOFA['depth'], 0.05, M @ T(0, F + 0.2, 0), mat, skip=('ny',))
    cw = (L - 2 * arm) / n
    for i in range(n):
        lx, ch = -L / 2 + arm + cw * (i + 0.5), 0.15
        C0 = M @ T(lx, SOFA['top'] - ch / 2, SOFA['cushionZ'])
        k.room.rbox(cw - 0.03, ch, SOFA['cushionD'], 0.05, C0, mat, skip=('ny',))
        cushion_rect(k, C0, cw - 0.03, SOFA['cushionD'], SOFA['top'])
    k.room.rbox(L - 0.3, 0.5, 0.2, 0.06, M @ T(0, F + 0.58, 0.34), mat, skip=('ny',))
    for sx in (-1, 1): k.room.rbox(arm, 0.44, SOFA['depth'], 0.05, M @ T(sx * (L / 2 - arm / 2), F + 0.42, 0), mat, skip=('ny',))
    for lx, lz in ((-L / 2 + 0.1, -0.36), (L / 2 - 0.1, -0.36), (-L / 2 + 0.1, 0.36), (L / 2 - 0.1, 0.36)):
        k.room.cyl(0.025, 0.02, 0.1, 6, M @ T(lx, F + 0.05, lz), 'solid', k.C['metal'], caps=(False, False))

def armchair(k, o, A, col=None):
    """a leather armchair from the layout's ARMCHAIR dimensions (its cushion is a seat in the lounge)"""
    F, col = k.FLOOR, col or k.C['armchair']
    M = frame_of(o, 0)
    k.room.rbox(A['w'], 0.24, 0.85, 0.05, M @ T(0, F + 0.2, 0), 'solid', col, skip=('ny',))
    ch = 0.14; C0 = M @ T(0, A['top'] - ch / 2, A['cushionZ'])
    k.room.rbox(A['cushionW'], ch, A['cushionD'], 0.05, C0, 'solid', col, skip=('ny',))
    cushion_rect(k, C0, A['cushionW'], A['cushionD'], A['top'])
    k.room.rbox(A['w'], 0.55, 0.18, 0.06, M @ T(0, F + 0.55, 0.34), 'solid', col, skip=('ny',))
    for sx in (-1, 1): k.room.rbox(0.14, 0.42, 0.8, 0.05, M @ T(sx * 0.39, F + 0.42, 0.02), 'solid', col, skip=('ny',))
    for lx, lz in ((-0.36, -0.34), (0.36, -0.34), (-0.36, 0.34), (0.36, 0.34)):
        k.room.cyl(0.025, 0.02, 0.1, 6, M @ T(lx, F + 0.05, lz), 'solid', k.C['metal'], caps=(False, False))

def coffee_table(k, t):
    """the lounge's coffee table: an oak top on four legs, two books and a small plant"""
    F = k.FLOOR
    k.room.rbox(t['w'], 0.05, t['d'], 0.02, T(t['x'], F + 0.42, t['z']), k.role['wood'])
    for sx, sz in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        k.room.box(0.04, 0.4, 0.04, T(t['x'] + sx * (t['w'] / 2 - 0.08), F + 0.2, t['z'] + sz * (t['d'] / 2 - 0.08)), 'solid', k.C['metal'], skip=('ny', 'py'))
    k.room.box(0.34, 0.05, 0.26, T(t['x'] - 0.3, F + 0.47, t['z'] + 0.1, 0.3), 'solid', k.BOOKS[4], skip=('ny',))
    k.room.box(0.3, 0.04, 0.22, T(t['x'] - 0.3, F + 0.515, t['z'] + 0.1, 0.2), 'solid', k.BOOKS[7], skip=('ny',))
    small_plant(k, T(t['x'] + 0.35, F + 0.445, t['z'] - 0.15), 71, scale=0.55)

def side_table(k, x, z):
    """a small round side table with a book (the Research reading nook)"""
    F = k.FLOOR
    k.room.cyl(0.24, 0.24, 0.03, 16, T(x, F + 0.55, z), k.role['wood'])
    k.room.cyl(0.03, 0.03, 0.54, 8, T(x, F + 0.27, z), 'solid', k.C['metal'], caps=(False, False))
    k.room.cyl(0.16, 0.17, 0.02, 14, T(x, F + 0.01, z), 'solid', k.C['metal'], caps=(False, True))
    k.room.box(0.22, 0.05, 0.16, T(x, F + 0.59, z, 0.4), 'solid', k.BOOKS[1], skip=('ny',))

def floor_lamp(k, x, z, tx, tz, energy=90.0):
    """an arc floor lamp: base at (x, z), its shade reaching towards (tx, tz); its bulb is unlit (real-time on the page)
    and a warm spot light in the evening bake"""
    F, yaw = k.FLOOR, math.atan2(-(tx - x), -(tz - z))
    O = T(x, 0, z, yaw)
    k.room.cyl(0.17, 0.19, 0.04, 16, T(x, F + 0.02, z), 'solid', k.C['metal'], caps=(False, True))
    k.room.cyl(0.02, 0.02, 1.7, 8, T(x, F + 0.87, z), 'solid', k.C['metal'], caps=(False, False))
    k.room.box(0.03, 0.03, 0.75, O @ T(0, F + 1.78, -0.33, 0, 0.25), 'solid', k.C['metal'])
    k.room.cyl(0.2, 0.035, 0.22, 16, O @ T(0, F + 1.62, -0.68), 'solid', k.C['shade'], caps=(False, True))
    k.room.cyl(0.2, 0.035, 0.22, 16, O @ T(0, F + 1.62, -0.68), 'solid', '#e8dccb', caps=(False, False), outer=False)   # the shade's inside
    bulb = O @ T(0, F + 1.55, -0.68)
    k.em.sphere(0.06, bulb, 'led', '#ffffff')
    spot(k, tuple(bulb.to_translation()), (0, -1, 0), energy, size=130, blend=0.7)

def bench(k, o):
    """an atrium bench: three oak slats on two metal legs (layout.js prop 'bench')"""
    F, M = k.FLOOR, frame_of(o, 0)
    for i in range(3): k.fbox(1.7, 0.05, 0.13, M @ T(0, F + 0.45, -0.15 + i * 0.15), k.role['wood'])
    for sx in (-0.68, 0.68): k.room.box(0.05, 0.42, 0.4, M @ T(sx, F + 0.22, 0), 'solid', k.C['metal'], skip=('ny',))
    k.room.box(1.36, 0.035, 0.035, M @ T(0, F + 0.12, 0), 'solid', k.C['metal'])

def printer(k, o):
    """the office printer on its cabinet, with a scanner unit, an output tray with paper and a control panel"""
    F, M = k.FLOOR, frame_of(o, 0)
    k.room.rbox(0.9, 0.62, 0.62, 0.03, M @ T(0, F + 0.33, 0), 'solid', k.C['printer'], skip=('ny',))
    k.room.rbox(0.86, 0.34, 0.6, 0.03, M @ T(0, F + 0.81, 0.01), 'solid', k.C['printerTop'], skip=('ny',))
    k.room.box(0.62, 0.03, 0.42, M @ T(0, F + 1.0, 0.02), 'solid', k.C['printerLid'], skip=('ny',))
    k.room.box(0.5, 0.02, 0.26, M @ T(0.04, F + 0.67, -0.2), 'solid', k.C['paper'], skip=('ny',))
    k.room.box(0.2, 0.09, 0.012, M @ T(0.25, F + 0.9, -0.31, 0, -0.4), 'solid', k.C['metal'])
    for i in range(2): k.room.box(0.8, 0.006, 0.004, M @ T(0, F + 0.22 + i * 0.2, -0.312), 'solid', k.C['seam'], skip=('pz',))

def cooler(k, o):
    """a water cooler with its bottle, tap recess, drip tray and a cup bin beside it"""
    F, M = k.FLOOR, frame_of(o, 0)
    k.room.rbox(0.38, 0.95, 0.38, 0.03, M @ T(0, F + 0.475, 0), 'solid', k.C['cooler'], skip=('ny',))
    k.room.box(0.2, 0.12, 0.04, M @ T(0, F + 0.78, -0.2), 'solid', k.C['metal'], skip=('pz',))
    k.room.box(0.24, 0.02, 0.12, M @ T(0, F + 0.5, -0.19), 'solid', k.C['metal'])
    k.room.cyl(0.15, 0.15, 0.36, 14, M @ T(0, F + 1.16, 0), 'solid', k.C['water'], caps=(False, False))
    k.room.cyl(0.06, 0.15, 0.08, 14, M @ T(0, F + 1.38, 0), 'solid', k.C['water'], caps=(False, True))
    k.room.cyl(0.05, 0.05, 0.03, 10, M @ T(0.32, F + 0.02, -0.05), 'solid', k.C['box'], caps=(False, True))
    k.room.cyl(0.045, 0.035, 0.22, 10, M @ T(0.32, F + 0.13, -0.05), 'solid', k.C['label'], caps=(False, True))

# ---------------------------------------------------------------- structure: the slab, the core plinth, the closet
def slab(k):
    """the floor slab's visible sides (front and right, down to the ground) and its foot (themed 'slab')"""
    W, D, F = k.W, k.D, k.FLOOR
    k.room.face([(0, 0.05, D), (W, 0.05, D), (W, F, D), (0, F, D)], 'slab')
    k.room.face([(W, 0.05, D), (W, 0.05, 0), (W, F, 0), (W, F, D)], 'slab')
    e = 0.03                                                    # the foot: 3 cm proud of the slab, 5 cm high
    k.room.face([(-e, 0, D + e), (W + e, 0, D + e), (W + e, 0.05, D + e), (-e, 0.05, D + e)], 'slab')
    k.room.face([(W + e, 0, D + e), (W + e, 0, -e), (W + e, 0.05, -e), (W + e, 0.05, D + e)], 'slab')
    k.room.face([(-e, 0.05, D + e), (W + e, 0.05, D + e), (W, 0.05, D), (0, 0.05, D)], 'slab')
    k.room.face([(W, 0.05, D), (W + e, 0.05, D + e), (W + e, 0.05, -e), (W, 0.05, 0)], 'slab')

def concrete_floor(k, rects):
    """the atrium's polished concrete floor (themed colour times the page's canvas concrete) on the given rectangles"""
    F = k.FLOOR
    for r in rects: k.room.face([(r['x0'], F, r['z1']), (r['x1'], F, r['z1']), (r['x1'], F, r['z0']), (r['x0'], F, r['z0'])], 'concrete')

def plinth(k, cx, cz, R):
    """the memory core's octagonal plinth, its pedestal, the plaza disc and inlay ring, and an unlit LED ring on top
    (the crystal, its torus and its glow stay real-time on the page)"""
    F = k.FLOOR
    k.room.cyl(R - 0.27, R - 0.35, 0.12, 8, T(cx, F + 0.38, cz, math.pi / 8), 'plinth', caps=(False, True))
    k.room.cyl(R, R - 0.1, 0.32, 8, T(cx, F + 0.16, cz, math.pi / 8), 'plinth_edge', caps=(False, False))
    k.room.ring(R - 0.27, R - 0.1, 8, T(cx, F + 0.32, cz, math.pi / 8), 'plinth_edge')    # the top between the edge and the pedestal
    k.room.cyl(0.6, 0.46, 0.5, 6, T(cx, F + 0.66, cz), 'plinth_edge', caps=(False, True))
    k.room.cyl(R + 0.75, R + 0.75, 0.004, 48, T(cx, F + 0.002, cz), 'plaza', caps=(False, True))
    k.room.ring(R + 0.2, R + 0.27, 48, T(cx, F + 0.0045, cz), 'solid', k.C['inlay'])
    k.em.ring(R - 0.16, R - 0.12, 8, T(cx, F + 0.323, cz, math.pi / 8), 'led', '#ffffff')
    k.leds.append({'a': [round(cx, 4), round(F + 0.323, 4), round(cz, 4)], 'b': [round(cx, 4), round(F + 0.323, 4), round(cz, 4)], 'emit': [0, 1, 0], 'kind': 'ring'})

def closet(k, c, wall):
    """the services closet: its dark floor, the low partition (themed), the cable tray on its hangers, and a cool
    light along the tray in the evening bake (its LED strip, the cabinets' status lights and the cabinets themselves
    stay real-time on the page)"""
    F, WT = k.FLOOR, k.WT
    w, d, cxm, czm = c['x1'] - c['x0'], c['z1'] - c['z0'], (c['x0'] + c['x1']) / 2, (c['z0'] + c['z1']) / 2
    k.room.box(w - 0.1, 0.012, d - WT - 0.05, T(cxm + 0.05, F + 0.006, czm + WT / 2), 'closet_floor', skip=('ny', 'nx', 'nz'))
    wall_run(k, wall, 'closet_wall', F)
    tx = c['x0'] + WT + 0.45 - 0.05
    k.room.box(0.3, 0.06, d - WT - 0.3, T(tx, F + 2.35, czm + WT / 2), 'solid', k.C['metal'])
    for i in range(4): k.room.box(0.025, 0.4, 0.025, T(tx, F + 2.55, c['z0'] + WT + 0.3 + i * (d - WT - 0.6) / 3), 'solid', k.C['metal'], skip=('ny', 'py'))
    a, b = (tx + 0.17, F + 2.31, c['z0'] + WT + 0.2), (tx + 0.17, F + 2.31, c['z1'] - 0.2)
    k.lights.append({'type': 'AREA', 'a': list(a), 'b': list(b), 'aim': [0.3, -1, 0], 'energy': 9.0 * (b[2] - a[2]), 'colour': '#cfe2ff'})

# ---------------------------------------------------------------- plants
LEAF = [(0, 0), (0.28, 0.12), (0.42, 0.38), (0.34, 0.55), (0.46, 0.78), (0.3, 0.96), (0, 1.0), (-0.3, 0.96), (-0.46, 0.78), (-0.34, 0.55), (-0.42, 0.38), (-0.28, 0.12)]
def leaf(k, base, az, elev, length, width, roll, col):
    d = Vector((math.cos(elev) * math.cos(az), math.sin(elev), -math.cos(elev) * math.sin(az)))
    side = Vector((0, 1, 0)).cross(d).normalized(); up = d.cross(side).normalized()
    side = (side * math.cos(roll) + up * math.sin(roll)).normalized(); up = d.cross(side).normalized()
    pts = []
    for (sx, sz) in LEAF:
        sag = -0.12 * (sz ** 2) * length                       # the tip droops a little
        pts.append(tuple(Vector(base) + d * (sz * length) + side * (sx * width) + up * sag))
    k.room.face(list(reversed(pts)), 'leaf', col)           # wound so the face normal is the leaf's upper side

def fig(k, x, z, seed, y0=None, pot=None):
    """a fiddle-leaf fig in a tall dark pot (layout.js plant 'tall')"""
    r, PT = random.Random(seed), (k.PT if y0 is None else y0)
    k.room.cyl(0.26, 0.2, 0.5, 18, T(x, PT + 0.25, z), 'solid', pot or k.C['pot'], caps=(False, False))
    k.room.cyl(0.265, 0.265, 0.03, 18, T(x, PT + 0.5, z), 'solid', pot or k.C['potRim'], caps=(False, True))
    k.room.cyl(0.24, 0.24, 0.01, 14, T(x, PT + 0.47, z), 'solid', k.C['soil'], caps=(False, True))
    pts = [Vector((x, PT + 0.45, z)), Vector((x + 0.03, PT + 1.0, z - 0.02)), Vector((x - 0.02, PT + 1.5, z + 0.03)), Vector((x + 0.02, PT + 1.95, z))]
    for a, b in zip(pts, pts[1:]):
        d = b - a; L = d.length; mid = (a + b) / 2
        k.room.cyl(0.026, 0.02, L, 6, T(mid.x, mid.y, mid.z, 0, math.atan2(d.z, d.y), -math.atan2(d.x, d.y)), 'solid', k.C['trunk'], caps=(False, False))
    n = 34
    for i in range(n):
        t = i / (n - 1); y = PT + 1.0 + t * 1.0
        az = i * 2.39996 + r.random() * 0.3
        j = min(2, int(t * 3)); a, b = pts[j], pts[j + 1]; f = (y - a.y) / max(1e-6, b.y - a.y)
        c = a + (b - a) * max(0, min(1, f))
        elev = 0.55 - 0.75 * (1 - t) + (r.random() - 0.5) * 0.3
        leaf(k, (c.x + math.cos(az) * 0.04, y, c.z - math.sin(az) * 0.04), az, elev, 0.26 + r.random() * 0.1 + 0.06 * (1 - t), 0.19 + r.random() * 0.04, (r.random() - 0.5) * 0.6, LEAVES[i % len(LEAVES)])

def small_plant(k, M, seed, scale=1.0, pot=None):
    """a small pot plant (layout.js plant 'small'); M: the pot's base"""
    r = random.Random(seed); s = scale
    k.room.cyl(0.19 * s, 0.15 * s, 0.32 * s, 14, M @ T(0, 0.16 * s, 0), 'solid', pot or k.C['potSmall'], caps=(False, False))
    k.room.cyl(0.175 * s, 0.175 * s, 0.01, 12, M @ T(0, 0.3 * s, 0), 'solid', k.C['soil'], caps=(False, True))
    o = M.to_translation()
    for i in range(16):
        az = i * 2.39996; elev = 0.9 - (i % 4) * 0.22 + (r.random() - 0.5) * 0.2
        leaf(k, (o.x + math.cos(az) * 0.03 * s, o.y + (0.33 + (i % 3) * 0.04) * s, o.z - math.sin(az) * 0.03 * s), az, elev, (0.2 + r.random() * 0.06) * s, 0.12 * s, (r.random() - 0.5) * 0.5, LEAVES[(i + 1) % len(LEAVES)])

def plants(k, seed0=31, y0=None):
    """every plant the layout puts in the area (layout.js plants: 'tall' -> fig, otherwise a small pot plant)"""
    y0 = k.PT if y0 is None else y0
    for i, p in enumerate(k.S['plants']):
        if p['kind'] == 'tall': fig(k, p['x'], p['z'], seed0 + i, y0)
        else: small_plant(k, T(p['x'], y0, p['z']), seed0 + i)

# ---------------------------------------------------------------- Blender side: textures, materials, objects
def configure(look):
    """the floor's tile size and colour, and the fabric's and rug's averages, come from the look (bakedlook.js)"""
    global WARM
    TEX['floor'][1] = look['floor']['tile']; TEX['floor'][2] = look['floor']['colour']
    for name, t in look.get('textures', {}).items(): TEX[name][2] = t['mean']
    WARM = look.get('warm')
    if WARM:                 # R4a: the warm textures' targets and the tile's repeat from the look (warm-office.js)
        for name, t in WARM['textures'].items(): TEX[name][2] = t['mean']
        TEX['tile'][1] = WARM['tile']['texture']

def load_textures(tex_dir):
    """the shared photo textures at 512 px, shifted to their target colours; packed, so the exporter writes them once"""
    out = {}
    for name, (fname, _scale, target) in TEX.items():
        if fname is None:    # R4a: a texture made here (tile, plaster), seeded, already at its target colour
            if not WARM: continue
            n = GEN_PX[name]; px = gen_tile(n, WARM['tile']) if name == 'tile' else gen_plaster(n, target)
            img = bpy.data.images.new(name, n, n, alpha=False); img.colorspace_settings.name = 'sRGB'
            img.pixels.foreach_set(px.ravel()); img.update(); img.pack(); out[name] = img
            continue
        src = bpy.data.images.load(os.path.join(tex_dir, fname), check_existing=True)
        src.scale(TEX_PX, TEX_PX)
        px = np.empty(TEX_PX * TEX_PX * 4, np.float32); src.pixels.foreach_get(px); px = px.reshape(-1, 4)
        if target:
            mean = px[:, :3].mean(axis=0); tgt = np.array(srgb(target), np.float32)
            px[:, :3] = np.clip(px[:, :3] / np.maximum(mean, 1e-3) * tgt, 0, 1)
        img = bpy.data.images.new(name, TEX_PX, TEX_PX, alpha=False); img.colorspace_settings.name = 'sRGB'
        img.pixels.foreach_set(px.ravel()); img.update(); img.pack()
        out[name] = img
        if src.users == 0: bpy.data.images.remove(src)
    return out

def make_material(name, teximg, colour=None):
    m = bpy.data.materials.new(name)
    try: m.use_nodes = True
    except Exception: pass
    nt = m.node_tree; bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value = 0.85
    if 'Specular IOR Level' in bsdf.inputs: bsdf.inputs['Specular IOR Level'].default_value = 0.25
    m.use_backface_culling = name != 'leaf'
    t = tex_of(name)
    if name in ('solid', 'leaf'):
        vc = nt.nodes.new('ShaderNodeVertexColor'); vc.layer_name = 'Col'
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
    elif name == 'led':
        bsdf.inputs['Base Color'].default_value = (1, 0.85, 0.65, 1)
        bsdf.inputs['Emission Color'].default_value = (1, 0.72, 0.42, 1); bsdf.inputs['Emission Strength'].default_value = 0.0
    elif t:                   # a shared texture, times a tint (white unless themed) for the bake's bounce light
        tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = teximg[t]; tex.name = 'tex'
        uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'UVMap'
        mul = nt.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'; mul.name = 'tint'; mul.inputs[1].default_value = (1, 1, 1)
        nt.links.new(uvn.outputs['UV'], tex.inputs['Vector']); nt.links.new(tex.outputs['Color'], mul.inputs[0]); nt.links.new(mul.outputs['Vector'], bsdf.inputs['Base Color'])
    else:                     # flat colour: decal and concrete (bake stand-ins) and the themed colours (set per bake mode)
        bsdf.inputs['Base Color'].default_value = (*(colour or lin('#9a958d')), 1)
    return m

def set_colour(m, hexcol):
    m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (*lin(hexcol), 1)
def set_tint(m, rgb): m.node_tree.nodes['tint'].inputs[1].default_value = tuple(rgb)
def set_image(m, img): m.node_tree.nodes['tex'].image = img
def untint(m):
    """before export: the texture straight into the base colour (the page applies the tints itself)"""
    nt = m.node_tree
    if 'tint' not in nt.nodes: return
    nt.links.new(nt.nodes['tex'].outputs['Color'], nt.nodes.get('Principled BSDF').inputs['Base Color']); nt.nodes.remove(nt.nodes['tint'])

def make_object(scene, name, mb, mats, lightmap):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_bl(p) for p in mb.v], [], mb.f); me.update()
    order = list(mats.keys())
    used = sorted(set(mb.m), key=lambda n: order.index(n))
    for n in used: me.materials.append(mats[n])
    me.polygons.foreach_set('material_index', [used.index(n) for n in mb.m])
    uv = me.uv_layers.new(name='UVMap'); flat = []
    for f in mb.uv:
        for (u, v) in f: flat += [u, v]
    uv.data.foreach_set('uv', flat)
    ca = me.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='CORNER'); cols = []
    for f, c in zip(mb.f, mb.col): cols += [c[0], c[1], c[2], 1.0] * len(f)
    ca.data.foreach_set('color', cols)
    if lightmap: me.uv_layers.new(name='LightMap')
    me.uv_layers.active_index = 0
    for p in me.polygons: p.use_smooth = False
    me.update()
    ob = bpy.data.objects.new(name, me); scene.collection.objects.link(ob)
    return ob

def triangles(ob): return sum(len(p.vertices) - 2 for p in ob.data.polygons)

# ---------------------------------------------------------------- R4a: the warm office (config/warm-office.js)
# Textures made here, seeded, tileable (FFT noise wraps round): no photo, no download, no reference sampled.
def _noise(n, rng, sigma):
    """tileable smooth noise, zero mean, unit spread; sigma: the blur in pixels"""
    w = rng.standard_normal((n, n)); f = np.fft.fftfreq(n)
    g = np.exp(-2 * (math.pi * sigma) ** 2 * (f[:, None] ** 2 + f[None, :] ** 2))
    o = np.real(np.fft.ifft2(np.fft.fft2(w) * g))
    return (o - o.mean()) / (o.std() + 1e-9)

def gen_tile(n, t, seed=4041):
    """beige large-format tile, two by two tiles per texture, grout on the tile edges (the texture's edges and middle)
    and a little darkening at each tile's edge; each tile its own slight tone, soft clouding and a fine speckle (the
    unlit page shows no gloss, so the porcelain's variation is in the colour only)"""
    rng = np.random.default_rng(seed)
    base, grout = np.array(srgb(t['colour'])), np.array(srgb(t['grout']))
    half = n // 2
    yy, xx = np.mgrid[0:n, 0:n]
    tone = rng.uniform(-1, 1, (2, 2))[yy // half, xx // half]
    v = 1 + 0.022 * tone + 0.03 * _noise(n, rng, 70) + 0.012 * _noise(n, rng, 7) + 0.008 * _noise(n, rng, 0.8)
    col = np.clip(base[None, None, :] * v[:, :, None], 0, 1)
    gw = t['grout_w'] / t['texture'] * n                               # grout width in pixels
    d = np.minimum(np.minimum(xx % half, half - xx % half), np.minimum(yy % half, half - yy % half)).astype(np.float32)
    edge = np.clip((d - gw / 2) / 3.0, 0, 1)                           # 3 px of a slightly darker tile edge
    col = col * (0.965 + 0.035 * edge)[:, :, None]
    g = np.clip(d - gw / 2 + 0.5, 0, 1)                                # grout, anti-aliased by half a pixel
    gc = grout[None, None, :] * (1 + 0.02 * _noise(n, rng, 1.5))[:, :, None]
    col = col * g[:, :, None] + gc * (1 - g)[:, :, None]
    out = np.ones((n * n, 4), np.float32); out[:, :3] = np.clip(col.reshape(-1, 3), 0, 1)
    return out

def gen_plaster(n, mean, seed=4042):
    """a low-contrast plaster: soft clouding and a fine grain, averaging exactly `mean` (tinted per theme on the page)"""
    rng = np.random.default_rng(seed)
    v = 1 + 0.022 * _noise(n, rng, 24) + 0.012 * _noise(n, rng, 3) + 0.006 * _noise(n, rng, 0.7)
    m = np.array(srgb(mean))
    col = m[None, :] * v.reshape(-1, 1)
    col = col / col.mean(axis=0) * m
    out = np.ones((n * n, 4), np.float32); out[:, :3] = np.clip(col, 0, 1)
    return out

def warm_setup(k):
    """the warm look on an area's kit: materials per role, colours, books, the furniture bevel, thicker walls"""
    w = k.look['warm']
    k.role.update({'deskTop': 'lightwood', 'drawer': 'lightwood', 'wood': 'lightwood', 'fabric': 'fabric_warm', 'rug': 'rug_warm', 'credenzaTop': 'lightwood'})
    k.C.update({'pedestal': w['pedestal'], 'metal': w['metal'], 'lamp': w['metal'], 'deskShade': w['accents']['terracotta'], 'handle': '#b9a27f',
                'caseBack': '#e4d9c6', 'rugBorder': w['rug']['border'], 'leather': w['accents']['terracotta'], 'label': '#f1e9dc',
                'pot': w['pots']['brown'], 'potRim': '#8c6c52', 'potSmall': w['pots']['cream'], 'frame': '#7a5d45', 'mat': '#f4eee4',
                'box': '#d8c9b0', 'vase': w['accents']['sage'], 'caster': '#2a2826'})
    k.BOOKS = list(w['books']); k.BINDERS = [w['books'][i] for i in (0, 1, 2, 4, 5, 8)]
    k.bevel = 0.012
    k.WT = 0.32                               # thick walls: the inner faces move in (the room's outline stays the layout's)

def warm_shell(k, windows, sill, head):
    """the warm room's shell: thick cream plaster walls with bevelled caps and capped cut ends, the left wall a window
    wall (openings with light wood frames and sills; panes unlit on the page and left out of the bake, and a soft
    daylight behind each in the day bake), light wood skirting, the tiled floor framed by a light wood band on the
    room's open edges, and the plinth deck along the slab's front edge (a light wood fascia over a dark base)"""
    W, D, PT, F, WH, WT = k.W, k.D, k.PT, k.FLOOR, k.WH, k.WT
    w = k.look['warm']; B, sc, lw = w['band'], w['tile']['texture'], 'lightwood'
    for wl in k.S['walls']:
        if abs(wl['at']) > 1e-6: raise RuntimeError(k.key + ': the room shell expects the back walls at x = 0 and z = 0')
    # floor: tile (grout lines start at the inner wall faces), the band on the open front and right edges
    k.room.face([(WT, PT, D - B), (W - B, PT, D - B), (W - B, PT, WT), (WT, PT, WT)], 'tile', uvoff=(-WT / sc, WT / sc))
    k.room.face([(WT, PT, D), (W, PT, D), (W, PT, D - B), (WT, PT, D - B)], lw, uvoff=(0.21, 0.37))
    k.room.face([(W - B, PT, D - B), (W, PT, D - B), (W, PT, WT), (W - B, PT, WT)], lw, uvoff=(0.53, 0.11))
    k.room.face([(W, F, D), (W, F, 0), (W, PT, 0), (W, PT, D)], lw)                                  # the right edge (2 cm)
    # the plinth deck at the slab's front edge, 4 cm proud of the slab (it covers the atrium unit's slab face there)
    e, dk = 0.04, F - 0.06
    k.room.face([(0, dk, D + e), (W, dk, D + e), (W, PT, D + e), (0, PT, D + e)], lw)               # light wood fascia
    k.room.face([(0, PT, D + e), (W, PT, D + e), (W, PT, D), (0, PT, D)], lw)                       # its top lip
    k.room.face([(0, 0, D + e), (W, 0, D + e), (W, dk, D + e), (0, dk, D + e)], 'solid', w['plinth'])   # dark base
    k.room.face([(W, 0, D + e), (W, 0, D), (W, PT, D), (W, PT, D + e)], 'solid', w['plinth'])
    # the back wall (plane z = 0): plaster, a capped cut end at x = W, a bevelled cap, light wood skirting
    k.room.box(W, WH, WT, T(W / 2, F + WH / 2, WT / 2), 'wall_warm', skip=('nz', 'ny', 'py', 'nx', 'px'))
    k.room.box(0.03, WH, WT, T(W - 0.015, F + WH / 2, WT / 2), 'cap_warm', skip=('nz', 'ny', 'py', 'nx'))
    k.room.rbox(W + 0.03, 0.07, WT + 0.04, 0.03, T((W - 0.01) / 2, F + WH + 0.035, WT / 2), 'cap_warm', skip=('ny',))
    k.fbox(W - WT, 0.09, 0.025, T((W + WT) / 2, PT + 0.045, WT + 0.0125), lw, skip=('nz', 'ny'))
    # the left wall (plane x = 0): piers between the window openings, sills below them and headers above
    edges = [0.0] + [c for o in windows for c in o] + [D]
    for i in range(0, len(edges), 2):
        z0, z1 = edges[i], edges[i + 1]
        if z1 - z0 < 1e-6: continue
        sk = ('nx', 'ny', 'py') + (('nz',) if z0 == 0 else ()) + (('pz',) if z1 == D else ())
        k.room.box(WT, WH, z1 - z0, T(WT / 2, F + WH / 2, (z0 + z1) / 2), 'wall_warm', skip=sk)
    k.room.box(WT, WH, 0.03, T(WT / 2, F + WH / 2, D - 0.015), 'cap_warm', skip=('nx', 'ny', 'py', 'nz'))
    xp = WT * 0.4                                                     # the panes, set back in the reveal
    for z0, z1 in windows:
        L, zm = z1 - z0, (z0 + z1) / 2
        k.room.box(WT, sill - F, L, T(WT / 2, F + (sill - F) / 2, zm), 'wall_warm', skip=('nx', 'ny', 'py', 'nz', 'pz'))
        k.room.box(WT, F + WH - head, L, T(WT / 2, (head + F + WH) / 2, zm), 'wall_warm', skip=('nx', 'ny', 'py', 'nz', 'pz'))
        sw = WT - xp + 0.05
        k.room.rbox(sw, 0.04, L + 0.06, 0.01, T(xp + sw / 2, sill + 0.02, zm), lw, skip=('ny',))       # the sill
        fr = 0.05                                                     # the frame: jambs, a mullion, the head, a transom
        for zz, t in ((z0 + fr / 2, fr), (z1 - fr / 2, fr), (zm, 0.04)):
            k.room.rbox(0.05, head - sill - 0.04, t, 0.006, T(xp + 0.03, (sill + 0.04 + head) / 2, zz), lw, skip=('nx',))
        for yy, t in ((head - fr / 2, fr), (sill + 0.04 + (head - sill) * 0.66, 0.04)):
            k.room.rbox(0.05, t, L - 2 * fr, 0.006, T(xp + 0.03, yy, zm), lw, skip=('nx',))
        k.win.face([(xp, sill + 0.04, z1), (xp, sill + 0.04, z0), (xp, head, z0), (xp, head, z1)], 'window', '#ffffff')
        # daylight through the window (day bake only): a soft spot well outside, its cone just the window's size, aimed
        # down through the opening: the wall masks it, so the light falls across the floor as a window-shaped patch (with
        # the frame's shadows) and nothing spills over the wall top (there is no ceiling in the bake)
        WL = WINDOW_LIGHT; dx, dy = 1 / math.hypot(1, WL['slope']), -WL['slope'] / math.hypot(1, WL['slope'])
        cx, cy = WT / 2 - dx * WL['dist'], (sill + head) / 2 - dy * WL['dist']
        k.lights.append({'type': 'SPOT', 'pos': [round(cx, 4), round(cy, 4), round(zm, 4)], 'aim': (dx, dy, 0), 'energy': 0.0, 'day': WL['watts'] * L,
                         'colour': '#fff1dc', 'size': math.degrees(2 * math.atan(0.5 * math.hypot(L, head - sill) / WL['dist'])) * WL['cone'], 'blend': 0.15, 'radius': 0.25})
    k.room.rbox(WT + 0.04, 0.07, D - WT - 0.01, 0.03, T(WT / 2, F + WH + 0.035, (D + WT + 0.01) / 2 + 0.005), 'cap_warm', skip=('ny',))
    k.fbox(0.025, 0.09, D - WT, T(WT + 0.0125, PT + 0.045, (D + WT) / 2), lw, skip=('nx', 'ny'))
# day bake: the daylight through each window: a spot dist units outside, aimed down at slope (rise over run), its cone
# cone x the window's diagonal; watts per metre of window width, sized for a floor patch about 1.5 x the sunlit floor
WINDOW_LIGHT = {'dist': 5.0, 'slope': 1.0, 'cone': 0.92, 'watts': 3800.0}

def pendant(k, x, z, y, energy=40.0, day=10.0):
    """a dome pendant over a desk: a soft brown shade with a cream inside on a thin cable, a lit bulb (unlit, real-time
    on the page) and a warm pool of light on the desk in both bakes. Compact on purpose: in the isometric view anything
    hung over a desk crosses its monitor, and a dome sits behind the desk's label at overview zoom (R4a: a linear
    pendant along each row read as a dark beam across the monitors)"""
    top = k.FLOOR + k.WH + 0.3
    k.room.cyl(0.2, 0.07, 0.17, 20, T(x, y + 0.085, z), 'solid', k.look['warm']['accents']['brown'], caps=(False, True))
    k.room.cyl(0.198, 0.068, 0.17, 20, T(x, y + 0.085, z), 'solid', '#efe2cc', caps=(False, False), outer=False)
    k.room.cyl(0.005, 0.005, top - y - 0.17, 4, T(x, (y + 0.17 + top) / 2, z), 'solid', k.C['metal'], caps=(False, False))
    k.em.sphere(0.05, T(x, y + 0.05, z), 'led', '#ffffff', 8, 5)
    k.lights.append({'type': 'SPOT', 'pos': [round(x, 4), round(y + 0.03, 4), round(z, 4)], 'aim': (0, -1, 0), 'energy': energy, 'day': day, 'colour': '#ffcf94', 'size': 110, 'blend': 0.75, 'radius': 0.08})

def sconce(k, axis, u, y, energy=14.0, day=4.0):
    """a wall lamp: a small back plate and arm, an open drum shade in soft brown; warm light up and down the wall"""
    M = k.on_wall(axis, u, y, 0)
    k.room.rbox(0.09, 0.16, 0.02, 0.005, M @ T(0, 0, 0.01), 'solid', k.C['metal'], skip=('nz',))
    k.room.box(0.025, 0.025, 0.1, M @ T(0, 0, 0.07), 'solid', k.C['metal'])
    k.room.cyl(0.075, 0.075, 0.17, 16, M @ T(0, 0, 0.17), 'solid', k.look['warm']['accents']['brown'], caps=(False, False))
    k.room.cyl(0.074, 0.074, 0.17, 16, M @ T(0, 0, 0.17), 'solid', '#efe2cc', caps=(False, False), outer=False)
    k.em.sphere(0.035, M @ T(0, 0, 0.17), 'led', '#ffffff', 6, 4)
    p = (M @ T(0, 0, 0.17)).to_translation()
    for dy in (1, -1): k.lights.append({'type': 'SPOT', 'pos': [round(v, 4) for v in p], 'aim': (0, dy, 0), 'energy': energy, 'day': day, 'colour': '#ffc684', 'size': 80, 'blend': 0.7, 'radius': 0.04})

def desk_items(k, x, z, seed):
    """a mug, a notebook stack, a pen cup and a small succulent on a desk, clear of the real-time monitor, keyboard and
    status light (no text, no logo)"""
    r, Y = random.Random(seed), k.DESK_Y + 0.03
    a = k.look['warm']['accents']
    mug = r.choice([a['terracotta'], a['sage'], '#efe7da'])
    k.room.cyl(0.04, 0.037, 0.095, 12, T(x + 0.62, Y + 0.0475, z + 0.02), 'solid', mug, caps=(False, True))
    k.room.box(0.012, 0.05, 0.035, T(x + 0.665, Y + 0.05, z + 0.02), 'solid', mug, skip=('ny',))
    for i, c in enumerate(r.sample([a['brown'], a['sage'], '#e6dccb', a['terracotta']], 2)):
        k.room.rbox(0.22 - i * 0.02, 0.016, 0.29 - i * 0.02, 0.004, T(x - 0.5, Y + 0.008 + i * 0.017, z + 0.3, 0.15 + i * 0.1), 'solid', c, skip=('ny',))
    k.room.cyl(0.035, 0.035, 0.1, 10, T(x + 0.66, Y + 0.05, z - 0.36), 'solid', '#e6dccb', caps=(False, True))
    for dx, c in ((-0.012, '#2a2826'), (0.01, a['terracotta']), (0.0, '#5c4a3b')):
        k.room.cyl(0.004, 0.004, 0.14, 4, T(x + 0.66 + dx, Y + 0.12, z - 0.36 + dx, 0, dx * 5), 'solid', c, caps=(False, False))
    small_plant(k, T(x + 0.88, Y, z - 0.28), r.randint(1, 10 ** 6), scale=0.38, pot=k.look['warm']['pots']['terracotta'])

def meeting_warm(k, pr):
    """the round meeting table in light wood with a bevelled top, two terracotta stools, papers and a mug"""
    M = T(pr['x'], k.PT, pr['z'], pr['yaw'])
    k.room.cyl(0.5, 0.5, 0.03, 32, M @ T(0, 0.725, 0), 'lightwood', caps=(False, False))
    k.room.cyl(0.5, 0.485, 0.015, 32, M @ T(0, 0.7475, 0), 'lightwood')
    k.room.cyl(0.035, 0.035, 0.7, 8, M @ T(0, 0.36, 0), 'solid', k.C['metal'], caps=(False, False))
    k.room.cyl(0.26, 0.28, 0.025, 16, M @ T(0, 0.013, 0), 'solid', k.C['metal'], caps=(False, True))
    for sx in (-0.8, 0.8):
        k.room.cyl(0.19, 0.19, 0.04, 16, M @ T(sx, 0.47, 0.05), 'solid', k.C['leather'], caps=(False, False))
        k.room.cyl(0.19, 0.18, 0.012, 16, M @ T(sx, 0.496, 0.05), 'solid', k.C['leather'])
        k.room.cyl(0.025, 0.025, 0.45, 8, M @ T(sx, 0.23, 0.05), 'solid', k.C['metal'], caps=(False, False))
        k.room.cyl(0.16, 0.17, 0.02, 14, M @ T(sx, 0.01, 0.05), 'solid', k.C['metal'], caps=(False, True))
    k.room.rbox(0.3, 0.008, 0.22, 0.002, M @ T(-0.12, 0.759, 0.05, 0.3), 'solid', '#f4eee4', skip=('ny',))
    k.room.cyl(0.04, 0.035, 0.09, 10, M @ T(0.2, 0.8, -0.1), 'solid', '#efe7da', caps=(False, True))

def snake_plant(k, x, z, seed, pot):
    """a snake plant: upright blades, a little splayed, in a pot"""
    r, PT = random.Random(seed), k.PT
    k.room.cyl(0.17, 0.14, 0.32, 16, T(x, PT + 0.16, z), 'solid', pot, caps=(False, False))
    k.room.cyl(0.16, 0.16, 0.01, 14, T(x, PT + 0.3, z), 'solid', k.C['soil'], caps=(False, True))
    for i in range(11):
        az = i * 2.39996 + r.random() * 0.4; h = 0.5 + r.random() * 0.4; wd = 0.045 + r.random() * 0.025; lean = 0.08 + r.random() * 0.12
        b = Vector((x + math.cos(az) * 0.05, PT + 0.29, z - math.sin(az) * 0.05))
        d = Vector((math.cos(az) * lean, 1, -math.sin(az) * lean)).normalized(); s = Vector((-math.sin(az), 0, -math.cos(az)))
        k.room.face([tuple(b - s * wd), tuple(b + s * wd), tuple(b + d * h * 0.75 + s * wd * 0.8), tuple(b + d * h), tuple(b + d * h * 0.75 - s * wd * 0.8)], 'leaf', ['#3b5f34', '#4b6f3a', '#5d7f45'][i % 3])

def warm_rug(k, x0, x1, z0, z1):
    """a dark charcoal rug: a darker border round the textured field"""
    y = k.PT
    k.room.box(x1 - x0, 0.012, z1 - z0, T((x0 + x1) / 2, y + 0.006, (z0 + z1) / 2), 'solid', k.C['rugBorder'], skip=('ny',))
    k.room.box(x1 - x0 - 0.24, 0.01, z1 - z0 - 0.24, T((x0 + x1) / 2, y + 0.017, (z0 + z1) / 2), 'rug_warm', skip=('ny',), uvoff=(0.3, 0.7))

def desk_warm(k, dk, seed):
    """a desk in the warm look: a bevelled light wood top, a cream pedestal with light wood drawer fronts, a charcoal side
    panel, a cream modesty panel, the L return on the first desk of a row; its lamp, chair and desk items; the bake-only
    occluders of the real-time monitor and keyboard (as desk())"""
    x, z, PT, DY = dk['x'], dk['z'], k.PT, k.DESK_Y
    k.room.rbox(2.1, 0.06, 0.95, 0.014, T(x, DY, z), 'lightwood')
    drawers(k, T(x - 0.74, PT + 0.35, z + 0.02), 0.46, 0.68, 0.82, 'pz')
    k.fbox(0.04, 0.7, 0.84, T(x + 0.98, PT + 0.35, z), 'solid', k.C['metal'], skip=('ny',))
    k.fbox(1.4, 0.34, 0.02, T(x + 0.15, PT + 0.5, z - 0.4), 'solid', k.C['pedestal'])
    if dk['lshape']:
        k.room.rbox(0.6, 0.06, 0.95, 0.014, T(x + 0.75, DY, z + 0.95), 'lightwood')
        drawers(k, T(x + 0.79, PT + 0.35, z + 1.0), 0.48, 0.68, 0.8, 'nx')
    desk_lamp(k, x, z)
    chair(k, dk['chair']['x'], dk['chair']['z'])
    desk_items(k, x, z, seed)
    k.occ.box(1.3, 0.82, 0.05, T(x, DY + 0.03 + 0.72, z - 0.24, 20 * math.pi / 180), 'solid', '#202022')
    k.occ.box(0.46, 0.04, 0.26, T(x, DY + 0.05, z - 0.24, 20 * math.pi / 180), 'solid', '#202022')
    k.occ.box(0.56, 0.025, 0.18, T(x - 0.05, DY + 0.045, z + 0.14), 'solid', '#202022')
