// lib/eng-records.mjs — R2 (RESTRUCTURE.md §2.2, §8 R2): the engineering line's records, checked by the engine. No model, no network.
//   issue        written by the owner (until R4: "the owner writes and approves issues directly"), on the page or with npm run owner -- issue;
//                data/products/<id>/backlog/issues/<issue-id>.md. Its decisions (approve, reject, withdraw, with the owner's words and the
//                issue's sha256) are appended to backlog/issue-decisions.jsonl; an issue is approved only while its latest decision is an
//                approval of the text as it is now (an edited issue is no longer approved)
//   dev queue    the CTO's order and assignments, backlog/dev-queue.json, checked when the CTO writes it: every issue in it must be
//                approved by the owner (the CTO cannot assign an issue the owner has not approved), once, in order 1..n
//   spec         TECH-LEAD's spec.md, checked when it is written: the sections, testable acceptance criteria AC1..ACn, and size small|large
//   verdicts     submit_verdict records for the engineering kinds: architecture (CTO), test (TESTER), review (REVIEWER), security (SECURITY)
// Another company's data never enters the Station (config/building.json foreignDataMarkers), and no secret is written in any of them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { secretContentHits } from './secrets.mjs';

export const ISSUE_ID_RE = /^\d{4}-\d{2}-\d{2}--[a-z0-9][a-z0-9-]{1,60}$/;
export const MODELS = ['default', 'opus'];
export const SPEC_SECTIONS = ['Problem', 'Scope', 'Out of scope', 'Acceptance criteria', 'Test plan', 'Files likely touched', 'Risk notes'];
export const ENG_VERDICT_KINDS = ['architecture', 'test', 'review', 'security'];
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const backlog = (dataRoot, productId) => path.join(dataRoot, 'products', productId, 'backlog');
export const issueFile = (dataRoot, productId, id) => path.join(backlog(dataRoot, productId), 'issues', id + '.md');
export const decisionsFile = (dataRoot, productId) => path.join(backlog(dataRoot, productId), 'issue-decisions.jsonl');
export const queueFile = (dataRoot, productId) => path.join(backlog(dataRoot, productId), 'dev-queue.json');
const slug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');

// ---- issues
// the owner's issue as a file -> { ok, id, text } | { ok: false, problems }
export function composeIssue({ title, problem, acceptance = '', notes = '', model = 'default', productId, day }) {
  const t = String(title || '').replace(/\s+/g, ' ').trim(), p = String(problem || '').replace(/\r\n/g, '\n').trim(), a = String(acceptance || '').replace(/\r\n/g, '\n').trim(), n = String(notes || '').replace(/\r\n/g, '\n').trim(), bad = [];
  if (t.length < 5 || t.length > 120) bad.push('a title of 5 to 120 characters');
  if (p.length < 20 || p.length > 6000) bad.push('the problem (what and why) in 20 to 6,000 characters');
  if (a.length > 4000 || n.length > 4000) bad.push('acceptance hints and notes under 4,000 characters each');
  if (!MODELS.includes(model)) bad.push('model "default" (the agents\' configured models) or "opus" (refused until Opus is priced from Anthropic\'s official page)');
  const s = slug(t); if (!s || s.length < 2) bad.push('a title with letters or digits');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) bad.push('the day');
  if (bad.length) return { ok: false, problems: bad };
  const id = day + '--' + s;
  const text = ['---', 'id: ' + id, 'product: ' + productId, 'title: ' + t, 'model: ' + model, 'by: owner', '---', '', '# ' + t, '', '## Problem', '', p, '', '## Acceptance hints', '', a || '(none: TECH-LEAD writes the acceptance criteria)', '', '## Notes', '', n || '(none)', ''].join('\n');
  return { ok: true, id, text };
}
// R2c: the page's issue form (what happens, what should happen, where, acceptance criteria) -> composeIssue's fields; the problem keeps
// the owner's three parts under their own labels
export function issueFromForm({ title, happens, should, where, acceptance = '', model = 'default' } = {}) {
  const part = (label, v) => { const t = String(v == null ? '' : v).replace(/\r\n/g, '\n').trim(); return t ? label + ':\n' + t : ''; };
  return { title, problem: [part('What happens', happens), part('What should happen', should), part('Where', where)].filter(Boolean).join('\n\n'), acceptance, model };
}
export function issueField(text, k) { const m = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(String(text || '').split(/\n---\n/)[0] || ''); return m ? m[1].trim() : null; }
export function readIssue(dataRoot, productId, id) {
  if (!ISSUE_ID_RE.test(String(id || ''))) return null;
  const f = issueFile(dataRoot, productId, id); if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  return { id, productId, text, sha256: sha256(text), title: issueField(text, 'title') || id, model: issueField(text, 'model') || 'default' };
}
export function readDecisions(dataRoot, productId) {
  const f = decisionsFile(dataRoot, productId); if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
// an issue's state from its latest decision: draft (none yet), approved (of this text), stale (approved, but the text changed), rejected, withdrawn
export function issueState(issue, decisions) {
  const d = decisions.filter((x) => x.issueId === issue.id).pop();
  if (!d) return { state: 'draft', decision: null };
  if (d.decision === 'approve') return d.sha256 === issue.sha256 ? { state: 'approved', decision: d } : { state: 'stale', decision: d };
  return { state: d.decision === 'reject' ? 'rejected' : 'withdrawn', decision: d };
}
export function listIssues(dataRoot, productId) {
  const dir = path.join(backlog(dataRoot, productId), 'issues'); if (!fs.existsSync(dir)) return [];
  const ds = readDecisions(dataRoot, productId);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => readIssue(dataRoot, productId, f.slice(0, -3))).filter(Boolean).map((i) => ({ ...i, ...issueState(i, ds) }));
}
export const isApproved = (dataRoot, productId, id) => { const i = readIssue(dataRoot, productId, id); return !!i && issueState(i, readDecisions(dataRoot, productId)).state === 'approved'; };

