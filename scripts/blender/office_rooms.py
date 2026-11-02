# office_rooms.py — R3a, R3b: the baked areas, each a recipe of office_lib.py pieces placed from the area's spec (layout.js
# bakedRoomSpec: footprint, desks, chairs, plants and props in the area's own frame; the lounge's furniture and seats;
# the atrium's floor, walls, closet and props). R3a: Design and Office; R3b: Research, the lounge and the atrium.
# Decals (mood board, whiteboard, pictures) use regions of the page's own procedural atlas (textures.js ATLAS), passed
# in the look as UV rectangles, so the baked rooms show the same abstract artwork as the procedural ones.
# R4a: the Office is the warm prototype (office() below); R4b rolls the warm look out to the other areas.
import math
import office_lib as lib

def clusters(S):
    """one rug per row of desks, as layout.js draws them"""
    rows = {}
    for d in S['desks']: rows.setdefault(round(d['z'], 3), []).append(d)
    return [(min(d['x'] for d in ds) - 1.55, max(d['x'] for d in ds) + 1.55, ds[0]['z'] - 0.95, ds[0]['z'] + 1.55) for _, ds in sorted(rows.items())]

def research(k):
    """the Research library: a tall bookcase along the back wall, a reading nook on the left wall (leather armchair, arc
    floor lamp, side table, a framed picture and a lit wall shelf), oak desks on their rug, two figs"""
    S, A, PT = k.S, k.look['atlas'], k.PT
    lib.shell(k)
    lib.bookcase(k, 0.35, k.W - 1.2, 31 + int(k.W * 10))
    nook = {'x': 1.25, 'z': 2.75, 'yaw': -math.pi * 0.62}
    lib.armchair(k, nook, {'w': 0.9, 'cushionW': 0.66, 'cushionD': 0.66, 'cushionZ': -0.05, 'top': k.FLOOR + 0.45})
    lib.floor_lamp(k, 0.55, 1.55, nook['x'], nook['z'])
    lib.side_table(k, 2.25, 3.55)
    lib.frame(k, 'x', 2.9, PT + 1.75, 0.95, 1.2, A['art'][0])
    lib.wall_shelf(k, 'x', 1.35, 1.2, PT + 1.55, 41)
    for c in clusters(S): lib.rug(k, *c)
    for dk in S['desks']: lib.desk(k, dk)
    lib.plants(k)

def design(k):
    """dark-evening studio: an oak slat panel with the mood board over the desks, binder shelves, a gallery of framed
    abstract pictures over a credenza on the left wall, the easel, a fig and a small plant. R3b: the slat backing, the
    desk tops, drawer fronts and credenza are themed, so the light-mode room is brighter (pale backing and credenza, oak
    tops) while the evening keeps the dark backing, walnut and the dark credenza"""
    S, A, PT, WT = k.S, k.look['atlas'], k.PT, k.WT
    k.role.update({'deskTop': 'design_wood', 'drawer': 'design_wood', 'credenzaTop': 'design_wood', 'credenza': 'design_credenza', 'backing': 'design_backing'})
    lib.shell(k)
    xs = [d['x'] for d in S['desks']]
    px0, px1 = min(xs) - 1.1, max(xs) + 1.3
    front = lib.slat_panel(k, px0, px1)
    bu = (min(xs) + max(xs)) / 2
    lib.mood_board(k, 'z', bu, PT + 1.68, 3.8, 1.35, A['board'], v0=front - WT)
    lib.board_light(k, 'z', bu, PT + 2.43, 3.6, front - WT + 0.1)
    lib.binder_shelf(k, WT + 0.32, px0 - 0.25, PT + 1.42, WT, 13, depth=0.26)
    lib.binder_shelf(k, WT + 0.32, px0 - 0.25, PT + 1.92, WT, 17, depth=0.26)
    # left wall: a gallery of three framed pictures over a credenza
    lib.credenza(k, 'x', 2.6, 2.2, 47)
    lib.frame(k, 'x', 1.45, PT + 1.65, 1.05, 1.3, A['art'][1])
    lib.frame(k, 'x', 2.75, PT + 1.75, 0.8, 1.0, A['art'][2])
    if k.D > 4.6: lib.frame(k, 'x', 3.95, PT + 1.7, 0.7, 0.9, A['art'][4])
    for c in clusters(S): lib.rug(k, *c)
    for dk in S['desks']: lib.desk(k, dk)
    lib.plants(k)
    for pr in S['props']:
        if pr['kind'] == 'easel': lib.easel(k, pr, A['art'][3])

