// building.mjs — R1 (RESTRUCTURE.md §1.4): the seven-floor company. It replaces B0's business.mjs as the source of truth: departments own
// floors (display order only), rooms, agents, lines and a reporting line (config/departments/<id>.json); products own budgets, repos,
// data, roadmaps and policy overrides (config/products/<id>.json). Every job, run, routine, request, ledger row and event carries
// product_id and department_id; no record carries a floor, so moving a department to another floor changes its config and nothing else.
// The building check (validateCompany) stops the engine with the reason when the config does not hold: a floor used twice, an agent or
// a line in no department or in two, a department reporting to anyone but the owner or an exec, an agent status other than active,
// not-hired or archived, a product dataDir outside products/<id>/, ownerApprovalRequired false, a day cap above the station's.
// The locked rules (locked.mjs) and the policy (policy.mjs) are checked beside it at every start.
// B0 compatibility (until R7 draws the seven floors): business.mjs still answers "which business" for the 3D page, the agents' data jail
// and the business_id column (kept, read only in meaning, for one release so a rollback to B0 still reads its data). compatBuilding()
// derives B0's view from this config: each archived department with a product is a B0 business (today: etsy-shop, the trophy room,
// drawn on the page's floor 1 until R7 moves it to G), and every other department is B0's shared floor.
import fs from 'node:fs';
import path from 'node:path';
import { RULES } from './locked.mjs';

export const STATION = 'station', HQ = 'hq';
export const FLOORS = ['6', '5', '4', '3', '2', '1', 'G'];          // display order, top to bottom
export const REPORTS_TO = ['owner', 'ceo', 'cto', 'coo'];
export const AGENT_STATUSES = ['active', 'not-hired', 'archived'];
export const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const LEGACY_DATA_DIR = '.';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.json') && !n.startsWith('_')).sort().map((n) => ({ ...readJson(path.join(d, n)), file: n })) : []);
// config/products/*.json and config/departments/*.json, never a file whose name starts with "_" (the templates)
export function readCompany(configDir) { return { products: readDir(path.join(configDir, 'products')), departments: readDir(path.join(configDir, 'departments')) }; }
const normDir = (d) => { const s = String(d == null ? '' : d).replace(/\\/g, '/').replace(/\/+$/, ''); return s === '' ? LEGACY_DATA_DIR : s; };
const stepAgents = (l) => [...new Set(Object.values(l.steps || {}).map((s) => s.agent).filter(Boolean))];

