// ui/labels.js — HTML labels over the 3D scene: desk name tags, department cards, the station-memory card and the
// services rack labels. Cards are placed above the far edge of their platform with a thin leader line, and a small
// layout pass keeps them off desks, labels and each other. Desk tags show from LABEL_ZOOM, or always for the selected
// and working desks. Re-laid out only when the camera, the data or the size changes.
// R7a.2 (owner, 29/10/2026): on the seven-floor stack every desk shows its tag, hired or not, standing on its own monitor with a short
// stem; a hired agent's tag has a status dot (working or idle) from its live status.
import { esc, when } from './format.js';
import { PALETTE } from '../config/palette.js';

export const LABEL_ZOOM = 1.5;     // desk name tags appear from this zoom (selected / working desks always)
const RACK_LABEL_ZOOM = 2.0;       // per-terminal labels on the services rack
const PAD = 6, EDGE = 8, STEM = 12;   // STEM: the desk tag's stem down to its monitor (px, styles.css .lbl-desk)
// pure (tests/r7a-floors.test.mjs): the dot of a hired agent's tag
export const workDot = (status) => (status === 'working' ? 'working' : 'idle');

// pure (tests/r7a-floors.test.mjs): the trophy cabinet's plaque: the product's name, then a name plate per archived agent, shelf by shelf
export function trophyCard(plan) {
  const sc = (plan.screens || []).find((x) => x.kind === 'trophy'), c = (sc && sc.content) || {}, names = plan.cabinet.map((a) => a.name);
  return '<div class="trophy-head"><span>Trophy cabinet · Etsy archive</span><small>archived</small></div><h3 class="trophy-name">' + esc(c.title || 'Archive') + '</h3>'
    + '<div class="trophy-sub">' + esc(c.sub || names.length + ' archived agents') + '</div>'
    + '<div class="plaques">' + names.map((n) => '<span class="plaque">' + esc(n) + '</span>').join('') + '</div>';
}

