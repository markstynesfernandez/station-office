// lib/eng-gates.mjs — R2 (RESTRUCTURE.md §5.3, §5.5): the mechanical gates on an engineering diff. Built in, no new dependency, no model.
//   secrets       every added line of the diff is scanned with the secret patterns (lib/secrets.mjs) and every changed path with the secret
//                 path rules: any hit refuses the commit (the job blocks with the file and the kind, never the value)
//   dependencies  a change to a dependency or lock file (requirements*.txt, pyproject.toml, package.json, a lockfile …) is not refused: it
//                 becomes a dependency.add request in the Owner's office with SECURITY's dependency verdict on the card (deps.patch)
//   ci            a change under .github/workflows/ becomes a ci.change request (the owner's)
// SECURITY's audit is a second, judgement layer on top of these gates, not a replacement for them.
import { secretContentHits, secretPathHit } from './secrets.mjs';

export const DEPENDENCY_FILES = [/(^|\/)requirements[^/]*\.txt$/i, /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|Pipfile\.lock|poetry\.lock|uv\.lock)$/i, /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i];
export const WORKFLOW_RE = /^\.github\/workflows\//i;

// a unified diff split per file -> [{ path, text }] (the "b/" side; a deletion keeps its "a/" path)
export function splitPatch(patch) {
  const out = [], parts = String(patch || '').split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  for (const p of parts) { const m = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(p); out.push({ path: m ? (m[2] || m[1]) : '?', text: p }); }
  return out;
}

// the gates -> { secrets: [{ path, kind }], dependencyFiles: [], workflowFiles: [], depsPatch, workflowPatch, ok (no secret) }
export function gateDiff({ patch, files }) {
  const secrets = [];
  for (const f of files || []) { for (const p of [f.path, f.from].filter(Boolean)) { const k = secretPathHit(p); if (k) secrets.push({ path: p, kind: k }); } }
  for (const { path: p, text } of splitPatch(patch)) {
    if (/^GIT binary patch$/m.test(text)) continue;   // a binary file's literal is not text; its path is checked above
    const added = text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
    for (const k of secretContentHits(added)) secrets.push({ path: p, kind: k });
  }
  const changed = (files || []).flatMap((f) => [f.path, f.from].filter(Boolean));
  const dependencyFiles = [...new Set(changed.filter((p) => DEPENDENCY_FILES.some((re) => re.test(p))))];
  const workflowFiles = [...new Set(changed.filter((p) => WORKFLOW_RE.test(p)))];
  const pick = (set) => splitPatch(patch).filter((x) => set.includes(x.path)).map((x) => x.text).join('');
  return { ok: !secrets.length, secrets, dependencyFiles, workflowFiles, depsPatch: dependencyFiles.length ? pick(dependencyFiles) : '', workflowPatch: workflowFiles.length ? pick(workflowFiles) : '' };
}
