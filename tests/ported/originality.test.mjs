// PORTED from Virtual-workers/station/tests/originality.test.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment), source sha256 bf853a54b1749f59b8297f229115c0796410335d4f635913545691a858169704.
//   change: re-ported (the 1st-moment port was of source sha256 d78a1a53ac71a05f534b6c73933025367bbe1d2f51e86e9ac32d3d8675264d6e); now also covers the near-miss allow-list and the digital set screen
//   change: imports point at src/engine/lib; config is the engine's (config/station.config.json, productType 'digital'); ID is the old helpers/room.mjs id, inlined
//   change: job folders are jobs/<id>/ with outbox/ inside (were work/<id>/ and outbox/<id>/)
//   change: each temp folder is the data root of a data jail
//   change: the stock-template (saturated) test now expects a hit on titles and tags (owner Q5: SOFT_CATEGORIES is [] in the engine)
//   change: not ported: screenSlogan (slogan.mjs, POD slogan flow), the four POD package-gate tests (podTest, archived tee room), the StarNet
//           COMMS/BRIDGE guards (guards.mjs, no StarNet in the engine) and the approvals.reviewBeforeLister test (run-line.mjs, POD fixtures)
//   change: added: hitLine on a hit without a field prints "text:" and never "undefined" (port item 13); screenDigitalSetOnDisk reads jobs/<id>/...
// Everything else is the source unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screenText, screenFields, screenListing, screenDesign, imagePromptOf, recordDesignOriginality, recordListingOriginality, readings, designDeliverableText, screenDigitalSet, screenDigitalSetOnDisk, hitLine } from '../../src/engine/lib/originality.mjs';
import { config } from '../../src/engine/lib/common.mjs';
import { createJail } from '../../src/engine/store/jail.mjs';
import { useJail } from '../../src/engine/store/active.mjs';
import { tempDir } from '../helpers/engine.mjs';
const ID = '2026-10-15--gate-test-tee';

const cat = (t) => screenText(t).hits.map((h) => h.category);

// one known-bad example per protected class, plus the evasion forms
const BAD = [
  ['trademark / brand', 'Nike Dad', 'brands'], ['brand, case + punctuation', 'N.I.K.E. dad!', 'brands'], ['brand, spaced letters', 'n i k e', 'brands'], ['brand, digit swap', 'N1KE dad', 'brands'],
  ['brand, plural', 'Nikes for Dad', 'brands'], ['brand, possessive', "Disney's Finest Dad", 'brands'], ['brand, misspelt', 'Addidas Dad', 'brands'], ['brand, misspelt long', 'Starbuks Dad', 'brands'],
  ['logo mark', 'The Swoosh Dad', 'brands'],
  ['character', 'Pikachu Dad', 'characters'], ['character, compound', 'Spiderman Dad', 'characters'], ['character, hyphen', 'Spider-Man Dad', 'characters'], ['character, accent', 'Pokémon Dad', 'characters'],
  ['franchise', 'Star Trek Dad', 'franchises'], ['franchise (film)', 'The Big Lebowski Dad', 'franchises'],
  ['real person', 'Taylor Swift Dad', 'people'], ['real person (sport)', 'Lebron Dad', 'people'], ['real person, misspelt', 'Cristiano Ronalldo Dad', 'people'],
  ['song lyric', 'We Will Rock You Dad', 'lyrics-and-quotes'], ['film quote', 'Yippee Ki Yay Dad', 'lyrics-and-quotes'], ['book / TV quote', 'You Know Nothing Jon Snow', 'lyrics-and-quotes'],
  ['well-known slogan', 'Just Do It Dad', 'catchphrases'], ['well-known slogan, shouted', 'JUST DO IT!!!', 'catchphrases'], ['advertising slogan', 'Finger Lickin Good Dad', 'lyrics-and-quotes'],
  ['sports team', 'Dallas Cowboys Dad', 'teams-and-leagues'], ['sports league', 'Premier League Dad', 'teams-and-leagues'], ['sports team, club', 'Man Utd Dad', 'teams-and-leagues'],
  ['named artist', 'Banksy Dad', 'artists'], ['artist style', 'In the style of Van Gogh', 'artists'], ['style wording', 'in the manner of a famous painter', 'derivative'],
  ['inspired by a product', 'Inspired by the Yeti Rambler', 'derivative'], ['dupe / copy wording', 'A dupe of the bestseller', 'derivative'], ['fan art wording', 'Fan art dad shirt', 'derivative'],
  ['stock template (slogans only)', 'Grill Sergeant', 'saturated']
];
for (const [what, text, category] of BAD) test('FAILS: ' + what + ' — "' + text + '"', () => { assert.ok(cat(text).includes(category), text + ' -> ' + JSON.stringify(screenText(text).hits)); });

