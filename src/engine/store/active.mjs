// active.mjs — the data jail of the running engine, for the modules ported from the owner's station code. Their few
// file writes call dataJail() from here, so every write they make is checked against the engine's data root exactly
// like the engine's own. The engine sets it at start (useJail); without one, every write is refused.
let active = null;
export function useJail(J) { active = J; }
export function activeJail() { return active; }
export function dataJail(p, opts) { if (!active) { const e = new Error('no data jail is active: refusing to write ' + p); e.code = 'JAIL'; throw e; } return active.dataJail(p, opts); }
