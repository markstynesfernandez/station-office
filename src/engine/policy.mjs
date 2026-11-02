// policy.mjs — R1 (RESTRUCTURE.md §3.1): the autonomy policy. config/autonomy.json gives every action one level: auto, owner (the
// engine files a request in the Owner's office and the job waits) or forbidden (refused, logged, the job blocks with the reason).
//   - every tool declares the action it performs in TOOL_ACTIONS (here, in code); a tool with no declared action stops the engine at
//     start, and an action not in the file is forbidden (fail closed)
//   - a product's policy override (config/products/<id>.json policy) may only move an action to a stricter level; a looser one stops
//     the engine with the reason (departments and agents may not override at all, except stricter, the same way)
//   - the file is the owner's: the page shows it and cannot edit it. At every start the engine compares the file's sha256 with the last
//     one recorded and appends one row per changed action to data/policy/autonomy-log.jsonl (time, action, old -> new, the file's sha256,
//     the git commit, the instance); the first start records every action once (old: null)
//   - the locked rules (locked.mjs) sit above all of this: they are checked at start and again on every action
// The runtime checks the policy before the guard reserves any spend (runtime.mjs: a run whose tools include a forbidden action is
// refused at USD 0; a tool call is checked before it runs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LEVELS, RANK } from './locked.mjs';

// tool -> the action it performs. The planned tools (R2–R6) are declared now so their agents' configs load; an agent that lists a tool
// with no implementation cannot be hired (building.mjs)
export const TOOL_ACTIONS = {
  fs_read: 'file.read',
  fs_list: 'file.read',
  fs_write: 'draft.write',
  fs_edit: 'code.edit',
  image_generate: 'image.generate',
  image_analyze: 'image.analyze',
  web_search: 'research.web',
  web_fetch: 'research.web',
  submit_verdict: 'verdict.submit',
  report_blocked: 'report.write',
  code_search: 'code.search',
  run_check: 'code.check',
  line_pause: 'line.pause',
  metrics_read: 'metrics.read',
  support_ticket_read: 'product.read'
};
export const PLANNED_TOOLS = ['metrics_read', 'support_ticket_read'];   // R2 built code_search, run_check (and fs_edit); R3 line_pause
export const POLICY_FILE = 'autonomy.json';
const ACTION_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

export class PolicyRefusal extends Error { constructor(msg, { action, level } = {}) { super(msg); this.code = 'POLICY'; this.action = action; this.level = level; } }

// -> { file, text, sha256, levels }
export function readPolicy(configDir) {
  const file = path.join(configDir, POLICY_FILE);
  if (!fs.existsSync(file)) throw new Error('config/' + POLICY_FILE + ' is missing: the engine runs only with an autonomy policy (RESTRUCTURE.md §3.1)');
  const text = fs.readFileSync(file, 'utf8'), json = JSON.parse(text);
  return { file, text, sha256: crypto.createHash('sha256').update(text).digest('hex'), levels: json.levels || {} };
}

export function policyProblems(levels) {
  const bad = [];
  if (!levels || typeof levels !== 'object' || Array.isArray(levels) || !Object.keys(levels).length) return ['config/' + POLICY_FILE + ': levels must list every action'];
  for (const [a, lv] of Object.entries(levels)) {
    if (!ACTION_RE.test(a)) bad.push('config/' + POLICY_FILE + ': "' + a + '" is not an action name (lowercase words joined by dots, e.g. git.merge)');
    if (!LEVELS.includes(lv)) bad.push('config/' + POLICY_FILE + ': ' + a + ' is "' + lv + '"; a level is ' + LEVELS.join(', '));
  }
  return bad;
}

// an override (product, department or agent) against the station's file: stricter only -> problems[]
export function overrideProblems(levels, overrides) {
  const bad = [];
  for (const o of overrides) for (const [a, lv] of Object.entries(o.policy || {})) {
    if (!LEVELS.includes(lv)) { bad.push(o.file + ': policy ' + a + ' is "' + lv + '"; a level is ' + LEVELS.join(', ')); continue; }
    const base = levels[a] || 'forbidden';
    if (RANK[lv] < RANK[base]) bad.push(o.file + ': policy ' + a + ' is "' + lv + '", looser than "' + base + '" in config/' + POLICY_FILE + ' (an override may only be stricter)');
  }
  return bad;
}

// every agent's tools have a declared action -> problems[]
export function toolProblems(agents) {
  const bad = [];
  for (const a of Object.values(agents)) for (const t of a.tools || []) if (!TOOL_ACTIONS[t]) bad.push('agent ' + a.key + ': the tool ' + t + ' declares no action (src/engine/policy.mjs TOOL_ACTIONS)');
  return bad;
}

const stricter = (a, b) => (RANK[a] >= RANK[b] ? a : b);

// the loaded policy: level(action, productId) with the product's stricter override; toolAction(name)
export function createPolicy({ levels, sha256, products = [] }) {
  const byProduct = Object.fromEntries(products.map((p) => [p.id, p.policy || {}]));
  return {
    sha256, levels: { ...levels },
    level(action, productId = null) {
      const base = levels[action] || 'forbidden', o = productId && byProduct[productId] ? byProduct[productId][action] : null;
      return o ? stricter(o, base) : base;
    },
    toolAction: (name) => TOOL_ACTIONS[name] || null,
    known: (action) => action in levels
  };
}

// at every start: one row per changed action (the first start: every action, old null) -> the rows appended
export function recordPolicyChanges({ J, store, policy, commit = null, instance = null, now = Date.now, log = null, bus = null }) {
  const prev = store.meta.get('policy:autonomy');
  if (prev && prev.sha256 === policy.sha256) return [];
  const old = (prev && prev.levels) || {}, at = new Date(now()).toISOString(), rows = [];
  for (const a of [...new Set([...Object.keys(old), ...Object.keys(policy.levels)])].sort()) {
    const o = old[a] ?? null, n = policy.levels[a] ?? null;
    if (o !== n) rows.push({ at, action: a, old: o, new: n, sha256: policy.sha256, commit, instance, first: !prev });
  }
  const file = path.join(J.dataRoot, 'policy', 'autonomy-log.jsonl');
  for (const r of rows) J.add(file, JSON.stringify(r) + '\n', { fsync: true });
  store.meta.set('policy:autonomy', { sha256: policy.sha256, levels: policy.levels, at, commit });
  if (log) log.info(prev ? 'autonomy policy changed: logged' : 'autonomy policy recorded (first start)', { rows: rows.length, sha256: policy.sha256, commit });
  if (bus && rows.length) bus.emit('policy.changed', { data: { rows: rows.length, first: !prev, sha256: policy.sha256, changes: prev ? rows.map((r) => ({ action: r.action, old: r.old, new: r.new })) : [] } });
  return rows;
}

// the change log as written (the Owner's office and the COO's report read it)
export function policyLog(dataRoot, limit = 200) {
  const f = path.join(dataRoot, 'policy', 'autonomy-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).slice(-limit);
}
