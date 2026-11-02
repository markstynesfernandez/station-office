// palette.js — the one place colours live (spec: "One config file holds the palette"). Redesign R1, R2:
// light mode (R2: more contrast): crisp warm-white walls with a clearly visible department tint, one mid-tone oak
//   floor in both themes (R3a: the shared texture as is, wood: white), pale polished concrete in the atrium, dark rugs
//   under the desk clusters, a stronger sun with softer, darker shadows; LED strips read as pale aluminium profiles and
//   give no glow.
// dark mode: charcoal walls, the same oak floor, dark rugs, warm LED strips (emissive lines plus soft additive washes),
//   glowing monitors and desk lamps. One warm accent (ledGlowColour / --accent) runs through the scene and the UI.
export const PALETTE = {
  light: {
    background: ['#f1ede7', '#d9d2c7'],   // vertical gradient, top -> bottom
    shadowOpacity: 0.2, blobOpacity: 0.36,
    slabEdge: '#d8d0c3', slabFoot: '#c4baab',
    tile: '#dcd6cd', wood: '#ffffff',      // multiplied by the oak floor (R3a: one wood, the texture's own tone) / concrete textures
    wall: '#fcf9f3', wallTint: 0.42, wallCap: '#cdc2b2', baseboard: '#e4dacb',
    rug: '#6b6762', rugBorder: '#55524e', loungeRug: '#6b6762', loungeRugBorder: '#55524e',   // R3b: dark grey rugs everywhere (owner)
    shelf: '#f1ebe1', shelfBack: '#e7e0d5', shelfObject: '#cbbfae', label: '#f6f3ec',
    potSmall: '#d9cdbb', leafSmall: '#7aa872', leafTrail: '#5f9a5c',
    frame: '#3a3633', mat: '#f8f5ef', clockRim: '#2f3034', clockFace: '#fbf9f5',
    printer: '#e9e7e3', printerTop: '#d6d4cf', printerLid: '#55575d', paper: '#fdfcf9', cooler: '#f1efea', water: '#8fc0e2', mug: '#c2673f',
    metal: '#2f3034', leather: '#b77a50', sofa: '#d8cec0', sofaBase: '#bfb4a5', lampShade: '#2f3034', bulb: '#fff3dc', lampGlow: '#ffd9a0',
    led: '#efeae2', ledGlow: 0, ledGlowColour: '#ffb15f',
    seam: '#a0988c', locker: '#cdcac4', credenza: '#ebe5db', woodSolid: '#c99c6b', whiteboardFrame: '#babdc2',
    closetFloor: '#bdbab5', closetWall: '#dedad3', closetLED: '#e9f2ff', rackLedA: '#79d98f', rackLedB: '#f0c35a',
    plinth: '#ece6dd', plinthEdge: '#cfc5b7', inlay: '#bfae94', plaza: '#cdc6bb',
    deskTop: '#d9ae7c', deskMetal: '#2e2f33', chair: '#45464c', monitorFrame: '#2b2c30', keyboard: '#e6e3de', trousers: '#4a4d55',
    plantPot: '#dacfbf', plantPotTall: '#cfc6b9', plantLeaf: '#7dab76', plantLeafTall: '#6e9f6a',
    worker: '#ecdccb',
    terminal: '#d3d6db', terminalScreen: 0.55,
    hubCore: '#5f9fe6', hubGlow: 0.6,
    screenPool: 0, lampPool: 0,
    text: '#2b2a28',
    hemiSky: '#fff6ea', hemiGround: '#bfb4a4', hemiIntensity: 0.6,
    sunIntensity: 3.5, sunColour: '#ffefd8',
    exposure: 1.0, aoBlend: 1.0
  },
  dark: {
    background: ['#2a2a2d', '#111113'],   // charcoal
    shadowOpacity: 0.3, blobOpacity: 0.45,
    slabEdge: '#1d1d20', slabFoot: '#151517',
    tile: '#5a5753', wood: '#ffffff',      // tile: polished dark concrete (R2); wood: the shared oak as is (R3a)
    wall: '#3c3d42', wallTint: 0.08, wallCap: '#111113', baseboard: '#232427',
    rug: '#4a4a4e', rugBorder: '#36363a', loungeRug: '#4a4a4e', loungeRugBorder: '#36363a',
    shelf: '#26262a', shelfBack: '#303034', shelfObject: '#3b3a37', label: '#d9d4ca',
    potSmall: '#4b4844', leafSmall: '#5f9a63', leafTrail: '#4f8a56',
    frame: '#141414', mat: '#e8e2d8', clockRim: '#1b1b1e', clockFace: '#e3ddd2',
    printer: '#3c3d42', printerTop: '#47484d', printerLid: '#232428', paper: '#d9d4ca', cooler: '#c9c6c0', water: '#5d8db2', mug: '#b5533c',
    metal: '#18191c', leather: '#93603e', sofa: '#5b5a61', sofaBase: '#38383d', lampShade: '#1b1b1e', bulb: '#ffd89c', lampGlow: '#ffae5e',
    led: '#ffd394', ledGlow: 1.0, ledGlowColour: '#ffab58',
    seam: '#19191b', locker: '#55565c', credenza: '#38383d', woodSolid: '#a06f47', whiteboardFrame: '#575a60',
    closetFloor: '#222225', closetWall: '#2a2b2f', closetLED: '#a4d2ff', rackLedA: '#5fe08a', rackLedB: '#ffcc66',
    plinth: '#4a4846', plinthEdge: '#2c2c2f', inlay: '#806a4c', plaza: '#43413e',
    deskTop: '#c99769', deskMetal: '#141518', chair: '#3a3b40', monitorFrame: '#111215', keyboard: '#2d2e32', trousers: '#2e3036',
    plantPot: '#4a4743', plantPotTall: '#3f3d3a', plantLeaf: '#5e9b63', plantLeafTall: '#4f8a56',
    worker: '#dccab6',
    terminal: '#34373c', terminalScreen: 0.9,
    hubCore: '#8fc0f2', hubGlow: 1.0,
    screenPool: 0.55, lampPool: 0.9,
    text: '#e7e4df',
    hemiSky: '#d9ccbc', hemiGround: '#3b342d', hemiIntensity: 1.35,
    sunIntensity: 1.5, sunColour: '#ffd9b0',
    exposure: 1.05, aoBlend: 0.7
  },
  // one soft accent per department (keyed by the department key from the office layout): card edges, wall tint
  departments: {
    research: '#8fb5d6',
    design: '#c7a4d6',
    office: '#a9cfa6',
    default: '#d9c48f'
  },
  status: {
    idle: '#9aa3ad',
    working: '#4fbf73',
    waiting: '#e8b53e',
    error: '#e2584d'
  },
  // services rack: status light colours (owner vocabulary, round 1)
  serviceStatus: {
    configured: '#4fbf73',
    manual: '#6f93d8',
    offline: '#e2584d',
    unknown: '#9aa3ad'
  },
  services: {
    anthropic: '#d9956a',
    openrouter: '#7f9cf5',
    realesrgan: '#8fb3c8',
    etsy: '#f08a5d',
    mock: '#b9b4c9'
  }
};
