// providers/openrouter.mjs — the live image provider (E6 step c0): OpenRouter chat completions with modalities image + text,
// the route the legacy station used (one image per call, returned as a base64 data URL in choices[0].message.images[]). Same
// generate({ model, prompt, aspectRatio, transparent, width, height, n, signal, ctx, reference }) shape as the mock image
// provider (providers/mock.mjs), so the toolbox (tools/index.mjs image_generate) and the spend guard treat both alike.
//   - Built only when STATION_PROVIDER=live is in this process's environment, never in demo mode, and only with
//     OPENROUTER_API_KEY set. The key is read once here and kept in this closure: it is never logged, returned, put on an error
//     or written anywhere. Every message that leaves this module goes through redact().
//   - Only the models config/engine.json image.allowedModels lists (and prices) may run (openai/gpt-5-image-mini, owner
//     17/10/2026); anything else is refused before any network call. The e-stop and the abort signal are checked before the call.
//   - One HTTP attempt per generate(). Retries belong to the toolbox, which reserves again for every attempt (live.retries).
//   - Errors come back as ImageProviderError, sorted for the caller (OpenRouter errors reference, read 17/10/2026):
//       hardStop  the job stops, nothing more is tried: 401 (key refused), 402 (credits; except an in-flight budget, retried),
//                 403 without moderation metadata (the key's own limit, e.g. the owner's USD 2 a day, a budget or a guardrail),
//                 400 that is not a content refusal, 404 (model)
//       refusal   a content-policy refusal: 403 with moderation metadata, a 400 naming the safety system, or a 200 that came back
//                 with no image (finish_reason content_filter, or text only); goes back to the DESIGNER as a failed attempt
//       retryable 408, 429, 5xx, a 200 carrying an error, network and timeouts (W2: also a connection dropped while the body is
//                 read; code NETWORK or TIMEOUT with no status = no HTTP response, providers/connection.mjs)
//   - Cost: usage.cost on the response (OpenRouter credits, USD), reported on every response; null when absent (the toolbox then
//     settles at the reservation, marked estimated). A refused 200 that reports a cost carries it on the error (usd).
//   - The returned image is checked here: a data URL only (no download from a host the response names), at most
//     image.maxImageBytes, decodable, with its pixel size and alpha coverage measured. Nothing is upscaled (digital build only).
//   - reference (the style-reference run, E6 c0): { buffer, mime, name } is sent with the prompt as an image_url part, and the
//     prompt says it is a style reference only.
import sharp from 'sharp';
import { makeRedactor } from './anthropic.mjs';
import { liveInstanceProblem } from '../instance.mjs';
import { connectionFailure } from './connection.mjs';

export class ImageProviderError extends Error {
  constructor(message, { code, status = undefined, retryable = false, hardStop = false, refusal = false, retryAfterMs = null, generationId = null, usd = null } = {}) {
    super(message);
    this.name = 'ImageProviderError';
    Object.assign(this, { code, status, retryable, hardStop, refusal, retryAfterMs, generationId, usd });
  }
}

// prompt additions (the legacy route's approach, in the station's own words): transparency is asked for in the prompt and then
// measured in the returned bytes; a reference image is named as a style reference only
const TRANSPARENT_ASKED = /\btransparent[\s-]+(background|bg|png)\b|\balpha[\s-]+channel\b/i;
export const TRANSPARENT_LINE = ' Draw the subject on its own on a fully transparent background (a PNG with an alpha channel): no backdrop, no scenery, no checkerboard.';
export const REFERENCE_LINE = ' The attached image is a style reference only: draw the new subject above as a new, separate image that matches it in outline weight, shading, colour palette and level of detail. Do not copy, edit or include the subject of the reference.';

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };
const CONTENT_400 = /safety|moderat|content[\s_-]?polic|violat|not allowed|disallowed|inappropriate/i;

