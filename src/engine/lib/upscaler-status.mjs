// lib/upscaler-status.mjs — L2: the Real-ESRGAN status the page shows (the services pill and its tooltip). Until L2 the pill was a
// fixed "offline" with the note "not wired in the engine yet", left over from before the port batch: that is why it was red on live
// while the pinned upscaler built every set. The status now comes from the same checks a build makes, without running the binary:
//   1. the pin in config/engine.json upscale (binary under tools/, its sha256 and the DLL and model files' sha256s: lib/esrgan.mjs checkPin)
//   2. the Vulkan loader the ncnn-vulkan build needs (Windows: %SystemRoot%\System32\vulkan-1.dll)
//   3. how the GPU is picked (REALESRGAN_GPU, config upscale.gpuId, else a probe at the first build that prefers the NVIDIA device)
// Hashing the files is done once per change of their size or time, not on every snapshot. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { checkPin } from './esrgan.mjs';
import { APP_ROOT } from '../store/jail.mjs';

let cache = null;   // { key, pin: checkPin result }
const statKey = (files) => files.map((f) => { try { const s = fs.statSync(f); return f + ':' + s.size + ':' + s.mtimeMs; } catch (_) { return f + ':missing'; } }).join('|');

export function vulkanLoader({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { ok: null, detail: 'Vulkan loader not checked on ' + platform };
  const f = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'vulkan-1.dll');
  return fs.existsSync(f) ? { ok: true, detail: 'Vulkan loader present (' + f + ')' } : { ok: false, detail: 'no Vulkan loader (' + f + ' is missing): install or update the GPU driver' };
}

// -> { status: 'configured' | 'offline', detail, reason (when offline) }
export function upscalerStatus(pin, { root = APP_ROOT, platform = process.platform, env = process.env } = {}) {
  const bin = pin && pin.binary ? path.resolve(root, pin.binary) : null;
  const files = bin ? [bin, ...Object.keys(pin.files || {}).map((f) => path.resolve(path.dirname(bin), f))] : [];
  // the sha256 check is cached on the files' size and time; the loader check is a stat, done every time
  const key = JSON.stringify([pin || null, root]) + statKey(files);
  if (!cache || cache.key !== key) cache = { key, pin: checkPin(pin, { root, toolsDir: path.join(root, 'tools') }) };
  const p = cache.pin, vk = vulkanLoader({ platform, env });
  const gpu = env.REALESRGAN_GPU !== undefined ? 'GPU ' + env.REALESRGAN_GPU + ' (REALESRGAN_GPU)' : pin && pin.gpuId != null ? 'GPU ' + pin.gpuId + ' (config upscale.gpuId)' : 'GPU picked by a probe at the first build (NVIDIA preferred over the Intel iGPU)';
  if (!p.ok) return { status: 'offline', reason: p.reason, detail: 'not usable: ' + p.reason + '. Packaged products fail closed at the build until it is fixed.' };
  if (vk.ok === false) return { status: 'offline', reason: vk.detail, detail: 'not usable: ' + vk.detail + '. The pinned binary itself checks out (sha256).' };
  return { status: 'configured', reason: null, detail: 'pinned realesrgan-ncnn-vulkan: binary, DLL and model sha256 match config/engine.json upscale; ' + vk.detail + '; ' + gpu + '. Runs locally per build, $0.' };
}