// the company against the rest of the config -> problems[] (empty: the building holds)
export function validateCompany({ company, agents = {}, lines = {}, engine = {}, office = {}, implementedTools = null, promptsDir = null }) {
  const bad = [], caps = engine.caps || {}, P = company.products || [], D = company.departments || [];
  const pid = new Set(), did = new Set(), floors = new Map(), owner = { agent: new Map(), line: new Map(), room: new Map() };
  const claim = (kind, key, who) => { if (owner[kind].has(key)) bad.push(kind + ' ' + key + ' is in both ' + owner[kind].get(key) + ' and ' + who); else owner[kind].set(key, who); };
  let legacyDirs = 0;
  for (const p of P) {
    const who = 'config/products/' + (p.file || p.id + '.json');
    if (!ID_RE.test(String(p.id || ''))) bad.push(who + ': id must be lowercase letters, digits and hyphens');
    if (p.file && p.file !== p.id + '.json') bad.push(who + ': the file must be named ' + p.id + '.json');
    if (pid.has(p.id)) bad.push(who + ': the product id is used twice'); pid.add(p.id);
    if (!String(p.name || '').trim()) bad.push(who + ': name is required');
    if (!['active', 'archived'].includes(p.status)) bad.push(who + ': status must be active or archived');
    if (!(typeof p.monthlyBudgetUsd === 'number' && p.monthlyBudgetUsd > 0)) bad.push(who + ': monthlyBudgetUsd must be a positive number');
    if (p.dailyCapUsd != null && !(typeof p.dailyCapUsd === 'number' && p.dailyCapUsd > 0 && !(caps.perDayUsd > 0 && p.dailyCapUsd > caps.perDayUsd))) bad.push(who + ': dailyCapUsd must be a positive number at most the station\'s day cap' + (caps.perDayUsd ? ' (USD ' + caps.perDayUsd.toFixed(2) + ')' : ''));
    for (const [d, v] of Object.entries(p.jobCapUsdByDepartment || {})) {
      if (!D.some((x) => x.id === d)) bad.push(who + ': jobCapUsdByDepartment names department ' + d + ', which has no config/departments file');
      if (!(typeof v === 'number' && v > 0)) bad.push(who + ': jobCapUsdByDepartment.' + d + ' must be a positive number (the guard applies the lowest of it, the line\'s and the station\'s job cap)');
    }
    if (p.ownerApprovalRequired === false) bad.push('locked rule owner-never-lowered (' + RULES['owner-never-lowered'] + '): ownerApprovalRequired cannot be false in ' + who + ' (every outbound or irreversible action waits for the owner)');
    const dir = normDir(p.dataDir);
    if (p.dataDir == null) bad.push(who + ': dataDir is required (products/' + p.id + '/)');
    else if (dir === LEGACY_DATA_DIR) { legacyDirs++; if (p.status !== 'archived') bad.push(who + ': dataDir "." is the archived Etsy layout only; an active product keeps products/' + p.id + '/'); }
    else if (dir !== 'products/' + p.id) bad.push(who + ': dataDir must be products/' + p.id + '/ (under the data root)');
    if (p.proposals != null && !Array.isArray(p.proposals)) bad.push(who + ': proposals must be a list of the figures still proposed');
  }
  if (legacyDirs > 1) bad.push('only one product may keep the archived Etsy layout (dataDir ".")');
  if (!pid.has(STATION)) bad.push('config/products/' + STATION + '.json is required (HQ and station-wide records belong to it)');
  const rooms = new Set(((office && office.departments) || []).map((d) => d.key));
  for (const d of D) {
    const who = 'config/departments/' + (d.file || d.id + '.json');
    if (!ID_RE.test(String(d.id || ''))) bad.push(who + ': id must be lowercase letters, digits and hyphens');
    if (d.file && d.file !== d.id + '.json') bad.push(who + ': the file must be named ' + d.id + '.json');
    if (did.has(d.id)) bad.push(who + ': the department id is used twice'); did.add(d.id);
    if (!String(d.name || '').trim()) bad.push(who + ': name is required');
    const fl = String(d.floor == null ? '' : d.floor);
    if (!FLOORS.includes(fl)) bad.push(who + ': floor must be one of ' + FLOORS.join(', ') + ' (display order only)');
    else if (floors.has(fl)) bad.push(who + ': floor ' + fl + ' is already ' + floors.get(fl) + '\'s'); else floors.set(fl, d.id);
    if (!REPORTS_TO.includes(d.reportsTo)) bad.push(who + ': reportsTo must be one of ' + REPORTS_TO.join(', '));
    if (!['active', 'archived'].includes(d.status)) bad.push(who + ': status must be active or archived');
    for (const k of ['agents', 'lines', 'rooms']) if (!Array.isArray(d[k] || [])) bad.push(who + ': ' + k + ' must be a list');
    for (const k of d.agents || []) { if (!agents[k]) bad.push(who + ': agent ' + k + ' has no config/agents file'); claim('agent', k, 'department ' + d.id); }
    for (const k of d.lines || []) { if (!lines[k]) bad.push(who + ': line ' + k + ' has no config/lines file'); claim('line', k, 'department ' + d.id); }
    for (const k of d.rooms || []) { if (!rooms.has(k)) bad.push(who + ': room ' + k + ' is not in config/office.json'); claim('room', k, 'department ' + d.id); }
    // R2: a line may borrow an agent of another active department by name (config/lines/<id>.json borrows: the engineering line borrows the
    // CTO and SECURITY); every other agent of its steps must be in its own department
    for (const k of d.lines || []) {
      const borrows = (lines[k] && lines[k].borrows) || [];
      for (const a of lines[k] ? stepAgents(lines[k]) : []) if (!(d.agents || []).includes(a) && !borrows.includes(a)) bad.push(who + ': line ' + k + ' uses agent ' + a + ', which is not in this department (a line borrows another department\'s agent only by naming it in borrows)');
      for (const a of borrows) { const od = D.find((x) => (x.agents || []).includes(a)); if (!agents[a] || !od) bad.push(who + ': line ' + k + ' borrows agent ' + a + ', which is in no department'); else if (od.status !== 'active') bad.push(who + ': line ' + k + ' borrows agent ' + a + ' from the archived department ' + od.id); }
    }
    if (d.status === 'archived') {
      if (!d.product || !P.some((p) => p.id === d.product)) bad.push(who + ': an archived department names the product its history belongs to (product)');
      for (const k of d.agents || []) if (agents[k] && agents[k].status !== 'archived') bad.push(who + ': agent ' + k + ' of an archived department must be archived');
    } else for (const k of d.lines || []) { const ps = (lines[k] && lines[k].products) || []; if (!ps.length || ps.some((x) => !P.some((p) => p.id === x))) bad.push(who + ': line ' + k + ' must list the products it serves (config/lines/' + k + '.json products)'); }
  }
  if (!did.has(HQ)) bad.push('config/departments/' + HQ + '.json is required (the penthouse: HQ)');
  for (const k of Object.keys(agents)) if (!owner.agent.has(k)) bad.push('agent ' + k + ' is in no department');
  for (const k of Object.keys(lines)) if (!owner.line.has(k)) bad.push('line ' + k + ' is in no department');
  for (const a of Object.values(agents)) {
    const who = 'config/agents/' + a.key + '.json';
    if (!AGENT_STATUSES.includes(a.status)) { bad.push(who + ': status must be one of ' + AGENT_STATUSES.join(', ')); continue; }
    if (a.reportsTo != null && !REPORTS_TO.includes(a.reportsTo)) bad.push(who + ': reportsTo must be one of ' + REPORTS_TO.join(', '));
    if (a.status === 'not-hired' && !a.phase) bad.push(who + ': a not-hired agent names the phase it is hired in (phase)');
    if (a.status === 'active') {
      const d = D.find((x) => (x.agents || []).includes(a.key));
      if (d && d.status !== 'active') bad.push(who + ': an active agent cannot sit in an archived department (' + d.id + ')');
      if (!(a.limits && a.limits.maxTurns > 0 && a.limits.maxOutputTokens > 0)) bad.push(who + ': an active agent needs limits.maxTurns and limits.maxOutputTokens');
      if (implementedTools) for (const t of a.tools || []) if (!implementedTools.includes(t)) bad.push(who + ': the tool ' + t + ' is not built yet, so the agent cannot be hired');
      if (promptsDir && !fs.existsSync(path.join(promptsDir, 'agents', a.promptFile || a.key + '.md'))) bad.push(who + ': an active agent needs its prompt (prompts/agents/' + (a.promptFile || a.key + '.md') + ')');
    }
  }
  return bad;
}

