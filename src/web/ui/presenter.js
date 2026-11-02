// ui/presenter.js — the presenter view (P; on by default in demo mode): a gentle camera tour that follows the active desk,
// holding at least `holdMs` on each stage change, and a caption strip that says what is happening. Captions are built
// from the engine's own events and the snapshot (nothing here is scripted or invented), so the same view works on a
// live station. Money is hidden while it is on (main.js: format.setMoneyHidden).
import { esc } from './format.js';

const MECH = {
  'brief-check': 'Station step: checking the brief\'s evidence, keyword sources and originality (no model)',
  prep: 'Station step: measuring the files and screening design.md and the image prompts for originality (no model)',
  'price-fill': 'Station step: filling in prices, delivery and licence facts (no model)',
  'package-gate': 'Package gate: every gate and the originality screen run again before packaging',
  package: 'The package gate passed. The job is being packaged for the approval queue'
};
const clip = (s, n = 150) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// 'ORIGINALITY HARD FAIL in set-v1/design.md: design.md: "garfield" matches characters "garfield"' -> a plain sentence
function originality(note) {
  const m = /ORIGINALITY HARD FAIL in ([^:]+):.*?"([^"]+)" matches (\w+)/.exec(note || '');
  if (!m) return null;
  return m[1].trim() + ' names “' + m[2] + '” (' + (m[3] === 'characters' ? 'a protected character' : 'protected ' + m[3]) + ')';
}

