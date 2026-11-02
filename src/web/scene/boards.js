// scene/boards.js — R7a: the floors' screens, boards, signs and plates as canvas textures. Each draws a content model from
// towerplan.js screenContent (only what the snapshot has; the empty state when there is none) in the screen's style: screen (a dark
// display), board (a whiteboard), sign (the lobby's stone sign), glass-sign (lettering on a glass door), plate (brass), portrait
// (a framed picture of a retired agent: an abstract figure, no likeness), strip (the trophy cabinet's name plates). Redrawn only
// when its content, theme or the money-hidden state (the presenter view) changes.
import * as THREE from 'three';
import { isMoneyHidden } from '../ui/format.js';

const SANS = '"Segoe UI", system-ui, sans-serif';
const PX = 230;                                    // canvas pixels per world unit (capped)
const TONE = { ok: '#4fbf73', warn: '#e8b53e', bad: '#e2584d', muted: null };
const fit = (g, text, maxW) => { let t = String(text == null ? '' : text); if (g.measureText(t).width <= maxW) return t; while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };

export function makeBoard(sc) {
  const W = Math.min(2048, Math.max(128, Math.round(sc.w * PX))), H = Math.min(1024, Math.max(48, Math.round(sc.h * PX)));
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter;
  let drawn = null;
  function draw(content, theme, pal) {
    const key = JSON.stringify([content, theme, isMoneyHidden()]); if (key === drawn) return false; drawn = key;
    g.clearRect(0, 0, W, H);
    const P = { theme, pal, W, H, g };
    (STYLES[sc.style] || STYLES.screen)(P, content || {}, sc);
    texture.needsUpdate = true; return true;
  }
  return { canvas, texture, draw, transparent: sc.style === 'glass-sign' };
}