const GOOD = ['Smoke signals: dad is grilling', 'Tongs up', 'Fully loaded dad', 'Camp dad', 'Toddler wrangler', 'Cowboy dad spurs', 'Uber dad', 'Eagle eyed dad', 'Pineapple on pizza', 'Afford it', 'Chocolate dad',
  'I fix things and know things', 'Dad, but make it quiet', 'Reel tired', 'Bad at golf, great at dad', 'Dink responsibly'];
for (const t of GOOD) test('PASSES: "' + t + '"', () => { const r = screenText(t); assert.equal(r.result, 'clear', JSON.stringify(r.hits)); });

// owner exception 2026-10-17: "chunky" (a style word in the brief) was flagged as a near-miss of the character "Chucky"
test('near-miss allow-list: "chunky" is not a misspelling of "Chucky"; Chucky itself and its evasions still hit', () => {
  assert.deepEqual(config.sloganScreen.nearMissAllow.chucky, ['chunky']);
  for (const t of ['Chunky rounded kawaii proportions', 'a CHUNKY mug', 'chunky.']) assert.equal(screenText(t).result, 'clear', t + ' -> ' + JSON.stringify(screenText(t).hits));
  // exact whole words only (owner, 2026-10-17): an unlisted form of the allowed word is not allowed
  assert.ok(cat('chunkys').includes('characters'));
  for (const t of ['Chucky mug', 'CHUCKY', "Chucky's mug", 'Chuckys', 'c h u c k y', 'Chuckky mug']) assert.ok(cat(t).includes('characters'), t + ' -> ' + JSON.stringify(screenText(t).hits));
  // the allow-list is per name: an unlisted near-miss of another long name still hits
  assert.ok(cat('Addidas Dad').includes('brands'));
});

// owner, 2026-10-17: set-v4's brief hit on "channel(s)" (Chanel) and "browser" (Bowser); allow-listed as exact whole words
test('near-miss allow-list: channel(s) and browser(s) pass as exact words; Chanel, Bowser and their other one-typo variants still fail, in the brief and the listing text', () => {
  assert.deepEqual(config.sloganScreen.nearMissAllow.chanel, ['channel', 'channels']);
  assert.deepEqual(config.sloganScreen.nearMissAllow.bowser, ['browser', 'browsers']);
  const listing = (w) => ({ title: 'Cosy desk props', tags: ['desk props', w + ' props'], description: 'Rounded props for ' + w + '.', altText: 'A ' + w + ' mug' });
  const brief = (w) => '## Buyer persona\nStreamers who buy for ' + w + '.\n## Design direction\nRounded ' + w + ' props.\n';
  const where = (w) => ({ brief: screenDigitalSet({ briefText: brief(w) }), listing: screenDigitalSet({ listing: listing(w) }) });
  for (const w of ['channel', 'channels', 'Channel', 'CHANNELS', 'browser', 'browsers', 'Browser']) {
    for (const [k, r] of Object.entries(where(w))) assert.equal(r.result, 'clear', w + ' in the ' + k + ' -> ' + JSON.stringify(r.hits));
  }
  const fails = [['Chanel', 'brands', 'chanel'], ['Bowser', 'characters', 'bowser'], ['Chanels', 'brands', 'chanel'], ['Bowsers', 'characters', 'bowser'],
    // one-typo variants that are not the allow-listed words
    ['chanell', 'brands', 'chanel'], ['chanle', 'brands', 'chanel'], ['bowzer', 'characters', 'bowser'], ['bowserr', 'characters', 'bowser'], ['bowsr', 'characters', 'bowser'],
    // exact words only: an unlisted form of an allowed word is not allowed
    ['channeles', 'brands', 'chanel'], ['browseres', 'characters', 'bowser']];
  for (const [w, category, phrase] of fails) {
    for (const [k, r] of Object.entries(where(w))) {
      assert.equal(r.result, 'hit', w + ' in the ' + k);
      assert.ok(r.hits.some((h) => h.category === category && h.phrase === phrase && h.field.startsWith(k === 'brief' ? 'brief.md' : 'listing ')), w + ' in the ' + k + ' -> ' + JSON.stringify(r.hits));
    }
  }
  // the allowed word beside the name: the name still hits
  assert.ok(cat('my channel, Chanel').includes('brands')); assert.ok(cat('a browser for Bowser').includes('characters'));
});