def office(k):
    """R4a: the warm Office (config/warm-office.js; the owner's style direction from 02.png with 01-main.png's light wood
    edge band, plinth deck, desk and wall lamps and wall shelves; style only, nothing traced or copied). Thick cream
    plaster walls with bevelled caps; the left wall a window wall (three tall windows, daylight on the floor in the day
    bake); a beige large-format tiled floor in a light wood band; the plinth deck on the slab's front edge. On the back
    wall a light wood bookcase (blank spines), two wall shelves, two framed abstract pictures (the page's atlas) and two
    wall lamps. One dark charcoal rug under the department's whole desk cluster; light wood desks with cream pedestals,
    desk lamps, mugs and small desk items; a dome pendant over each desk; the round meeting table with
    terracotta stools; plants in warm pots. Walkways stay as the layout has them (nothing new on the agents' paths)."""
    S, A, PT, W, D = k.S, k.look['atlas'], k.PT, k.W, k.D
    w = k.look['warm']
    lib.warm_setup(k)
    WT = k.WT
    # three tall windows on the left wall, evenly spaced between the back wall and the front pier
    n, pier, front = 3, 0.9, 0.9
    span = D - WT - 0.55 - front
    ww = (span - (n - 1) * pier) / n
    wins = [(WT + 0.55 + i * (ww + pier), WT + 0.55 + i * (ww + pier) + ww) for i in range(n)]
    lib.warm_shell(k, wins, PT + 0.62, PT + 2.25)
    xs = sorted(d['x'] for d in S['desks']); zs = sorted(set(round(d['z'], 3) for d in S['desks']))
    # back wall: bookcase in the left corner, a wall lamp, two stacked shelves, a picture, a wall lamp, a picture over
    # the meeting table
    lib.bookcase(k, WT + 0.12, WT + 1.95, 83, depth=0.36, height=2.15)
    lib.sconce(k, 'z', WT + 2.45, PT + 1.95)
    sx = (xs[0] + xs[-1]) / 2 - 0.85
    lib.wall_shelf(k, 'z', sx, 1.5, PT + 1.38, 89)
    lib.wall_shelf(k, 'z', sx, 1.5, PT + 1.9, 97)
    lib.frame(k, 'z', sx + 1.95, PT + 1.65, 1.3, 0.95, A['art'][5])
    lib.sconce(k, 'z', sx + 3.0, PT + 1.95)
    mt = next((p for p in S['props'] if p['kind'] == 'meeting'), None)
    if mt: lib.frame(k, 'z', mt['x'], PT + 1.7, 0.85, 1.1, A['art'][0])
    # one rug per department: under the whole desk cluster
    lib.warm_rug(k, xs[0] - 1.55, xs[-1] + 1.55, zs[0] - 0.95, zs[-1] + 1.55)
    for i, dk in enumerate(S['desks']): lib.desk_warm(k, dk, 101 + i)
    # a dome pendant over each desk of the cluster (a warm pool on the desk)
    for dk in S['desks']: lib.pendant(k, dk['x'] + 0.1, dk['z'] - 0.05, PT + 2.1)
    if mt: lib.meeting_warm(k, mt)
    # plants: the layout's (a fig, a small plant) in warm pots, and two more by the window piers (off every path)
    P = w['pots']
    for i, p in enumerate(S['plants']):
        if p['kind'] == 'tall': lib.fig(k, p['x'], p['z'], 31 + i, pot=P['brown'])
        else: lib.small_plant(k, lib.T(p['x'], PT, p['z']), 31 + i, pot=P['terracotta'])
    lib.small_plant(k, lib.T(WT + 0.32, PT, (wins[0][1] + wins[1][0]) / 2), 61, scale=1.35, pot=P['sage'])
    lib.snake_plant(k, WT + 0.3, (wins[1][1] + wins[2][0]) / 2, 67, P['cream'])

