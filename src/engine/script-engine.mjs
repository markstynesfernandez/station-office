// script-engine.mjs — L3 (owner, 21/10/2026): every script that opens the engine (settle:failed, settle:images, the owner and line
// scripts, the dry runs, the demo, the screenshots) opens it through here, so no job can start from a script by itself:
//   - the scheduler is locked: it never starts, not even when the e-stop is released while the script runs, and no routine fires
//   - restart recovery marks interrupted jobs as usual but never starts them (the Station resumes them when it next starts)
//   - a maintenance script (startsJobs false: settle:failed, settle:images, owner-brief, blocklist hygiene, the live smoke test)
//     refuses every job start
//   - a script whose purpose is to run a job (startsJobs true: line:live, scout:live, the owner's run modes, the dry runs, the demo)
//     starts only the jobs it starts itself; a queued "next" job that the script did not start is never started when its job ends
// createEngine's startScheduler and resume cannot be turned back on from a script: they are set after the caller's options.
import { createEngine } from './engine.mjs';

export function openScriptEngine({ purpose, startsJobs = false, ...opts } = {}) {
  if (!purpose || typeof purpose !== 'string') throw new Error('openScriptEngine needs the script\'s purpose');
  return createEngine({ ...opts, startScheduler: false, resume: false, scriptRun: { purpose, startsJobs: startsJobs === true } });
}
