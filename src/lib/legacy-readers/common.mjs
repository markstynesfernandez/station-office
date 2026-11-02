// common.mjs — pure helpers copied from the owner's own station code.
// Source: Virtual-workers/station/scripts/lib/common.mjs (owner-written; MIT-free, no third-party code).
// Copied: readJson, today, LISTING_ID_RE, isListingId, loadEnv (re-rooted to office-agents' own .env).
// NOT copied on purpose: api() (can POST), makeLogger (writes under station-workspace), writeIfChanged, sha256File.
import fs from 'node:fs';
import path from 'node:path';

// Load an .env file without overriding variables already set in the shell. Returns true when the file existed.
export function loadEnv(file) {
  if (!file || !fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// Tolerant variant for the office: { ok, v } or { ok:false, err } instead of throwing (the viewer must never crash on a torn file).
export function readJsonSafe(file) {
  try { return { ok: true, v: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { ok: false, err: fs.existsSync(file) ? 'unreadable JSON' : 'missing' }; }
}

// Local calendar date (the owner's day), YYYY-MM-DD.
export function today(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}

export const LISTING_ID_RE = /^\d{4}-\d{2}-\d{2}--[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isListingId(id) { return typeof id === 'string' && id.length <= 60 && LISTING_ID_RE.test(id); }

// Station paths relative to a station root (the folder holding station/ and station-workspace/).
// Mirrors station.config.json "paths"; read from the config when present so a renamed folder still resolves.
export function stationPaths(root, config) {
  const p = (config && config.paths) || {};
  const j = (rel, fallback) => path.join(root, rel || fallback);
  return {
    root,
    station: path.join(root, 'station'),
    config: path.join(root, 'station', 'config', 'station.config.json'),
    workspace: j(p.workspace, 'station-workspace'),
    starnetData: j(p.starnetData, 'station-workspace/starnet'),
    ledger: j(p.ledger, 'station-workspace/starnet/ledger.jsonl'),
    researchLab: j(p.researchLab, 'station-workspace/research-lab'),
    briefs: j(p.briefsWatched, 'station-workspace/research-lab/briefs'),
    room1: j(p.room1, 'station-workspace/room1-etsy'),
    room1Work: j(p.room1Work, 'station-workspace/room1-etsy/work'),
    room1Outbox: j(p.room1Outbox, 'station-workspace/room1-etsy/outbox'),
    approvalQueue: j(p.approvalQueue, 'station-workspace/approval-queue'),
    rejected: path.join(root, 'station-workspace', 'rejected'),
    tracker: j(p.tracker, 'station-workspace/tracker/listings.csv'),
    overseer: j(p.overseer, 'station-workspace/overseer')
  };
}
