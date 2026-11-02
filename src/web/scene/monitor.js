// scene/monitor.js — a canvas texture per monitor, drawn only when it is shown (zoomed in or the desk is selected).
// Few, large lines so it stays legible at close zoom: status + agent, job, stage, spend today (calendar day).
import * as THREE from 'three';
import { PALETTE } from '../config/palette.js';
import { money, isMoneyHidden } from '../ui/format.js';

const W = 512, H = 312;
const fit = (ctx, text, maxW) => { let t = String(text || ''); if (ctx.measureText(t).width <= maxW) return t; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };
const SANS = '"Segoe UI", system-ui, sans-serif', MONO = '"Cascadia Code", Consolas, monospace';

export function makeMonitorTexture() {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true;
  let drawnKey = null;
  function draw(agent, theme = 'light') {
    const key = JSON.stringify([agent.status, agent.statusText, agent.currentJob, agent.spendToday, agent.synthetic, theme, isMoneyHidden()]);
    if (key === drawnKey) return; drawnKey = key;
    const dark = theme === 'dark';
    const bg = dark ? '#0d1220' : '#172033', bar = dark ? '#141c2e' : '#1f2a42', fg = '#eef2f8', dim = '#93a0b8';
    const status = PALETTE.status[agent.status] || PALETTE.status.idle;
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // header: status colour band + name
    // three large lines + footer, sized to stay legible when the screen is ~100 px wide on the page
    ctx.fillStyle = bar; ctx.fillRect(0, 0, W, 92);
    ctx.fillStyle = status; ctx.fillRect(0, 0, 16, 92);
    ctx.textBaseline = 'middle'; ctx.fillStyle = fg; ctx.font = '700 46px ' + SANS; ctx.fillText(fit(ctx, agent.name, W - 60), 36, 48);
    // status (+ stage or failure)
    const stage = agent.currentJob ? (agent.currentJob.stageLabel || agent.currentJob.stage) + (agent.currentJob.pass ? ' ' + agent.currentJob.pass : '') : agent.status === 'error' ? (agent.statusText || '').replace(/^error · /, '') : '';
    ctx.fillStyle = status; ctx.font = '700 40px ' + SANS;
    ctx.fillText(fit(ctx, (agent.status === 'waiting' ? 'NEEDS MY OK' : agent.status.toUpperCase()) + (stage ? ' · ' + stage : ''), W - 60), 36, 140);
    // job
    const job = agent.currentJob ? agent.currentJob.id.replace(/^\d{4}-\d{2}-\d{2}--/, '') : 'no current job';
    ctx.fillStyle = agent.currentJob ? fg : dim; ctx.font = '600 36px ' + MONO; ctx.fillText(fit(ctx, job, W - 60), 36, 194);
    if (agent.synthetic) { ctx.font = '700 24px ' + SANS; const t = 'SYNTHETIC'; const w = ctx.measureText(t).width + 18; ctx.strokeStyle = '#e8b53e'; ctx.lineWidth = 3; ctx.strokeRect(W - w - 16, 226, w, 34); ctx.fillStyle = '#e8b53e'; ctx.fillText(t, W - w - 7, 244); }
    // footer: spend today (calendar day)
    ctx.fillStyle = bar; ctx.fillRect(0, H - 56, W, 56);
    ctx.fillStyle = fg; ctx.font = '700 36px ' + MONO;
    ctx.fillText(money(agent.spendToday && agent.spendToday.usd) + (agent.spendToday ? ' · ' + agent.spendToday.runs + ' runs' : ''), 36, H - 28);
    texture.needsUpdate = true;
  }
  return { texture, draw, canvas };
}