// a dark display: title bar, a big number, rows (label, value, a bar), kanban columns, or the empty state
function screenStyle({ g, W, H, theme, pal }, c, sc, light = false) {
  const bg = light ? pal.boardBg : pal.screenBg, fg = light ? pal.boardFg : pal.screenFg, dim = light ? '#5b5853' : pal.screenDim, acc = pal.accent2 || '#6f93d8';
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const u = H / 10;                                    // one unit of type: a tenth of the height
  if (!light) { g.fillStyle = theme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.07)'; g.fillRect(0, 0, W, u * 1.9); g.fillStyle = acc; g.fillRect(0, 0, Math.max(6, u * 0.18), u * 1.9); }
  else { g.strokeStyle = acc; g.lineWidth = Math.max(2, u * 0.08); g.beginPath(); g.moveTo(u * 0.5, u * 1.85); g.lineTo(W - u * 0.5, u * 1.85); g.stroke(); }
  g.textBaseline = 'middle'; g.fillStyle = fg; g.font = '700 ' + Math.round(u * 1.05) + 'px ' + SANS; g.fillText(fit(g, c.title, W - u * 1.4), u * 0.7, u * 0.98);
  let y = u * 2.6;
  if (c.big != null) {
    g.font = '800 ' + Math.round(u * 3.6) + 'px ' + SANS; g.fillStyle = Number(c.big) > 0 ? (pal.accent || acc) : fg; g.fillText(c.big, u * 0.7, y + u * 1.6);
    const bw = g.measureText(c.big).width; g.font = '600 ' + Math.round(u * 0.85) + 'px ' + SANS; g.fillStyle = dim; g.fillText(fit(g, c.bigLabel || '', W - bw - u * 2.2), u * 1.4 + bw, y + u * 1.7);
    y += u * 3.6;
  }
  if (c.columns) {
    const n = c.columns.length, cw = (W - u * 1.0) / n;
    c.columns.forEach((col, i) => {
      const x = u * 0.5 + i * cw;
      g.fillStyle = light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)'; g.fillRect(x + u * 0.1, y - u * 0.2, cw - u * 0.2, H - y - u * 0.3);
      g.fillStyle = dim; g.font = '700 ' + Math.round(u * 0.62) + 'px ' + SANS; g.fillText(fit(g, col.name + ' · ' + col.cards.length, cw - u * 0.5), x + u * 0.3, y + u * 0.3);
      col.cards.slice(0, 4).forEach((t, k) => { const cy = y + u * 0.95 + k * u * 1.35; g.fillStyle = ['#ffe066', '#a0e7e5', '#f7a8b8', '#b4f8c8', '#fbe7c6'][i % 5]; g.fillRect(x + u * 0.25, cy, cw - u * 0.5, u * 1.15); g.fillStyle = '#2b2a28'; g.font = '600 ' + Math.round(u * 0.55) + 'px ' + SANS; g.fillText(fit(g, t, cw - u * 0.8), x + u * 0.4, cy + u * 0.58); });
    });
  } else if (c.rows && c.rows.length) {
    const rh = Math.min(u * 1.25, (H - y - (c.foot ? u * 1.2 : u * 0.4)) / c.rows.length);
    c.rows.forEach((r, i) => {
      const ry = y + i * rh + rh / 2;
      g.font = '600 ' + Math.round(rh * 0.6) + 'px ' + SANS; g.fillStyle = dim; g.fillText(fit(g, r.label, W * 0.46), u * 0.7, ry);
      const v = String(r.value == null ? '' : r.value); g.font = '700 ' + Math.round(rh * 0.62) + 'px ' + SANS; g.fillStyle = (r.tone && TONE[r.tone]) || fg;
      const vt = fit(g, v, W * 0.46); g.fillText(vt, W - u * 0.7 - g.measureText(vt).width, ry);
      if (r.bar != null) { const bx = u * 0.7, bw = W - u * 1.4; g.fillStyle = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.1)'; g.fillRect(bx, ry + rh * 0.36, bw, rh * 0.12); g.fillStyle = (r.tone && TONE[r.tone]) || acc; g.fillRect(bx, ry + rh * 0.36, bw * Math.max(0, Math.min(1, r.bar)), rh * 0.12); }
    });
  }
  if (c.empty && !(c.columns && c.columns.some((x) => x.cards.length)) && !(c.rows && c.rows.length) && c.big == null) {
    g.textAlign = 'center'; g.fillStyle = dim; g.font = '600 ' + Math.round(u * 1.2) + 'px ' + SANS; g.fillText(c.empty, W / 2, (y + H) / 2 - (c.foot ? u * 0.4 : 0)); g.textAlign = 'left';
  } else if (c.empty && c.columns) {
    g.textAlign = 'center'; g.fillStyle = dim; g.font = '600 ' + Math.round(u * 0.95) + 'px ' + SANS; g.fillText(c.empty, W / 2, H - u * 1.2); g.textAlign = 'left';
  } else if (c.empty && c.big != null) {
    g.fillStyle = dim; g.font = '600 ' + Math.round(u * 0.9) + 'px ' + SANS; g.fillText(c.empty, u * 0.7, y + u * 0.6);
  }
  if (c.foot) { g.fillStyle = dim; g.font = '500 ' + Math.round(u * 0.62) + 'px ' + SANS; g.fillText(fit(g, c.foot, W - u * 1.4), u * 0.7, H - u * 0.6); }
}

