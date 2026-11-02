// ui/floormenu.js — the Floors button on the stage (owner, 28/10/2026): one clear way to reach every department. F (or the button)
// opens a list of the floors, top floor first, each with its departments; a floor goes to that floor, a department goes to its floor
// and flies the camera to it. Esc or F again closes it. Rows come from floors.js floorMenu (pure).
// R2c: above the floors, the Engineering panel (the ReplyDesk engineering line) when the snapshot has one.
import { esc } from './format.js';
import { floorMenu } from './floors.js';

export function createFloorMenu({ button, root, onFloor = () => {}, onDept = () => {}, onEng = null }) {
  let open = false, rows = [], cur = null, eng = null;
  function render() {
    root.innerHTML = '<div class="fm-head">Floors <span class="muted">click a department to go there · F or Esc to close</span></div>'
      + (eng && onEng ? '<div class="fm-floor fm-eng"><button class="fm-go" data-eng-open><span class="fm-n">⚙</span><span class="fm-name">Engineering · ' + esc(eng.products.map((p) => p.name).join(', ')) + '</span>' + (eng.waitingForYou ? '<span class="tag tag-warn">' + eng.waitingForYou + ' waiting for you</span>' : '') + '</button></div>' : '')
      + rows.map((r) => '<div class="fm-floor' + (r.floor != null && String(r.floor) === String(cur) ? ' fm-cur' : '') + '">'
      + (r.floor == null ? '<div class="fm-name">' + esc(r.name) + '</div>' : '<button class="fm-go" data-floor="' + r.floor + '"><span class="fm-n">' + r.floor + '</span><span class="fm-name">' + esc(r.name) + '</span>' + (r.floor != null && String(r.floor) === String(cur) ? '<span class="muted">you are here</span>' : '') + '</button>')
      + '<div class="fm-depts">' + (r.departments.length ? r.departments.map((d) => '<button class="chip" data-floor="' + (r.floor == null ? '' : r.floor) + '" data-dept="' + esc(d.key) + '">' + esc(d.name) + '</button>').join('') : '<span class="muted">' + (r.empty ? 'empty floor: no lines yet' : 'no departments') + '</span>') + '</div></div>').join('');
    root.querySelectorAll('[data-eng-open]').forEach((el) => el.addEventListener('click', () => { hide(); onEng(); }));
    root.querySelectorAll('[data-floor]').forEach((el) => el.addEventListener('click', () => {
      const n = el.dataset.floor === '' ? null : el.dataset.floor, dept = el.dataset.dept || null;   // R7a: 'G' and '1'..'6' (B0: '0', '1')
      hide();
      if (n != null && n !== String(cur)) onFloor(n);
      if (dept) onDept(dept);
    }));
  }
  function setData(snap, floor) { rows = floorMenu(snap); cur = floor; eng = (snap && snap.engineering) || null; button.classList.toggle('hidden', !rows.some((r) => r.departments.length || r.floor != null)); if (open) render(); }
  function show() { open = true; render(); root.classList.remove('hidden'); button.setAttribute('aria-expanded', 'true'); }
  function hide() { open = false; root.classList.add('hidden'); button.setAttribute('aria-expanded', 'false'); }
  button.addEventListener('click', (e) => { e.currentTarget.blur(); if (open) hide(); else show(); });
  return { setData, show, hide, toggle: () => (open ? hide() : show()), isOpen: () => open };
}
