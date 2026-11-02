// locked.mjs — R1 (RESTRUCTURE.md §3.2; owner, R1 prompt 23/10/2026): the locked rules, in code, not config. Nothing under config/ can
// loosen them: config/autonomy.json, a product's policy override, a department or an agent config that tries stops the engine at start
// with the rule and the file (lockedConfigProblems), and every action is checked against them again when it is taken (assertActor).
// Changing one needs a code change, its tests, a recorded test pass and the owner's deploy.
//   owner-only-approver     the owner is the only approver: a request is decided only through the owner's page session
//                           (requests.mjs); request.decide.agent is forbidden
//   ceo-recommends-only     the CEO's tools are fs_read, fs_list and fs_write jailed to the memos folder; it decides nothing, changes no
//                           policy, budget or cap, sends nothing, files no request (its proposals are documents)
//   coo-pause-only          the COO's one engine action is line.pause; it never resumes a line and never changes a cap or budget
//   compliance-independent  COMPLIANCE reports to the owner; no agent, the CEO included, overrides or skips its verdict
//   no-merge-deploy-push    no agent can merge, deploy or push (git.merge.agent, deploy.agent, git.push.branch)
//   secrets-refused         secrets are refused by path and by content (lib/secrets.mjs; the file tools)
//   legal-forbidden         scraping personal data, fake reviews or accounts, misleading claims, an agent sending directly
//   outbound-needs-owner    anything leaving the building (outreach, a support reply, merge, deploy, a price, a refund, a public post, a
//                           new dependency …) is owner or forbidden, never auto
//   owner-never-lowered     B0's ownerApprovalRequired: nothing at owner is lowered to auto by a product, department or agent override
// What code cannot see (a misleading claim in free text, a fake review written by hand) is COMPLIANCE's and the owner's to catch; the
// code refuses every tool and action that could do it (RESTRUCTURE.md §3.1).

export const LEVELS = ['auto', 'owner', 'forbidden'];
export const RANK = { auto: 0, owner: 1, forbidden: 2 };

export const RULES = {
  'owner-only-approver': 'the owner is the only approver',
  'ceo-recommends-only': 'the CEO recommends only',
  'coo-pause-only': 'the COO can pause a line but never raise a cap',
  'compliance-independent': 'COMPLIANCE reports to the owner and no agent overrides it',
  'no-merge-deploy-push': 'no agent can merge, deploy or push',
  'secrets-refused': 'secrets are refused by path and by content',
  'legal-forbidden': 'scraping personal data, fake reviews or accounts, misleading claims and direct sends are forbidden',
  'outbound-needs-owner': 'anything leaving the building needs the owner\'s approval',
  'owner-never-lowered': 'nothing at owner is lowered to auto by an override'
};

// action -> the locked rule that keeps it forbidden, whatever any config says
export const LOCKED_FORBIDDEN = {
  'request.decide.agent': 'owner-only-approver',
  'policy.change.agent': 'ceo-recommends-only',
  'cap.change.agent': 'coo-pause-only',
  'budget.change.agent': 'coo-pause-only',
  'compliance.override.agent': 'compliance-independent',
  'git.merge.agent': 'no-merge-deploy-push',
  'deploy.agent': 'no-merge-deploy-push',
  'git.push.branch': 'no-merge-deploy-push',
  'secrets.read': 'secrets-refused',
  'personal-data.scrape': 'legal-forbidden',
  'review.fake': 'legal-forbidden',
  'account.fake': 'legal-forbidden',
  'claim.misleading': 'legal-forbidden',
  'email.send.agent': 'legal-forbidden'
};

// actions that leave the building: owner or forbidden, never auto (a request the owner decides, then the owner or the engine's own
// executor acts; never an agent)
export const OUTBOUND = ['email.send.prospect', 'email.send.customer', 'support.reply.send', 'git.merge', 'deploy', 'site.change', 'price.set', 'refund.issue', 'public.post', 'dependency.add', 'ci.change', 'etsy.read-own-shop'];
// outbound drafts that need COMPLIANCE's pass before they can become a request (RESTRUCTURE.md §4)
export const COMPLIANCE_GATED = ['email.send.prospect', 'email.send.customer', 'support.reply.send', 'public.post'];

export const CEO = 'ceo', COO = 'coo', COMPLIANCE = 'compliance';
export const CEO_TOOLS = ['fs_read', 'fs_list', 'fs_write'];
export const CEO_FOLDER = 'products/station/memos';
export const CEO_ACTIONS = ['file.read', 'draft.write', 'memo.write'];
export const COO_TOOLS = ['fs_read', 'fs_list', 'fs_write', 'line_pause'];
export const COO_FOLDER = 'products/station/reports';
export const COO_ACTIONS = ['file.read', 'draft.write', 'report.write', 'line.pause'];
// a tool named for any of these can never be given to an agent (on top of tools/index.mjs FORBIDDEN_TOOL_RE)
export const FORBIDDEN_TOOL_WORDS = /push|merge|deploy|install|publish|signup|sign_up|register|scrape|account|testimonial|refund|price/i;

export class LockedRefusal extends Error {
  constructor(rule, msg) { super('refused by a locked rule (' + rule + ': ' + RULES[rule] + '): ' + msg); this.code = 'LOCKED'; this.rule = rule; }
}

const said = (rule, what) => 'locked rule ' + rule + ' (' + RULES[rule] + '): ' + what;
const flatWrites = (w) => Array.isArray(w) && w.every((g) => typeof g === 'string' && /^[^/\\]+\.md$/.test(g) && !g.includes('..'));