// ---- the CTO's dev queue: problems[] (empty: it may be written)
export function devQueueProblems(text, { dataRoot, productId }) {
  let q; try { q = JSON.parse(text); } catch (e) { return ['dev-queue.json is not valid JSON: ' + e.message]; }
  const bad = [];
  if (!q || typeof q !== 'object' || Array.isArray(q)) return ['dev-queue.json must be an object: { "product", "queue": [ { "issue", "order", "size", "note" } ], "notes" }'];
  if (q.product !== productId) bad.push('"product" must be "' + productId + '"');
  if (!Array.isArray(q.queue)) return [...bad, '"queue" must be a list (empty when no issue is approved)'];
  const seen = new Set();
  q.queue.forEach((x, i) => {
    const at = 'queue[' + i + ']';
    if (!x || typeof x !== 'object') { bad.push(at + ' must be an object'); return; }
    if (!ISSUE_ID_RE.test(String(x.issue || ''))) { bad.push(at + '.issue must be an issue id (YYYY-MM-DD--slug)'); return; }
    if (seen.has(x.issue)) bad.push(at + ': ' + x.issue + ' is in the queue twice'); seen.add(x.issue);
    const iss = readIssue(dataRoot, productId, x.issue);
    if (!iss) bad.push(at + ': there is no issue ' + x.issue);
    else { const st = issueState(iss, readDecisions(dataRoot, productId)).state; if (st !== 'approved') bad.push(at + ': ' + x.issue + ' is ' + st + ', not approved by the owner: the CTO assigns only owner-approved issues'); }
    if (x.order !== i + 1) bad.push(at + '.order must be ' + (i + 1) + ' (the queue is in order)');
    if (!['small', 'large'].includes(x.size)) bad.push(at + '.size must be "small" or "large" (the CTO\'s estimate; TECH-LEAD\'s spec sets the size that counts)');
    if (x.note != null && (typeof x.note !== 'string' || x.note.length > 500)) bad.push(at + '.note must be text under 500 characters');
  });
  if (q.notes != null && (typeof q.notes !== 'string' || q.notes.length > 2000)) bad.push('"notes" must be text under 2,000 characters');
  return bad;
}
export function readQueue(dataRoot, productId) { try { return JSON.parse(fs.readFileSync(queueFile(dataRoot, productId), 'utf8')); } catch (_) { return null; } }

// ---- TECH-LEAD's spec: { ok, problems, size, criteria: ['AC1', …] }
export function checkSpec(text) {
  const t = String(text || '').replace(/\r\n/g, '\n'), bad = [];
  const heads = [...t.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].toLowerCase());
  for (const s of SPEC_SECTIONS) if (!heads.includes(s.toLowerCase())) bad.push('the section "## ' + s + '" is missing');
  const sz = /^size:\s*(small|large)\s*$/im.exec(t); if (!sz) bad.push('a line "size: small" or "size: large"');
  const sec = (name) => { const m = new RegExp('^##\\s+' + name.replace(/ /g, '\\s+') + '\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))', 'im').exec(t); return m ? m[1] : ''; };
  const criteria = [...sec('Acceptance criteria').matchAll(/^\s*[-*]?\s*\**(AC\d+)\**\s*[:.)]/gm)].map((m) => m[1]);
  if (!criteria.length) bad.push('acceptance criteria as testable statements, one per line, each starting "AC1:", "AC2:" …');
  const dup = criteria.filter((c, i) => criteria.indexOf(c) !== i); if (dup.length) bad.push('acceptance criteria numbered twice: ' + [...new Set(dup)].join(', '));
  if (!sec('Test plan').trim()) bad.push('a test plan');
  if (t.length > 40000) bad.push('a spec under 40,000 characters');
  return { ok: !bad.length, problems: bad, size: sz ? sz[1].toLowerCase() : null, criteria };
}