test('digital set screen: only the Designer\'s self-check section is skipped; a protected name anywhere else still fails, with its field', () => {
  // set-v3 failed on "copy of" in the Designer's own notes; the self-check section says "Copied work? No ... No Disney, no Nike"
  const md = ['# Design set v3', 'Style: plump rounded kawaii props, warm palette.', '## Image prompt (exact)', 'A plump rounded mug, thick dark brown outline.',
    '## Files', '11. 11-steaming-mug-alt: file 1 prompt with a sage mug. Analysis: sage mug, cream band, no text.',
    '## Originality self-check', '1. Copied work? No, not a copy of anything. Not in the style of any artist.', '2. Trademarks? No Disney, no Nike.',
    '## After', 'A closing line that is screened.'].join('\n');
  const brief = '---\nid: x\n---\n# Niche\nCosy desk props.\n## Design direction\nOriginal cosy desk props, plump and rounded.\n## Risks\nKeep every prop generic.\n';
  const listing = { title: 'Cosy desk props for streamers', tags: ['cosy desk', 'stream props'], description: 'Twelve rounded desk props.', altText: 'A rounded mug' };
  const d = designDeliverableText(md);
  assert.deepEqual(d.skipped, { sections: ['Originality self-check'] });
  assert.ok(!/copy of|style of|Disney|Nike/i.test(d.text) && /Analysis: sage mug/.test(d.text) && /thick dark brown/.test(d.text) && /closing line/.test(d.text), d.text);
  const r = screenDigitalSet({ designMd: md, fileNames: ['pngtuber-cosy-desk-props-r2.zip', '01-steaming-mug.png'], briefText: brief, listing });
  assert.equal(r.result, 'clear', JSON.stringify(r.hits));
  for (const f of ['design.md', 'file names[2]', 'brief.md', 'listing title', 'listing tags[2]', 'listing description', 'listing altText']) assert.ok(r.screened.includes(f), f + ' not screened: ' + r.screened.join());
  // a protected name in each place the owner listed fails the set, labelled with where it was
  const base = { designMd: md, fileNames: ['01-steaming-mug.png'], briefText: brief, listing };
  const fields = (x) => screenDigitalSet({ ...base, ...x }).hits.map((h) => h.field + ':' + h.phrase);
  const cases = [
    ['image prompt', { designMd: md.replace('A plump rounded mug', 'A plump rounded Nike mug') }, 'design.md:nike'],
    ['design description', { designMd: md.replace('Style: plump', 'Style: Disney-like plump') }, 'design.md:disney'],
    ['a per-file note', { designMd: md.replace('Analysis: sage mug', 'Analysis: a Chucky mug') }, 'design.md:chucky'],
    ['the Designer\'s Analysis note, "copy of"', { designMd: md.replace('no text.', 'not an exact copy of file 1.') }, 'design.md:copy of'],
    ['a deliverable file name', { fileNames: ['01-steaming-mug.png', '02-nike-mug.png'] }, 'file names[2]:nike'],
    ['brief Design direction', { briefText: brief.replace('plump and rounded', 'like Disney props') }, 'brief.md:disney'],
    ['brief, another section', { briefText: brief.replace('Keep every prop generic.', 'Nike-style swoosh on the mug.') }, 'brief.md:nike'],
    ['listing title', { listing: { ...listing, title: 'Nike desk props' } }, 'listing title:nike'],
    ['listing tag', { listing: { ...listing, tags: ['cosy desk', 'disney props'] } }, 'listing tags[2]:disney'],
    ['listing description', { listing: { ...listing, description: 'Props for your Chucky stream.' } }, 'listing description:chucky'],
    ['listing alt text', { listing: { ...listing, altText: 'A Nike mug' } }, 'listing altText:nike'],
  ];
  for (const [where, x, want] of cases) { const got = fields(x); assert.equal(screenDigitalSet({ ...base, ...x }).result, 'hit', where); assert.ok(got.includes(want), where + ': ' + got.join()); }
  // the owner's listing blocklist applies to the listing text
  assert.ok(fields({ listing: { ...listing, title: 'Zorblax props' }, extra: ['zorblax'] }).some((h) => h.startsWith('listing title:')));
  // the skip ends at the next heading of the self-check's level or higher: a prompt after it is screened
  assert.equal(screenDigitalSet({ designMd: '## Plan\n### Self-check\nNo Nike.\n### Prompts\nA mug.' }).result, 'clear');
  assert.equal(screenDigitalSet({ designMd: '## Plan\n### Self-check\nfine\n## Prompts\nA Nike mug.' }).result, 'hit');
  assert.equal(screenDigitalSet({ designMd: '## Plan\n### Self-check\nfine\n### Prompts\nA Nike mug.' }).result, 'hit');
});