def lounge(k):
    """the lounge: the oak floor (no walls: it sits at the slab's front corner), a dark rug, an L of two three-seat sofas,
    two leather armchairs, the coffee table, an arc floor lamp and three figs. The seats are built from the layout's
    SOFA and ARMCHAIR numbers, so every cushion stays where the walkers sit (the seat-bounds test reads them back)"""
    S, F, PT, W, D = k.S, k.FLOOR, k.PT, k.W, k.D
    k.room.face([(0, PT, D), (W, PT, D), (W, PT, 0), (0, PT, 0)], 'floor', uvoff=(0.37, 0.19))
    k.room.face([(0, F, D), (W, F, D), (W, PT, D), (0, PT, D)], 'skirting')                 # floor edge, front
    k.room.face([(W, F, D), (W, F, 0), (W, PT, 0), (W, PT, D)], 'skirting')                 # floor edge, right
    if S.get('open'): return                                                                 # B0: a business floor: open floor, the lounge is on floor 0
    f = S['furniture']
    r = f['rug']; lib.rug(k, r['x0'], r['x1'], r['z0'], r['z1'])
    lib.sofa(k, f['sofaA'], S['sofa']); lib.sofa(k, f['sofaB'], S['sofa'])
    lib.armchair(k, f['chair1'], S['armchair']); lib.armchair(k, f['chair2'], S['armchair'])
    lib.coffee_table(k, f['table'])
    lib.floor_lamp(k, f['lamp']['x'], f['lamp']['z'], f['table']['x'], f['table']['z'])
    lib.plants(k, 51)

def atrium(k):
    """the atrium: the slab, polished concrete outside the rooms and the lounge, the memory core's plinth (the crystal
    and its glow stay real-time), the atrium walls with a picture, a lit shelf and two clocks, the printer and the water
    cooler, five benches, plants, and the services closet (its cabinets and status lights stay real-time). The walls of
    the rooms round it are bake-only occluders, so they still shade the atrium floor"""
    S, A, F = k.S, k.look['atlas'], k.FLOOR
    lib.slab(k)
    lib.concrete_floor(k, S['floorRects'])
    lib.plinth(k, S['core']['x'], S['core']['z'], S['coreR'])
    for w in S['walls']:
        if w['owner'] == 'atrium': lib.wall_run(k, w, k.wall, F)
    for w in S['occluders']: lib.occluder_wall(k, w)
    pr = {p['kind']: p for p in S['props'] if p['kind'] in ('printer', 'cooler')}
    if 'printer' in pr:
        lib.frame(k, 'z', pr['printer']['x'], F + 2.08, 0.72, 0.5, A['art'][4])
        lib.wall_shelf(k, 'z', pr['printer']['x'], 1.0, F + 1.36, 67)
    if 'cooler' in pr: lib.clock(k, 'z', pr['cooler']['x'] + 0.05, F + 2.05)
    left = next((w for w in S['walls'] if w['owner'] == 'atrium' and w['axis'] == 'x'), None)
    if left:
        um = (left['from'] + left['to']) / 2
        lib.frame(k, 'x', um - 0.25, F + 1.6, 1.1, 0.75, A['art'][5])
        lib.clock(k, 'x', um + 0.95, F + 1.95)
    for p in S['props']: {'bench': lib.bench, 'printer': lib.printer, 'cooler': lib.cooler}[p['kind']](k, p)
    lib.plants(k, 71, F)
    lib.closet(k, S['closet'], next(w for w in S['walls'] if w['owner'] == 'closet'))

RECIPES = {'research': research, 'design': design, 'office': office, 'lounge': lounge, 'atrium': atrium}