// ---- engineering verdicts (submit_verdict): the record, checked -> the record as recorded, or throws with every problem
const FINDING_KEYS = ['file', 'line', 'text', 'severity', 'criterion'];
function findings(r, { need = false, fileNeeded = false } = {}, bad) {
  if (r.findings == null) r.findings = [];
  if (!Array.isArray(r.findings)) { bad.push('findings must be a list of { file, line, text, severity }'); return; }
  if (need && !r.findings.length) bad.push('a ' + r.verdict + ' needs at least one finding the DEVELOPER can act on');
  r.findings.forEach((f, i) => {
    if (!f || typeof f !== 'object') { bad.push('findings[' + i + '] must be an object'); return; }
    for (const k of Object.keys(f)) if (!FINDING_KEYS.includes(k)) bad.push('findings[' + i + '] has an unknown field "' + k + '"');
    if (typeof f.text !== 'string' || f.text.trim().length < 5 || f.text.length > 2000) bad.push('findings[' + i + '].text must say what is wrong (5 to 2,000 characters)');
    if (fileNeeded && (typeof f.file !== 'string' || !f.file)) bad.push('findings[' + i + '].file is required (the file the finding is about)');
    if (f.file != null && (typeof f.file !== 'string' || /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-z]:/i.test(f.file))) bad.push('findings[' + i + '].file must be a path relative to the repo');
    if (f.line != null && !(Number.isInteger(f.line) && f.line > 0)) bad.push('findings[' + i + '].line must be a line number');
    if (f.severity != null && !['blocker', 'major', 'minor', 'note'].includes(f.severity)) bad.push('findings[' + i + '].severity must be blocker, major, minor or note');
  });
}
// kind: architecture | test | review | security; ctx: { checks: names the checks step ran, criteria: the spec's AC ids, dependencyFiles: changed dependency files }
export function validateEngVerdict(record, kind, ctx = {}) {
  const r = record && typeof record === 'object' && !Array.isArray(record) ? JSON.parse(JSON.stringify(record)) : null, bad = [];
  if (!r) throw new Error('record must be an object (the verdict schema in your orders)');
  if (r.kind !== kind) bad.push('kind must be "' + kind + '"');
  if (kind === 'architecture') {
    if (!['approve', 'revise'].includes(r.verdict)) bad.push('verdict must be "approve" or "revise"');
    findings(r, { need: r.verdict === 'revise' }, bad);
  } else if (kind === 'test') {
    if (!['pass', 'fail'].includes(r.verdict)) bad.push('verdict must be "pass" or "fail"');
    const want = ctx.checks || [], crit = ctx.criteria || [];
    if (!r.checks || typeof r.checks !== 'object' || Array.isArray(r.checks)) bad.push('checks must be an object: check name -> "pass" or "fail"');
    else { for (const c of want) if (!['pass', 'fail'].includes(r.checks[c])) bad.push('checks.' + c + ' must be "pass" or "fail" (the checks step ran it)'); for (const k of Object.keys(r.checks)) if (!want.includes(k)) bad.push('checks.' + k + ' was not run by the checks step (' + (want.join(', ') || 'none') + ')'); }
    if (!r.criteria || typeof r.criteria !== 'object' || Array.isArray(r.criteria)) bad.push('criteria must be an object: AC id -> "pass", "fail" or "not-covered"');
    else { for (const c of crit) if (!['pass', 'fail', 'not-covered'].includes(r.criteria[c])) bad.push('criteria.' + c + ' must be "pass", "fail" or "not-covered"'); for (const k of Object.keys(r.criteria)) if (!crit.includes(k)) bad.push('criteria.' + k + ' is not an acceptance criterion of the spec (' + (crit.join(', ') || 'none') + ')'); }
    const anyFail = (r.checks && Object.values(r.checks).some((v) => v !== 'pass')) || (r.criteria && Object.values(r.criteria).some((v) => v !== 'pass'));
    if (r.verdict === 'pass' && anyFail) bad.push('a pass needs every check and every acceptance criterion to pass');
    findings(r, { need: r.verdict === 'fail' }, bad);
  } else if (kind === 'review' || kind === 'security') {
    if (!['approve', 'revise', 'refuse'].includes(r.verdict)) bad.push('verdict must be "approve", "revise" or "refuse"');
    findings(r, { need: r.verdict !== 'approve', fileNeeded: r.verdict !== 'approve' }, bad);
    if (kind === 'security' && (ctx.dependencyFiles || []).length && !['approve', 'revise', 'refuse'].includes(r.dependencyVerdict)) bad.push('dependencyVerdict ("approve", "revise" or "refuse") is required: the diff changes ' + ctx.dependencyFiles.join(', '));
    if (kind === 'security' && r.verdict === 'approve' && r.dependencyVerdict && r.dependencyVerdict !== 'approve') bad.push('an approve with a dependencyVerdict of ' + r.dependencyVerdict + ' is not an approve: use revise or refuse');
  } else bad.push('unknown verdict kind ' + kind);
  if (r.summary != null && (typeof r.summary !== 'string' || r.summary.length > 2000)) bad.push('summary must be text under 2,000 characters');
  const sh = secretContentHits(JSON.stringify(r)); if (sh.length) bad.push('the record holds what looks like a secret (' + sh.join(', ') + '): name the file and line, never the value');
  if (bad.length) throw Object.assign(new Error('verdict refused: ' + bad.join('; ') + '. Fix it and call submit_verdict again.'), { problems: bad });
  return r;
}
