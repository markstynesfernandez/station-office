// halt.mjs — the e-stop (ENGINE-PLAN.md §5.5). Three ways in, one state:
//   - the red button in the office (POST /api/engine/halt)
//   - `npm run estop` (writes data/HALT and data/halt.json directly, so it works when the page or the server is stuck)
//   - creating data/HALT by hand (checked before every paid call and polled every second)
// Effect: every in-flight call is aborted through the shared AbortSignal, the scheduler stops, the guard refuses every
// new call, in-flight jobs go to `stopped`. The state is persisted in data/halt.json, so it survives a restart.
// Resume is a separate, explicit action with a typed confirmation; stopped jobs are never resumed automatically.
import fs from 'node:fs';
import path from 'node:path';

export const RESUME_WORD = 'RESUME';
export const haltFiles = (dataRoot) => ({ flag: path.join(dataRoot, 'HALT'), state: path.join(dataRoot, 'halt.json') });

// used by the CLI and by the engine: press or release without a running engine (file level only)
export function writeHaltFiles(J, { halted, by, reason }) {
  const f = haltFiles(J.dataRoot);
  const rec = { halted: !!halted, at: Date.now(), by: by || 'unknown', reason: reason || '' };
  J.put(f.state, JSON.stringify(rec, null, 1) + '\n', { fsync: true });
  if (halted) J.put(f.flag, 'halted by ' + rec.by + ' at ' + new Date(rec.at).toISOString() + (reason ? ': ' + reason : '') + '\n', { fsync: true });
  else if (fs.existsSync(f.flag)) J.remove(f.flag);
  return rec;
}

export function readHaltState(dataRoot) {
  const f = haltFiles(dataRoot);
  let rec = { halted: false };
  try { rec = JSON.parse(fs.readFileSync(f.state, 'utf8')); } catch (_) { /* never pressed */ }
  if (fs.existsSync(f.flag)) return { ...rec, halted: true, viaFile: true };
  return rec;
}

export function createHalt({ J, bus, log, pollMs = 1000 }) {
  let ctl = new AbortController();
  let state = readHaltState(J.dataRoot);
  if (state.halted) ctl.abort(new Error('e-stop is on'));
  const listeners = new Set();
  function fire(rec) {
    state = rec;
    if (!ctl.signal.aborted) ctl.abort(Object.assign(new Error('e-stop pressed'), { code: 'HALT' }));
    log && log.warn('E-STOP ON', { by: rec.by, reason: rec.reason, viaFile: !!rec.viaFile });
    bus && bus.emit('halt.on', { data: { by: rec.by, reason: rec.reason, at: rec.at, viaFile: !!rec.viaFile } });
    for (const fn of listeners) { try { fn(true, rec); } catch (e) { log && log.error('halt listener failed', { error: e.message }); } }
  }
  // the poll notices data/HALT (or a CLI press) while a call is in flight, and a CLI release
  const timer = setInterval(() => {
    const now = readHaltState(J.dataRoot);
    if (now.halted && !state.halted) fire({ ...now, by: now.by || 'HALT file' });
    else if (!now.halted && state.halted && !now.viaFile) { state = now; ctl = new AbortController(); log && log.info('E-STOP OFF (released outside the page)', { by: now.by }); bus && bus.emit('halt.off', { data: { by: now.by, at: now.at } }); for (const fn of listeners) fn(false, now); }
  }, pollMs);
  timer.unref();

  return {
    isHalted: () => state.halted || fs.existsSync(haltFiles(J.dataRoot).flag),
    get state() { return state; },
    get signal() { return ctl.signal; },
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    press({ by = 'owner', reason = '' } = {}) { if (state.halted && ctl.signal.aborted) return state; const rec = writeHaltFiles(J, { halted: true, by, reason }); fire(rec); return rec; },
    resume({ by = 'owner', confirm } = {}) {
      if (confirm !== RESUME_WORD) { const e = new Error('type ' + RESUME_WORD + ' to resume'); e.code = 'CONFIRM'; throw e; }
      const rec = writeHaltFiles(J, { halted: false, by, reason: 'resumed' });
      state = rec; ctl = new AbortController();
      log && log.warn('E-STOP OFF', { by });
      bus && bus.emit('halt.off', { data: { by, at: rec.at } });
      for (const fn of listeners) fn(false, rec);
      return rec;
    },
    close: () => clearInterval(timer)
  };
}