export function createLabels({ container, office, onDept, onHub, onService }) {
  const els = { agents: {}, depts: {}, services: {}, vacant: {}, hub: null, rack: null, svg: null, leaders: {} };
  let snap = null;
  const svgNS = 'http://www.w3.org/2000/svg';

  function build(s) {
    snap = s; container.innerHTML = ''; els.agents = {}; els.depts = {}; els.services = {}; els.vacant = {}; els.leaders = {};
    const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('class', 'leaders'); container.appendChild(svg); els.svg = svg;
    const leader = (key) => { const g = document.createElementNS(svgNS, 'g'); const line = document.createElementNS(svgNS, 'path'); const dot = document.createElementNS(svgNS, 'circle'); dot.setAttribute('r', '2.6'); g.appendChild(line); g.appendChild(dot); svg.appendChild(g); els.leaders[key] = { g, line, dot }; };
    const tower = !!s.plan;
    for (const a of s.agents) {
      const el = document.createElement('div'); el.className = 'lbl' + (tower ? ' lbl-desk' : ''); el.dataset.agent = a.id;
      const dot = tower ? '<i class="dot dot-' + workDot(a.status) + '" title="' + workDot(a.status) + '" style="background:' + PALETTE.status[workDot(a.status)] + '"></i>' : '<i style="background:' + (PALETTE.status[a.status] || '#999') + '"></i>';
      el.innerHTML = '<span class="lbl-name">' + dot + esc(a.name) + (a.synthetic ? '<span class="syn" title="' + esc('synthetic test state: ' + (a.syntheticWhat || '')) + '">synthetic</span>' : '') + '</span>';
      el.title = a.statusText || a.status;
      container.appendChild(el); els.agents[a.id] = el;
    }
    const trophy = s.plan && s.plan.trophy ? trophyCard(s.plan) : null;
    for (const d of s.departments) {
      const el = document.createElement('div'); el.className = 'dept-card'; el.style.borderTopColor = PALETTE.departments[d.key] || PALETTE.departments.default;
      // R7a.2: the lobby's archived department is the trophy cabinet: its card is the cabinet's plaque, on the cabinet
      if (trophy && d.countLabel === 'archived') { el.classList.add('trophy-card'); el.innerHTML = trophy; el.title = d.name + ': the archived agents in the cabinet; click to go to the floor'; el.addEventListener('click', () => onDept(d.key)); container.appendChild(el); els.depts[d.key] = el; leader('dept:' + d.key); continue; }
      el.innerHTML = '<h3>' + esc(d.name) + '<small>' + esc(d.countLabel || d.agentCount + ' agent' + (d.agentCount === 1 ? '' : 's')) + '</small></h3>'
        + '<div class="metrics">' + d.metrics.map((m) => '<div class="metric" title="' + esc('source: ' + m.source) + '"><b>' + esc(m.value) + '</b><span>' + esc(m.label) + '</span></div>').join('') + '</div>'
        + '<div class="counts"><span>doing <b>' + d.counts.doing + '</b></span><span>next <b>' + d.counts.next + '</b></span><span>done <b>' + d.counts.done + '</b></span></div>'
        + (d.warnings && d.warnings.length ? '<div class="warn"><span class="badge badge-warn" title="' + esc(d.warnings.join('\n')) + '">⚠ save and floorRooms disagree</span></div>' : '');
      el.addEventListener('click', () => onDept(d.key));
      container.appendChild(el); els.depts[d.key] = el; leader('dept:' + d.key);
    }
    // R7a: an empty desk's tag (not hired yet, with its phase)
    for (const v of s.vacancies || []) {
      const el = document.createElement('div'); el.className = 'lbl lbl-vacant lbl-desk'; el.dataset.agent = v.id;
      el.innerHTML = '<span class="lbl-name">' + esc(v.name) + '<small>' + esc(v.label) + '</small></span>'; el.title = v.name + ': ' + v.label + '; the desk waits for its phase';
      container.appendChild(el); els.vacant[v.id] = el;
    }
    // R7a.2: the retired agent's own plaque on its portrait (OVERSEER: retired into the COO), apart from the cabinet
    els.retired = null;
    for (const r of (s.plan && s.plan.trophy ? s.plan.retired : []).slice(0, 1)) {
      const el = document.createElement('div'); el.className = 'lbl lbl-desk lbl-plaque';
      el.innerHTML = '<span class="lbl-name">' + esc(r.name) + '<small>' + esc(r.label) + '</small></span>'; el.title = r.name + ': ' + r.label + ' (not in the trophy cabinet)';
      container.appendChild(el); els.retired = el;
    }
    const h = s.hub, hub = document.createElement('div'); hub.className = 'hub-card';
    hub.innerHTML = '<h3>' + esc(h.label.toUpperCase()) + '</h3><div class="row"><span>notebook entries</span><b>' + h.notebooks.entries + '</b></div><div class="row"><span>ledger rows</span><b>' + h.ledger.rows + '</b></div>' + (h.legacyLedger ? '<div class="row"><span>legacy ledger rows</span><b>' + h.legacyLedger.rows + '</b></div>' : '') + '<div class="row"><span>last recalled by</span><b>' + (h.notebooks.lastRecalledBy ? esc(h.notebooks.lastRecalledBy) : '—') + '</b></div>' + (h.notebooks.lastRecalledAt ? '<div class="row sub"><span></span><span>' + esc(when(h.notebooks.lastRecalledAt, s.generatedAt)) + '</span></div>' : '');
    hub.title = 'open the ledger viewer · source: ' + h.notebooks.source + ' + ' + h.ledger.source;
    hub.addEventListener('click', onHub);
    // R7a: on the seven-floor stack the card hangs on the penthouse's Finance screen only
    if (!s.plan || s.plan.hub) { container.appendChild(hub); els.hub = hub; leader('hub'); } else els.hub = null;
    const rack = document.createElement('div'); rack.className = 'lbl rack-lbl';
    rack.innerHTML = '<span class="lbl-name">SERVICES ' + s.services.map((sv) => '<i title="' + esc(sv.label + ': ' + sv.status) + '" style="background:' + (PALETTE.serviceStatus[sv.status] || PALETTE.serviceStatus.unknown) + '"></i>').join('') + '</span>';
    rack.title = s.services.map((sv) => sv.label + ': ' + sv.status + (sv.reason ? ' (why: ' + sv.reason + ')' : '') + ' — ' + sv.detail).join('\n');
    // B0: the services sit on the shared floor (0); a business floor's closet is empty, so it has no rack label
    if (s.services.length) { container.appendChild(rack); els.rack = rack; } else els.rack = null;
    for (const sv of s.services) {
      const el = document.createElement('div'); el.className = 'lbl svc-lbl';
      el.innerHTML = '<span class="lbl-name"><i style="background:' + (PALETTE.serviceStatus[sv.status] || PALETTE.serviceStatus.unknown) + '"></i>' + esc(sv.label) + '<small>' + esc(sv.status) + '</small></span>';
      el.title = sv.detail + ' · source: ' + sv.source; if (onService) el.addEventListener('click', () => onService(sv.id));
      container.appendChild(el); els.services[sv.id] = el;
    }
    // measure once (sizes do not change with the camera)
    for (const el of [...Object.values(els.depts), els.hub].filter(Boolean)) { el.style.left = '0px'; el.style.top = '0px'; el._w = el.offsetWidth; el._h = el.offsetHeight; }
    update();
  }

  const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const inflate = (r, p) => ({ x0: r.x0 - p, y0: r.y0 - p, x1: r.x1 + p, y1: r.y1 + p });
  function tag(el, p, show, lift = 0) { if (!show || !p.visible) { el.style.display = 'none'; return null; } el.style.display = ''; el.style.transform = 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y - lift) + 'px) translate(-50%,-100%)'; if (!el._w) { el._w = el.offsetWidth; el._h = el.offsetHeight; } return { x0: p.x - el._w / 2, y0: p.y - lift - el._h, x1: p.x + el._w / 2, y1: p.y }; }

  function update() {
    if (!snap) return;
    const zoom = office.view.zoom, sel = office.selected, W = office.size.x, H = office.size.y;
    const obstacles = office.obstacles().map((r) => inflate(r, 2));
    const placed = [];
    // 1. desk name tags (fixed positions)
    for (const a of snap.agents) {
      const v = office.anchors.agents[a.id]; if (!v) continue;
      const r = tag(els.agents[a.id], office.project(v), !!snap.plan || zoom >= LABEL_ZOOM || a.status === 'working' || a.id === sel, snap.plan ? STEM : 0);
      if (els.agents[a.id].classList.contains('lbl-selected') !== (a.id === sel)) { els.agents[a.id].classList.toggle('lbl-selected', a.id === sel); els.agents[a.id]._w = 0; }
      if (r) placed.push(r);
    }
    if (els.retired) { const r = office.anchors.retired ? tag(els.retired, office.project(office.anchors.retired), true, STEM) : tag(els.retired, { visible: false }, false); if (r) placed.push(r); }
    for (const [id, el] of Object.entries(els.vacant)) { const v = office.anchors.vacant && office.anchors.vacant[id]; const r = v ? tag(el, office.project(v), true, STEM) : tag(el, { visible: false }, false); if (r) placed.push(r); }
    // 2. services rack: one compact label at overview, a tag per terminal when zoomed in
    const perTerminal = zoom >= RACK_LABEL_ZOOM;
    const rr = els.rack ? tag(els.rack, office.project(office.anchors.rack), !perTerminal) : null; if (rr) placed.push(rr);
    for (const [id, el] of Object.entries(els.services)) { const r = tag(el, office.project(office.anchors.services[id]), perTerminal); if (r) placed.push(r); }
    // 3. cards: above the far edge of the platform, nudged until clear of desks, labels and other cards
    const cards = snap.departments.map((d) => ({ key: 'dept:' + d.key, el: els.depts[d.key], anchor: office.anchors.deptCorners[d.key] })).filter((c) => c.el && c.anchor);
    if (els.hub) cards.push({ key: 'hub', el: els.hub, anchor: office.anchors.hub });
    for (const c of cards) {
      const a = office.project(c.anchor), L = els.leaders[c.key];
      if (!a.visible || a.x < -200 || a.x > W + 200 || a.y < -200 || a.y > H + 200) { c.el.style.display = 'none'; L.g.style.display = 'none'; continue; }
      const w = c.el._w, h = c.el._h;
      let best = null, bestScore = Infinity;
      // above the anchor first; R7a.2: below it (scored a little worse) where the top of the stage leaves no clear room above
      for (const down of [false, true]) for (let dy = 0; dy <= 260; dy += 16) for (const dx of [0, -40, 40, -80, 80, -130, 130, -190, 190, -260, 260]) {
        const cx = a.x + dx, by = down ? a.y + 26 + h + dy : a.y - 26 - dy;
        let r = { x0: cx - w / 2, y0: by - h, x1: cx + w / 2, y1: by };
        // keep inside the stage
        const sx = Math.max(0, EDGE - r.x0) - Math.max(0, r.x1 - (W - EDGE)), sy = Math.max(0, EDGE - r.y0) - Math.max(0, r.y1 - (H - EDGE));
        r = { x0: r.x0 + sx, x1: r.x1 + sx, y0: r.y0 + sy, y1: r.y1 + sy };
        const box = inflate(r, PAD);
        let overlap = 0;
        for (const o of obstacles) if (hit(box, o)) overlap += 3;
        for (const o of placed) if (hit(box, o)) overlap += 4;
        const score = overlap * 1000 + Math.abs(dx) * 1.1 + dy + Math.abs(sx) + Math.abs(sy) + (down ? 120 : 0);
        if (score < bestScore) { bestScore = score; best = r; }
        if (!overlap && dx === 0) break;
      }
      c.el.style.display = ''; c.el.style.transform = 'translate(' + Math.round(best.x0) + 'px,' + Math.round(best.y0) + 'px)';
      placed.push(best);
      // leader: from the card's bottom edge (nearest point) to the platform's far corner
      const lx = Math.min(Math.max(a.x, best.x0 + 14), best.x1 - 14), ly = a.y > best.y1 ? best.y1 : a.y < best.y0 ? best.y0 : best.y1;
      L.g.style.display = ''; L.line.setAttribute('d', 'M' + lx.toFixed(1) + ',' + ly.toFixed(1) + ' L' + a.x.toFixed(1) + ',' + a.y.toFixed(1)); L.dot.setAttribute('cx', a.x.toFixed(1)); L.dot.setAttribute('cy', a.y.toFixed(1));
    }
  }
  return { build, update };
}