// B0's view of the company (business.mjs, the 3D page, the data jail, business_id): -> { businesses: [...], shared: {...} }
export function compatBuilding({ company, agents = {}, office = {} }) {
  const P = Object.fromEntries((company.products || []).map((p) => [p.id, p])), businesses = [];
  const archived = (company.departments || []).filter((d) => d.status === 'archived' && d.product && P[d.product]);
  archived.forEach((d, i) => {
    const p = P[d.product];
    businesses.push({ id: p.id, name: p.name, floor: i + 1, departments: d.rooms || [], lines: d.lines || [], agents: d.agents || [], monthlyBudgetUsd: p.monthlyBudgetUsd, dailyCapUsd: p.dailyCapUsd ?? null, allowedOutbound: (p.allowedActions || []).includes('etsy.read-own-shop') ? ['etsy:read-own-shop'] : [], dataDir: p.dataDir, ownerApprovalRequired: true });
  });
  const inBiz = new Set(businesses.flatMap((b) => b.agents)), base = (office && office.shared) || {};
  const sharedRooms = (company.departments || []).filter((d) => !archived.includes(d)).flatMap((d) => d.rooms || []);
  // R2: the lines of the active departments (the engineering line, the CTO's triage) are B0's shared floor's
  const sharedLines = (company.departments || []).filter((d) => !archived.includes(d)).flatMap((d) => d.lines || []);
  return { businesses, shared: { ...base, floor: base.floor ?? 0, name: base.name || 'Shared services', departments: sharedRooms, agents: Object.keys(agents).filter((k) => !inBiz.has(k)).sort(), lines: sharedLines } };
}

