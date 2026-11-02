// ui/role.js — the role line the page shows for an agent (Redesign R2). Shared by the server (model.mjs,
// engine-model.mjs: the snapshot never carries prompt-like text) and the page (sidepanel.js: a second guard).
// A role that reads like a prompt (starts with "You are", or is longer than ROLE_MAX characters) is never shown: the
// page gets a short label instead, the department plus what the agent does, taken from the agent's name
// (DEMAND-RESEARCHER -> "Research · demand researcher"). Pure: no I/O.
export const ROLE_MAX = 80;

export function looksLikePrompt(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return /^you\s+are\b/i.test(t) || t.length > ROLE_MAX;
}

// "QA-DESIGN" -> "QA design", "STATION-OVERSEER" -> "station overseer" (short words such as QA stay in capitals)
export function dutyFromName(name) {
  return String(name || 'agent').split(/[-_\s]+/).filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w.toLowerCase())).join(' ');
}

export function roleLabel(role, { dept = null, name = null } = {}) {
  const t = String(role || '').replace(/\s+/g, ' ').trim();
  if (t && !looksLikePrompt(t)) return t;
  return [dept, dutyFromName(name)].filter(Boolean).join(' · ');
}
