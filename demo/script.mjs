// demo/script.mjs — DEMO (npm run demo): the scripted replies the mock provider gives each agent in the demo day. No
// model is called and nothing is charged. Each agent's turn is chosen from how many replies it has already given in
// this run; values an agent would read from a file (the manifest's sha256) come from the tool results in the
// conversation, as a model would read them. The brief texts come from demo/briefs/ (passed in, never read here).
//   research batch:  DEMAND-RESEARCHER drafts the mushroom brief -> EVIDENCE-CHECKER verifies it -> brief check
//   job A (mushroom): DESIGNER set-v1 -> QA-DESIGN revise (file 3 detail too small) -> DESIGNER set-v2 -> QA-DESIGN
//                     approved -> LISTER -> QA-LISTING approved -> package gate -> approval queue
//   job B (cats):     DESIGNER names a protected character: the image call is refused and design.md trips the prep
//                     originality screen twice -> blocked at prep with the reason (the real line, owner 16/10/2026)
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const text = (t) => ({ type: 'text', text: t });
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const firstInput = (params) => String(params.messages[0].content);
const results = (params) => { const last = params.messages[params.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []; };
const setFromInput = (s) => Number((/Write (?:a corrected )?set-v(\d+)/.exec(s) || /set-v(\d+)\/deliverables/.exec(s) || [0, 1])[1]);
const handoff = (id, n, who) => '```\nLISTING_ID: ' + id + '\nBRIEF: work/' + id + '/brief.md\nDESIGN: work/' + id + '/set-v' + n + '/deliverables.json\nSTAGE_DONE: ' + who + '\n```';
const field = (t, k) => ((new RegExp('^' + k + ':[ \\t]*(.+)$', 'm').exec(t) || [])[1] || '').trim();

const MUSHROOMS = ['01-red-cap-door', '02-brown-cluster', '03-acorn-house', '04-tall-moss-cap', '05-tiny-window'];
const CATS = ['01-cat-helmet', '02-cat-ringed-planet', '03-cat-rocket', '04-cat-stars', '05-cat-moon'];
export const QA_REVISE_REASONS = ['file 3 (03-acorn-house.png): the door detail is too small to read at sticker size; redraw it larger with a wide margin', 'set: keep the five on one palette'];

// draft: the researcher's candidate brief (status: candidate); jobA, jobB: the two job ids; cfg: the effective station config
export function createDemoScript({ cfg, draft, jobA, jobB }) {
  const d = cfg.digital;
  const day = jobA.slice(0, 10);
  const draftPath = 'drafts/' + day + '/' + jobA + '.md';
  // E7a (owner decision 1, 19/10/2026): the research brief is indicative (non-Etsy results, origin research); its rows are
  // the results the simulated search below returns, so the station's citation and price checks pass on the transcript
  const query = field(draft, 'search queries');
  const rows = [...draft.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(https:\/\/\S+)\s*\|$/gm)].map((m) => ({ title: m[2], price: m[3], url: m[4] }));
  const listingUrl = rows[0].url, secondUrl = rows[1].url;
  const verified = draft.replace(/^status: candidate$/m, 'status: verified').replace(/## Evidence check[\s\S]*$/, '## Evidence check\n'
    + '- ' + listingUrl + ' — DEMO: re-opened (simulated), title and price match; supports claim: YES\n'
    + '- keyword sources (5) — DEMO search results (simulated); supports claim: YES\n'
    + '- originality and Etsy policy: original concept, no protected names\n'
    + '- Verdict: VERIFIED — DEMO brief (simulated data, nothing was opened)\n');

  function demandResearcher(ctx, params, t) {
    const steps = [
      [tool('dr1', 'fs_read', { path: 'products.json' }), tool('dr2', 'fs_list', { path: 'drafts' })],
      [tool('dr3', 'web_search', { query })],
      [tool('dr4', 'web_fetch', { url: listingUrl })],
      [tool('dr5', 'fs_write', { path: draftPath, content: draft })],
      [text(jobA + ' — ' + ((/^# Niche\s*\n([^\n]+)/m.exec(draft) || [])[1] || '') + ' — ' + field(draft, 'product_type') + ' — evidence ' + field(draft, 'evidence level'))]
    ];
    return { content: steps[Math.min(t, steps.length - 1)] };
  }
  function evidenceChecker(ctx, params, t) {
    const steps = [
      [tool('ec1', 'fs_list', { path: 'drafts/' + day })],
      [tool('ec2', 'fs_read', { path: draftPath })],
      [tool('ec3', 'web_fetch', { url: listingUrl })],
      [tool('ec4', 'web_fetch', { url: secondUrl })],
      [tool('ec5', 'fs_write', { path: draftPath, content: verified })],
      [text(jobA + ' — VERIFIED — demand evidence complete and matching, 5 sourced keywords, original concept (DEMO)')]
    ];
    return { content: steps[Math.min(t, steps.length - 1)] };
  }
  function designer(ctx, params, t) {
    const id = ctx.jobId, n = setFromInput(firstInput(params)), b = id === jobB, names = b ? CATS : MUSHROOMS;
    const subj = b ? 'a cartoon cat in a round space helmet' : 'a round woodland mushroom with a tiny door';
    const prompts = names.map((nm, i) => (b ? 'Flat sticker of ' + subj + ', pose ' + (i + 1) + ', bright retro palette of teal, coral and mustard, thick clean outline, transparent background, no text' : 'Flat sticker of ' + subj + ', variation ' + (i + 1) + ', soft autumn palette of rust, moss and cream' + (n > 1 && i === 2 ? ', large door detail, whole shape inside the frame with a wide margin' : '') + ', thick clean outline, transparent background, no text'));
    const gen = (i) => tool('g' + n + i, 'image_generate', { path: 'set-v' + n + '/files/' + names[i] + '.png', prompt: prompts[i], aspectRatio: '1:1', transparent: true, widthPx: 1500, heightPx: 1500 });
    const md = '# set-v' + n + ' — ' + id + '\n\n' + names.map((nm, i) => '## ' + nm + '.png\nImage prompt (exact): ' + prompts[i] + '\nFor: sticker ' + (i + 1) + ' of 5.\nAnalysis: a single sticker shape on a clear background; no text.\n').join('\n')
      + (b ? '\nFirst idea, dropped: an astronaut cat like Garfield floating in space.\n' : '')
      + '\n## Originality self-check\n1. Copied work? No.\n2. Trademarks? ' + (b ? 'No, I did not use the cartoon cat I first thought of.' : 'No.') + '\n3. Named style? No.\n4. Real person? No.\n';
    const steps = b
      ? [[tool('r' + n, 'fs_read', { path: 'products.json' })],
        [tool('x' + n, 'image_generate', { path: 'set-v' + n + '/files/00-idea.png', prompt: 'A cartoon astronaut cat like Garfield floating among planets, transparent background', aspectRatio: '1:1', transparent: true, widthPx: 1500, heightPx: 1500 })],
        [0, 1, 2, 3, 4].map(gen),
        [tool('w' + n, 'fs_write', { path: 'set-v' + n + '/design.md', content: md })],
        [text('Five astronaut-cat stickers in set-v' + n + '.\n\n' + handoff(id, n, 'DESIGNER'))]]
      : [[tool('r' + n, 'fs_read', { path: 'products.json' })],
        [0, 1, 2, 3, 4].map(gen),
        [tool('a' + n, 'image_analyze', { path: 'set-v' + n + '/files/' + names[2] + '.png', question: 'What does this show, and is there any text?' })],
        [tool('w' + n, 'fs_write', { path: 'set-v' + n + '/design.md', content: md })],
        [text('Five matching mushroom stickers in set-v' + n + (n > 1 ? '; 03 redrawn with a larger door and a margin.' : '.') + '\n\n' + handoff(id, n, 'DESIGNER'))]];
    return { content: steps[Math.min(t, steps.length - 1)] };
  }
  function qaDesign(ctx, params, t) {
    const id = ctx.jobId, n = setFromInput(firstInput(params));
    if (t === 0) return { content: [tool('q1' + n, 'fs_read', { path: 'set-v' + n + '/deliverables.sha256' }), tool('q2' + n, 'fs_read', { path: 'set-v' + n + '/deliverables.json' }), tool('q3' + n, 'image_analyze', { path: 'set-v' + n + '/files/' + MUSHROOMS[2] + '.png', question: 'Is the detail readable at sticker size? Is anything cut off? Any text?' })] };
    if (t === 1) {
      const sha = String((results(params).find((r) => r.tool_use_id === 'tu_q1' + n) || {}).content || '').trim();
      const ok = ctx.pass > 1;
      const checks = { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', complete: 'pass', usable: ok ? 'pass' : 'fail', matchesSpec: 'pass', worthThePrice: ok ? 'pass' : 'fail', licence: 'pass' };
      const record = { stage: 'design', listingId: id, pass: ctx.pass, verdict: ok ? 'approved' : 'revise', designFile: 'work/' + id + '/set-v' + n + '/deliverables.json', manifestSha256: sha, checks,
        worthThePrice: ok ? { verdict: 'pass', reason: 'Five matching stickers where most of the top five sell three or four.' } : { verdict: 'fail', reason: 'One of the five is hard to use as delivered, so the set is thinner than the top five.' },
        reasons: ok ? [] : QA_REVISE_REASONS, reviewer: 'QA DESIGN' };
      return { content: [tool('v' + n, 'submit_verdict', { record })] };
    }
    return { content: [text((ctx.pass > 1 ? 'All five stickers pass.' : 'File 3 detail is too small; revise.') + '\n\n' + handoff(id, n, 'QA DESIGN') + '\n' + (ctx.pass > 1 ? 'VERDICT: approved' : 'VERDICT: revise'))] };
  }
  function lister(ctx, params, t) {
    const id = ctx.jobId, n = setFromInput(firstInput(params));
    if (t === 0) return { content: [tool('l1', 'fs_read', { path: 'set-v' + n + '/deliverables.json' }), tool('l2', 'fs_read', { path: 'brief.md' })] };
    if (t === 1) {
      const listing = { listingId: id, productKey: 'demo-sticker-pack-5', designFile: 'work/' + id + '/set-v' + n + '/deliverables.json',
        title: 'Cozy Mushroom Stickers, 5 PNG Planner and Journal Stickers, Digital Download',
        tags: ['mushroom stickers', 'planner stickers', 'journal stickers', 'digital stickers', 'png stickers', 'woodland stickers', 'autumn stickers'],
        description: 'Five cozy woodland mushroom stickers as transparent PNG files, 1500 x 1500 px each, for digital planners and journals.\n\n' + d.listingNotice + '\n\n' + d.licences['personal-use'].listingText + '\n\n' + d.aiDisclosure.text,
        altText: 'Five round woodland mushroom stickers with tiny doors in rust, moss and cream', ownerTodo: ['confirm price', 'upload the preview images in Etsy'] };
      return { content: [tool('l3', 'fs_write', { path: 'outbox/listing.json', content: JSON.stringify(listing, null, 2) })] };
    }
    return { content: [text('Listing written.\n\n' + handoff(id, n, 'LISTER'))] };
  }
  function qaListing(ctx, params, t) {
    const id = ctx.jobId, n = setFromInput(firstInput(params));
    if (t === 0) return { content: [tool('k1', 'fs_read', { path: 'outbox/listing.json' })] };
    if (t === 1) return { content: [tool('k2', 'submit_verdict', { record: { stage: 'listing', listingId: id, pass: ctx.pass, verdict: 'approved', designFile: 'work/' + id + '/set-v' + n + '/deliverables.json', checks: { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', matchesFiles: 'pass', limits: 'pass' }, reasons: [], reviewer: 'QA LISTING' } })] };
    return { content: [text('Listing passes.\n\n' + handoff(id, n, 'QA LISTING') + '\nVERDICT: approved')] };
  }
  const script = async (ctx, params) => {
    if (ctx.purpose === 'image_analyze') return { content: [text('MOCK analysis of ' + ctx.file + ': one sticker shape on a clear background, the word MOCK at the top, nothing cut off, no other text.')] };
    const t = turnOf(params);
    if (ctx.agentKey === 'demand-researcher') return demandResearcher(ctx, params, t);
    if (ctx.agentKey === 'evidence-checker') return evidenceChecker(ctx, params, t);
    if (ctx.agentKey === 'designer') return designer(ctx, params, t);
    if (ctx.agentKey === 'qa-design') return qaDesign(ctx, params, t);
    if (ctx.agentKey === 'lister') return lister(ctx, params, t);
    if (ctx.agentKey === 'qa-listing') return qaListing(ctx, params, t);
    if (ctx.agentKey === 'rejects-desk') return t === 0 ? { content: [tool('rj', 'fs_write', { path: 'REJECTED.md', content: '# REJECTED\n\nDEMO (simulated)\n' })] } : { content: [text('Recorded.')] };
    return { content: [text('DEMO: no script for ' + ctx.agentKey)] };
  };
  // the researchers' web backend (canned, simulated): never a real page
  script.web = async (name, args) => (name === 'web_search'
    ? 'DEMO simulated search results for "' + args.query + '" (no real data; nothing was opened):\nResults:\n' + rows.map((r) => '- ' + r.title + ' | ' + r.url + ' | ' + r.price).join('\n')
    : 'DEMO simulated page for ' + args.url + ': the figures in the brief (simulated data); nothing was opened.');
  return script;
}
