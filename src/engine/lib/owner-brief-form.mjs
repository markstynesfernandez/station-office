// lib/owner-brief-form.mjs — L2: the owner brief written from the Station page's form (title, theme, audience, the item list with the
// count from the product spec, product_key from products.json, the "ownerFile1" toggle, price bounds at or above the floor). This only
// composes the text in the owner brief format (lib/owner-brief.mjs) and checks the form itself; the brief is then saved through the same
// intake and checks as the CLI (orchestrator.saveOwnerBrief: format, product, originality of the whole brief, scouting blocklist, image
// policy, owner bounds against the floor). Station code, no model.
import { briefPriceCheck } from './etsy-fees.mjs';
import { dublinDay } from '../time.mjs';
import { isListingId } from './common.mjs';
// the id comes from the title by the same function the page shows it with (L2 fix: an id is at most 60 characters in all)
import { slugOf, briefIdOf } from '../../web/ui/brief-id.js';
export { slugOf, briefIdOf };

const clean = (s, n) => String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const oneLine = (s, n) => clean(s, n).replace(/\n+/g, ' ');
const money = (v) => (typeof v === 'number' ? v : Number(String(v == null ? '' : v).trim()));

// what the form needs per product: the file count from the spec, the floor, whether file 1 is a style reference
export function formProducts(products, cfg) {
  return (products || []).filter((p) => p.digital === true && p.deliverables && Array.isArray(p.deliverables.files) && p.deliverables.files.length).map((p) => {
    const r = briefPriceCheck(null, p, cfg);
    return { key: p.key, files: p.deliverables.files.length, floorUsd: r.floorUsd ?? null, styleReference: !!(p.styleReference && p.styleReference.ownerOk), kind: p.kind || null };
  });
}

// -> { ok, id, text, problems[] }; problems are the form's own (the intake checks run on save)
export function composeOwnerBrief(form = {}, { products = [], cfg, today = dublinDay() } = {}) {
  const problems = [], P = formProducts(products, cfg), prod = P.find((p) => p.key === String(form.productKey || ''));
  const title = oneLine(form.title, 120), theme = clean(form.theme, 1500), audience = oneLine(form.audience, 120);
  const items = (Array.isArray(form.items) ? form.items : []).map((x) => oneLine(x, 200));
  if (!prod) problems.push('pick a product from products.json (' + P.map((p) => p.key).join(', ') + ')');
  if (title.length < 3) problems.push('give the brief a title');
  if (theme.length < 10) problems.push('describe the theme in a sentence or more');
  if (audience.length < 3) problems.push('name the audience (e.g. PNGTuber and VTuber streamers)');
  if (prod && items.length !== prod.files) problems.push('the product spec has ' + prod.files + ' files: give exactly ' + prod.files + ' items (got ' + items.length + ')');
  items.forEach((x, i) => { if (x.length < 3) problems.push('item ' + (i + 1) + ' is empty'); });
  const min = money(form.minUsd), max = money(form.maxUsd), cents = (v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
  if (!(min > 0) || !cents(min)) problems.push('give the lowest price in USD (e.g. 3.50)');
  if (!(max > 0) || !cents(max)) problems.push('give the highest price in USD (e.g. 9.00)');
  if (min > 0 && max > 0 && min > max) problems.push('the lowest price is above the highest');
  if (prod && prod.floorUsd != null && min > 0 && min < prod.floorUsd - 1e-9) problems.push('the lowest price USD ' + min.toFixed(2) + ' is below the floor USD ' + prod.floorUsd.toFixed(2) + ' for ' + prod.key);
  const slug = slugOf(title), id = briefIdOf(title, today);
  if (!slug) problems.push('the title needs letters or digits for the brief id');
  else if (!isListingId(id)) problems.push('the brief id ' + id + ' is not a valid id (YYYY-MM-DD--slug, at most 60 characters)');
  if (problems.length) return { ok: false, id: slug ? id : null, text: null, problems };
  const file1 = form.ownerFile1 === true || form.ownerFile1 === 'true';
  const text = ['---', 'id: ' + id, 'date: ' + today, 'status: owner', 'origin: owner', 'product_type: ' + prod.key, 'audience_segment: ' + audience, ...(file1 ? ['ownerFile1: true'] : []), '---',
    '# Niche', title + ' for ' + audience + '.', '',
    '## Demand evidence', 'evidence level: owner',
    'Owner brief (owner, ' + today + '), written in the Station page. No demand evidence is claimed: no market research was done for this brief. It has no competitor count, no listing prices and no keyword figures. The approval card shows it as "Evidence: OWNER BRIEF — no market evidence".', '',
    '## Design direction', 'Title idea: ' + title + '.', '', 'Theme: ' + theme, '',
    'What the files are: ' + prod.files + ' files, each as the product spec (' + prod.key + ') defines the format.', '',
    'The ' + prod.files + ' items:', ...items.map((x, i) => (i + 1) + '. ' + x.charAt(0).toUpperCase() + x.slice(1).replace(/\.$/, '') + '.'), '',
    'No text, letters, logos, brands, characters or real people in any image.', '',
    ...(prod.styleReference ? ['File 1 is drawn alone first as the style reference. ' + (file1 ? 'QA DESIGN checks it, then the owner approves it before the other files are drawn (ownerFile1).' : 'QA DESIGN\'s pass on it is its approval; the other files follow without a pause.'), ''] : []),
    '## Price range', 'owner bounds: USD ' + min.toFixed(2) + '–' + max.toFixed(2) + ' (owner brief, ' + today + ')',
    'LISTER proposes a price within these bounds, with its reason. The owner sets the final price at approval. No market prices were researched for this brief.', '',
    '## Listing', 'AI use is disclosed: the description carries the AI disclosure line word for word (config.digital.aiDisclosure). US English.', ''].join('\n');
  return { ok: true, id, text, problems: [] };
}
