// e6-c-formats.test.mjs — the owner's genre-brief formats of 17/10/2026 (after scout run 5): prices as the search result showed
// them (a sale with its original price, a range with both ends; the floor and the price range use the current price, a
// range's low end), every price figure checked against the job's transcript, and Seasonality "not measured (no source)"
// unless a cited result supports a season. Floor (owner correction, 17/10/2026): the full range is recorded, cheap rows
// included, and the brief passes when at least 3 cited listings show a current price at or above USD 3.50; a brief may not hide a
// cheaper result its searches showed. Station code only: no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/engine/config.mjs';
import { buildAgentPrompt } from '../src/engine/prompts.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { validateScoutBrief, checkScoutBrief, parsePrice, priceStringProblems, hiddenRowProblems, floorRows, SEASON_NOT_MEASURED } from '../src/engine/lib/scout-brief.mjs';
import { pricesIn, urlsIn } from '../src/engine/lib/web-sources.mjs';
import { genreBrief, GENRES } from '../fixtures/engine/scout-script.mjs';

const CFG = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts') });
const DAY = '2026-10-17', TODAY = new Date('2026-10-17T12:00:00Z');
const G = { ...GENRES[1], price: 4 };   // rows USD 4.00, 4.50, 5.00, 5.50, 6.00; price range USD 4.00–6.00
// the fixture genre brief with row 1's price cell and the Price range line replaced
function brief({ row1 = null, range = null, season = null, verified = true } = {}) {
  let t = genreBrief(DAY, G);
  if (row1) t = t.replace(/^(\| 1 \| [^|]+\| )USD 4\.00( \|)/m, '$1' + row1 + '$2');
  if (range) t = t.replace(/^USD 4\.00–6\.00 — /m, range + ' — ');
  if (season != null) t = t.replace(/(## Seasonality\n)[^\n]*\n/, '$1' + season + '\n');
  return verified ? t.replace('status: candidate', 'status: verified') + '\n## Evidence check\n- ok\n' : t;
}
// the fixture brief with every row's price cell given (rows 1..n keep their result URLs) and the Price range as the full range
function withRows(cells) {
  const t = genreBrief(DAY, G), lines = t.split('\n'), rows = lines.filter((l) => /^\| \d+ \|/.test(l));
  const out = lines.map((l) => { const i = rows.indexOf(l); if (i < 0) return l; const c = l.split('|'); c[3] = ' ' + cells[i] + ' '; return c.join('|'); });
  const ps = cells.map(parsePrice), lo = Math.min(...ps.map((p) => p.current)), hi = Math.max(...ps.map((p) => p.high));
  return out.join('\n').replace(/^USD 4\.00–6\.00 — /m, 'USD ' + lo.toFixed(2) + '–' + hi.toFixed(2) + ' — ').replace('status: candidate', 'status: verified') + '\n## Evidence check\n- ok\n';
}
const QUERY = /^search queries: (.+)$/m;
const numbersOf = (t) => new Set(t.split('\n').filter((l) => /^\| \d+ \|/.test(l)).flatMap((l) => { const p = parsePrice(l.split('|')[3].trim()); return p.ok ? p.numbers.map((n) => n.toFixed(2)) : []; }));
const check = (t, prices = numbersOf(t)) => checkScoutBrief(t, { products: CFG.products, cfg: CFG.station, returned: new Set(urlsIn(t)), returnedPrices: prices, today: TODAY });

test('the price forms: one price, a sale with its original, a range with both ends; anything else is refused', () => {
  assert.deepEqual(parsePrice('USD 4.99'), { ok: true, kind: 'single', currency: 'USD', current: 4.99, high: 4.99, was: null, numbers: [4.99] });
  assert.deepEqual(parsePrice('USD 7.49 (was 9.99)'), { ok: true, kind: 'sale', currency: 'USD', current: 7.49, high: 7.49, was: 9.99, numbers: [7.49, 9.99] });
  assert.equal(parsePrice('USD 7.49 (was USD 9.99)').was, 9.99);
  assert.deepEqual(parsePrice('USD 4.50–18.75'), { ok: true, kind: 'range', currency: 'USD', current: 4.5, high: 18.75, was: null, numbers: [4.5, 18.75] });
  assert.equal(parsePrice('USD 4.50 to 18.75').kind, 'range');
  for (const [bad, why] of [['USD 4.50 to 18.75 on sale', /price must be/], ['USD 9.99 (was 7.49)', /must be above the current price/], ['USD 18.75–4.50', /low end to a higher end/], ['USD 7.49 (was EUR 9.99)', /one currency/], ['$4.99', /price must be/]]) assert.match(parsePrice(bad).problem, why, bad);
});

test('a price string the job\'s web calls never showed is rejected (brief-check and intake read the transcript)', () => {
  const t = brief({ row1: 'USD 3.50 (was 9.99)', range: 'USD 3.50–6.00' }), shown = numbersOf(t);
  assert.equal(check(t, shown).ok, true);
  shown.delete('9.99');
  const c = check(t, shown);
  assert.equal(c.ok, false); assert.match(c.reasons[0], /^prices not shown by any web call in this job: row 1 "USD 3\.50 \(was 9\.99\)" \(9\.99\)/);
  assert.match(check(t, new Set()).reasons[0], /prices not shown by any web call/, 'no price record (a transcript from before E6 c): fails closed');
  assert.deepEqual(priceStringProblems(t, numbersOf(t)), []);
  // what the transcript keeps: the figures a result showed, in the forms results use
  assert.deepEqual(pricesIn('Cozy farm props $7.49 (was $9.99); bundle USD 4.50 to 18.75; €7 sticker; 2026 trends; 12,400 views').sort(), ['18.75', '4.50', '7.00', '7.49', '9.99']);
});

test('a brief that hides a below-floor result its own searches showed fails; recording it passes; its queries must have run', () => {
  const t = withRows(['USD 3.50', 'USD 4.00', 'USD 4.50', 'USD 5.00', 'USD 6.00']), q = QUERY.exec(t)[1];
  const searches = [{ query: q, prices: ['1.00', '3.50', '4.00', '4.50', '5.00', '6.00', '9.99'] }];
  assert.match(hiddenRowProblems(t, searches, 3.5)[0], /^Demand evidence hides results its searches showed below the floor USD 3\.5: USD 1\.00/);
  const c = checkScoutBrief(t, { products: CFG.products, cfg: CFG.station, returned: new Set(urlsIn(t)), returnedPrices: new Set(searches[0].prices), searches, today: TODAY });
  assert.equal(c.ok, false); assert.match(c.reasons[0], /hides results/);
  const shown = withRows(['USD 3.50', 'USD 4.00', 'USD 4.50', 'USD 5.00', 'USD 1.00']);
  assert.deepEqual(hiddenRowProblems(shown, searches, 3.5), []);
  assert.equal(checkScoutBrief(shown, { products: CFG.products, cfg: CFG.station, returned: new Set(urlsIn(shown)), returnedPrices: new Set(searches[0].prices), searches, today: TODAY }).ok, true);
  // another search of the job showing a cheaper price is not this brief's; a named query no search ran fails
  assert.deepEqual(hiddenRowProblems(t, [{ query: q, prices: ['3.50'] }, { query: 'something else', prices: ['0.50'] }], 3.5), []);
  assert.match(hiddenRowProblems(t, [{ query: 'something else', prices: ['5.00'] }], 3.5)[0], /search queries not run by any web search in this job/);
});

test('Seasonality: "not measured (no source)" is valid; a season needs a cited result; a cited season is accepted', () => {
  assert.equal(SEASON_NOT_MEASURED, 'not measured (no source)');
  assert.deepEqual(validateScoutBrief(brief({ season: 'not measured (no source)' })).problems, []);
  assert.match(validateScoutBrief(brief({ season: 'Peaks in December (holiday streams).' })).problems.join(' '), /Seasonality: a season \(or "evergreen"\) needs a cited result that supports it/);
  assert.match(validateScoutBrief(brief({ season: 'evergreen' })).problems.join(' '), /Seasonality: a season/);
  const t = genreBrief(DAY, G), url = urlsIn(t.split('## Genre trend evidence')[1])[0];
  assert.deepEqual(validateScoutBrief(brief({ season: 'Peaks in winter — ' + url })).problems, [], 'a season with a cited (and listed) result');
  assert.match(validateScoutBrief(brief({ season: 'Peaks in winter — https://other.example.com/season' })).problems.join(' '), /Sources: every cited URL must be listed/);
});

test('EVIDENCE-CHECKER\'s prompt is at most 14,000 chars and states the new formats; the scout skill and TREND-SCOUT say them too', () => {
  const p = buildAgentPrompt(CFG.agents['evidence-checker'], { promptsDir: path.join(APP_ROOT, 'prompts') });
  assert.ok(p.chars <= 14000, 'evidence-checker is ' + p.chars + ' chars');
  assert.ok(p.skills.includes('originality-rules') && p.skills.includes('originality-sources'));
  assert.match(p.text, /every number in it must be on the PRICES RETURNED list/);
  assert.match(p.text, /Seasonality is `not measured \(no source\)` or a season a cited result supports/);
  const s = buildAgentPrompt(CFG.agents['trend-scout'], { promptsDir: path.join(APP_ROOT, 'prompts') }).text;
  assert.match(s, /a sale `USD 7\.49 \(was 9\.99\)`; a range `USD 4\.50–18\.75`/);
  assert.match(s, /with no season in the results Seasonality is `not measured \(no source\)`/);
});