// lookups over a loaded config (cfg.company, cfg.lines, cfg.agents)
export function company(cfg) {
  const C = cfg.company || { products: [], departments: [] };
  const products = Object.fromEntries(C.products.map((p) => [p.id, p])), departments = Object.fromEntries(C.departments.map((d) => [d.id, d]));
  const deptOfAgent = {}, deptOfLine = {};
  for (const d of C.departments) { for (const k of d.agents || []) deptOfAgent[k] = d; for (const k of d.lines || []) deptOfLine[k] = d; }
  const etsyProduct = C.products.find((p) => (p.allowedActions || []).includes('etsy.read-own-shop')) || null;
  const deptOfProduct = (id) => C.departments.find((d) => d.product === id) || null;
  const hq = { productId: STATION, departmentId: HQ };
  // a line's department, and its product when the line has exactly one (an archived department: its product)
  function ofLine(line) {
    const d = deptOfLine[line]; if (!d) return null;
    const ps = ((cfg.lines || {})[line] || {}).products || [];
    return { departmentId: d.id, productId: d.product || (ps.length === 1 ? ps[0] : null) };
  }
  // B0's business id -> the product and department its records map to (migrate:products; records written before R1); null: unknown
  function fromBusiness(b) {
    if (b === 'shared') return hq;
    if (products[b]) { const d = deptOfProduct(b); return d ? { productId: b, departmentId: d.id } : null; }
    return null;
  }
  // a record's product and department: its own, else its job's, its line's, its agent's (an HQ or not-hired agent: the station), an
  // own-shop Etsy call's (the product that owns that action), its B0 business's, else the station's HQ
  function resolve(rec, jobOf = () => null) {
    if (!rec) return hq;
    const own = { productId: rec.productId || rec.product_id || null, departmentId: rec.departmentId || rec.department_id || null };
    if (own.productId && own.departmentId) return own;
    let r = null;
    const j = rec.jobId || rec.job_id; const jr = j ? jobOf(j) : null; if (jr && jr.productId && jr.departmentId) r = jr;
    if (!r && rec.line) { const lr = ofLine(rec.line); if (lr && lr.productId) r = lr; }
    const ak = rec.agentKey || rec.agent_key;
    if (!r && ak && deptOfAgent[ak]) { const d = deptOfAgent[ak]; r = { productId: d.product || STATION, departmentId: d.id }; }
    if (!r && rec.kind === 'etsy' && etsyProduct) { const d = deptOfProduct(etsyProduct.id); if (d) r = { productId: etsyProduct.id, departmentId: d.id }; }
    if (!r) { const b = rec.businessId || rec.business_id; if (b) r = fromBusiness(b); }
    r = r || hq;
    return { productId: own.productId || r.productId, departmentId: own.departmentId || r.departmentId };
  }
  const agentStatus = (key) => ((cfg.agents || {})[key] || {}).status || null;
  // a line is archived when its department or its product is (every start on it is refused with "archived")
  const lineArchived = (line) => { const d = deptOfLine[line]; if (!d) return false; return d.status === 'archived' || (d.product && products[d.product] && products[d.product].status === 'archived'); };
  // the departments top to bottom (display order: 6 … 1, G)
  const floors = () => [...C.departments].sort((a, b) => FLOORS.indexOf(String(a.floor)) - FLOORS.indexOf(String(b.floor)));
  return { products, departments, list: C.products, departmentList: C.departments, product: (id) => products[id] || null, department: (id) => departments[id] || null, ofLine, deptOfAgent: (k) => (deptOfAgent[k] ? deptOfAgent[k].id : null), fromBusiness, resolve, agentStatus, lineArchived, floors, compatBusiness: (productId) => (productId && products[productId] && C.departments.some((d) => d.status === 'archived' && d.product === productId) ? productId : 'shared') };
}

// a product's data area (absolute): products/<id>/, or for the archived Etsy layout the data root minus businesses/ and products/
export function productDataArea(dataRoot, p) {
  const dir = normDir(p && p.dataDir);
  if (dir === LEGACY_DATA_DIR) return { root: path.resolve(dataRoot), excludes: [path.resolve(dataRoot, 'businesses'), path.resolve(dataRoot, 'products')] };
  return { root: path.resolve(dataRoot, dir), excludes: [] };
}
