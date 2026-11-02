// business.mjs — B0 (owner, 21/10/2026): the Station is one building that runs several businesses. Each business is a floor with its
// own departments, lines, agents, budget, data and rules (config/businesses/<id>.json); the shared services sit on floor 0 (the shared
// block of config/office.json: Finance, Compliance, OVERSEER and the lounge). Today there is one business, "etsy-shop". This module
// loads and checks the businesses (a bad file stops the engine: fail closed) and answers "which business" for a line, an agent, a
// department or a record. Station-level caps stay the outer limit (guard.mjs, spend.mjs).
// R1 (RESTRUCTURE.md §1.4): building.mjs is now the source of truth (products x departments). This module stays as B0's view for the
// 3D page, the agents' data jail and the business_id column until R7: cfg.businesses is derived from config/products and
// config/departments (building.mjs compatBuilding), not read from files; config/businesses/ is retired.
import fs from 'node:fs';
import path from 'node:path';

export const SHARED = 'shared';                     // business_id of the shared floor (OVERSEER) and of station-wide records
export const DEFAULT_BUSINESS = 'etsy-shop';        // what records written before B0 belong to (npm run migrate:businesses)
export const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
// the outbound actions a business may list in allowedOutbound (each also needs the owner's approval when it is taken)
export const OUTBOUND_ACTIONS = ['etsy:read-own-shop'];
const LEGACY_DATA_DIR = '.';                         // today's layout under the data root (etsy-shop only; no files are moved)

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// config/businesses/*.json, never a file whose name starts with "_" (the template)
export function readBusinesses(configDir) {
  const d = path.join(configDir, 'businesses');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => n.endsWith('.json') && !n.startsWith('_')).sort().map((n) => ({ ...readJson(path.join(d, n)), file: n }));
}

const normDir = (d) => { const s = String(d || '').replace(/\\/g, '/').replace(/\/+$/, ''); return s === '' ? LEGACY_DATA_DIR : s; };
const stepAgents = (l) => [...new Set(Object.values(l.steps || {}).map((s) => s.agent).filter(Boolean))];

// every business against the rest of the config -> problems[] (empty: the building holds)
export function validateBusinesses({ businesses, engine, lines, agents, office }) {
  const bad = [], shared = (office && office.shared) || { departments: [], agents: [] }, floors = new Set(), ids = new Set();
  const deptKeys = new Set(((office && office.departments) || []).map((d) => d.key)), dayCap = engine && engine.caps ? engine.caps.perDayUsd : null;
  const owner = { dept: new Map(), line: new Map(), agent: new Map() }, claim = (kind, key, who) => { if (owner[kind].has(key)) bad.push({ dept: 'department', line: 'line', agent: 'agent' }[kind] + ' ' + key + ' belongs to both ' + owner[kind].get(key) + ' and ' + who); else owner[kind].set(key, who); };
  for (const k of shared.departments || []) { if (!deptKeys.has(k)) bad.push('the shared floor names department ' + k + ', which is not in config/office.json'); claim('dept', k, 'the shared floor'); }
  for (const k of shared.agents || []) { if (!agents[k]) bad.push('the shared floor names agent ' + k + ', which has no config/agents file'); claim('agent', k, 'the shared floor'); }
  for (const k of shared.lines || []) { if (!lines[k]) bad.push('the shared floor names line ' + k + ', which has no config/lines file'); claim('line', k, 'the shared floor'); }   // R2: the active departments' lines
  let legacyDirs = 0;
  for (const b of businesses) {
    const who = 'business ' + (b.id || b.file);
    if (!ID_RE.test(String(b.id || '')) || b.id === SHARED) bad.push(who + ': id must be lowercase letters, digits and hyphens (not "' + SHARED + '")');
    if (b.file && b.file !== b.id + '.json') bad.push(who + ': the file must be named ' + b.id + '.json');
    if (ids.has(b.id)) bad.push(who + ': the id is used twice'); ids.add(b.id);
    if (!String(b.name || '').trim()) bad.push(who + ': name is required');
    if (!Number.isInteger(b.floor) || b.floor < 1) bad.push(who + ': floor must be a whole number, 1 or more (floor 0 is the shared floor)');
    else if (floors.has(b.floor)) bad.push(who + ': floor ' + b.floor + ' is taken'); else floors.add(b.floor);
    for (const [k, list] of [['departments', b.departments], ['lines', b.lines], ['agents', b.agents]]) if (!Array.isArray(list)) bad.push(who + ': ' + k + ' must be a list');
    for (const k of b.departments || []) { if (!deptKeys.has(k)) bad.push(who + ': department ' + k + ' is not in config/office.json'); claim('dept', k, who); }
    for (const k of b.lines || []) { if (!lines[k]) bad.push(who + ': line ' + k + ' has no config/lines file'); claim('line', k, who); }
    for (const k of b.agents || []) { if (!agents[k]) bad.push(who + ': agent ' + k + ' has no config/agents file'); claim('agent', k, who); }
    for (const k of b.lines || []) for (const a of lines[k] ? stepAgents(lines[k]) : []) if (!(b.agents || []).includes(a)) bad.push(who + ': line ' + k + ' uses agent ' + a + ', which the business does not list');
    if (!(typeof b.monthlyBudgetUsd === 'number' && b.monthlyBudgetUsd > 0)) bad.push(who + ': monthlyBudgetUsd must be a positive number');
    if (b.dailyCapUsd != null && !(typeof b.dailyCapUsd === 'number' && b.dailyCapUsd > 0 && (dayCap == null || b.dailyCapUsd <= dayCap))) bad.push(who + ': dailyCapUsd must be a positive number at most the station\'s day cap' + (dayCap != null ? ' (USD ' + dayCap.toFixed(2) + ')' : ''));
    if (b.allowedOutbound != null && !Array.isArray(b.allowedOutbound)) bad.push(who + ': allowedOutbound must be a list ([] = none)');
    for (const x of b.allowedOutbound || []) if (!OUTBOUND_ACTIONS.includes(x)) bad.push(who + ': allowedOutbound "' + x + '" is not an outbound action the Station knows (' + OUTBOUND_ACTIONS.join(', ') + ')');
    // building rule: every agent output is a draft until the owner approves it
    if (b.ownerApprovalRequired === false) bad.push(who + ': ownerApprovalRequired cannot be false (building rule: every agent output is a draft until the owner approves it)');
    const dir = normDir(b.dataDir);
    if (b.dataDir == null) bad.push(who + ': dataDir is required (businesses/' + b.id + '/ for a new business)');
    else if (dir === LEGACY_DATA_DIR) legacyDirs++;
    else if (dir !== 'businesses/' + b.id) bad.push(who + ': dataDir must be businesses/' + b.id + '/ (under the data root)');
  }
  if (legacyDirs > 1) bad.push('only one business may keep today\'s layout (dataDir ".")');
  for (const k of deptKeys) if (!owner.dept.has(k)) bad.push('department ' + k + ' belongs to no business and not to the shared floor');
  for (const k of Object.keys(lines)) if (!owner.line.has(k)) bad.push('line ' + k + ' belongs to no business');
  for (const k of Object.keys(agents)) if (!owner.agent.has(k)) bad.push('agent ' + k + ' belongs to no business and not to the shared floor');
  return bad;
}

