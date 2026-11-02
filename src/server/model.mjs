// model.mjs — turns the raw station read (sources/files.mjs) into the office snapshot the page renders.
// Pure: no fs, no network, no clock except the `now` passed in. Every derived figure names its source so nothing is
// invented (DECISIONS.md 5, 7, 8, 10). Phase 2 merges the allow-listed live reads into the same shape.
import { rosterList, activeAgents, nameKey, isListingId, briefUsdRange, today } from '../lib/legacy-readers/index.mjs';
import { roleLabel } from '../web/ui/role.js';

// Owner-named board columns (DECISIONS.md 6) keyed by the StarNet dock agent that owns the stage.
const COLUMN_KEY_OF_AGENT = { DESIGNER: 'design', QADESIGN: 'qa-design', LISTER: 'listing', QALISTING: 'qa-listing', REJECTSDESK: 'rejected' };
const PROGRESS = { brief: 0.08, design: 0.25, 'qa-design': 0.4, listing: 0.58, 'qa-listing': 0.72, 'approval-queue': 0.9, done: 1 };

const first = (arr) => (arr && arr.length ? arr[0] : null);
const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
const r6 = (n) => Number((n || 0).toFixed(6));
const briefField = (t, k) => { const m = new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(t || ''); return m ? m[1].trim() : ''; };
const briefNiche = (t) => { const m = /^# Niche\s*\n([^\n]+)/m.exec(t || ''); return m ? m[1].trim() : ''; };
const sessionId = (s) => { const m = /^id:\s*(\S+)/m.exec(s && s.input || ''); return m && isListingId(m[1]) ? m[1] : null; };
const titleFromId = (id) => id.slice(12).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// One date format everywhere (owner, Irish locale): dd/mm/yyyy. The page adds 24h times and relative times.
const z2 = (n) => String(n).padStart(2, '0');
export const dmy = (ms) => { if (ms == null || Number.isNaN(Number(ms))) return '—'; const d = new Date(ms); return z2(d.getDate()) + '/' + z2(d.getMonth() + 1) + '/' + d.getFullYear(); };
const dmyFromIso = (s) => (s ? dmy(Date.parse(s)) : '—');
const firstLine = (t) => (String(t || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0] || '');

// ---------------------------------------------------------------- cron schedule in words (the 5-field forms StarNet writes)
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function cronWords(expr) {
  const p = String(expr || '').trim().split(/\s+/); if (p.length !== 5) return expr ? 'cron ' + expr : '—';
  const [mi, ho, dom, mon, dow] = p;
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(ho)) return 'cron ' + expr;
  const at = 'at ' + z2(ho) + ':' + z2(mi);
  if (dom === '*' && mon === '*' && dow === '*') return 'every day ' + at;
  if (dom === '*' && mon === '*' && /^[0-6](,[0-6])*$/.test(dow)) { const days = dow.split(',').map((d) => DAY_NAMES[Number(d)] + 's'); return days.length > 1 ? 'on ' + days.slice(0, -1).join(', ') + ' and ' + days[days.length - 1] + ' ' + at : 'every ' + days[0].slice(0, -1) + ' ' + at; }
  if (dom === '*' && mon === '*' && dow === '1-5') return 'every weekday ' + at;
  if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return 'on day ' + dom + ' of every month ' + at;
  return 'cron ' + expr;
}

// ---------------------------------------------------------------- cron "next run" (supports * , lists, */n on the 5 fields)
export function cronNext(expr, fromMs, { maxDays = 400 } = {}) {
  const parts = String(expr || '').trim().split(/\s+/); if (parts.length !== 5) return null;
  const field = (s, lo, hi) => { if (s === '*') return null; const out = new Set(); for (const p of s.split(',')) { const m = /^(\*|\d+)(?:\/(\d+))?$/.exec(p); if (!m) return undefined; if (m[2]) { for (let v = m[1] === '*' ? lo : Number(m[1]); v <= hi; v += Number(m[2])) out.add(v); } else out.add(Number(m[1])); } return [...out].sort((a, b) => a - b); };
  const [mi, ho, dom, mon, dow] = [field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12), field(parts[4], 0, 6)];
  if ([mi, ho, dom, mon, dow].includes(undefined)) return null;
  const from = new Date(fromMs);
  for (let d = 0; d <= maxDays; d++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d);
    if (mon && !mon.includes(day.getMonth() + 1)) continue;
    const domOk = !dom || dom.includes(day.getDate()), dowOk = !dow || dow.includes(day.getDay());
    if (dom && dow ? !(domOk || dowOk) : !(domOk && dowOk)) continue;
    for (const h of ho || Array.from({ length: 24 }, (_, i) => i)) for (const m of mi || [0]) { const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime(); if (t > fromMs) return t; }
  }
  return null;
}

