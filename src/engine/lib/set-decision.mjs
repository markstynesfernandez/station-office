// lib/set-decision.mjs — W4 (owner, 21/10/2026): whether the job panel may offer "Approve set-vN…" and "Reject set-vN…", and if not, why in
// one line. The set is the one the last QA DESIGN pass reviewed (a QA-only run on an older set makes that set the one to decide), else the
// newest set. The buttons are offered only when the set is built and an owner set approval would be accepted on the points the page cannot
// supply: the pass limit (or the post-fix rule), the last verdict not "approved", no limit problems or build warnings, originality clear for
// the current design.md. The owner's decision on every file and the owner's words come with the approval itself, and owner.approveSet
// still composes and checks the whole record (lib/owner-approval.mjs). Pure reads.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './common.mjs';
import { designPasses, readJsonSafe } from './gates.mjs';
import { postFixProblems, POST_FIX } from './owner-approval.mjs';

const setOf = (designFile) => Number((/set-v(\d+)\/deliverables\.json$/.exec(String(designFile || '')) || [])[1]) || null;

// a set is built when the station measured it (deliverables.json) with every file of the spec in raw/ -> { ok, have }
function builtState(sd, total) {
  const have = fs.existsSync(path.join(sd, 'raw')) ? fs.readdirSync(path.join(sd, 'raw')).filter((f) => /^\d{2}-.*\.png$/i.test(f)).length : 0;
  return { ok: fs.existsSync(path.join(sd, 'deliverables.json')) && (!total || have >= total), have };
}

// -> { set, ok, rule, reviewedPreviews, note } (note: one line, null when the buttons are offered with nothing to add)
export function setDecisionState({ roomDir, id, newest, total = null, maxDesignPasses = 3 }) {
  const workDir = path.join(roomDir, 'jobs', id), passes = designPasses(workDir), last = passes[passes.length - 1];
  const lastRec = last && last.rec.ok ? last.rec.v : null, reviewed = lastRec ? setOf(lastRec.designFile) : null;
  const n = reviewed || newest || null, notes = [], of = (b) => b.have + ' of ' + (total || '?') + ' files';
  if (!n) return { set: null, ok: false, rule: null, reviewedPreviews: [], note: 'no set yet' };
  // a newer set than the one QA DESIGN last reviewed: said first, so the owner sees why its buttons are not offered
  if (newest && newest !== n) {
    const b = builtState(path.join(workDir, 'set-v' + newest), total);
    notes.push(b.ok ? 'set-v' + newest + ' is built but has no QA DESIGN pass' : 'set-v' + newest + ' is not built: ' + of(b));
  }
  const sd = path.join(workDir, 'set-v' + n), b = builtState(sd, total), problems = [];
  let rule = null, reviewedPreviews = [];
  if (!b.ok) problems.push('set-v' + n + ' is not built: ' + of(b));
  else if (!lastRec) problems.push('set-v' + n + ' has no QA DESIGN pass yet');
  else if (lastRec.verdict === 'approved') problems.push('QA DESIGN approved set-v' + n + ' (pass ' + last.n + '): no set approval is needed');
  else {
    if (passes.length > maxDesignPasses) problems.push('set-v' + n + ': ' + passes.length + ' design passes are past the limit ' + maxDesignPasses);
    else if (passes.length < maxDesignPasses) {
      // the post-fix rule: a $0 region fix of build-check findings, rebuilt; the owner lists the after previews when approving (d)
      const ed = readJsonSafe(path.join(sd, 'edits.json')), edits = ed.ok && Array.isArray(ed.v.edits) ? ed.v.edits : [];
      const previews = edits.map((e) => 'set-v' + n + '/review-after/' + String(e.file || '').replace(/^raw\//, '').replace(/\.png$/i, '') + '.preview.json');
      const pf = edits.length ? postFixProblems({ roomDir, id, n, last, sa: { reviewedPreviews: previews }, maxDesignPasses }) : ['no fix'];
      if (pf.length) problems.push('set-v' + n + ': your set approval stands in for QA DESIGN only at the pass limit (' + passes.length + ' of ' + maxDesignPasses + ' passes) or after a post-fix');
      else { rule = POST_FIX; reviewedPreviews = previews; }
    }
    const m = readJsonSafe(path.join(sd, 'deliverables.json'));
    if (m.ok && ((m.v.limitProblems || []).length || (m.v.buildWarnings || []).length)) problems.push('set-v' + n + ' has ' + [(m.v.limitProblems || []).length ? 'limit problems' : '', (m.v.buildWarnings || []).length ? 'build warnings' : ''].filter(Boolean).join(' and ') + ': never overridden');
    const dm = path.join(sd, 'design.md'), og = readJsonSafe(path.join(sd, 'originality.json'));
    if (!fs.existsSync(dm) || !og.ok || og.v.designNotesSha256 !== sha256(fs.readFileSync(dm, 'utf8'))) problems.push('set-v' + n + ': its originality record is missing or for an older design.md (rebuild it)');
    else if (og.v.result !== 'clear') problems.push('set-v' + n + ': originality is not clear: never overridden');
  }
  notes.push(...problems);
  return { set: n, ok: !problems.length, rule, reviewedPreviews, note: notes.join('; ') || null };
}