// building rule (B0): an outbound action is taken only for a business that lists it in allowedOutbound -> that business's id, or null
export const outboundOwner = (cfg, action) => { const b = (cfg.businesses || []).find((x) => (x.allowedOutbound || []).includes(action)); return b ? b.id : null; };

// building rule (B0): never another company's data in the Station -> the markers a text holds (config/building.json foreignDataMarkers)
export function foreignDataHits(text, cfg) { const t = String(text || '').toLowerCase(); return ((cfg && cfg.building && cfg.building.foreignDataMarkers) || []).filter((m) => m && t.includes(String(m).toLowerCase())); }

// the defaults a business record gets once checked
export const withDefaults = (b) => ({ ...b, allowedOutbound: b.allowedOutbound || [], ownerApprovalRequired: b.ownerApprovalRequired !== false, dataDir: normDir(b.dataDir), dailyCapUsd: b.dailyCapUsd ?? null });

// lookups over a loaded config (cfg.businesses, cfg.office.shared)
export function building(cfg) {
  const list = cfg.businesses || [], shared = (cfg.office && cfg.office.shared) || { floor: 0, name: 'Shared services', departments: [], agents: [] };
  const byId = Object.fromEntries(list.map((b) => [b.id, b]));
  const find = (field, key) => { const b = list.find((x) => (x[field] || []).includes(key)); return b ? b.id : null; };
  return {
    list, byId, shared,
    get: (id) => byId[id] || null,
    ofLine: (line) => find('lines', line),
    ofAgent: (key) => find('agents', key) || ((shared.agents || []).includes(key) ? SHARED : null),
    ofDept: (key) => find('departments', key) || ((shared.departments || []).includes(key) ? SHARED : null),
    // a record's business: its own business id, else its job's, its line's, its agent's; an own-shop Etsy call (ledger kind etsy) the business
    // that owns that outbound action; else the shared floor (station-wide)
    resolve(rec, jobBusiness = () => null) {
      if (!rec) return SHARED;
      const own = rec.businessId || rec.business_id; if (own) return own;
      const j = rec.jobId || rec.job_id; const jb = j ? jobBusiness(j) : null; if (jb) return jb;
      const lb = rec.line ? find('lines', rec.line) : null; if (lb) return lb;
      const ak = rec.agentKey || rec.agent_key; const ab = ak ? (find('agents', ak) || ((shared.agents || []).includes(ak) ? SHARED : null)) : null;
      if (ab) return ab;
      if (rec.kind === 'etsy') { const eb = list.find((x) => (x.allowedOutbound || []).includes('etsy:read-own-shop')); if (eb) return eb.id; }
      return SHARED;
    },
    floors: () => [{ floor: shared.floor ?? 0, id: SHARED, name: shared.name || 'Shared services', departments: shared.departments || [], shared: true }, ...list.map((b) => ({ floor: b.floor, id: b.id, name: b.name, departments: b.departments || [], shared: false }))].sort((a, b) => a.floor - b.floor)
  };
}

// a business's data area: { root, excludes } (absolute). "." (etsy-shop) is the data root minus businesses/ and (R1) products/, where every
// other business or product keeps its own dataDir; a new business has businesses/<id>/ alone
export function businessDataArea(dataRoot, b) {
  const dir = normDir(b && b.dataDir);
  if (dir === LEGACY_DATA_DIR) return { root: path.resolve(dataRoot), excludes: [path.resolve(dataRoot, 'businesses'), path.resolve(dataRoot, 'products')] };   // R1: never a product's data
  return { root: path.resolve(dataRoot, dir), excludes: [] };
}
const inside = (p, root) => { const n = (x) => (process.platform === 'win32' ? x.toLowerCase() : x); const a = n(path.resolve(p)), r = n(path.resolve(root)); return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
// is an absolute path inside the business's data area? (the agents' file tools refuse anything else)
export function inBusinessArea(abs, area) { return inside(abs, area.root) && !area.excludes.some((x) => inside(abs, x)); }