// ---------------------------------------------------------------- the snapshot
export function buildSnapshot(raw, { now = Date.now(), host = {} } = {}) {
  const warnings = [];
  const config = raw.config || {};
  const roster = rosterList(raw.roster || []);
  const active = activeAgents(roster);
  const nameOf = Object.fromEntries(roster.map((a) => [a.agentId, a.name]));
  const saveAgents = Object.fromEntries(Object.values((raw.save && raw.save.doc && raw.save.doc.agents) || {}).map((a) => [a.id, a]));
  const cfgAgents = Object.fromEntries((config.agents || []).map((a) => [nameKey(a.name), a]));
  const dayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  const todayStr = today(new Date(now));

  // ---- rooms + desks -> departments (save frame; DECISIONS.md 4, 10/D5)
  const station = (raw.save && raw.save.doc && raw.save.doc.station) || { rooms: {}, props: [] };
  const rooms = Object.values(station.rooms || {});
  const props = station.props || [];
  const roomOfPoint = (x, y) => rooms.find((r) => (r.rects || []).some((q) => x >= q.x1 && x <= q.x2 && y >= q.y1 && y <= q.y2)) || null;
  const deskOf = {};
  for (const p of props) if (p.t === 'desk' && p.agentId) { const room = roomOfPoint(p.x + (p.w - 1) / 2, p.y + (p.h - 1) / 2); deskOf[p.agentId] = { propId: p.id, x: p.x, y: p.y, w: p.w || 1, h: p.h || 1, roomId: room ? room.id : null, roomName: room ? room.name : null }; }
  const activeIds = active.map((a) => a.agentId);
  const deptRooms = rooms.filter((r) => activeIds.some((id) => deskOf[id] && deskOf[id].roomId === r.id));
  const departments = deptRooms.map((r) => ({ id: r.id, key: String(r.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: r.name, rect: first(r.rects), agents: activeIds.filter((id) => deskOf[id] && deskOf[id].roomId === r.id), warnings: [], metrics: [], counts: { doing: 0, next: 0, done: 0 } }));
  const deptOfAgent = Object.fromEntries(departments.flatMap((d) => d.agents.map((id) => [id, d])));
  // cross-check against station.config.json floorRooms
  const floor = config.floorRooms || {};
  for (const [roomName, spec] of Object.entries(floor)) {
    if (!spec || !Array.isArray(spec.desks)) continue;
    for (const key of spec.desks) {
      if (/RETIRED/i.test(key)) continue;
      // floorRooms names config agent KEYS ("overseer"); map key -> config name -> roster name, comparing on letters+digits (D4)
      const cfgA = (config.agents || []).find((a) => a.key === key);
      const agent = active.find((a) => nameKey(a.name) === nameKey(cfgA ? cfgA.name : key));
      if (!agent) { warnings.push('floorRooms.' + roomName + ' lists "' + key + '" which is not an active roster agent'); continue; }
      const d = deptOfAgent[agent.agentId];
      if (!d) { warnings.push(agent.name + ' has no desk inside a room in the save; floorRooms puts it in ' + roomName); continue; }
      if (nameKey(d.name) !== nameKey(roomName)) { const msg = agent.name + ': save puts the desk in ' + d.name + ', floorRooms says ' + roomName; d.warnings.push(msg); warnings.push(msg); }
    }
  }
  for (const id of activeIds) if (!deptOfAgent[id]) warnings.push((nameOf[id] || id) + ' has no desk in any room of the save');

  // ---- line stages from the routing plan (stage order), labelled with the owner's column keys
  const plan = raw.plan || {};
  const chains = plan.dockChains || {}, agentOfDock = plan.agentOfDock || {};
  const escDocks = new Set(Object.values(plan.gateDocks || {}).map((g) => g && g.escTo).filter(Boolean));
  const referenced = new Set(Object.values(chains).flatMap((c) => c.next || []));
  let cur = Object.keys(chains).find((d) => !referenced.has(d)) || null;
  const mainChain = []; const seen = new Set();
  while (cur && !seen.has(cur)) { seen.add(cur); mainChain.push(cur); const nx = (chains[cur].next || []).filter((d) => !escDocks.has(d)); cur = nx[0] || null; }
  const stageOfAgent = {}; const stages = [];
  for (const dock of mainChain) { const aid = agentOfDock[dock]; const nm = nameOf[aid] || aid; const key = COLUMN_KEY_OF_AGENT[nameKey(nm)] || String(nm).toLowerCase(); stageOfAgent[aid] = key; stages.push({ key, label: key, dock, agentId: aid, agentName: nm }); }
  for (const dock of escDocks) { const aid = agentOfDock[dock]; if (aid) stageOfAgent[aid] = 'rejected'; }
  if (!stages.length) { warnings.push('routing.plan.json has no dock chain; using the owner\'s default column order'); for (const [k, v] of Object.entries(COLUMN_KEY_OF_AGENT)) { const a = active.find((x) => nameKey(x.name) === k); if (a && v !== 'rejected') { stageOfAgent[a.agentId] = v; stages.push({ key: v, label: v, dock: null, agentId: a.agentId, agentName: a.name }); } } }
  const columns = [{ key: 'brief', label: 'brief', agentName: 'Research Lab' }, ...stages, { key: 'approval-queue', label: 'approval queue', agentName: 'owner' }, { key: 'done', label: 'done', agentName: 'approved / published' }];
  const stageLabel = Object.fromEntries(columns.map((c) => [c.key, c.label]));

  // ---- runs by id, latest run per agent, hop timing
  const runsById = Object.fromEntries((raw.runs || []).map((r) => [r.runId, r]));
  const runsByAgent = {}; for (const r of raw.runs || []) (runsByAgent[r.agentId] ||= []).push(r);
  for (const list of Object.values(runsByAgent)) list.sort((a, b) => (a.ts || a.endedAt || 0) - (b.ts || b.endedAt || 0));
  const sessions = [...(raw.sessions || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const hopEnd = (h) => { const r = runsById[h.runId]; return r ? (r.endedAt || r.ts) : (h.output == null ? now : null); };
  const liveAgentIds = new Set((raw.spendPending || []).map((p) => p.agentId).filter(Boolean));
  // which "working" signals come from the synthetic overlay (fixtures only), so the page can tag them
  const syntheticLive = {};
  for (const p of raw.spendPending || []) if (p.synthetic && p.agentId) syntheticLive[p.agentId] = p.syntheticWhat;
  for (const s of sessions) if (s.state === 'running' || s.running) { const h = last(s.hops); if (h && h.output == null) { liveAgentIds.add(h.agentId); if (s.synthetic) syntheticLive[h.agentId] = s.syntheticWhat; } }
  for (const j of (raw.cron && raw.cron.jobs) || []) { const hb = j.heartbeatAt ? Date.parse(j.heartbeatAt) : 0; if (j.fireClaim || (hb && now - hb < 10 * 60000)) liveAgentIds.add(j.agentId); }

  // ---- jobs: one per listing id, from every place an id can appear
  const ids = new Set([...Object.keys(raw.work || {}), ...Object.keys(raw.outbox || {}), ...Object.keys(raw.queue || {}), ...Object.keys(raw.rejectedPkgs || {}), ...(raw.tracker || []).map((r) => r.listing_id), ...raw.research.drafts.map((b) => b.id), ...raw.research.briefs.map((b) => b.id), ...sessions.map(sessionId).filter(Boolean)]);
  const sessionOf = {}; for (const s of sessions) { const id = sessionId(s); if (id) sessionOf[id] = s; }
  const trackerOf = Object.fromEntries((raw.tracker || []).map((r) => [r.listing_id, r]));
  const jobs = [];
  for (const id of ids) {
    if (!isListingId(id)) continue;
    const work = raw.work[id], out = raw.outbox[id], q = raw.queue[id], rp = raw.rejectedPkgs[id], tr = trackerOf[id], s = sessionOf[id];
    const draft = raw.research.drafts.find((b) => b.id === id), briefRec = raw.research.briefs.find((b) => b.id === id);
    const briefText = (work && work.brief) || (briefRec && briefRec.text) || (draft && draft.text) || '';
    const job = { id, title: titleFromId(id), niche: briefNiche(briefText) || (tr && tr.niche) || null, slogan: work ? work.slogan : null, briefStatus: briefField(briefText, 'status') || null, priceRange: briefUsdRange(briefText), stage: 'brief', lane: null, status: 'backlog', flag: null, statusReason: null, agentId: null, hops: [], files: [], images: [], costUsd: null, startedAt: null, updatedAt: null, endedAt: null, tracker: tr ? { status: tr.status, status_reason: tr.status_reason, packaged_at: tr.packaged_at, owner_decision_at: tr.owner_decision_at, published_at: tr.published_at, etsy_listing_url: tr.etsy_listing_url, cost_usd: tr.cost_usd, updated_at: tr.updated_at } : null, queue: q ? { collectedAt: q.manifest && q.manifest.collectedAt, costUsd: q.manifest && q.manifest.costUsd, gates: q.manifest && q.manifest.gates, variants: q.manifest && Array.isArray(q.manifest.variantPrices) ? q.manifest.variantPrices.length : null } : null };
    job.warnings = [];
    const synth = [s, q, tr].find((x) => x && x.synthetic);
    job.synthetic = !!synth; job.syntheticWhat = synth ? synth.syntheticWhat : null;
    // session hops (line progress) — the newest session for this id
    if (s) {
      job.startedAt = s.createdAt || null; job.updatedAt = s.updatedAt || null; job.costUsd = r6(s.totalUsd);
      job.hops = (s.hops || []).map((h) => ({ i: h.i, agentId: h.agentId, agentName: nameOf[h.agentId] || h.agentLabel, stage: stageOfAgent[h.agentId] || null, pass: h.pass, verdict: h.verdict, usd: r6(h.usd), ms: h.ms, output: h.output == null ? null : String(h.output).slice(0, 240), live: h.output == null, at: hopEnd(h) }));
      const h = last(s.hops);
      if (h) { job.agentId = h.agentId; job.stage = stageOfAgent[h.agentId] || job.stage; job.status = (s.state === 'running' || s.running) ? 'in_progress' : 'in_progress'; }
      if (s.state === 'done') { job.endedAt = s.ended || s.updatedAt; job.status = 'in_progress'; }
      if (s.paused) job.status = 'waiting';
      if (s.error) { job.flag = 'error'; job.statusReason = String(s.error).slice(0, 200); }
    } else if (briefRec) { job.stage = 'brief'; job.status = 'backlog'; job.statusReason = 'verified brief, waiting for line intake'; job.startedAt = briefRec.mtime; job.updatedAt = briefRec.mtime; const d = active.find((a) => stageOfAgent[a.agentId] === first(stages)?.key); job.agentId = d ? d.agentId : null; }
    else if (draft) { job.stage = 'brief'; job.status = 'backlog'; job.statusReason = 'candidate brief in drafts/' + draft.day + ', awaiting the evidence check'; job.startedAt = draft.mtime; job.updatedAt = draft.mtime; const ev = active.find((a) => nameKey(a.name) === 'EVIDENCECHECKER'); job.agentId = ev ? ev.agentId : null; }
    // outcome overrides, in precedence order
    const lastHop = last(job.hops);
    const lastStageHop = [...job.hops].reverse().find((h) => h.stage && h.stage !== 'rejected') || null;
    // Precedence when sources disagree: an owner decision in the tracker wins; otherwise the newer of rejected/ and
    // the tracker's gate status wins. Either way the disagreement is recorded on the job, never silently dropped.
    const rpLine = rp ? firstLine(rp.rejected) : '';
    const ownerDone = tr && ['approved', 'published', 'retired'].includes(tr.status);
    if (tr && tr.status === 'rejected_by_owner') { job.lane = 'rejected'; job.stage = 'rejected'; job.status = 'rejected'; job.statusReason = tr.status_reason || rpLine || 'rejected by the owner'; job.endedAt = (tr.owner_decision_at && Date.parse(tr.owner_decision_at)) || (rp && rp.mtime) || job.endedAt; job.rejectedBy = 'owner'; }
    else if (ownerDone) {
      job.stage = 'done'; job.status = 'done'; job.statusReason = tr.status === 'published' ? 'published ' + dmyFromIso(tr.published_at) : tr.status === 'approved' ? 'approved by the owner ' + dmyFromIso(tr.owner_decision_at) + ', publish by hand' : 'retired'; job.endedAt = Date.parse(tr.published_at || tr.owner_decision_at || tr.updated_at) || job.endedAt;
      if (rp) job.warnings.push('rejected/ also holds this id (' + (rpLine || 'REJECTED.md') + ', ' + dmy(rp.mtime) + '); the tracker\'s owner decision (' + tr.status + ') is shown');
      if (tr.status === 'approved' && tr.status_reason) job.statusReason += ' · ' + tr.status_reason;
    }
    else if (rp) {
      job.lane = 'rejected'; job.stage = 'rejected'; job.status = 'rejected'; job.statusReason = rpLine || 'moved to rejected/'; job.endedAt = rp.mtime || job.endedAt; job.rejectedBy = /by the owner/i.test(rp.rejected || '') ? 'owner' : 'archived';
      if (tr && tr.status === 'blocked') job.warnings.push('tracker still says blocked (' + (tr.status_reason || 'no reason') + ', ' + dmyFromIso(tr.updated_at) + '); rejected/ is newer (' + dmy(rp.mtime) + ') and is shown');
    }
    else if (work && work.rejected) { job.lane = 'rejected'; job.stage = 'rejected'; job.status = 'rejected'; job.statusReason = 'refused by QA, recorded by REJECTS-DESK: ' + firstLine(work.rejected.text); job.endedAt = work.rejected.mtime; job.rejectedBy = 'rejects-desk'; const rd = active.find((a) => stageOfAgent[a.agentId] === 'rejected'); if (rd) job.agentId = rd.agentId; }
    else if (tr && tr.status === 'blocked') { job.lane = 'blocked'; job.stage = 'blocked'; job.status = 'blocked'; job.statusReason = tr.status_reason || 'blocked by the package gate'; job.endedAt = tr.updated_at ? Date.parse(tr.updated_at) : job.endedAt; job.qaPassedGateFailed = !!(tr.qa_design === 'approved' && tr.qa_listing === 'approved'); }
    else if (q || (tr && tr.status === 'packaged')) { job.stage = 'approval-queue'; job.status = 'waiting'; job.statusReason = 'packaged, waiting for the owner\'s decision'; job.updatedAt = Date.parse((q && q.manifest && q.manifest.collectedAt) || (tr && tr.packaged_at)) || job.updatedAt; }
    else if (lastHop && !lastHop.live && s && s.state === 'done') { if (lastHop.verdict === 'approved' && job.stage === last(stages)?.key) { job.statusReason = 'approved by ' + lastHop.agentName + ', not yet collected into a package'; job.status = 'in_progress'; } else if (lastHop.verdict === 'revise') { job.statusReason = 'revise from ' + lastHop.agentName + ' (pass ' + lastHop.pass + ')'; } else job.statusReason = 'line stopped after ' + lastHop.agentName; }
    else if (lastHop && lastHop.live) { job.statusReason = lastHop.agentName + ' working, pass ' + lastHop.pass; job.status = 'in_progress'; }
    if (tr && tr.cost_usd && job.costUsd == null) job.costUsd = Number(tr.cost_usd);
    if (q && q.manifest && typeof q.manifest.costUsd === 'number') job.costUsd = q.manifest.costUsd;
    // files + images for the side panel (paths relative to the station root; the page never gets absolute paths)
    if (work) { for (const f of work.files) job.files.push('work/' + id + '/' + f); for (const d of work.designs) job.images.push({ url: '/api/office/image/work/' + id + '/' + d.file, file: d.file, n: d.n, at: d.mtime }); }
    if (out) { for (const f of ['listing.json', 'listing.md', 'qa-design.json', 'qa-listing.json']) job.files.push('outbox/' + id + '/' + f); job.listing = out.listing ? { title: out.listing.title, tags: (out.listing.tags || []).length, priceEur: out.listing.listingPriceEur ?? null } : null; }
    if (q) for (const f of q.files || []) job.files.push('approval-queue/' + id + '/' + f);
    if (rp && rp.manifest) job.images.push({ url: '/api/office/image/rejected/' + id + '/design-original.png', file: 'design-original.png', n: 0, at: rp.mtime });
    job.qaDesign = work ? work.designPasses.map((p) => ({ pass: p.n, verdict: p.rec && p.rec.verdict, reasons: (p.rec && p.rec.reasons || []).slice(0, 3) })) : [];
    job.qaListing = work ? work.listingPasses.map((p) => ({ pass: p.n, verdict: p.rec && p.rec.verdict, reasons: (p.rec && p.rec.reasons || []).slice(0, 3) })) : [];
    // progress + timing
    // progress % only for active stages (in progress / waiting); done, blocked, rejected and backlog show a pill instead
    const base = PROGRESS[job.stage] ?? 0.05;
    job.progress = job.status === 'in_progress' || job.status === 'waiting' ? Math.round(100 * (lastHop && lastHop.live ? base + 0.06 : base)) : null;
    void lastStageHop;
    job.updatedAt = Math.max(job.updatedAt || 0, job.endedAt || 0, work ? work.mtime || 0 : 0) || job.startedAt || null;
    // the time of the latest stage change (calendar: one entry per job, on this day)
    const prevHop = job.hops.length > 1 ? job.hops[job.hops.length - 2] : null;
    let sc = null;
    if (job.lane || job.status === 'done') sc = job.endedAt;
    else if (job.stage === 'approval-queue') sc = Date.parse((q && q.manifest && q.manifest.collectedAt) || (tr && tr.packaged_at)) || null;
    else if (lastHop) sc = lastHop.live ? ((prevHop && prevHop.at) || job.startedAt) : lastHop.at;
    else sc = job.startedAt;
    job.stageChangedAt = sc || job.updatedAt || job.startedAt || null;
    job.elapsedMs = job.startedAt ? Math.max(0, (job.endedAt || (job.status === 'in_progress' || job.status === 'waiting' ? now : job.updatedAt || now)) - job.startedAt) : null;
    job.agentName = job.agentId ? (nameOf[job.agentId] || job.agentId) : null;
    job.dept = job.agentId && deptOfAgent[job.agentId] ? deptOfAgent[job.agentId].key : null;
    job.stageLabel = stageLabel[job.stage] || job.stage;
    jobs.push(job);
  }
  // an agent error on a brief check marks that brief
  const errRuns = Object.values(runsByAgent).map(last).filter((r) => r && r.reason && !['done', 'cancelled'].includes(r.reason));
  for (const r of errRuns) { const ev = jobs.find((j) => j.stage === 'brief' && j.agentId === r.agentId); if (ev) { ev.flag = 'error'; ev.statusReason = (nameOf[r.agentId] || r.agentId) + ' run failed: ' + (r.failureCode || r.reason) + (r.failureStage ? ' (' + r.failureStage + ')' : ''); if (r.synthetic) { ev.synthetic = true; ev.syntheticWhat = r.syntheticWhat; } } }
  jobs.sort((a, b) => (b.stageChangedAt || b.updatedAt || 0) - (a.stageChangedAt || a.updatedAt || 0));
  const conflicted = jobs.filter((j) => j.warnings.length);
  if (conflicted.length) warnings.push(conflicted.length + ' job' + (conflicted.length > 1 ? 's have' : ' has') + ' sources that disagree (tracker vs rejected/); open a job for details');

  // ---- board
  const board = { columns: columns.map((c) => ({ ...c, jobIds: jobs.filter((j) => !j.lane && j.stage === c.key).map((j) => j.id) })), lanes: { rejected: jobs.filter((j) => j.lane === 'rejected').map((j) => j.id), blocked: jobs.filter((j) => j.lane === 'blocked').map((j) => j.id) } };

  // ---- agents
  const ledger = raw.ledger || [];
  const agents = active.map((a) => {
    const id = a.agentId, sa = saveAgents[id] || {}, cfg = cfgAgents[nameKey(a.name)] || {};
    const desk = deskOf[id] || null, dept = deptOfAgent[id] || null;
    const myRuns = runsByAgent[id] || [], lastRun = last(myRuns);
    const todayRows = ledger.filter((r) => r.agentId === id && r.tsMs >= dayStart && r.tsMs <= now);
    const myJobs = jobs.filter((j) => j.hops.some((h) => h.agentId === id) || j.agentId === id);
    const myHops = jobs.flatMap((j) => j.hops.filter((h) => h.agentId === id).map((h) => ({ ...h, jobId: j.id }))).sort((x, y) => (x.at || 0) - (y.at || 0));
    const liveHop = myHops.find((h) => h.live);
    const curJob = liveHop ? jobs.find((j) => j.id === liveHop.jobId) : (myJobs.find((j) => j.agentId === id && j.status === 'waiting') || myJobs.find((j) => j.agentId === id && j.status === 'in_progress') || null);
    let status = 'idle', statusText = 'idle', since = lastRun ? (lastRun.endedAt || lastRun.ts) : null, services = [], synthetic = null;
    const routineLive = ((raw.cron && raw.cron.jobs) || []).find((j) => j.agentId === id && (j.fireClaim || (j.heartbeatAt && now - Date.parse(j.heartbeatAt) < 10 * 60000)));
    if (liveAgentIds.has(id)) {
      status = 'working';
      statusText = liveHop ? 'working · ' + (stageLabel[liveHop.stage] || liveHop.stage) + ' pass ' + liveHop.pass : routineLive ? 'working · routine: ' + routineLive.name : 'working';
      since = liveHop ? (first((raw.spendPending || []).filter((p) => p.runId === liveHop.runId))?.startedAt || null) : (routineLive && routineLive.fireClaim && routineLive.fireClaim.at) || null;
      services = [a.provider || 'anthropic'];
      if ((cfg.gear || []).includes('studio') && (!liveHop || liveHop.stage === 'design')) services.push('openrouter');
      synthetic = syntheticLive[id] || null;
    } else if (lastRun && lastRun.reason && !['done', 'cancelled'].includes(lastRun.reason)) {
      status = 'error'; statusText = 'error · ' + (lastRun.failureCode || lastRun.reason) + (lastRun.failureStage ? ' (' + lastRun.failureStage + ')' : '');
      synthetic = lastRun.synthetic ? lastRun.syntheticWhat : null;
    } else if (curJob && curJob.status === 'waiting') {
      status = 'waiting'; statusText = 'waiting for approval · ' + curJob.id;
      synthetic = curJob.synthetic ? curJob.syntheticWhat : null;
    }
    // cross-check: the roster's model against the tier station.config.json declares for this agent (flag, never pick)
    const agentWarnings = [];
    const tierModel = cfg.tier && config.models && config.models[cfg.tier] ? config.models[cfg.tier].id : null;
    if (tierModel && a.model && tierModel !== a.model) { const msg = a.name + ': roster model ' + a.model + ' differs from station.config.json tier "' + cfg.tier + '" (' + tierModel + ')'; agentWarnings.push(msg); warnings.push(msg); }
    const lastHopDone = [...myHops].reverse().find((h) => !h.live);
    const lastOutput = lastHopDone ? { text: lastHopDone.output, at: lastHopDone.at, jobId: lastHopDone.jobId } : lastRun ? { text: (lastRun.deliveryText || ('ran: ' + (lastRun.title || '').slice(0, 120))), at: lastRun.endedAt || lastRun.ts, jobId: null } : null;
    const recentJobs = [...new Set([...(curJob ? [curJob.id] : []), ...myHops.slice().reverse().map((h) => h.jobId), ...myJobs.map((j) => j.id)])].slice(0, 8);
    const designJobs = recentJobs.map((jid) => jobs.find((j) => j.id === jid)).filter((j) => j && j.images.length);
    const latestImage = (cfg.gear || []).includes('studio') && designJobs.length ? { ...last(designJobs[0].images), jobId: designJobs[0].id } : null;
    const overseer = nameKey(a.name) === 'STATIONOVERSEER';
    return {
      // model, provider and role come from agent.roster.json only; the roster's system prompt is never read into the snapshot.
      // R2: a prompt-like roster role becomes a short label (department + duty), ui/role.js
      id, name: a.name, model: a.model || null, provider: a.provider || null, role: roleLabel(a.role, { dept: dept ? dept.name : null, name: a.name }), modelSource: 'agent.roster.json', color: sa.color || null, gear: cfg.gear || [], tier: cfg.tier || null, warnings: agentWarnings,
      dept: dept ? dept.key : null, deptName: dept ? dept.name : null, desk, status, statusText, since, services, synthetic: !!synthetic, syntheticWhat: synthetic,
      currentJob: curJob ? { id: curJob.id, stage: curJob.stage, stageLabel: curJob.stageLabel, status: curJob.status, pass: liveHop ? liveHop.pass : null } : null,
      lastOutput, spendToday: { usd: r6(todayRows.reduce((s, r) => s + r.usd, 0)), runs: todayRows.length, date: todayStr, label: 'calendar day ' + dmy(dayStart) },
      lastRun: lastRun ? { at: lastRun.endedAt || lastRun.ts, reason: lastRun.reason, title: (lastRun.title || '').slice(0, 100), usd: lastRun.usd } : null,
      recentJobs, latestImage, runsTotal: myRuns.length,
      overseer: overseer ? { report: raw.overseerReports && raw.overseerReports.length ? { file: raw.overseerReports[0].file, at: raw.overseerReports[0].mtime, text: raw.overseerReports[0].text } : null, note: raw.overseerReports && raw.overseerReports.length ? null : 'No report yet' } : null
    };
  });
  for (const a of agents) if (!a.desk) warnings.push(a.name + ' has no desk prop in the save');

  // ---- department metrics + counts (each metric names its source)
  const designsMade = Object.values(raw.work).reduce((s, w) => s + w.designs.length, 0);
  const allDesignPasses = Object.values(raw.work).flatMap((w) => w.designPasses.map((p) => p.rec && p.rec.verdict));
  const passRate = allDesignPasses.length ? Math.round(100 * allDesignPasses.filter((v) => v === 'approved').length / allDesignPasses.length) : null;
  for (const d of departments) {
    const k = nameKey(d.name);
    if (k === 'RESEARCH') d.metrics = [{ label: 'briefs produced', value: raw.research.drafts.length + raw.research.briefs.length + raw.research.rejected.length, source: 'research-lab/drafts + briefs + rejected' }, { label: 'verified', value: raw.research.briefs.length, source: 'research-lab/briefs' }];
    else if (k === 'DESIGN') d.metrics = [{ label: 'designs made', value: designsMade, source: 'work/*/design-vN.png' }, { label: 'QA pass rate', value: passRate == null ? 'n/a' : passRate + '%', source: 'work/*/qa/design-passN.json' }];
    else if (k === 'OFFICE') d.metrics = [{ label: 'listings drafted', value: Object.keys(raw.outbox).length, source: 'outbox/*/listing.json' }, { label: 'approval queue', value: Object.keys(raw.queue).length, source: 'approval-queue/' }];
    else d.metrics = [{ label: 'agents', value: d.agents.length, source: 'save' }];
    d.counts.doing = jobs.filter((j) => j.status === 'in_progress' && j.dept === d.key).length;
    d.counts.next = jobs.filter((j) => (j.status === 'backlog' || j.status === 'waiting') && j.dept === d.key).length;
    d.counts.done = jobs.filter((j) => (j.status === 'done' || j.lane) && j.dept === d.key).length;
    d.agentCount = d.agents.length;
  }

  // ---- hub: "Station memory" (DECISIONS.md 5)
  const notes = Object.entries(raw.notebooks || {}).flatMap(([aid, list]) => list.map((n) => ({ ...n, agentId: aid })));
  const recalled = notes.filter((n) => n.lastUsedAt).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] || null;
  const lastLedger = last([...ledger].sort((a, b) => a.tsMs - b.tsMs));
  const hub = {
    label: 'Station memory',
    notebooks: { entries: notes.length, byAgent: Object.fromEntries(Object.entries(raw.notebooks || {}).filter(([aid]) => activeIds.includes(aid)).map(([aid, l]) => [nameOf[aid] || aid, l.length])), lastRecalledBy: recalled ? (nameOf[recalled.agentId] || recalled.agentId) : null, lastRecalledAt: recalled ? recalled.lastUsedAt : null, source: 'legacy/<agent>.notebook.json lastUsedAt' },
    ledger: { rows: ledger.length, last: lastLedger ? { at: lastLedger.tsMs, agent: nameOf[lastLedger.agentId] || lastLedger.agentId, usd: lastLedger.usd, model: lastLedger.model } : null, source: 'legacy/ledger.jsonl' },
    recent: notes.sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0)).slice(0, 12).map((n) => ({ agent: nameOf[n.agentId] || n.agentId, kind: n.kind, body: String(n.body || n.content || '').slice(0, 140), lastUsedAt: n.lastUsedAt || null, useCount: n.useCount || 0, createdAt: n.createdAt || null }))
  };

  // ---- spend (calendar day, labelled; DECISIONS.md 7)
  const todayRows = ledger.filter((r) => r.tsMs >= dayStart && r.tsMs <= now);
  const spend = {
    today: { date: todayStr, label: 'calendar day ' + dmy(dayStart) + ' (local)', usd: r6(todayRows.reduce((s, r) => s + r.usd, 0)), runs: todayRows.length, byAgent: Object.fromEntries(agents.map((a) => [a.name, a.spendToday.usd])), source: 'legacy/ledger.jsonl' },
    trailing24h: null,
    lineToday: raw.lineSpend && raw.lineSpend.lines ? Object.entries(raw.lineSpend.lines).map(([lineId, v]) => ({ lineId, usd: v.usd, day: v.day, label: 'line ' + lineId + ' day counter (legacy line-spend.json)' })) : [],
    caps: raw.budget && raw.budget.caps ? { ...raw.budget.caps, source: 'legacy/budget.json' } : null,
    lineLimits: plan.lineLimits || null,
    last7days: Array.from({ length: 7 }, (_, i) => { const s = dayStart - (6 - i) * 86400000, e = s + 86400000; return { date: today(new Date(s)), usd: r6(ledger.filter((r) => r.tsMs >= s && r.tsMs < e).reduce((t, r) => t + r.usd, 0)) }; })
  };

  // ---- routines (cron jobs) + calendar
  const routines = (((raw.cron && raw.cron.jobs) || [])).map((j) => {
    const expr = (j.schedule && j.schedule.expr) || (typeof j.schedule === 'string' ? j.schedule : null);
    const enabled = !!j.enabled;
    // A paused routine (enabled:false) has no next run: it will not fire. Where it WOULD run is offered only as
    // ghostRuns, which the page shows behind an off-by-default toggle.
    const nextRun = enabled ? (j.nextRunAt ? Date.parse(j.nextRunAt) : (expr ? cronNext(expr, now) : null)) : null;
    const runsFrom = (t0) => { const out = []; let t = t0, n = 0; while (t && n < 12 && t < now + 62 * 86400000) { out.push(t); t = cronNext(expr, t); n++; } return out; };
    return { id: j.id, name: j.name, prompt: String(j.prompt || '').slice(0, 200), schedule: expr, scheduleWords: cronWords(expr), scheduleDisplay: j.scheduleDisplay || (j.schedule && j.schedule.display) || expr, agentId: j.agentId, agentName: nameOf[j.agentId] || j.agentId, dept: deptOfAgent[j.agentId] ? deptOfAgent[j.agentId].key : null, enabled, state: j.state || (enabled ? 'scheduled' : 'paused'), needsOk: !enabled, nextRun, nextRunIsProjection: enabled && !j.nextRunAt, upcoming: enabled && expr ? runsFrom(nextRun) : [], ghostRuns: !enabled && expr ? runsFrom(cronNext(expr, now)) : [], lastRunAt: j.lastRunAt ? Date.parse(j.lastRunAt) : null, lastStatus: j.lastStatus || null, lastUsd: j.lastUsd || 0, live: liveAgentIds.has(j.agentId) && !!(j.fireClaim || j.heartbeatAt), workdir: j.workdir || null, source: 'legacy/cron.jobs.json' };
  });
  // calendar: ONE entry per job, on the day of its latest stage change, with the stage it reached
  const events = [];
  for (const j of jobs) {
    const at = j.stageChangedAt; if (!at) continue;
    events.push({ date: today(new Date(at)), at, kind: 'job', jobId: j.id, title: j.title, stage: j.lane || j.stage, stageLabel: j.lane || j.stageLabel, status: j.status, dept: j.dept, agent: j.agentName, reason: j.statusReason, synthetic: j.synthetic });
  }
  for (const r of routines) {
    if (r.lastRunAt) events.push({ date: today(new Date(r.lastRunAt)), at: r.lastRunAt, kind: 'routine-run', routineId: r.id, title: r.name, dept: r.dept, agent: r.agentName });
    for (const t of r.upcoming) events.push({ date: today(new Date(t)), at: t, kind: 'routine', routineId: r.id, title: r.name, dept: r.dept, agent: r.agentName, projected: r.nextRunIsProjection || t !== r.nextRun });
  }
  events.sort((a, b) => a.at - b.at);

  // ---- services (read status only; Phase 2 adds /api/providers "configured" booleans)
  const providers = new Set(active.map((a) => a.provider).filter(Boolean));
  const models = config.models || {};
  const services = [];
  // status vocabulary (owner, round 1): configured | manual | offline | unknown. In files-only mode "configured" means
  // declared in the roster / station.config.json; key presence is not checked (the office never reads .secrets/).
  const declared = 'declared in files; key not checked';
  for (const p of providers) services.push({ id: p, label: p === 'anthropic' ? 'Anthropic' : p, kind: 'model', status: 'configured', detail: 'text models for ' + active.filter((a) => a.provider === p).length + ' agents · ' + declared, source: 'agent.roster.json' });
  if (models.imageTransparent && /\//.test(models.imageTransparent.id || '')) services.push({ id: 'openrouter', label: 'OpenRouter', kind: 'image', status: 'configured', detail: 'image generation: ' + models.imageTransparent.id + ' · ' + declared, source: 'station.config.json models' });
  if (config.upscale && config.upscale.method === 'realesrgan') services.push({ id: 'realesrgan', label: 'Real-ESRGAN', kind: 'local', status: 'configured', detail: 'local upscaler on this PC (' + (config.upscale.model || '') + ')', source: 'station.config.json upscale' });
  services.push({ id: 'etsy', label: 'Etsy', kind: 'market', status: 'manual', detail: 'no API key; listings published by hand', source: 'station.config.json market' });

  return {
    generatedAt: now, warnings, errors: raw.errors || [], sourcesRead: (raw.sources || []).length,
    source: { mode: raw.mode || 'files', root: raw.rootLabel || null, snapshotAt: raw.snapshotAt || null, synthetic: raw.synthetic || [], legacy: true },
    // the legacy view has no engine behind it: the badge says so (the engine view sets state from the running engine)
    engine: { state: 'legacy', label: 'legacy view · read-only', detail: 'history read from the legacy build\'s files; nothing runs from this view' },
    station: { name: 'Station', runtime: 'legacy view (read-only files)', host: host.label || null, provider: (raw.save && raw.save.doc && raw.save.doc.prov) || null },
    services, departments, agents, hub, jobs, board, stages, columns, routines, events, spend
  };
}
