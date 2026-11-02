// mock-script.mjs — FIXTURE: the scripted replies the mock provider gives each agent in the E3 dry run. No model is
// called. Each agent's turn is chosen from how many replies it has already given in this run; values the agent would
// read from a file (the manifest's sha256) are taken from the tool results in the conversation, as a model would.
// Both fixture briefs are owner briefs (E7a.1, owner decision 4, 20/10/2026: a legacy Etsy-format brief no longer starts a job).
//   job A (mushroom stickers): DESIGNER set-v1 -> QA-DESIGN revise -> DESIGNER set-v2 -> QA-DESIGN approved -> LISTER
//                              -> QA-LISTING approved -> package gate -> approval queue
//   job B (astronaut cats):    DESIGNER names a protected character: the image call is refused and design.md trips the
//                              prep originality screen twice -> blocked with the reason
export const JOB_A = '2026-10-16--dry-run-mushroom-stickers';
export const JOB_B = '2026-10-16--dry-run-astronaut-cat-stickers';

const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const text = (t) => ({ type: 'text', text: t });
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const firstInput = (params) => String(params.messages[0].content);
const results = (params) => { const last = params.messages[params.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []; };
const setFromInput = (s) => Number((/Write (?:a corrected )?set-v(\d+)/.exec(s) || /set-v(\d+)\/deliverables/.exec(s) || [0, 1])[1]);
const handoff = (id, n, who) => '```\nLISTING_ID: ' + id + '\nBRIEF: work/' + id + '/brief.md\nDESIGN: work/' + id + '/set-v' + n + '/deliverables.json\nSTAGE_DONE: ' + who + '\n```';

const MUSHROOMS = ['01-red-cap-door', '02-brown-cluster', '03-acorn-house', '04-tall-moss-cap', '05-tiny-window'];
const CATS = ['01-cat-helmet', '02-cat-ringed-planet', '03-cat-rocket', '04-cat-stars', '05-cat-moon'];

export function createDryRunScript({ cfg }) {
  const d = cfg.digital;
  function designer(ctx, params, t) {
    const id = ctx.jobId, n = setFromInput(firstInput(params)), b = id === JOB_B, names = b ? CATS : MUSHROOMS;
    const subj = b ? 'a cartoon cat in a round space helmet' : 'a round woodland mushroom with a tiny door';
    const prompts = names.map((nm, i) => (b ? 'Flat sticker of ' + subj + ', pose ' + (i + 1) + ', bright retro palette of teal, coral and mustard, thick clean outline, transparent background, no text' : 'Flat sticker of ' + subj + ', variation ' + (i + 1) + ', soft autumn palette of rust, moss and cream' + (n > 1 && i === 2 ? ', whole shape inside the frame with a wide margin' : '') + ', thick clean outline, transparent background, no text'));
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
        [text('Five matching mushroom stickers in set-v' + n + (n > 1 ? '; 03 redrawn with a margin.' : '.') + '\n\n' + handoff(id, n, 'DESIGNER'))]];
    return { content: steps[Math.min(t, steps.length - 1)] };
  }
  function qaDesign(ctx, params, t) {
    const id = ctx.jobId, n = setFromInput(firstInput(params));
    if (t === 0) return { content: [tool('q1' + n, 'fs_read', { path: 'set-v' + n + '/deliverables.sha256' }), tool('q2' + n, 'fs_read', { path: 'set-v' + n + '/deliverables.json' }), tool('q3' + n, 'image_analyze', { path: 'set-v' + n + '/files/' + MUSHROOMS[2] + '.png', question: 'Is anything cut off? Any text?' })] };
    if (t === 1) {
      const sha = String((results(params).find((r) => r.tool_use_id === 'tu_q1' + n) || {}).content || '').trim();
      const ok = ctx.pass > 1;
      const checks = { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', complete: 'pass', usable: ok ? 'pass' : 'fail', matchesSpec: 'pass', worthThePrice: ok ? 'pass' : 'fail', licence: 'pass' };
      const record = { stage: 'design', listingId: id, pass: ctx.pass, verdict: ok ? 'approved' : 'revise', designFile: 'work/' + id + '/set-v' + n + '/deliverables.json', manifestSha256: sha, checks,
        worthThePrice: ok ? { verdict: 'pass', reason: 'Five matching stickers at the top-five price, where most sell three or four.' } : { verdict: 'fail', reason: 'One of the five is unusable as delivered, so the set is thinner than the top five at this price.' },
        reasons: ok ? [] : ['03-acorn-house.png: the outline is cut off at the right edge; redraw it with a margin', 'set: keep the five on one palette'], reviewer: 'QA DESIGN' };
      return { content: [tool('v' + n, 'submit_verdict', { record })] };
    }
    return { content: [text((ctx.pass > 1 ? 'All five stickers pass.' : '03 is cut off; revise.') + '\n\n' + handoff(id, n, 'QA DESIGN') + '\n' + (ctx.pass > 1 ? 'VERDICT: approved' : 'VERDICT: revise'))] };
  }
  function lister(ctx, params, t) {
    const id = ctx.jobId, n = setFromInput(firstInput(params));
    if (t === 0) return { content: [tool('l1', 'fs_read', { path: 'set-v' + n + '/deliverables.json' }), tool('l2', 'fs_read', { path: 'brief.md' })] };
    if (t === 1) {
      const listing = { listingId: id, productKey: 'dry-run-sticker-pack-5', designFile: 'work/' + id + '/set-v' + n + '/deliverables.json',
        title: 'Cozy Mushroom Stickers, 5 PNG Planner and Journal Stickers, Digital Download',
        tags: ['mushroom stickers', 'planner stickers', 'journal stickers', 'digital stickers', 'png stickers', 'woodland stickers', 'autumn stickers'],
        description: 'Five cozy woodland mushroom stickers as transparent PNG files, 1500 x 1500 px each, for digital planners and journals.\n\n' + d.listingNotice + '\n\n' + d.licences['personal-use'].listingText + '\n\n' + d.aiDisclosure.text,
        altText: 'Five round woodland mushroom stickers with tiny doors in rust, moss and cream', ownerTodo: ['confirm price', 'upload the preview images in Etsy'],
        // the fixture briefs are owner briefs (E7a.1): LISTER proposes a price within the owner bounds
        priceProposal: { usd: 9.99, reason: 'Five matching stickers in one pack, so the top of the owner bounds.' } };
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
    if (ctx.agentKey === 'designer') return designer(ctx, params, t);
    if (ctx.agentKey === 'qa-design') return qaDesign(ctx, params, t);
    if (ctx.agentKey === 'lister') return lister(ctx, params, t);
    if (ctx.agentKey === 'qa-listing') return qaListing(ctx, params, t);
    if (ctx.agentKey === 'rejects-desk') return t === 0 ? { content: [tool('rj', 'fs_write', { path: 'REJECTED.md', content: '# REJECTED\n\nmock\n' })] } : { content: [text('Recorded.')] };
    return { content: [text('mock: no script for ' + ctx.agentKey)] };
  };
  return script;
}
