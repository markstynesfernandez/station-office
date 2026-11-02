// providers/mock.mjs — the mock providers for E1–E5: zero spend, no key, no network.
// Text: an object with the same create(params, { signal, ctx }) shape as the Anthropic Messages API. Replies come from a
// script (ctx = { agentKey, jobId, step, pass, turn, job }) and usage is a fake token count; the engine prices it from
// the "mock" provider entry in config/engine.json, which is $0. Images: PNGs drawn with sharp at the requested size,
// different per prompt, clearly marked MOCK. Both honour the abort signal (the e-stop).
import crypto from 'node:crypto';
import sharp from 'sharp';

export const MOCK_MODEL_NOTE = 'mock provider: scripted reply, no model was called';
const sleep = (ms, signal) => new Promise((res, rej) => { if (signal && signal.aborted) return rej(signal.reason || new Error('aborted')); const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason || new Error('aborted')); }, { once: true }); });
const approxTokens = (s) => Math.ceil(String(s || '').length / 4);

export function createMockText({ script, delayMs = 0 } = {}) {
  let calls = 0;
  return {
    id: 'mock',
    get calls() { return calls; },
    async create(params, { signal, ctx = {} } = {}) {
      if (signal && signal.aborted) throw signal.reason || new Error('aborted');
      calls++;
      await sleep(delayMs, signal);
      const out = script ? await script(ctx, params) : { content: [{ type: 'text', text: 'mock reply' }] };
      const content = out.content || [{ type: 'text', text: String(out.text || '') }];
      const stop = out.stop_reason || (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
      const inTok = approxTokens(JSON.stringify(params.system || '')) + approxTokens(JSON.stringify(params.messages || []));
      return { id: 'mock_' + crypto.randomUUID(), type: 'message', role: 'assistant', model: params.model, content, stop_reason: stop, usage: { input_tokens: inTok, output_tokens: approxTokens(JSON.stringify(content)), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, mock: true };
    }
  };
}

// a deterministic, obviously fake picture for a prompt: soft gradient, a shape, the word MOCK and a short label
export async function mockPng({ prompt, width, height, transparent = false }) {
  const h = crypto.createHash('sha256').update(String(prompt)).digest();
  const hue = h[0] * 360 / 256, hue2 = (hue + 40 + h[1] % 80) % 360, shape = h[2] % 3;
  const w = width, ht = height, m = Math.min(w, ht);
  const fig = shape === 0 ? '<circle cx="' + w / 2 + '" cy="' + ht / 2 + '" r="' + m * 0.28 + '" fill="hsl(' + hue2 + ',55%,62%)"/>'
    : shape === 1 ? '<rect x="' + w * 0.25 + '" y="' + ht * 0.25 + '" width="' + w * 0.5 + '" height="' + ht * 0.5 + '" rx="' + m * 0.08 + '" fill="hsl(' + hue2 + ',55%,62%)"/>'
      : '<polygon points="' + [w / 2, ht * 0.18, w * 0.82, ht * 0.78, w * 0.18, ht * 0.78].join(',') + '" fill="hsl(' + hue2 + ',55%,62%)"/>';
  const label = String(prompt).replace(/[^A-Za-z0-9 ,.-]/g, '').slice(0, 40);
  const bg = transparent ? '' : '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + hue + ',45%,88%)"/><stop offset="1" stop-color="hsl(' + hue2 + ',45%,78%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + ht + '">' + bg + fig
    + '<text x="50%" y="' + ht * 0.12 + '" font-family="Segoe UI, Arial" font-size="' + m * 0.07 + '" font-weight="700" text-anchor="middle" fill="#3a3550" opacity="0.8">MOCK</text>'
    + '<text x="50%" y="' + ht * 0.93 + '" font-family="Segoe UI, Arial" font-size="' + m * 0.035 + '" text-anchor="middle" fill="#3a3550" opacity="0.7">' + label + '</text></svg>';
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

export function createMockImage({ delayMs = 0 } = {}) {
  let calls = 0;
  return {
    id: 'mock',
    get calls() { return calls; },
    async generate({ model, prompt, width = 1024, height = 1024, transparent = false, n = 1, signal }) {
      if (signal && signal.aborted) throw signal.reason || new Error('aborted');
      calls++;
      await sleep(delayMs, signal);
      const files = [];
      for (let i = 0; i < n; i++) files.push(await mockPng({ prompt: prompt + (i ? ' #' + i : ''), width, height, transparent }));
      return { files, usd: 0, priceSource: 'mock', raw: { model, mock: true } };
    }
  };
}
