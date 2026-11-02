// PORTED in part from Virtual-workers/station/scripts/lib/esrgan.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment; unchanged in the source since the 1st), source sha256 7bb48ee9d9ea821c3f7bd2694edbe90bef1ac6deac30d2a4583a0dbd184680bc.
//   kept:   esrganCfg, bleedColour, and esrganUpscale's three parts (colour under clear pixels bled from the artwork, colour through the model,
//           alpha upscaled separately with Lanczos unless alphaMethod is "model", recombined and resampled to the exact size); the GPU pick
//           (REALESRGAN_GPU, config upscale.gpuId, else a probe that prefers the NVIDIA device over the Intel iGPU)
//   change: the binary is the engine's OWN pinned copy (config/engine.json upscale: path under office-agents/tools/, sha256 of the binary,
//           its DLL and the model files), checked before every run; the legacy build's copy is never run
//   change: OWNER DECISION 17/10/2026: Real-ESRGAN may run as a local child process. This module is the only place in src/ that starts
//           one (tests/write-guard.test.mjs): execFile, never a shell; its cwd and every file it reads or writes are inside the job's set
//           folder (the data jail); a minimal environment (no proxy, no keys); windowsHide; killed at once when the E-STOP or the owner's
//           Stop fires (AbortSignal); one process at a time. The binary has no network code path; the engine gives it nothing to reach.
//   change: probe and temp files live in the caller's jail folder, not the OS temp
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { config as defaultConfig } from './common.mjs';
import { APP_ROOT } from '../store/jail.mjs';
import { dataJail } from '../store/active.mjs';

export const esrganCfg = (cfg = defaultConfig) => ({ method: 'lanczos', nativeScale: 4, model: 'realesrgan-x4plus', binary: null, ...(cfg.upscale || {}) });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const TOOLS = path.join(APP_ROOT, 'tools');

// the pin from config/engine.json upscale: { binary, sha256, files: { relPath: sha256 } } -> { ok, bin, modelsDir } or { ok: false, reason }
export function checkPin(pin, { root = APP_ROOT, toolsDir = TOOLS } = {}) {
  if (!pin || !pin.binary || !/^[0-9a-f]{64}$/.test(String(pin.sha256 || ''))) return { ok: false, reason: 'no pinned Real-ESRGAN binary in config/engine.json upscale (binary + sha256)' };
  const bin = path.resolve(root, pin.binary), rel = path.relative(toolsDir, bin);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'the pinned upscaler must live under office-agents/tools/: ' + pin.binary };
  if (!fs.existsSync(bin)) return { ok: false, reason: 'the pinned upscaler is not installed: ' + pin.binary };
  if (sha(bin) !== pin.sha256) return { ok: false, reason: pin.binary + ' differs from its pinned sha256: refused' };
  for (const [f, h] of Object.entries(pin.files || {})) {
    const p = path.resolve(path.dirname(bin), f);
    if (!fs.existsSync(p) || sha(p) !== h) return { ok: false, reason: 'pinned upscaler file ' + f + ' is missing or differs from its sha256: refused' };
  }
  return { ok: true, bin, modelsDir: path.join(path.dirname(bin), 'models') };
}

// one pinned run. cwd and every path are the caller's (inside the jail); the signal kills the process (E-STOP / owner Stop)
let running = 0;
export function runPinned(bin, args, { cwd, signal, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (running) return Promise.reject(new Error('another upscaler process is running (one at a time)'));
  if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('stopped before the upscaler started'), { code: 'STOPPED' }));
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const env = { SystemRoot: sys, windir: sys, PATH: [path.dirname(bin), path.join(sys, 'System32')].join(path.delimiter) };
  return new Promise((resolve, reject) => {
    let done = false; const end = () => { if (!done) { done = true; running--; } };
    running++;
    try { execFile(bin, args, { cwd: dataJail(cwd), env, signal: signal || undefined, windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 26, encoding: 'utf8' }, (err, stdout, stderr) => {
      end();
      if (err && (err.name === 'AbortError' || (signal && signal.aborted))) return reject(Object.assign(new Error('upscaler killed: ' + ((signal && signal.reason && signal.reason.message) || 'stopped')), { code: 'STOPPED' }));
      if (err) return reject(Object.assign(new Error('realesrgan failed (exit ' + err.code + '): ' + String(stderr || stdout).split('\n').filter((l) => !/%$/.test(l)).slice(-4).join(' | ')), { stdout, stderr }));
      resolve({ stdout, stderr });
    }); } catch (e) { end(); reject(e); }
  });
}
export const upscalerRunning = () => running;

// Fill RGB under (semi)transparent pixels from nearby artwork colour. data: RGBA raw. Mutates and returns it.
// Pixels with alpha >= solid keep their colour; others take the mean of filled 8-neighbours, ring by ring (maxRing px deep).
export function bleedColour(data, W, H, { solid = 200, maxRing = 12 } = {}) {
  const n = W * H, filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) filled[i] = data[i * 4 + 3] >= solid ? 1 : 0;
  for (let ring = 0; ring < maxRing; ring++) {
    const add = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (filled[i]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W || (!dx && !dy)) continue;
          const j = yy * W + xx; if (filled[j]) { r += data[j * 4]; g += data[j * 4 + 1]; b += data[j * 4 + 2]; c++; } } }
      if (c) add.push(i, Math.round(r / c), Math.round(g / c), Math.round(b / c));
    }
    if (!add.length) break;
    for (let k = 0; k < add.length; k += 4) { const i = add[k]; data[i * 4] = add[k + 1]; data[i * 4 + 1] = add[k + 2]; data[i * 4 + 2] = add[k + 3]; filled[i] = 1; }
  }
  return data;
}