const STYLES = {
  screen: (P, c, sc) => screenStyle(P, c, sc, false),
  board: (P, c, sc) => screenStyle(P, c, sc, true),
  sign: ({ g, W, H, pal }, c) => {
    g.fillStyle = '#2b2c30'; g.fillRect(0, 0, W, H);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = pal.brass; g.font = '400 ' + Math.round(H * 0.58) + 'px ' + SANS;
    const t = String(c.title || '').split('').join(String.fromCharCode(8202)); g.fillText(fit(g, t, W * 0.92), W / 2, H * 0.52); g.textAlign = 'left';
  },
  'glass-sign': ({ g, W, H, theme }, c) => {
    g.textBaseline = 'middle'; g.fillStyle = theme === 'dark' ? 'rgba(240,236,228,0.92)' : 'rgba(30,30,32,0.85)';
    g.font = '700 ' + Math.round(H * 0.42) + 'px ' + SANS; g.fillText(fit(g, c.title, W * 0.95), H * 0.15, H * 0.33);
    g.font = '500 ' + Math.round(H * 0.26) + 'px ' + SANS; g.fillText(fit(g, c.sub || '', W * 0.95), H * 0.15, H * 0.76);
  },
  plate: ({ g, W, H, pal }, c) => {
    g.fillStyle = pal.brass; g.fillRect(0, 0, W, H); g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, 0, W, H * 0.12);
    g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillStyle = '#2a2116';
    if (c.sub) { g.font = '700 ' + Math.round(H * 0.5) + 'px ' + SANS; const t = fit(g, c.title, W * 0.6); const tw = g.measureText(t).width; g.font = '500 ' + Math.round(H * 0.34) + 'px ' + SANS; const s2 = '  ·  ' + c.sub, sw = g.measureText(s2).width; const x0 = (W - tw - sw) / 2; g.textAlign = 'left'; g.font = '700 ' + Math.round(H * 0.5) + 'px ' + SANS; g.fillText(t, x0, H * 0.54); g.font = '500 ' + Math.round(H * 0.34) + 'px ' + SANS; g.fillText(s2, x0 + tw, H * 0.56); }
    else { g.font = '800 ' + Math.round(H * 0.7) + 'px ' + SANS; g.fillText(fit(g, c.title, W * 0.9), W / 2, H * 0.54); }
    g.textAlign = 'left';
  },
  strip: ({ g, W, H, pal }, c) => {
    const names = c.names || [], n = Math.max(1, c.slots || names.length);
    g.textBaseline = 'middle'; g.textAlign = 'center';
    names.forEach((name, i) => { const cx = (i + 0.5) * W / n, pw = W / n * 0.86; g.fillStyle = pal.brass; g.fillRect(cx - pw / 2, H * 0.08, pw, H * 0.84); g.fillStyle = '#2a2116'; g.font = '700 ' + Math.round(H * 0.5) + 'px ' + SANS; g.fillText(fit(g, name, pw * 0.92), cx, H * 0.53); });
    g.textAlign = 'left';
  },
  portrait: ({ g, W, H, pal, theme }, c) => {
    g.fillStyle = theme === 'dark' ? '#2b2925' : '#e9e2d6'; g.fillRect(0, 0, W, H);
    // an abstract figure in a soft circle (no likeness), the name and why it hangs here
    g.fillStyle = theme === 'dark' ? '#3d3a35' : '#d5cab8'; g.beginPath(); g.arc(W / 2, H * 0.36, W * 0.34, 0, Math.PI * 2); g.fill();
    g.fillStyle = theme === 'dark' ? '#8c8273' : '#9b8f7d'; g.beginPath(); g.arc(W / 2, H * 0.29, W * 0.12, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(W / 2, H * 0.52, W * 0.22, H * 0.11, 0, Math.PI, 0); g.fill();
    g.fillStyle = pal.brass; g.fillRect(W * 0.08, H * 0.7, W * 0.84, H * 0.24);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#2a2116';
    g.font = '700 ' + Math.round(H * 0.075) + 'px ' + SANS; g.fillText(fit(g, c.title, W * 0.8), W / 2, H * 0.77);
    g.font = '500 ' + Math.round(H * 0.06) + 'px ' + SANS; g.fillText(fit(g, c.sub, W * 0.8), W / 2, H * 0.875); g.textAlign = 'left';
  },
  lift: ({ g, W, H }, c) => { g.fillStyle = '#121316'; g.fillRect(0, 0, W, H); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffb15f'; g.font = '700 ' + Math.round(H * 0.72) + 'px ' + SANS; g.fillText('▲ ' + c.title, W / 2, H * 0.54); g.textAlign = 'left'; }
};
