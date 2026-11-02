// roster.mjs — hero / active-agent helpers.
// Source: Virtual-workers/station/scripts/lib/retire-bridge.mjs (owner-written). Copied: HERO_ID, rosterList, isHero,
// activeAgents. NOT copied: retireBridge (writes the save and the roster).
export const HERO_ID = 'agent';
export const rosterList = (r) => (Array.isArray(r) ? r : (r.agents || r.roster || []));
export const isHero = (a) => a && (a.id === HERO_ID || a.agentId === HERO_ID);
export const activeAgents = (list) => (list || []).filter((a) => !isHero(a));
