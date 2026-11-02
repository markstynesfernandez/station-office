// PORTED from Virtual-workers/station/scripts/lib/listing-photos.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, new in the source on 17/10/2026), source sha256 d8393752b5fe6df0c872602b5b59de85680913450efb5500b622bf8a02a9b56e.
//   change: none (pure layout and rendering; the engine step src/engine/owner.mjs makeListingPhotos writes the photos and photos.json)
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// listing-photos.mjs (lib) — Etsy listing-page photos composited from an approved digital set's own PNGs (OWNER exception to the station
// freeze, 2026-10-17: PNGTuber desk props r2). Deterministic: sharp only, no model, no image generation, no text, labels or watermarks.
// The photos are for the Etsy page only, never part of the buyer download: they are written to work/<id>/listing-photos/ and the approved
// package (approval-queue/<id>/, its ZIP and MANIFEST.json) is only read. Every prop is trimmed to its visible pixels, then placed whole
// inside the canvas with a margin (layouts are checked: nothing is cropped at the edges).
// Pure layout functions here (tested); renderPhotos draws them. scripts/make-listing-photos.mjs writes the files and photos.json.
import sharp from 'sharp';

export const WARM_BG = '#ECDFCF', DARK_BG = '#26282D';
export const HERO = { width: 3000, height: 2250 }, CLOSE = { width: 2000, height: 2000 };

// rect = { left, top, width, height } in canvas pixels; inside = fully on the canvas
export const inside = (r, W, H) => r.left >= 0 && r.top >= 0 && r.left + r.width <= W && r.top + r.height <= H;

// props: [{ name, w, h }] (trimmed sizes) -> placements in a cols x rows grid, one common scale (the props keep the sizes they are drawn at
// relative to each other), each bottom-aligned and centred in its cell
export function gridLayout(props, { width, height, cols = 4, rows = 3, margin = 150, pad = 40 }) {
  if (props.length > cols * rows) throw new Error('grid holds ' + cols * rows + ' props, got ' + props.length);
  const cw = (width - 2 * margin) / cols, ch = (height - 2 * margin) / rows;
  const s = Math.min(...props.map((p) => Math.min((cw - 2 * pad) / p.w, (ch - 2 * pad) / p.h)));
  return props.map((p, i) => {
    const w = Math.round(p.w * s), h = Math.round(p.h * s), c = i % cols, r = Math.floor(i / cols);
    return { name: p.name, left: Math.round(margin + c * cw + (cw - w) / 2), top: Math.round(margin + r * ch + ch - pad - h), width: w, height: h };
  });
}

// scene: [{ name, cx, base, h }] in free units (centre x, baseline y, height); widths from each prop's trimmed aspect. The whole arrangement
// is scaled and centred to fit the canvas inside the margin; drawn in the given order (later = in front)
export function sceneLayout(props, scene, { width, height, margin = 150 }) {
  const by = Object.fromEntries(props.map((p) => [p.name, p]));
  const raw = scene.map((e) => {
    const p = by[e.name]; if (!p) throw new Error('scene names a prop that is not in the set: ' + e.name);
    const w = (e.h * p.w) / p.h; return { name: e.name, x: e.cx - w / 2, y: e.base - e.h, w, h: e.h };
  });
  const x0 = Math.min(...raw.map((r) => r.x)), y0 = Math.min(...raw.map((r) => r.y)), x1 = Math.max(...raw.map((r) => r.x + r.w)), y1 = Math.max(...raw.map((r) => r.y + r.h));
  const s = Math.min((width - 2 * margin) / (x1 - x0), (height - 2 * margin) / (y1 - y0)), ox = (width - (x1 - x0) * s) / 2, oy = (height - (y1 - y0) * s) / 2;
  return raw.map((r) => ({ name: r.name, left: Math.round(ox + (r.x - x0) * s), top: Math.round(oy + (r.y - y0) * s), width: Math.round(r.w * s), height: Math.round(r.h * s) }));
}

// one prop, as large as fits in `fill` of the canvas, centred
export function closeLayout(p, { width, height, fill = 0.8 }) {
  const s = Math.min((width * fill) / p.w, (height * fill) / p.h), w = Math.round(p.w * s), h = Math.round(p.h * s);
  return [{ name: p.name, left: Math.round((width - w) / 2), top: Math.round((height - h) / 2), width: w, height: h }];
}

// png Buffer -> { buf (trimmed to visible pixels), w, h }
export async function trimProp(png) {
  const { data, info } = await sharp(png).ensureAlpha().trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
  return { buf: data, w: info.width, h: info.height };
}

// placements + trimmed props -> JPEG bytes (sRGB, no metadata, 4:4:4 so the outlines stay clean)
export async function renderPhoto({ width, height, background, placements, trimmed }) {
  for (const pl of placements) if (!inside(pl, width, height)) throw new Error(pl.name + ' would be cropped at the edge');
  const layers = [];
  for (const pl of placements) layers.push({ input: await sharp(trimmed[pl.name].buf).resize(pl.width, pl.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer(), left: pl.left, top: pl.top });
  return sharp({ create: { width, height, channels: 3, background } }).composite(layers).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();
}
