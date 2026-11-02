// config.mjs — loads the engine's config files (ENGINE-PLAN.md §1.2). Read-only. Config is edited as files in the
// repository (DECISIONS.md Q7, Q8); the page can only change an agent's on/off, tier and effort (an overlay in SQLite).
//   config/engine.json            caps, tiers, prices, providers, runtime
//   config/station.config.json    business settings ported from the station (fees, digital terms, originality lists)
//   config/archive/etsy/products.json   the Etsy digital product specs (one entry per product type; archived in R1, read only)
//   config/agents/<key>.json      one file per agent
//   config/lines/<id>.json        the written line specs
//   config/office.json            the office layout (departments and desks)
//   config/routines.json          routines the station ships with (seeded once per data root, always disabled)
//   config/building.json          B0: the building rules' data (foreignDataMarkers: another company's data never enters the Station)
// R1 (RESTRUCTURE.md §1.4, §3): the seven-floor company replaces config/businesses/ (retired):
//   config/products/<id>.json     products: budget, repo, data, policy overrides (_template.json is never loaded)
//   config/departments/<id>.json  departments: floor (display order only), rooms, agents, lines, reportsTo, status
//   config/autonomy.json          the autonomy policy (auto / owner / forbidden per action)
//   config/archive/etsy/products.json   the archived Etsy product specs (was config/products.json; cfg.products, as before)
// The building check, the policy, the tools' declared actions and the locked rules (building.mjs, policy.mjs, locked.mjs) are checked
// here: any problem stops the engine with the reason (fail closed). cfg.businesses and cfg.office.shared are B0's view, derived.
import fs from 'node:fs';
import path from 'node:path';
import { withDefaults } from './business.mjs';
import { readCompany, validateCompany, compatBuilding } from './building.mjs';
import { readPolicy, policyProblems, overrideProblems, toolProblems, TOOL_ACTIONS } from './policy.mjs';
import { lockedConfigProblems } from './locked.mjs';
import { TOOL_NAMES } from './tools/index.mjs';

export const ETSY_PRODUCTS_FILE = path.join('archive', 'etsy', 'products.json');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort().map((n) => readJson(path.join(d, n))) : []);

export function validateEngine(e) {
  const bad = [];
  for (const k of ['perRunUsd', 'perJobUsd', 'perDayUsd']) if (!(e.caps && e.caps[k] > 0)) bad.push('caps.' + k + ' must be a positive number');
  if (!e.tiers || !e.tiers.cheap || !e.tiers.strong) bad.push('tiers.cheap and tiers.strong are required');
  if (!e.pricing) bad.push('pricing is required');
  if (!e.runtime) bad.push('runtime is required');
  return bad;
}

// overrides (the dry run only): { productsFile: {products:[...]}, stationSet: { 'dotted.key': value } } on top of the files
export function applySet(obj, set) { const out = structuredClone(obj); for (const [k, v] of Object.entries(set || {})) { const parts = k.split('.'); let o = out; for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object') throw new Error('override path not found: ' + k); o = o[p]; } if (!(parts[parts.length - 1] in o)) throw new Error('override key not found: ' + k); o[parts[parts.length - 1]] = v; } return out; }

// demo values (demo/station-patch.json, demo/products.json) carry the word DEMO in capitals or a `demo-` product key.
// They apply to the demo engine only: a real engine refuses to start if any is in its config (engine.mjs).
const DEMO_WORD = /\bDEMO\b/;
export function demoMarkers(cfg) {
  const out = [];
  const walk = (v, at) => {
    if (typeof v === 'string') { if (DEMO_WORD.test(v)) out.push(at); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, at + '[' + i + ']'));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== '$comment') walk(x, at ? at + '.' + k : k);
  };
  walk(cfg.station || {}, 'station');
  for (const p of cfg.products || []) { if (/^demo-/i.test(String(p.key || ''))) out.push('products.' + p.key + ' (demo product key)'); walk(p, 'products.' + p.key); }
  return [...new Set(out)];
}

export function loadConfig({ configDir, promptsDir, overrides = null }) {
  const engine = readJson(path.join(configDir, 'engine.json'));
  const bad = validateEngine(engine); if (bad.length) throw new Error('config/engine.json: ' + bad.join('; '));
  const opt = (f) => (fs.existsSync(path.join(configDir, f)) ? readJson(path.join(configDir, f)) : null);
  const agents = Object.fromEntries(readDir(path.join(configDir, 'agents')).map((a) => [a.key, a]));
  const lines = Object.fromEntries(readDir(path.join(configDir, 'lines')).map((l) => [l.id, l]));
  const products = overrides && overrides.productsFile ? overrides.productsFile : opt(ETSY_PRODUCTS_FILE);
  const bl = path.join(configDir, 'blocklist.txt');
  const blocklist = fs.existsSync(bl) ? fs.readFileSync(bl, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
  const routines = opt('routines.json');
  const office = opt('office.json') || { departments: [] }, company = readCompany(configDir), policy = readPolicy(configDir);
  checkCompany({ company, policy, engine, lines, agents, office, promptsDir });
  const compat = compatBuilding({ company, agents, office });
  const strip = ({ file, ...x }) => x;
  return { configDir, promptsDir, engine, blocklist, routines: (routines && routines.routines) || [], station: overrides && overrides.stationSet ? applySet(opt('station.config.json') || {}, overrides.stationSet) : (opt('station.config.json') || {}), overridden: !!overrides, products: (products && products.products) || [], productsFile: products, agents, lines, office: { ...office, shared: compat.shared }, businesses: compat.businesses.map(withDefaults), company: { products: company.products.map(strip), departments: company.departments.map(strip) }, policy: { sha256: policy.sha256, levels: policy.levels }, building: opt('building.json') || { foreignDataMarkers: [] } };
}

// R1: the building check, the policy, the tools' declared actions and the locked rules, together; throws with every reason
export function checkCompany({ company, policy, engine, lines, agents, office, promptsDir = null }) {
  const overrides = [...company.products.map((p) => ({ file: 'config/products/' + p.file, policy: p.policy })), ...company.departments.map((d) => ({ file: 'config/departments/' + d.file, policy: d.policy })), ...Object.values(agents).map((a) => ({ file: 'config/agents/' + a.key + '.json', policy: a.policy }))].filter((o) => o.policy && Object.keys(o.policy).length);
  const bad = [
    ...validateCompany({ company, agents, lines, engine, office, implementedTools: TOOL_NAMES, promptsDir }),
    ...policyProblems(policy.levels), ...overrideProblems(policy.levels, overrides), ...toolProblems(agents),
    ...lockedConfigProblems({ levels: policy.levels, overrides, agents, departments: company.departments, toolActions: TOOL_ACTIONS })
  ];
  for (const p of company.products) for (const a of p.allowedActions || []) if (!(a in policy.levels)) bad.push('config/products/' + p.file + ': allowedActions "' + a + '" is not an action in config/autonomy.json');
  if (bad.length) throw Object.assign(new Error('the building does not hold: ' + bad.join('; ')), { code: 'BUILDING', problems: bad });
}
