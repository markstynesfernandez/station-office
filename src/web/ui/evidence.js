// ui/evidence.js — the brief's evidence level on the approval card (owner decision 2, 17/10/2026; DECISIONS.md "E6 step
// b2: owner decisions, part 2"). The approval queue is the only human gate before an Etsy listing, so a brief whose
// demand evidence is "indicative" (genre-scout briefs: web search results only, competitor count not measured, until
// the Etsy Open API) says so prominently there, as does an owner brief ("owner", decision 5: no market evidence at all).
// No DOM: the panel inserts the returned HTML (tested in node).
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// E7a (owner decision 1, 19/10/2026): indicative evidence is non-Etsy only (no Etsy data until Etsy authorises it in
// writing), and a brief whose results showed no price says the owner sets the price (ownerSetsPrice)
export function evidenceBanner(level, { ownerSetsPrice = false } = {}) {
  if (!level) return '';
  // owner decision 5 (17/10/2026): an owner brief claims no demand evidence
  if (level === 'owner') return '<div class="evidence-banner evidence-owner" role="note"><strong>Evidence: OWNER BRIEF — no market evidence</strong> — the owner\'s own product decision; no demand, price or keyword evidence was researched for it.</div>';
  if (level === 'indicative') return '<div class="evidence-banner evidence-indicative" role="note"><strong>Evidence: INDICATIVE</strong> — demand from non-Etsy web search results only (trend articles, roundups, discussion, other marketplaces; titles, prices and keywords as the results showed them); competitor count not measured; no Etsy data.'
    + (ownerSetsPrice ? ' <strong>Price: OWNER SETS PRICE</strong> — no cited result showed a price; the listing is at the no-brief price until you set it.' : '') + '</div>';
  return '<div class="evidence-banner" role="note"><strong>Evidence: ' + esc(level.toUpperCase()) + '</strong></div>';
}