// added in the port: the on-disk reader takes design.md, brief.md and the listing from the engine's jobs/<id>/ layout
test('digital set screen on disk: reads jobs/<id>/set-vN/design.md, jobs/<id>/brief.md and jobs/<id>/outbox/listing.json; the self-check is still skipped', () => {
  const dir = tempDir('og-disk-'), w = path.join(dir, 'jobs', ID);
  try {
    fs.mkdirSync(path.join(w, 'set-v2'), { recursive: true }); fs.mkdirSync(path.join(w, 'outbox'));
    fs.writeFileSync(path.join(w, 'set-v2', 'design.md'), '# Set\nA plump mug.\n## Originality self-check\nNo Nike, no Disney.\n');
    fs.writeFileSync(path.join(w, 'brief.md'), '# Niche\nCosy desk props.\n');
    fs.writeFileSync(path.join(w, 'outbox', 'listing.json'), JSON.stringify({ title: 'Cosy desk props', tags: ['desk props'], description: 'Props.', altText: 'A mug' }));
    const clear = screenDigitalSetOnDisk({ roomDir: dir, id: ID, n: 2, fileNames: ['01-mug.png'], extra: [] });
    assert.equal(clear.result, 'clear', JSON.stringify(clear.hits)); assert.deepEqual(clear.skipped, { sections: ['Originality self-check'] }); assert.ok(clear.screened.includes('listing title'));
    fs.writeFileSync(path.join(w, 'brief.md'), '# Niche\nChanel desk props.\n');
    fs.writeFileSync(path.join(w, 'outbox', 'listing.json'), JSON.stringify({ title: 'Nike desk props', tags: ['desk props'], description: 'Props.', altText: 'A mug' }));
    const hit = screenDigitalSetOnDisk({ roomDir: dir, id: ID, n: 2, extra: [] }).hits.map((h) => h.field + ':' + h.phrase);
    assert.ok(hit.includes('brief.md:chanel') && hit.includes('listing title:nike'), hit.join());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plurals are matched one way only: the text word may be plural, the listed team name is not loosened', () => {
  assert.equal(screenText('Eagle').result, 'clear'); assert.equal(screenText('Eagles').result, 'hit'); assert.equal(screenText('Disneys').result, 'hit');
});
test('readings: the plain text plus the digit/symbol readings (1 as i and as l)', () => {
  const v = readings('N1KE').map((r) => r.tokens.join(' ')); assert.ok(v.includes('n1ke') && v.includes('nike'), JSON.stringify(v));
});

// added in the port (port item 13): a hit from screenText has no field; its line says "text", never "undefined"
test('hitLine: a hit without a field prints "text:" and never "undefined"; a hit with a field prints the field', () => {
  const h = screenText('Nike Dad').hits[0]; assert.equal(h.field, undefined);
  const line = hitLine(h); assert.ok(line.startsWith('text: "'), line); assert.ok(!/undefined/.test(line), line); assert.match(line, /matches brands "nike"/);
  const f = screenFields({ title: 'Nike Dad' }).hits[0]; assert.ok(hitLine(f).startsWith('title: "'), hitLine(f));
});

// ---- listing text: title, tags, description, alt text ----
const L = (o = {}) => ({ title: 'Garden Gnome Tee', tags: ['gnome tee', 'garden gift'], description: 'A tee, designed with AI.', altText: 'A gnome on a tee', ...o });
test('listing: known-bad titles, tags, descriptions and alt text each fail and name the field', () => {
  for (const [field, o] of [['title', { title: 'Nike Style Dad Tee' }], ['tags[2]', { tags: ['dad tee', 'pokemon gift'] }], ['description', { description: 'Inspired by the Yeti Rambler. Made with AI.' }], ['altText', { altText: 'A Taylor Swift fan' }]]) {
    const r = screenListing({ listing: L(o) }); assert.equal(r.result, 'hit', field); assert.ok(r.hits.some((h) => h.field === field), JSON.stringify(r.hits));
  }
});
test('listing: a clean listing passes; the stock-template (saturated) list now applies to titles and tags too (owner Q5)', () => {
  assert.equal(screenListing({ listing: L() }).result, 'clear'); const r = screenListing({ listing: L({ title: 'Dad Bod Tee', tags: ['dad bod'] }) }); assert.equal(r.result, 'hit'); assert.ok(r.hits.every((h) => h.category === 'saturated'), JSON.stringify(r.hits));
});

// ---- design notes: the exact image prompt, not the self-check ----
const MD = '# design-v1\n\n## Image prompt (exact)\nFlat vector illustration of a camp mug, no text, no letters.\n\n## Originality self-check\n1. Copied work? No. 2. Trademarks? No Disney, no Nike. 3. Named style? No.\n';
test('imagePromptOf returns only the prompt section, so "no Disney" in the self-check never trips the screen', () => {
  assert.match(imagePromptOf(MD), /camp mug/); assert.ok(!/Disney/.test(imagePromptOf(MD)));
});
function designDir(over = {}) {
  const dir = tempDir('og-'); useJail(createJail({ dataRoot: dir, extraRoots: [] })); const w = path.join(dir, 'jobs', ID); fs.mkdirSync(w, { recursive: true });
  const opts = ['Tongs up', 'Smoke signals', 'Fully loaded dad', 'Camp dad', 'Dink responsibly'];
  fs.writeFileSync(path.join(w, 'design-v1.slogan.json'), JSON.stringify({ options: opts, optionReasons: opts, chosen: opts[0], reason: 'r', picture: 'A pair of tongs', ...over.slogan }));
  fs.writeFileSync(path.join(w, 'design-v1.md'), over.md || MD);
  return dir;
}
test('design: a clean design is clear; a branded option, a named-artist prompt and a "style of" picture each fail', () => {
  assert.equal(screenDesign({ roomDir: designDir(), id: ID }).result, 'clear');
  const bad1 = screenDesign({ roomDir: designDir({ slogan: { options: ['Nike Dad', 'Smoke signals', 'Fully loaded dad', 'Camp dad', 'Dink responsibly'] } }), id: ID }); assert.ok(bad1.hits.some((h) => h.field === 'sloganOptions[1]'));
  const bad2 = screenDesign({ roomDir: designDir({ md: MD.replace('camp mug', 'camp mug in the style of Banksy') }), id: ID }); assert.ok(bad2.hits.some((h) => h.field === 'imagePrompt'), JSON.stringify(bad2.hits));
  const bad3 = screenDesign({ roomDir: designDir({ slogan: { picture: 'A grill, inspired by Weber' } }), id: ID }); assert.ok(bad3.hits.some((h) => h.field === 'picture'));
});
test('records are idempotent: the second run writes nothing, and the file says hit or clear', () => {
  const dir = designDir(), a = recordDesignOriginality({ roomDir: dir, id: ID }), b = recordDesignOriginality({ roomDir: dir, id: ID });
  assert.equal(a.action, 'written'); assert.equal(b.action, 'unchanged'); assert.equal(JSON.parse(fs.readFileSync(a.file, 'utf8')).result, 'clear');
  fs.mkdirSync(path.join(dir, 'jobs', ID, 'outbox'), { recursive: true }); fs.writeFileSync(path.join(dir, 'jobs', ID, 'outbox', 'listing.json'), JSON.stringify(L({ tags: ['nike tee'] })));
  const l1 = recordListingOriginality({ roomDir: dir, id: ID, extra: [] }), l2 = recordListingOriginality({ roomDir: dir, id: ID, extra: [] });
  assert.equal(l1.result, 'hit'); assert.equal(l1.action, 'written'); assert.equal(l2.action, 'unchanged');
});
