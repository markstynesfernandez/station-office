// lib/design-plan.mjs — design.md's plan comes from the CURRENT product spec and brief (owner, 18/10/2026; DECISIONS.md "E6 step c:
// design.md from the current spec and brief"). The bug it fixes: set-v1's DESIGNER wrote a note while products.json still described
// DESK-PROPS-01 ("files 11-12 are colour variants"); DESIGNER carried it into set-v2, the redraw copied set-v2's design.md into set-v4,
// and QA DESIGN read the stale note as the spec. Now:
//   stationPlan      the "## Station plan" section, written by the station from products.json (the format) and brief.md (the
//                    subjects: its numbered file list when it has one per spec file) at the time the set starts
//   withStationPlan  design.md with that section replaced (or inserted under the title): the station writes it into every set at prep,
//                    so the plan in design.md is never older than the spec and the brief the set was measured against
//   keptSections     a redraw-only set's design.md carries only the kept files' own "### NN-..." sections (prompt and analysis) from the
//                    earlier set, never its notes
// The DESIGNER is given the same plan at the start of each run (orchestrator), with the rule to carry no notes from an earlier set.
import { briefFileList } from './brief-files.mjs';

export const STATION_PLAN = '## Station plan';
const pad2 = (n) => String(n).padStart(2, '0');

export function stationPlan({ briefText, product }) {
  const files = ((product && product.deliverables && product.deliverables.files) || []), items = briefFileList(briefText);
  const pkg = product && product.deliverables && product.deliverables.package, fromBrief = items.length === files.length && files.length > 0;
  const lines = [STATION_PLAN + ' (written by the station from the current products.json and brief.md; it replaces any earlier plan or note about the spec)',
    'The product spec (' + ((product && product.key) || '?') + ') gives the FORMAT only: ' + files.length + ' file(s), ' + [...new Set(files.map((f) => f.format.toUpperCase() + ' ' + f.widthPx + 'x' + f.heightPx))].join(', ') + (product && product.transparent ? ', transparent' : '') + (pkg && pkg.kind === 'zip' ? ', delivered as one zip' : '') + '. Each file\'s SUBJECT comes from the brief.'];
  if (fromBrief) for (const [i, f] of files.entries()) lines.push('- ' + pad2(i + 1) + ': ' + items[i].text + ' (' + f.format + ' ' + f.widthPx + 'x' + f.heightPx + ')');
  else lines.push('- Subjects: as the brief\'s Design direction describes them (it does not number ' + files.length + ' files).');
  return lines.join('\n') + '\n';
}

// design.md with the station plan replaced or inserted (after a leading "# " title line); idempotent for the same plan
export function withStationPlan(md, plan) {
  const t = String(md || '').replace(/\r\n/g, '\n'), lines = t.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    // the station's section is one block of lines (the heading, the format line, the file list) ended by a blank line or a heading
    if (lines[i].startsWith(STATION_PLAN)) { i++; while (i < lines.length && lines[i].trim() && !/^#{1,6} /.test(lines[i])) i++; i--; continue; }
    out.push(lines[i]);
  }
  const body = out.join('\n').replace(/^\n+/, ''), m = /^# [^\n]*\n/.exec(body);
  return (m ? m[0] + '\n' + plan + '\n' + body.slice(m[0].length).replace(/^\n+/, '') : plan + '\n' + body).replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

// the "### NN-..." sections of the given file numbers from an earlier design.md (prompt and analysis), in file order
export function keptSections(md, nums) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n'), want = new Set(nums.map(Number)), out = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^### (\d{2})-/.exec(lines[i]); if (!h || !want.has(Number(h[1]))) continue;
    const sec = [lines[i]]; for (i++; i < lines.length && !/^#{1,3} /.test(lines[i]); i++) sec.push(lines[i]); i--;
    out.push({ n: Number(h[1]), text: sec.join('\n').replace(/\n+$/, '') });
  }
  return out.sort((a, b) => a.n - b.n).map((s) => s.text);
}
