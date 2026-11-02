// vision.mjs — the most an image costs as vision input on an Anthropic model (E6 c0, owner row 20), from its pixel size alone.
// Per the vision docs (config/engine.json vision, read 17/10/2026): an image costs ceil(width/28) x ceil(height/28) visual tokens,
// and an image over the model's long-edge or visual-token limit is downscaled first (aspect kept), which caps its cost at the
// model's maxVisualTokens. The result is an upper bound for the guard's reservation; the real count is the response's usage.
// Pure, no network. An unknown model or a missing size refuses (the caller refuses the call): no guess.
import sharp from 'sharp';

export class VisionPriceError extends Error { constructor(msg) { super(msg); this.code = 'VISION'; } }

export function visionSettings(engineCfg, model) {
  const v = engineCfg && engineCfg.vision, m = v && v.models && v.models[model];
  if (!m || !(m.maxLongEdgePx > 0) || !(m.maxVisualTokens > 0) || !(v.patchPx > 0)) throw new VisionPriceError('no vision limits in config/engine.json vision.models for ' + model + ': image_analyze refused');
  return { patchPx: v.patchPx, maxLongEdgePx: m.maxLongEdgePx, maxVisualTokens: m.maxVisualTokens };
}

// visual tokens of one width x height image on a model: scaled to the long-edge limit first, then capped at the token limit
export function visionTokens(width, height, { patchPx, maxLongEdgePx, maxVisualTokens }) {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) throw new VisionPriceError('image size unknown (' + width + 'x' + height + '): image_analyze refused');
  const s = Math.min(1, maxLongEdgePx / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
  return Math.min(maxVisualTokens, Math.ceil(w / patchPx) * Math.ceil(h / patchPx));
}

// the pixel size of an image file's bytes (sharp metadata; nothing is decoded beyond the header)
export async function imageSize(buf) {
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height, format: m.format };
}
