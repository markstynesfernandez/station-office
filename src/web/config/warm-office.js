// warm-office.js — R4a: the warm office look in one place (owner's style direction, 17/10/2026: based on 02.png, with the
// light wood edge band, plinth deck, desk and wall lamps and wall shelves borrowed from 01-main.png; style guidance only,
// nothing traced, sampled or copied). The Blender build (scripts/build-office.mjs -> office_lib.py, office_rooms.py)
// bakes the warm room with these colours; the page (scene/baked.js) applies the themed ones per theme and office.js
// takes the tone mapping and exposure from here. R4a: the Office room only; R4b rolls it out to the other areas.
// No DOM: the build imports it in Node.

// base albedos (sRGB hex). day = the light theme and the day bake; evening = the dark theme and the evening bake
export const WARM = {
  // walls: a low-contrast plaster texture (made in the build) tinted cream; caps a shade lighter so the bevel reads
  wall: { day: '#efe4d2', evening: '#a89b88' },
  cap: { day: '#f7f0e4', evening: '#bdb09c' },
  plasterMean: '#e9e2d6',                    // what the generated plaster texture averages before its tint
  // floor: beige/cream large-format tile with visible grout (texture made in the build), framed by a light wood band
  tile: { colour: '#ddd1bd', grout: '#b3a691', size: 0.9, grout_w: 0.014, texture: 1.8 },
  band: 0.3,                                 // width of the light wood edge band along the room's open edges
  lightwood: '#cfb08a',                      // the oak veneer photo shifted to a light wood: desks, shelving, band, deck
  plinth: '#2c2a28',                         // the dark base under the plinth deck
  rug: { field: '#3a3734', border: '#2a2826' },   // dark charcoal, one rug per department (under its whole desk cluster)
  chair: '#b4a893',                          // task chairs: oatmeal upholstery (people read against it and the rug)
  pedestal: '#e9e1d3',                       // desk pedestals and modesty panels: cream lacquer
  metal: '#33302d',                          // desk side panels, lamp arms, cables: warm charcoal
  accents: { terracotta: '#c0673f', sage: '#8fa382', brown: '#8a6a4f' },
  pots: { terracotta: '#b9653f', cream: '#e6dccb', sage: '#93a587', brown: '#7a5d45' },
  books: ['#c0673f', '#8fa382', '#8a6a4f', '#e6dccb', '#3a3734', '#d9b26f', '#a8553a', '#6f7f62', '#b39b7c', '#f1e9dc', '#5c4a3b', '#c9b48f'],
  // the window wall's panes (unlit on the page): bright daylight by day, a dim dusk by evening
  window: { day: '#f6f2ea', evening: '#3b4152' }
};

// Tone mapping (R4a): AgX (three 0.186 has it). Exposure per theme, tuned so the cream walls do not clip: measured in the
// R4a light-mode captures, the plaster's brightest channel is at most 213 of 255 and the bevelled caps 217 (247 in the
// high tier, where the bevel catches the sun).
export const TONE = { mapping: 'agx', exposure: { light: 1.32, dark: 1.3 } };

// The warm look as the bake and the page use it (bakedlook.js puts it into the manifest as look.warm). Themed materials:
// one colour per theme; a tinted texture's colour is what it should average (its texture's mean is in `textures`).
export function warmLook() {
  const W = WARM;
  return {
    themed: {
      day: { wall_warm: W.wall.day, cap_warm: W.cap.day, window: W.window.day, fabric_warm: W.chair, rug_warm: W.rug.field },
      evening: { wall_warm: W.wall.evening, cap_warm: W.cap.evening, window: W.window.evening, fabric_warm: W.chair, rug_warm: W.rug.field }
    },
    textures: { plaster: { mean: W.plasterMean }, lightwood: { mean: W.lightwood } },
    tile: { ...W.tile }, band: W.band, plinth: W.plinth, rug: { ...W.rug }, chair: W.chair, pedestal: W.pedestal, metal: W.metal,
    accents: { ...W.accents }, pots: { ...W.pots }, books: W.books.slice()
  };
}
