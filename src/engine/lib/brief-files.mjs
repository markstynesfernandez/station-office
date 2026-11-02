// lib/brief-files.mjs — the brief defines the files, the product spec the format (owner decision, 18/10/2026; DECISIONS.md "E6 step
// c: product spec defines format, brief defines files"). products.json gives the format only (how many files, format, pixel size,
// alpha, packaging); each file's subject comes from the brief's numbered file list. Station code, no model:
//   briefFileList(brief)            the first numbered list (1., 2., ...) in ## Design direction: [{ n, text }]
//   briefFileProblems(brief, product, names)
//                                   when that list has exactly as many items as the product spec has files, every item N needs a set
//                                   file NN-<subject>.png whose subject shares a word with item N (books/book, leaf/leaves count);
//                                   -> { checked, problems[], note }. A brief without such a list is not checked (note says why).
// Used by the prep step and the QA-only run (orchestrator): a set that does not match its brief's list fails closed there.
import { designDirectionOf } from './brief-check.mjs';

const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'with', 'in', 'on', 'for', 'to', 'its', 'it', 'no', 'any', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'png', 'file', 'prop', 'small', 'large', 'little']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
const stem = (w) => w.replace(/(?:ies)$/, 'y').replace(/(?:ves)$/, 'f').replace(/(?:es|s)$/, '');
const same = (a, b) => { const x = stem(a), y = stem(b); return x === y || (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))); };

export function briefFileList(briefText) {
  const lines = designDirectionOf(briefText).split('\n'), out = [];
  for (const l of lines) {
    const m = /^\s*(\d+)\.\s+(\S.*)$/.exec(l);
    if (m && Number(m[1]) === out.length + 1) out.push({ n: Number(m[1]), text: m[2].trim() });
    else if (out.length && l.trim() && !m) break;   // the list ended
  }
  return out;
}

export function briefFileProblems(briefText, product, names) {
  const want = ((product && product.deliverables && product.deliverables.files) || []).length, list = briefFileList(briefText);
  if (!list.length) return { checked: false, problems: [], note: 'the brief has no numbered file list in its Design direction: subjects not checked by the station' };
  if (list.length !== want) return { checked: false, problems: [], note: 'the brief lists ' + list.length + ' files, the product spec has ' + want + ': subjects not checked by the station' };
  const byN = new Map();
  for (const f of names || []) { const m = /^(\d{2})-(.+)\.png$/i.exec(String(f)); if (m && !byN.has(Number(m[1]))) byN.set(Number(m[1]), m[2]); }
  const problems = [];
  for (const it of list) {
    const subject = byN.get(it.n), nn = String(it.n).padStart(2, '0');
    if (subject == null) { problems.push('file ' + nn + ' is missing (the brief\'s item ' + it.n + ': "' + it.text + '")'); continue; }
    if (!words(subject).some((w) => words(it.text).some((b) => same(w, b)))) problems.push('file ' + nn + '-' + subject + '.png does not match the brief\'s item ' + it.n + ': "' + it.text + '"');
  }
  return { checked: true, problems, note: problems.length ? problems.length + ' of ' + list.length + ' files do not match the brief\'s file list' : 'all ' + list.length + ' files match the brief\'s file list' };
}
