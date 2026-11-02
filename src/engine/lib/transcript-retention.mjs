// lib/transcript-retention.mjs — the retention rule for job transcripts (owner decision 5, 17/10/2026; DECISIONS.md
// "E6 step b2: owner decisions, part 2"). A scout job's transcript (data/jobs/<id>/transcript.jsonl) is the evidence for
// every genre brief that cites it (the brief's station citation record names the job, and intake re-checks the
// citations against that transcript), so retention follows the briefs:
//   - never delete a transcript while ANY brief citing it is open
//   - once all its briefs are closed (published, rejected or archived), it may be cleaned up 90 days after the last of
//     them closed (and after its own job ended)
// No cleanup runs today (nothing deletes transcripts); any cleanup must go through cleanupTranscripts(), which applies
// the rule and refuses outright to delete a transcript an open brief cites. Station code, no model; deletions go
// through the data jail and are logged.
import fs from 'node:fs';
import path from 'node:path';
import { STATION_CITATIONS_RE } from './scout-brief.mjs';

export const TRANSCRIPT_KEEP_DAYS = 90;
export const CLOSED = ['published', 'rejected', 'rejected_by_owner', 'archived'];
export class RetentionRefusal extends Error { constructor(msg) { super(msg); this.code = 'RETENTION'; } }

const citedJob = (t) => ([...String(t || '').matchAll(new RegExp(STATION_CITATIONS_RE.source, 'gm'))].pop() || [])[2] || null;
const mds = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')) : []);

// the state of a line job as the owner sees it (an approval row's decision wins), and when it closed
function jobClose(store, j) {
  const a = j.state === 'approval' && store.getApproval ? store.getApproval(j.id) : null;
  const st = a && ['published', 'rejected_by_owner'].includes(a.status) ? a.status : j.state;
  const at = st === 'published' ? a.published_at || a.decided_at : st === 'rejected_by_owner' ? a.decided_at : st === 'archived' ? (j.data && j.data.archivedAt) || j.ended_at : j.ended_at;
  return { state: st, closedAt: CLOSED.includes(st) ? Number(at) || null : null };
}

// every brief that cites a job's transcript: { brief, where, state, open, closedAt }
export function briefsCiting({ dataRoot, store }) {
  const out = new Map(), add = (jid, rec) => { if (!jid) return; if (!out.has(jid)) out.set(jid, []); out.get(jid).push(rec); };
  const rdir = path.join(dataRoot, 'research'), jdir = path.join(dataRoot, 'jobs');
  // briefs that became jobs: the job's state decides
  const jobIds = new Set();
  for (const id of fs.existsSync(jdir) ? fs.readdirSync(jdir) : []) {
    const f = path.join(jdir, id, 'brief.md'); if (!fs.existsSync(f)) continue;
    jobIds.add(id);
    const j = store.getJob(id), c = j ? jobClose(store, j) : { state: 'unknown', closedAt: null };
    add(citedJob(fs.readFileSync(f, 'utf8')), { brief: id, where: 'jobs/' + id + '/brief.md', state: c.state, open: !CLOSED.includes(c.state), closedAt: c.closedAt });
  }
  // verified briefs not yet taken in: open
  for (const f of mds(path.join(rdir, 'briefs'))) { const id = f.replace(/\.md$/, ''); if (jobIds.has(id)) continue; add(citedJob(fs.readFileSync(path.join(rdir, 'briefs', f), 'utf8')), { brief: id, where: 'research/briefs/' + f, state: 'verified', open: true, closedAt: null }); }
  // rejected briefs: closed when the file was written
  for (const f of mds(path.join(rdir, 'rejected'))) { const p = path.join(rdir, 'rejected', f); add(citedJob(fs.readFileSync(p, 'utf8')), { brief: f.replace(/\.md$/, ''), where: 'research/rejected/' + f, state: 'rejected', open: false, closedAt: fs.statSync(p).mtimeMs }); }
  return out;
}

// -> [{ jobId, file, citedBy, decision: 'keep' | 'delete', reason }]. apply: delete what the rule allows (logged).
// only: one job's transcript; if an open brief cites it, a RetentionRefusal is thrown (nothing is deleted).
export function cleanupTranscripts({ J, store, now = Date.now(), apply = false, only = null, log = null, keepDays = TRANSCRIPT_KEEP_DAYS }) {
  const dataRoot = J.dataRoot, jdir = path.join(dataRoot, 'jobs'), citing = briefsCiting({ dataRoot, store }), out = [];
  const ids = (fs.existsSync(jdir) ? fs.readdirSync(jdir) : []).filter((id) => fs.existsSync(path.join(jdir, id, 'transcript.jsonl')) && (!only || id === only));
  for (const id of ids) {
    const file = path.join(jdir, id, 'transcript.jsonl'), citedBy = citing.get(id) || [], own = store.getJob(id);
    const open = citedBy.filter((b) => b.open);
    let decision = 'keep', reason;
    if (open.length) reason = 'cited by ' + open.length + ' open brief(s): ' + open.map((b) => b.brief + ' (' + b.state + ')').join(', ');
    else if (!own || !own.ended_at) reason = 'its own job has not ended';
    else {
      const last = Math.max(Number(own.ended_at) || 0, ...citedBy.map((b) => b.closedAt || 0)), age = (now - last) / 86400000;
      if (citedBy.some((b) => !b.closedAt)) reason = 'a closed brief has no closing time (kept: fails closed)';
      else if (age <= keepDays) reason = 'all briefs closed; ' + Math.floor(age) + ' of ' + keepDays + ' days since the last closed';
      else { decision = 'delete'; reason = 'all ' + citedBy.length + ' citing brief(s) closed more than ' + keepDays + ' days ago'; }
    }
    if (only && open.length) throw new RetentionRefusal('transcript of ' + id + ' not deleted: ' + reason);
    if (apply && decision === 'delete') { J.remove(file); log && log.info('job transcript deleted (retention)', { jobId: id, reason }); }
    out.push({ jobId: id, file: 'jobs/' + id + '/transcript.jsonl', citedBy, decision, reason });
  }
  return out;
}