let gpuCache = null;
async function pickGpu(c, bin, modelsDir, dir, signal) {
  if (process.env.REALESRGAN_GPU !== undefined) return { id: Number(process.env.REALESRGAN_GPU), name: 'env REALESRGAN_GPU' };
  if (c.gpuId != null) return { id: c.gpuId, name: 'config upscale.gpuId' };
  if (gpuCache) return gpuCache;
  const f = path.join(dir, 'probe.png');
  await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toFile(dataJail(f));
  let out = '';
  try { const r = await runPinned(bin, ['-i', f, '-o', path.join(dir, 'probe-x.png'), '-n', c.model, '-s', '4', '-m', modelsDir], { cwd: dir, signal }); out = r.stderr + r.stdout; }
  catch (e) { if (e.code === 'STOPPED' || e.code === 'JAIL') throw e; out = String(e.stderr || '') + String(e.stdout || '') + ' ' + e.message; }
  const devs = [...new Set(out.match(/\[(\d+) ([^\]]+)\]/g) || [])].map((s) => /\[(\d+) ([^\]]+)\]/.exec(s)).map((m) => ({ id: Number(m[1]), name: m[2] }));
  gpuCache = devs.find((d) => /nvidia/i.test(d.name)) || devs.find((d) => !/intel/i.test(d.name)) || devs[0] || { id: 0, name: 'unknown (probe found no device list)' };
  return gpuCache;
}

// the upscaler digital-build.mjs calls: (input, outW, outH, { cfg }) -> { data (RGBA raw), facts, warnings }. pin = config/engine.json
// upscale; workDir = a folder inside the jail for its temp files; signal = E-STOP / owner Stop. Without a valid pin it refuses (the build
// then fails closed); it never falls back silently.
export function esrganUpscaler({ pin, workDir, signal = null }) {
  return async function upscale(input, outW, outH, { cfg = defaultConfig } = {}) {
    const c = esrganCfg(cfg);
    if (c.method !== 'realesrgan') throw new Error('upscale method is "' + c.method + '", not realesrgan');
    const p = checkPin(pin); if (!p.ok) throw new Error(p.reason);
    const dir = path.join(workDir, 'esrgan-' + process.pid); fs.mkdirSync(dataJail(dir), { recursive: true });
    try {
      const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), W = info.width, H = info.height;
      const alpha = Buffer.alloc(W * H); for (let i = 0; i < W * H; i++) alpha[i] = data[i * 4 + 3];
      const t0 = Date.now(), rgba = bleedColour(Buffer.from(data), W, H);
      const rgbIn = path.join(dir, 'rgb.png'), rgbOut = path.join(dir, 'rgb-x.png');
      await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).removeAlpha().png({ compressionLevel: 1 }).toFile(dataJail(rgbIn));
      const gpu = await pickGpu(c, p.bin, p.modelsDir, dir, signal);
      await runPinned(p.bin, ['-i', rgbIn, '-o', rgbOut, '-n', c.model, '-s', String(c.nativeScale), '-g', String(gpu.id), '-m', p.modelsDir, '-f', 'png'], { cwd: dir, signal });
      if (!fs.existsSync(rgbOut)) throw new Error('realesrgan wrote no output');
      const rgbX = await sharp(rgbOut).resize(outW, outH, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).removeAlpha().raw().toBuffer();
      let aX;
      if (c.alphaMethod === 'model') {
        const aIn = path.join(dir, 'a.png'), aOut = path.join(dir, 'a-x.png');
        await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).toColourspace('b-w').png({ compressionLevel: 1 }).toFile(dataJail(aIn));
        await runPinned(p.bin, ['-i', aIn, '-o', aOut, '-n', c.model, '-s', String(c.nativeScale), '-g', String(gpu.id), '-m', p.modelsDir, '-f', 'png'], { cwd: dir, signal });
        aX = await sharp(aOut).resize(outW, outH, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).extractChannel(0).raw().toBuffer();
      } else aX = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).resize(outW, outH, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).extractChannel(0).raw().toBuffer();
      const out = await sharp(rgbX, { raw: { width: outW, height: outH, channels: 3 } }).joinChannel(aX, { raw: { width: outW, height: outH, channels: 1 } }).ensureAlpha().raw().toBuffer();
      return { data: out, facts: { method: 'realesrgan', model: c.model, nativeScale: c.nativeScale, alphaSeparate: true, alphaMethod: c.alphaMethod === 'model' ? 'model' : 'lanczos3', gpu: gpu.id + ' ' + gpu.name, aiMs: Date.now() - t0, aiPx: [W * c.nativeScale, H * c.nativeScale] }, warnings: [] };
    } finally { fs.rmSync(dataJail(dir), { recursive: true, force: true }); }
  };
}
