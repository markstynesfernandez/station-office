// providers/index.mjs — picks the model and image providers (ENGINE-PLAN.md §2.3, §2.5).
//   mock  scripted replies and procedural images, fake usage priced at $0; reads no key (E1–E5)
//   live  E6 step a0: Anthropic text (official SDK, providers/anthropic.mjs). Built only when STATION_PROVIDER=live is in
//         this process's environment, never in demo mode, and only with ANTHROPIC_API_KEY set. E6 step b0: the web
//         backend is Anthropic's server-side web search / fetch through that provider (providers/anthropic-web.mjs).
//         E6 step c0: images are OpenRouter (providers/openrouter.mjs), built with OPENROUTER_API_KEY; without that key the
//         image provider refuses every call as a hard stop (a scout run, which draws nothing, still starts).
//         L1: and only on the live instance (STATION_INSTANCE=live, src/engine/instance.mjs); the dev instance never goes live.
import { createMockText, createMockImage } from './mock.mjs';
import { createAnthropicText } from './anthropic.mjs';
import { createAnthropicWeb } from './anthropic-web.mjs';
import { createOpenRouterImage, ImageProviderError } from './openrouter.mjs';

export class ProviderLocked extends Error { constructor(mode) { super('provider mode "' + mode + '" is not known: use STATION_PROVIDER=mock (or live, for an approved E6 step only).'); this.code = 'LOCKED'; } }

export function createProviders({ mode = process.env.STATION_PROVIDER || 'mock', script, delayMs = 0, log, engineCfg = null, halt = null, demo = false, env = process.env, client = null, fetchImpl = null } = {}) {
  if (mode === 'live') {
    const text = createAnthropicText({ engineCfg, env, demo, halt, log, client });
    const web = createAnthropicWeb({ text, engineCfg, log });
    let image;
    try { image = createOpenRouterImage({ engineCfg, env, demo, halt, log, fetchImpl }); }
    catch (e) {
      if (!(e instanceof ImageProviderError) || e.code !== 'NO_KEY') throw e;
      image = { id: 'no-key', models: [], get calls() { return 0; }, async generate() { throw new ImageProviderError('OPENROUTER_API_KEY is not set: no image can be generated (the job stops; no call was made)', { code: 'NO_KEY', hardStop: true }); } };
    }
    log && log.warn('providers: LIVE (Anthropic text and web; ' + (image.id === 'openrouter' ? 'OpenRouter images' : 'images refused: no OPENROUTER_API_KEY') + ')', { models: text.models, web: web.settings.model, images: image.models });
    return { mode, text, image, web };
  }
  if (mode !== 'mock') throw new ProviderLocked(mode);
  log && log.info('providers: mock (scripted replies, $0, no keys read)');
  // researchers' web backend: canned results in the mock (E6 wires Anthropic's server-side web search and fetch, Q6)
  const web = async (name, args) => ({ text: (script && script.web ? await script.web(name, args) : 'mock ' + name + ' result for ' + JSON.stringify(args)), usd: 0, priceSource: 'mock' });
  return { mode, text: createMockText({ script, delayMs }), image: createMockImage({ delayMs }), web };
}
