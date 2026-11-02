// PORTED from Virtual-workers/station/scripts/lib/slogan.mjs (the owner's own code) at 16/10/2026 19:16 Irish time, source sha256 438f63df5896fe2f784943dcfbbd95294925ba4e167f0f05f3797f3edfed2cf5.
//   change: only ukSpellings and listingSpellingProblems are ported (the market spelling rule; US English until the owner decides, §4.3 item 7); the slogan flow is POD and is not ported
//   change (port batch, 17/10/2026): the owner's US word list of the listing text fix (listing-fix.mjs US_SPELLING) is part of the check
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
import { config as defaultConfig } from './common.mjs';
import { US_SPELLING } from './listing-fix.mjs';

// port batch 17/10/2026 (owner: the market is US English for this product, enforced by the spelling check): the owner's US word list
// of the deterministic text fix (listing-fix.mjs, 2026-10-17: Cosy->Cozy, colour->color, colourway->colorway) joins the config's pairs,
// so the gate fails every word the owner fixes by hand ("colourway" was not in config.usSpelling.pairs; QA LISTING caught it)
const OWNER_PAIRS = Object.fromEntries(US_SPELLING.map(([uk, us]) => [uk.toLowerCase(), us.toLowerCase()]));
export function ukSpellings(text, cfg = defaultConfig) {
  const pairs = { ...OWNER_PAIRS, ...((cfg.usSpelling && cfg.usSpelling.pairs) || {}) }, found = [], low = ' ' + String(text || '').toLowerCase().replace(/[^a-z' -]+/g, ' ') + ' ';
  for (const [uk, us] of Object.entries(pairs)) if (uk !== us && low.includes(' ' + uk + ' ')) found.push({ word: uk, us });
  return found;
}
export function listingSpellingProblems(L, cfg = defaultConfig) {
  const parts = { title: L.title, description: L.description, altText: L.altText, tags: Array.isArray(L.tags) ? L.tags.join(' | ') : '' }, out = [];
  for (const [k, v] of Object.entries(parts)) for (const f of ukSpellings(v, cfg)) out.push('UK spelling "' + f.word + '" in ' + k + ' (US market: use "' + f.us + '")');
  return out;
}
