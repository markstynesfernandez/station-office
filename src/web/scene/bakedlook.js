// scene/bakedlook.js — R3a, R3b: what the baked areas share with the page's procedural ones, in one place. The Blender
// build (scripts/build-office.mjs) bakes with these values and writes them into the manifest; the page draws the
// procedural rooms' floor with the same oak texture at the same scale, and colours the baked areas per theme from the
// manifest. tests/baked-room.test.mjs checks the committed manifest still equals what this module gives, so a palette
// or atlas change shows up as a stale bake. No DOM: the build imports it in Node.
import * as THREE from 'three';
import { PALETTE } from '../config/palette.js';
import { ATLAS, atlasUV } from './textures.js';
import { warmLook } from '../config/warm-office.js';

// R3b: every area is baked (R3a: Design and Office). R4a: the Office room has the warm look (WARM_UNITS). A bake unit has its own lightmap atlas, so a change to one room
// re-bakes only that unit; the atrium and the lounge share one (they light each other).
export const BAKED_ROOMS = ['research', 'design', 'office', 'lounge', 'atrium'];
export const BAKE_UNITS = { research: ['research'], design: ['design'], office: ['office'], atrium: ['atrium', 'lounge'] };
export const WARM_UNITS = ['office'];          // R4a: the units built with the warm look (R4b: the rest)
export const unitOf = (key) => Object.keys(BAKE_UNITS).find((u) => BAKE_UNITS[u].includes(key)) || null;
export const FLOOR_OAK = { tile: 2.2, colour: '#a47f58', texture: 'textures/floor.jpg' };   // one mid-tone oak, every room
// shared textures the build shifts to a light neutral average; each material using one is tinted to its own colour
// (task chairs charcoal, sofas per theme, rugs dark grey per theme)
export const TEXTURE_MEANS = { fabric: '#c8c3ba', rug: '#a9a6a1' };
// materials whose texture changes with the theme (R3b, owner: a brighter Design room in light mode, the evening as it was)
export const THEMED_TEX = { design_wood: { day: 'oak', evening: 'walnut' } };
// the Design room's slat backing and credenza: pale by day (R3b), dark by evening (as R3a)
const DESIGN = { day: { backing: '#e3dbce', credenza: '#e8e1d6' }, evening: { backing: '#141416', credenza: '#2e2f33' } };

const hex = (c) => '#' + c.getHexString();
// the procedural rooms' wall colour (rooms.js): the theme's wall, tinted towards the department's accent
export const wallColour = (p, key) => hex(new THREE.Color(p.wall).lerp(new THREE.Color(PALETTE.departments[key] || PALETTE.departments.default), p.wallTint));
const ROOM_WALLS = ['research', 'design', 'office'];

// themed materials, one colour per theme (the light theme and the day bake; the dark theme and the evening bake):
// walls with the department tint (warm white by day, dark by evening, as the procedural rooms), the atrium's untinted
// walls, caps, skirting, the slab, its concrete, the core plinth, the closet, the Design room's backing and credenza.
// For a tinted texture (fabric, upholstery, rug) the colour is what the material should average.
export function themedColours() {
  const one = (p, mode) => ({
    cap: p.wallCap, skirting: p.baseboard, ...Object.fromEntries(ROOM_WALLS.map((k) => ['wall_' + k, wallColour(p, k)])), wall_atrium: p.wall,
    concrete: p.tile, slab: p.slabEdge, plinth: p.plinth, plinth_edge: p.plinthEdge, plaza: p.plaza, closet_wall: p.closetWall, closet_floor: p.closetFloor,
    design_backing: DESIGN[mode].backing, design_credenza: DESIGN[mode].credenza,
    fabric: '#34353a', upholstery: p.sofa, rug: p.rug
  });
  return { day: one(PALETTE.light, 'day'), evening: one(PALETTE.dark, 'evening') };
}

export function bakedLook() {
  return {
    floor: { ...FLOOR_OAK },
    textures: Object.fromEntries(Object.entries(TEXTURE_MEANS).map(([k, mean]) => [k, { mean }])),
    themed: themedColours(),
    themedTex: THEMED_TEX,
    atlas: { board: atlasUV(ATLAS.board), white: atlasUV(ATLAS.white), art: ATLAS.art.map(atlasUV) },
    // R4a: the warm office look (config/warm-office.js). Only the units that use it (R4a: the Office) are re-baked when it
    // changes; the rest of the look is shared by every unit (build-office.mjs mergeManifest)
    warm: warmLook()
  };
}