export function createPresenter({ office, root, holdMs = 3000, captionMs = 2800 }) {
  let on = false, tour = true, snap = null, status = '';
  const pending = [];

  // ---- camera: follow the newest active desk; never move again within holdMs of the last move
  let lastMoveAt = -Infinity, want = null, moveTimer = null, at = null;
  function target(t) { if (!t) return; want = t; schedule(); }
  function schedule() {
    clearTimeout(moveTimer);
    if (!on || !tour || !want) return;
    const wait = lastMoveAt + holdMs - performance.now();
    if (wait > 0) { moveTimer = setTimeout(schedule, wait + 10); return; }
    const t = want; want = null;
    const key = t.kind + ':' + (t.id || '');
    if (key === at) return;
    if (t.kind === 'desk') { const d = office.anchors.desks[t.id]; if (!d) return; office.focus({ x: d.x, z: d.z + 0.4 }, 1.95); }
    else office.resetView();
    at = key; lastMoveAt = performance.now();
  }

  // ---- captions: each stays up at least captionMs; routine ones are dropped when they pile up, important ones never
  const queue = []; let text = '', shownAt = -Infinity, capTimer = null;
  function caption(t, important = false) {
    if (!t) return;
    t = clip(t, 190);
    if ((queue.length ? queue[queue.length - 1].t : text) === t) return;
    queue.push({ t, important });
    while (queue.length > 2) { const i = queue.findIndex((c) => !c.important); if (i < 0 || i === queue.length - 1) break; queue.splice(i, 1); }
    pump();
  }
  function pump() {
    clearTimeout(capTimer);
    if (!queue.length) return;
    const wait = shownAt + captionMs - performance.now();
    if (wait > 0 && text) { capTimer = setTimeout(pump, wait + 10); return; }
    text = queue.shift().t; shownAt = performance.now(); render();
    if (queue.length) capTimer = setTimeout(pump, captionMs);
  }
  function render() {
    root.classList.toggle('hidden', !on || !text);
    root.innerHTML = '<span class="cap-dot"></span><span class="cap-text">' + esc(text) + '</span>' + (status ? '<span class="cap-status">' + esc(status) + '</span>' : '');
  }

  // ---- events -> captions and camera targets (handled with the first snapshot that already contains them)
  const job = (id) => (snap && snap.jobs.find((j) => j.id === id)) || null;
  const name = (k) => ((snap && snap.agents.find((a) => a.id === k)) || {}).name || String(k || '').toUpperCase();
  const titleOf = (id) => { const j = job(id); return j ? j.title : 'the job'; };
  function runCaption(ev) {
    const j = job(ev.jobId), pass = (ev.data && ev.data.pass) || 1, k = ev.agentKey;
    if (k === 'demand-researcher') return name(k) + ' is drafting a brief from Etsy demand evidence';
    if (k === 'evidence-checker') return name(k) + ' is re-opening the sources to verify the brief';
    if (k === 'designer') return pass === 1 ? name(k) + ' is making the ' + (j && j.productFiles ? j.productFiles + '-file set' : 'design set') + ' for ' + titleOf(ev.jobId) : null;   // later passes: the stage caption says why
    if (k === 'qa-design') return name(k) + ' is reviewing the set' + (pass > 1 ? ' again (pass ' + pass + ')' : '');
    if (k === 'lister') return pass === 1 ? name(k) + ' is writing the listing for ' + titleOf(ev.jobId) : null;
    if (k === 'qa-listing') return name(k) + ' is checking the listing against the files and the Etsy rules';
    if (k === 'rejects-desk') return name(k) + ' is recording why the job was refused';
    return name(k) + ' is working on ' + titleOf(ev.jobId);
  }
  function stageCaption(ev) {
    const d = ev.data || {}, j = job(ev.jobId), last = j && j.lastStage;
    if (d.step === 'done' && j && j.state === 'research-done') return caption('The brief passed the station\'s checks and is verified. It goes to the Room 1 line next.', true);
    if (d.kind === 'mechanical') return caption(MECH[d.step] || 'Station step: ' + d.step + ' (no model)');
    if (d.kind !== 'agent' || !(d.pass > 1) || !last) return;
    if (d.step === 'designer' && last.step === 'prep') return caption('Originality gate tripped: ' + (originality(last.note) || clip(last.note, 90)) + '. The line sends it back to ' + name('designer') + ' once (pass ' + d.pass + ').', true);
    if (d.step === 'designer' && last.step === 'qa-design') { const q = (j.qaDesign || [])[j.qaDesign.length - 1]; return caption(name('qa-design') + ' sent the design back: ' + clip((q && q.reasons && q.reasons[0]) || 'see the QA record', 100) + '. ' + name('designer') + ' redraws it (pass ' + d.pass + ').', true); }
    if (d.step === 'lister' && last.step === 'qa-listing') { const q = (j.qaListing || [])[j.qaListing.length - 1]; return caption(name('qa-listing') + ' sent the listing back: ' + clip((q && q.reasons && q.reasons[0]) || 'see the QA record', 100) + '.', true); }
  }
  function handle(ev) {
    const d = ev.data || {};
    if (ev.type === 'job.created') caption(d.line === 'research' ? 'A research batch starts on the research line' : 'New verified brief on the Room 1 line: ' + titleOf(ev.jobId));
    else if (ev.type === 'run.start') { target({ kind: 'desk', id: ev.agentKey }); caption(runCaption(ev)); }
    else if (ev.type === 'run.tool') {
      if (d.tool === 'image_generate' && d.refused === 'originality') caption('The originality screen refused an image prompt that names a protected character. No image was made.', true);
      else if (d.tool === 'submit_verdict' && d.verdict === 'approved') caption(name(ev.agentKey) + ' approved ' + (ev.agentKey === 'qa-listing' ? 'the listing' : 'the set'), true);
    } else if (ev.type === 'job.stage') stageCaption(ev);
    else if (ev.type === 'job.blocked') { const o = originality(d.reason); caption(titleOf(ev.jobId) + ' is blocked at ' + d.step + ': ' + (o ? 'the originality gate tripped again after the one retry (' + o + ')' : clip(d.reason, 100)) + '. It stops here, with its reason.', true); }
    else if (ev.type === 'job.queued-for-approval') { target({ kind: 'home' }); caption(titleOf(ev.jobId) + ' is packaged and in the approval queue, waiting for the owner\'s decision', true); }
    else if (ev.type === 'job.rejected') caption(name('rejects-desk') + ' recorded the refusal: ' + clip(d.reason, 110), true);
    else if (ev.type === 'job.stopped') caption('Stopped: ' + clip(d.reason, 120), true);
    else if (ev.type === 'halt.on') caption('E-STOP pressed: every model and image call is refused', true);
  }

  let lastPhase = null;
  function demoPhase(dm) {
    if (dm.phase === lastPhase) return;
    lastPhase = dm.phase;
    if (dm.phase === 'waiting' || (dm.phase === 'running' && !(snap.jobs || []).length)) caption(dm.label + ': a scripted day on the mock provider. No model is called and nothing is charged.');
    else if (dm.phase === 'done') { target({ kind: 'home' }); caption('Demo complete: one job waits in the approval queue, one is blocked by the originality gate. Press R to run the day again.', true); }
    else if (dm.phase === 'failed') caption('The demo stopped with an error: ' + clip(dm.error, 120), true);
  }

  return {
    onEvent(ev) { pending.push(ev); },
    onSnapshot(s) {
      snap = s;
      const seq = s.engine ? s.engine.seq : Infinity, later = [];
      for (const ev of pending.splice(0)) (ev.seq <= seq ? handle(ev) : later.push(ev));
      pending.push(...later);
      if (s.demo) demoPhase(s.demo);
      // a page opened mid-run: say who is working now, from the snapshot
      if (!text && !queue.length) { const w = s.agents.find((a) => a.status === 'working' && a.currentJob); if (w) { const j = job(w.currentJob.id); caption(w.name + ' is working on ' + (j ? j.title : w.currentJob.id) + ' · ' + w.currentJob.stageLabel + ' pass ' + (w.currentJob.pass || 1)); } }
      if (on && tour && !want && at === null) { const w = s.agents.find((a) => a.status === 'working'); target(w ? { kind: 'desk', id: w.id } : { kind: 'home' }); }
    },
    setOn(v) { on = !!v; office.view.ease = on ? 0.04 : 0.0005; if (!on) { clearTimeout(moveTimer); want = null; at = null; } render(); },
    setTour(v) { tour = !!v; if (!tour) { clearTimeout(moveTimer); want = null; } },
    setStatus(s) { status = s || ''; render(); },
    say: (t, important) => caption(t, important),
    isOn: () => on,
    caption: () => text
  };
}
