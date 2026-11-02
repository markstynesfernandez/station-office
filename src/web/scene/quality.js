// scene/quality.js — R4a: the rendering quality tiers and the automatic choice between them. Pure functions, no DOM, so
// the choice is unit-tested in Node.
//   default  the R3b budget: at least 60 fps on an Intel iGPU, the default asset set (<= 10 MB), no post-processing:
//            the scene is drawn straight to the canvas (AgX tone mapping in the materials), no anti-aliasing, no AO pass,
//            no glow; device pixel ratio capped at 1.5
//   high     the high-tier lightmap set (loaded lazily, high/), 4x MSAA, the cached half-resolution AO, a subtle bloom on
//            lamps, LED strips and screens; device pixel ratio capped at 2
// The automatic choice picks high only for a GPU it recognises as a discrete desktop or laptop GPU with room for the
// bigger lightmaps; anything else, or anything it cannot read, gets default ("default whenever detection is unsure").
export const TIERS = ['default', 'high'];
export const TIER = {
  default: { post: false, msaa: 0, ao: false, bloom: false, maxDpr: 1.5 },
  high: { post: true, msaa: 4, ao: true, bloom: true, maxDpr: 2 }
};
export const QUALITY_KEY = 'office-quality';       // the manual choice in localStorage: 'auto', 'default' or 'high'

const DISCRETE = /\b(geforce|rtx|gtx|quadro|nvidia\s+(t\d|a\d)|radeon\s+(rx|pro)|arc\s+a\d)/i;
const WEAK = /intel|uhd|iris|hd graphics|mali|adreno|powervr|apple gpu|swiftshader|llvmpipe|software|basic render|microsoft|vega\s*\d|radeon\(tm\)\s+graphics|radeon graphics/i;

// gpu: { renderer: the unmasked GL renderer string (or null), maxTextureSize, mobile (a touch device with a small screen) }
export function pickTier({ renderer = null, maxTextureSize = 0, mobile = false } = {}) {
  const r = String(renderer || '');
  if (!r) return { tier: 'default', reason: 'GPU not reported' };
  if (mobile) return { tier: 'default', reason: 'phone or tablet' };
  if (WEAK.test(r)) return { tier: 'default', reason: 'integrated or software GPU' };
  if (!DISCRETE.test(r)) return { tier: 'default', reason: 'GPU not recognised' };
  if (maxTextureSize < 8192) return { tier: 'default', reason: 'texture size limit ' + maxTextureSize };
  return { tier: 'high', reason: 'discrete GPU' };
}

// the tier to use: an explicit choice ('default' or 'high', from the page's control or ?quality=) wins; 'auto' or
// anything else asks pickTier
export function resolveTier(choice, gpu) {
  if (choice === 'default' || choice === 'high') return { tier: choice, reason: 'chosen', auto: false };
  return { ...pickTier(gpu), auto: true };
}