// the models the image provider may call: allowed by config AND priced
// OpenRouter's record of one generation (E6 wrap-up, 18/10/2026; docs read 18/10/2026: api-reference/get-a-generation):
// GET <config/engine.json image.generationEndpoint>?id=<gen-...> with the key as a bearer token -> { data: { id, model, total_cost (USD), ... } }.
// A read of a record: no image and no model call. Used only by lib/settle-images.mjs. -> { ok, status, data } (never throws on an HTTP
// error; the key is never in the result).
export function generationUrl(engineCfg) {
  const u = engineCfg && engineCfg.image && engineCfg.image.generationEndpoint;
  if (!/^https:\/\/openrouter\.ai\//.test(String(u || ''))) throw new ImageProviderError('config/engine.json image.generationEndpoint must be an https://openrouter.ai/ URL', { code: 'CONFIG', hardStop: true });
  return u;
}
export async function lookupGeneration({ engineCfg, id, key, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const res = await fetchImpl(generationUrl(engineCfg) + '?id=' + encodeURIComponent(id), { method: 'GET', headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
  let json = null; try { json = await res.json(); } catch (_) { json = null; }
  return { ok: !!res.ok, status: res.status, data: (json && json.data) || null };
}

export function allowedImageModels(engineCfg) {
  const img = (engineCfg && engineCfg.image) || {}, priced = (engineCfg && engineCfg.pricing && engineCfg.pricing[img.provider] && engineCfg.pricing[img.provider].models) || {};
  return (img.allowedModels || []).filter((m) => priced[m] && priced[m].perImage != null);
}

// an OpenRouter error response -> ImageProviderError (key-free)
export function classifyError(status, json, redact, { retryAfterMs = null } = {}) {
  const err = (json && json.error) || {}, meta = err.metadata || {}, msg = redact(clip(typeof err.message === 'string' ? err.message : (err.message ? JSON.stringify(err.message) : 'HTTP ' + status), 300));
  const s = Number(status), base = 'OpenRouter ' + s + ': ';
  if (s === 401) return new ImageProviderError(base + 'the key was refused; check that OPENROUTER_API_KEY holds a valid key', { code: 'AUTH', status: s, hardStop: true });
  if (s === 402) {
    if (meta.limit_source === 'openrouter_in_flight_budget') return new ImageProviderError(base + 'in-flight budget busy; retrying', { code: 'IN_FLIGHT', status: s, retryable: true, retryAfterMs });
    return new ImageProviderError(base + 'insufficient credits on the account or key: add credits (the job stops; nothing more is tried)', { code: 'CREDITS', status: s, hardStop: true });
  }
  if (s === 403) {
    if (meta.reasons || meta.flagged_input) return new ImageProviderError(base + 'the request was flagged by moderation' + (Array.isArray(meta.reasons) && meta.reasons.length ? ' (' + redact(clip(meta.reasons.join(', '), 200)) + ')' : ''), { code: 'MODERATION', status: s, refusal: true });
    return new ImageProviderError(base + 'refused before any provider ran: the key\'s own limit (the owner\'s USD 2 a day), a budget or a guardrail is spent or blocks it (' + msg + '). The job stops; nothing more is tried', { code: 'KEY_LIMIT', status: s, hardStop: true });
  }
  if (s === 408 || s === 429 || s >= 500) return new ImageProviderError(base + (s === 429 ? 'rate limited' : s === 408 ? 'request timed out' : 'provider unavailable') + ' (' + msg + ')', { code: 'HTTP_' + s, status: s, retryable: true, retryAfterMs });
  if (s === 400 && CONTENT_400.test(msg)) return new ImageProviderError(base + 'refused by the content policy (' + msg + ')', { code: 'CONTENT_POLICY', status: s, refusal: true });
  if (s === 404) return new ImageProviderError(base + 'model or endpoint not found (' + msg + ')', { code: 'MODEL_GONE', status: s, hardStop: true });
  return new ImageProviderError(base + 'the request was refused (' + msg + ')', { code: 'HTTP_' + s, status: s, hardStop: true });
}

// the first image in a chat-completions response: a data URL string, or ''
export function imageUrlOf(json) {
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!msg) return '';
  for (const im of Array.isArray(msg.images) ? msg.images : []) { const u = im && (typeof im.image_url === 'string' ? im.image_url : im.image_url && im.image_url.url); if (u) return u; }
  return '';
}
const textOf = (json) => { const m = json && json.choices && json.choices[0] && json.choices[0].message; return m && typeof m.content === 'string' ? m.content : ''; };

// alpha facts of a PNG's bytes: { hasAlpha, clearPct } (clear = alpha 0); opaque formats have none
export async function alphaFacts(buf) {
  const meta = await sharp(buf).metadata();
  if (!meta.hasAlpha) return { width: meta.width, height: meta.height, format: meta.format, hasAlpha: false, clearPct: 0 };
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let clear = 0; for (let i = 3; i < data.length; i += info.channels) if (data[i] === 0) clear++;
  return { width: meta.width, height: meta.height, format: meta.format, hasAlpha: true, clearPct: Math.round((clear / (info.width * info.height)) * 1000) / 10 };
}

// createOpenRouterImage({ engineCfg, env, demo, halt, log, fetchImpl }) — `fetchImpl` is injected by tests only
export function createOpenRouterImage({ engineCfg, env = process.env, demo = false, halt = null, log = null, fetchImpl = null } = {}) {
  if (demo) throw new ImageProviderError('the live image provider never runs in demo mode', { code: 'DEMO', hardStop: true });
  if (env.STATION_PROVIDER !== 'live') throw new ImageProviderError('the live image provider needs STATION_PROVIDER=live in this process\'s environment (it is "' + (env.STATION_PROVIDER || 'unset') + '")', { code: 'NOT_LIVE', hardStop: true });
  const notLive = liveInstanceProblem(env); if (notLive) throw new ImageProviderError(notLive, { code: 'NOT_LIVE_INSTANCE', hardStop: true });   // L1
  const img = (engineCfg && engineCfg.image) || {};
  if (img.provider !== 'openrouter') throw new ImageProviderError('config/engine.json image.provider is "' + img.provider + '", not openrouter', { code: 'CONFIG', hardStop: true });
  const key = env.OPENROUTER_API_KEY;
  if (typeof key !== 'string' || !key.trim()) throw new ImageProviderError('OPENROUTER_API_KEY is not set: the live image provider cannot start', { code: 'NO_KEY', hardStop: true });
  const models = allowedImageModels(engineCfg);
  if (!models.length) throw new ImageProviderError('no allowed image model with a price in config/engine.json', { code: 'CONFIG', hardStop: true });
  for (const k of ['endpoint', 'timeoutMs', 'maxImageBytes']) if (!img[k]) throw new ImageProviderError('config/engine.json image.' + k + ' is not set', { code: 'CONFIG', hardStop: true });
  if (!/^https:\/\/openrouter\.ai\//.test(img.endpoint)) throw new ImageProviderError('config/engine.json image.endpoint must be an https://openrouter.ai/ URL', { code: 'CONFIG', hardStop: true });
  const redact0 = makeRedactor([key]), redact = (s) => redact0(s).replace(/sk-or-[A-Za-z0-9_-]+/g, '<redacted>');
  const doFetch = fetchImpl || globalThis.fetch;
  let calls = 0;

  async function generate({ model, prompt, aspectRatio = null, transparent, width = null, height = null, n = 1, signal = null, ctx = {}, reference = null } = {}) {
    if (halt && halt.isHalted()) throw new ImageProviderError('e-stop is on: no call made', { code: 'HALT' });
    if (signal && signal.aborted) throw signal.reason || new ImageProviderError('aborted before the call', { code: 'ABORTED' });
    if (!models.includes(model)) throw new ImageProviderError('image model ' + model + ' is not allowed (config/engine.json image.allowedModels: ' + models.join(', ') + ')', { code: 'MODEL' });
    if (n !== 1) throw new ImageProviderError('one image per call', { code: 'BAD_PARAMS' });
    if (typeof transparent !== 'boolean') throw new ImageProviderError('transparent must be a boolean', { code: 'BAD_PARAMS' });
    if (typeof prompt !== 'string' || !prompt.trim()) throw new ImageProviderError('prompt must be text', { code: 'BAD_PARAMS' });
    if (reference && !(Buffer.isBuffer(reference.buffer) && /^image\/(png|jpeg)$/.test(reference.mime || ''))) throw new ImageProviderError('reference must be a PNG or JPEG buffer', { code: 'BAD_PARAMS' });
    const text = prompt + (transparent && !TRANSPARENT_ASKED.test(prompt) ? TRANSPARENT_LINE : '') + (reference ? REFERENCE_LINE : '');
    const content = reference ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:' + reference.mime + ';base64,' + reference.buffer.toString('base64') } }] : text;
    const body = { model, messages: [{ role: 'user', content }], modalities: ['image', 'text'], ...(aspectRatio ? { image_config: { aspect_ratio: String(aspectRatio) } } : {}) };
    const t0 = Date.now(), timeout = AbortSignal.timeout(img.timeoutMs), sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const logCtx = { model, agent: ctx.agentKey || null, jobId: ctx.jobId || null, reference: reference ? reference.name || true : false, transparent };
    calls++;
    let res, json = null;
    try {
      res = await doFetch(img.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig });
      // W2: a connection that drops while the body is read is a connection failure (retried), not a response that is not JSON
      json = await res.json().catch((e) => { if (sig.aborted || connectionFailure(e)) throw e; return null; });
    } catch (e) {
      if (signal && signal.aborted) throw e;   // the caller's e-stop / Stop path settles it
      const timedOut = timeout.aborted;
      const err = new ImageProviderError('OpenRouter ' + (timedOut ? 'request timed out' : 'connection failed') + ': ' + redact(clip(e && e.message, 200)), { code: timedOut ? 'TIMEOUT' : 'NETWORK', retryable: true });
      log && log.warn('openrouter image call failed', { ...logCtx, code: err.code, ms: Date.now() - t0 });
      throw err;
    }
    const generationId = (json && typeof json.id === 'string') ? json.id : null;
    const usd = json && json.usage && typeof json.usage.cost === 'number' && Number.isFinite(json.usage.cost) && json.usage.cost >= 0 ? r6(json.usage.cost) : null;
    const fail = (err) => { err.generationId = generationId; if (usd != null) err.usd = usd; log && log.warn('openrouter image refused or failed', { ...logCtx, status: err.status ?? null, code: err.code, hardStop: err.hardStop, refusal: err.refusal, retryable: err.retryable, generationId, usd, ms: Date.now() - t0 }); return err; };
    if (!res.ok) {
      const ra = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) : NaN;
      throw fail(classifyError(res.status, json, redact, { retryAfterMs: Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null }));
    }
    if (!json) throw fail(new ImageProviderError('OpenRouter returned a response that is not JSON', { code: 'BAD_RESPONSE', retryable: true }));
    // a 200 can carry an error (OpenRouter errors reference): the body's error, or finish_reason "error"
    if (json.error) { const c = Number(json.error.code); throw fail(classifyError(Number.isFinite(c) && c >= 400 ? c : 502, json, redact)); }
    const choice = (json.choices || [])[0] || {}, finish = choice.finish_reason || choice.native_finish_reason || null;
    if (finish === 'error') throw fail(new ImageProviderError('OpenRouter: the model failed while producing the image', { code: 'PROVIDER_ERROR', retryable: true }));
    const url = imageUrlOf(json);
    if (!url) {
      const said = redact(clip(textOf(json).replace(/\s+/g, ' '), 200));
      throw fail(new ImageProviderError('OpenRouter: no image came back' + (finish === 'content_filter' ? ' (content filter)' : '') + (said ? ': the model said "' + said + '"' : ''), { code: 'NO_IMAGE', refusal: true }));
    }
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
    if (!m) throw fail(new ImageProviderError('OpenRouter returned an image that is not a base64 data URL (a hosted URL is never downloaded)', { code: 'BAD_RESPONSE', hardStop: true }));
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (buf.length > img.maxImageBytes) throw fail(new ImageProviderError('the returned image is ' + buf.length + ' bytes, over image.maxImageBytes', { code: 'BAD_RESPONSE', hardStop: true }));
    let facts;
    try { facts = await alphaFacts(buf); } catch (e) { throw fail(new ImageProviderError('the returned image could not be decoded: ' + redact(clip(e.message, 120)), { code: 'BAD_RESPONSE', retryable: true })); }
    const size = facts.width + 'x' + facts.height;
    log && log.info('openrouter image', { ...logCtx, generationId, usd, size, format: facts.format, hasAlpha: facts.hasAlpha, clearPct: facts.clearPct, ms: Date.now() - t0 });
    return { files: [buf], usd, priceSource: usd != null ? 'provider' : 'unreported', generationId, model: json.model || model, size, alpha: { hasAlpha: facts.hasAlpha, clearPct: facts.clearPct, transparent: facts.hasAlpha && facts.clearPct > 0 }, format: facts.format, requested: { width, height, aspectRatio } };
  }

  return { id: 'openrouter', models, get calls() { return calls; }, generate };
}
