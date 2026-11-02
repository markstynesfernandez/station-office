// PORTED from Virtual-workers/station/scripts/lib/image-policy.mjs (the owner's own code) at 16/10/2026 19:16 Irish time, source sha256 dc28944d79fccb08f275b9e2cc1032ec5d35c99c625ecb7fc6412fa70d7c4bb6.
//   change: none (config default is the engine's business config)
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// image-policy.mjs (lib) — the owner's OpenRouter guardrail (2026-10-15) allows ONE image model on the Default key. Tees are transparent and render on
// openai/gpt-5-image-mini; an opaque product (the poster) would render on config.models.imageOpaque, which the guardrail refuses. Until the owner decides
// (allow that model, or render posters on the allowed one) an opaque product fails clearly here instead of wasting a Designer run.
// The owner records the decision by setting config.imagePolicy.opaqueModelApproved to true. Pure.
import { config as defaultConfig } from './common.mjs';

export function imagePolicyProblem(product, cfg = defaultConfig) {
  if (!product || product.transparent) return null;
  const pol = cfg.imagePolicy || {};
  if (pol.opaqueModelApproved === true) return null;
  const model = cfg.models && cfg.models.imageOpaque && cfg.models.imageOpaque.id;
  return 'image-model decision pending for opaque product "' + product.key + '": it would render on ' + model + ', which the OpenRouter guardrail refuses (allowed: ' + ((pol.allowedModels || []).join(', ') || 'none listed') + '). The owner must allow that model or choose another, then set config.imagePolicy.opaqueModelApproved to true.';
}