// the config against the locked rules -> problems[] (empty: every rule holds). levels: config/autonomy.json levels; overrides from
// products, departments and agents (each { file, policy }); agents: config/agents by key; departments; toolActions: tool -> action
export function lockedConfigProblems({ levels = {}, policyFile = 'config/autonomy.json', overrides = [], agents = {}, departments = [], toolActions = {} }) {
  const bad = [];
  for (const [action, rule] of Object.entries(LOCKED_FORBIDDEN)) {
    if (!(action in levels)) bad.push(said(rule, action + ' is missing from ' + policyFile + ' (it must be there at forbidden)'));
    else if (levels[action] !== 'forbidden') bad.push(said(rule, action + ' is "' + levels[action] + '" in ' + policyFile + '; it can only be forbidden'));
  }
  for (const action of OUTBOUND) if (levels[action] === 'auto') bad.push(said('outbound-needs-owner', action + ' is "auto" in ' + policyFile + '; it can only be owner or forbidden'));
  for (const o of overrides) {
    for (const [action, lv] of Object.entries(o.policy || {})) {
      if (LOCKED_FORBIDDEN[action] && lv !== 'forbidden') bad.push(said(LOCKED_FORBIDDEN[action], action + ' is "' + lv + '" in ' + o.file + '; it can only be forbidden'));
      if (OUTBOUND.includes(action) && lv === 'auto') bad.push(said('outbound-needs-owner', action + ' is "auto" in ' + o.file));
      if (levels[action] === 'owner' && lv === 'auto') bad.push(said('owner-never-lowered', action + ' is owner in ' + policyFile + ' and "auto" in ' + o.file));
    }
  }
  for (const a of Object.values(agents)) {
    const file = 'config/agents/' + a.key + '.json', tools = a.tools || [];
    for (const t of tools) {
      if (FORBIDDEN_TOOL_WORDS.test(t)) bad.push(said('no-merge-deploy-push', 'agent ' + a.key + ' lists the tool ' + t + ' in ' + file + '; no agent may have a tool that merges, deploys, pushes, installs, publishes, creates accounts, scrapes or sets prices'));
      const act = toolActions[t];
      if (act && LOCKED_FORBIDDEN[act]) bad.push(said(LOCKED_FORBIDDEN[act], 'agent ' + a.key + ' lists the tool ' + t + ' (action ' + act + ') in ' + file));
    }
    if (a.key === CEO) {
      const extra = tools.filter((t) => !CEO_TOOLS.includes(t));
      if (extra.length) bad.push(said('ceo-recommends-only', 'the CEO\'s tools are fixed to ' + CEO_TOOLS.join(', ') + '; ' + file + ' adds ' + extra.join(', ')));
      if (a.folder !== CEO_FOLDER) bad.push(said('ceo-recommends-only', 'the CEO writes only in ' + CEO_FOLDER + '; ' + file + ' sets folder "' + (a.folder || '') + '"'));
      if (a.writes != null && !flatWrites(a.writes)) bad.push(said('ceo-recommends-only', 'the CEO writes only .md memos in its folder; ' + file + ' sets writes ' + JSON.stringify(a.writes)));
      if (a.reportsTo !== 'owner') bad.push(said('ceo-recommends-only', 'the CEO reports to the owner; ' + file + ' says "' + (a.reportsTo || '') + '"'));
    }
    if (a.key === COO) {
      const extra = tools.filter((t) => !COO_TOOLS.includes(t));
      if (extra.length) bad.push(said('coo-pause-only', 'the COO\'s tools are fixed to ' + COO_TOOLS.join(', ') + '; ' + file + ' adds ' + extra.join(', ')));
      if (a.folder !== COO_FOLDER) bad.push(said('coo-pause-only', 'the COO writes only in ' + COO_FOLDER + '; ' + file + ' sets folder "' + (a.folder || '') + '"'));
      if (a.writes != null && !flatWrites(a.writes)) bad.push(said('coo-pause-only', 'the COO writes only .md reports in its folder; ' + file + ' sets writes ' + JSON.stringify(a.writes)));
    }
    if (a.key === COMPLIANCE && a.reportsTo !== 'owner') bad.push(said('compliance-independent', 'COMPLIANCE reportsTo must be "owner"; ' + file + ' says "' + (a.reportsTo || '') + '"'));
  }
  const cd = departments.find((d) => (d.agents || []).includes(COMPLIANCE));
  if (cd && cd.reportsTo !== 'owner') bad.push(said('compliance-independent', 'COMPLIANCE sits in department ' + cd.id + ', which reports to "' + cd.reportsTo + '"; it must be a department that reports to the owner'));
  return bad;
}

// an action about to be taken, by whom -> throws LockedRefusal when a locked rule forbids it. actor: { kind: 'owner' | 'agent' |
// 'engine' | 'script', key? }. The policy level (policy.mjs) and the request flow (actions.mjs) come after this.
export function assertActor(action, actor = {}) {
  if (LOCKED_FORBIDDEN[action]) throw new LockedRefusal(LOCKED_FORBIDDEN[action], action + ' is forbidden' + (actor.key ? ' (asked by ' + actor.key + ')' : ''));
  if (actor.kind === 'agent' && actor.key === CEO && !CEO_ACTIONS.includes(action)) throw new LockedRefusal('ceo-recommends-only', 'the CEO may only read and write memos, not ' + action);
  if (actor.kind === 'agent' && actor.key === COO && !COO_ACTIONS.includes(action)) throw new LockedRefusal('coo-pause-only', 'the COO may pause a line and write its report, not ' + action);
  if (action === 'line.resume' && actor.kind !== 'owner') throw new LockedRefusal('coo-pause-only', 'only the owner resumes a line' + (actor.key ? ' (asked by ' + actor.key + ')' : ''));
  return true;
}
