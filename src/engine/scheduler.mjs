// scheduler.mjs — routines (ENGINE-PLAN.md §5.4). A routine is { name, target (a line or an agent), input, schedule
// (5-field cron, Europe/Dublin), enabled, maxRunsPerDay, perRunCapUsd }. Routines are created disabled; enabling one in
// the office is the only approval, after which it runs unattended within the caps. Before each fire the scheduler
// checks: e-stop off, the day cap not reached, maxRunsPerDay not reached, the previous fire finished; otherwise it
// records routine.skip with the reason. Fires missed while the engine was off are logged and skipped, never replayed.
import { Cron } from 'croner';
import { TZ, dublinDay } from './time.mjs';

// pure: may this routine fire now? -> { ok: true } | { ok: false, reason }
export function fireDecision({ routine, halted, spentToday, perDayUsd, firesToday, running, held = null }) {
  if (!routine.enabled) return { ok: false, reason: 'routine is disabled' };
  if (halted) return { ok: false, reason: 'e-stop is on' };
  if (held) return { ok: false, reason: held };
  if (perDayUsd > 0 && spentToday >= perDayUsd) return { ok: false, reason: 'station day cap reached (' + spentToday.toFixed(2) + ' of ' + perDayUsd.toFixed(2) + ')' };
  if (firesToday >= (routine.max_runs_per_day ?? 1)) return { ok: false, reason: 'maxRunsPerDay reached (' + firesToday + ')' };
  if (running) return { ok: false, reason: 'the previous fire of this routine has not finished' };
  return { ok: true };
}

// pure: how many scheduled fires fell between lastFireAt and now (for the "missed while off" log line)
export function missedFires(schedule, lastFireAt, now, { cap = 100 } = {}) {
  if (!lastFireAt) return 0;
  const c = new Cron(schedule, { timezone: TZ, paused: true, startAt: new Date(lastFireAt + 1000) });
  let n = 0, t = c.nextRun(new Date(lastFireAt + 1000));
  while (t && t.getTime() < now && n < cap) { n++; t = c.nextRun(t); }
  c.stop();
  return n;
}

export const validSchedule = (expr) => { try { const c = new Cron(expr, { timezone: TZ, paused: true }); c.stop(); return String(expr).trim().split(/\s+/).length === 5; } catch (_) { return false; } };
export const nextRuns = (expr, n = 5, from = new Date()) => { try { const c = new Cron(expr, { timezone: TZ, paused: true }); const out = c.nextRuns(n, from).map((d) => d.getTime()); c.stop(); return out; } catch (_) { return []; } };

// hold(routine) -> a reason to skip or null (E5: the line's first agent is off duty)
// locked (L3, owner 21/10/2026): an engine opened by a script (script-engine.mjs): the scheduler never starts (an e-stop release
// included) and a routine never fires; the reason is logged
export function createScheduler({ store, halt, ledger, caps, bus, log, run, clock = Date.now, hold = () => null, locked = null }) {
  const jobs = new Map(), running = new Set();
  let started = false;
  const firesKey = (id) => 'fires:' + id + ':' + dublinDay(clock());
  const firesToday = (routine) => store.meta.get(firesKey(routine.id)) || 0;

  async function fire(routine) {
    if (locked) { log.warn('routine not fired: the scheduler is locked', { id: routine.id, locked }); return { skipped: 'the scheduler is locked (' + locked + ')' }; }
    const cur = store.getRoutine(routine.id) || routine;
    const d = fireDecision({ routine: cur, halted: halt.isHalted(), spentToday: ledger.spent.day(dublinDay(clock())), perDayUsd: caps.perDayUsd, firesToday: firesToday(cur), running: running.has(cur.id), held: hold(cur) });
    if (!d.ok) { store.markRoutineFire(cur.id, 'skipped: ' + d.reason); log.info('routine skipped', { id: cur.id, reason: d.reason }); bus.emit('routine.skip', { data: { routineId: cur.id, name: cur.name, reason: d.reason } }); return { skipped: d.reason }; }
    running.add(cur.id);
    store.meta.set(firesKey(cur.id), firesToday(cur) + 1);
    store.markRoutineFire(cur.id, 'fired');
    bus.emit('routine.fire', { data: { routineId: cur.id, name: cur.name, target: cur.target } });
    log.info('routine fired', { id: cur.id, target: cur.target });
    try {
      const out = await run(cur);
      if (out && out.skipped) { store.markRoutineFire(cur.id, 'skipped: ' + out.skipped); log.info('routine fired, nothing to do', { id: cur.id, reason: out.skipped }); bus.emit('routine.skip', { data: { routineId: cur.id, name: cur.name, reason: out.skipped } }); return out; }
      store.markRoutineFire(cur.id, 'done'); return out;
    }
    catch (e) { store.markRoutineFire(cur.id, 'failed: ' + e.message); log.error('routine run failed', { id: cur.id, error: e.message }); return { error: e.message }; }
    finally { running.delete(cur.id); }
  }

  function arm(routine) {
    disarm(routine.id);
    if (!routine.enabled || halt.isHalted()) return;
    const missed = missedFires(routine.schedule, routine.last_fire_at, clock());
    if (missed) { log.warn('routine fires missed while the engine was off were skipped, not replayed', { id: routine.id, missed }); bus.emit('routine.skip', { data: { routineId: routine.id, name: routine.name, reason: missed + ' fire(s) missed while the engine was off; not replayed' } }); }
    jobs.set(routine.id, new Cron(routine.schedule, { timezone: TZ, protect: true, catch: (e) => log.error('routine timer error', { id: routine.id, error: String(e) }) }, () => fire(store.getRoutine(routine.id) || routine)));
  }
  function disarm(id) { const c = jobs.get(id); if (c) { c.stop(); jobs.delete(id); } }

  function start() { if (locked) { log.info('scheduler not started: locked', { locked }); return; } if (halt.isHalted()) { log.warn('scheduler not started: e-stop is on'); return; } started = true; for (const r of store.listRoutines()) arm(r); log.info('scheduler started', { routines: store.listRoutines().length, armed: jobs.size }); }
  function stop() { for (const id of [...jobs.keys()]) disarm(id); started = false; log.info('scheduler stopped'); }
  halt.onChange((on) => { if (on) stop(); else start(); });

  return { start, stop, fire, refresh: (id) => { const r = store.getRoutine(id); if (r && started) arm(r); else disarm(id); }, armed: () => [...jobs.keys()], get started() { return started; }, get locked() { return locked; } };
}
