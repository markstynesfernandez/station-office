// lib/exec-records.mjs — R3 (RESTRUCTURE.md §2.1, §8 R3): the executives' records, checked when they are written (tools fs_write, through
// the run's validators) and read back for the Owner's office. Pure, no engine.
//   the COO's daily report    products/station/reports/<day>.md: a fixed heading and sections; every USD figure in it must be a figure of
//                             that day's metrics (metrics-<day>.json, engine-written), so the report cannot invent a number
//   the CEO's weekly memo     products/station/memos/<YYYY-Www>.md: priorities per active product, then proposals P1..Pn, each with its
//                             options (at least two), the recommendation and the cost. A proposal is a document: the owner marks it
//                             taken, declined or later (a note, not an approval of anything; proposal-marks.jsonl, engine-written)
import fs from 'node:fs';
import path from 'node:path';

export const REPORT_SECTIONS = ['Summary', 'Spend and caps', 'Routines', 'Blocked and stuck jobs', 'Requests and policy', 'Refusals', 'Pauses'];
export const MEMO_SECTIONS = ['Priorities', 'Proposals'];
export const MARKS = ['taken', 'declined', 'later'];
export const MAX_REPORT_CHARS = 20000, MAX_MEMO_CHARS = 30000;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/, WEEK_RE = /^\d{4}-W\d{2}$/;

// the ISO week of a Dublin day (YYYY-MM-DD) -> YYYY-Www
export function isoWeek(day) {
  const [y, m, d] = String(day).split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d));
  const wd = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - wd);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)), w = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(w).padStart(2, '0');
}

const lines = (t) => String(t || '').replace(/\r\n/g, '\n').split('\n');
const sectionsOf = (t) => lines(t).filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim());
// the USD figures a text names ("USD 3.20", "$3.20", "3.20 USD"), as 2-decimal strings
export const usdFigures = (t) => [...String(t || '').matchAll(/(?:USD\s?|\$)(\d{1,7}(?:\.\d{1,6})?)|(\d{1,7}(?:\.\d{1,6})?)\s?USD\b/g)].map((m) => Number(m[1] || m[2]).toFixed(2));
// every money figure in a metrics record (keys ending in Usd), as 2-decimal strings
export function moneyIn(obj, out = new Set(['0.00'])) {
  if (Array.isArray(obj)) for (const x of obj) moneyIn(x, out);
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { if (/Usd$/.test(k) && typeof v === 'number') out.add(v.toFixed(2)); else moneyIn(v, out); }
  return out;
}

// the COO's report against its day's metrics -> problems[] (empty: it holds)
export function reportProblems(text, { day, metrics = null } = {}) {
  const t = String(text || ''), bad = [];
  if (t.length > MAX_REPORT_CHARS) bad.push('the report is ' + t.length + ' characters; keep it under ' + MAX_REPORT_CHARS);
  if (lines(t)[0].trim() !== '# Operations report ' + day) bad.push('the first line must be "# Operations report ' + day + '"');
  const have = sectionsOf(t);
  for (const s of REPORT_SECTIONS) if (!have.includes(s)) bad.push('the section "## ' + s + '" is missing');
  if (metrics) {
    const allowed = moneyIn(metrics), stray = [...new Set(usdFigures(t).filter((x) => !allowed.has(x)))];
    if (stray.length) bad.push('these USD figures are not in metrics-' + day + '.json: ' + stray.slice(0, 8).map((x) => 'USD ' + x).join(', ') + ' (copy every figure from the metrics; never compute or estimate one)');
  }
  return bad;
}

// the CEO's memo -> { ok, problems, proposals: [{ id, title, options: [..], recommendation, cost }], priorities: [product names] }
export function parseMemo(text, { week, products = [] } = {}) {
  const t = String(text || ''), bad = [], ls = lines(t);
  if (t.length > MAX_MEMO_CHARS) bad.push('the memo is ' + t.length + ' characters; keep it under ' + MAX_MEMO_CHARS);
  if (week && ls[0].trim() !== '# CEO memo ' + week) bad.push('the first line must be "# CEO memo ' + week + '"');
  const have = sectionsOf(t);
  for (const s of MEMO_SECTIONS) if (!have.includes(s)) bad.push('the section "## ' + s + '" is missing');
  // the parts under each ## heading, and the ### blocks inside them
  const part = (name) => { const i = ls.findIndex((l) => l.trim() === '## ' + name); if (i < 0) return []; const j = ls.findIndex((l, k) => k > i && /^## /.test(l)); return ls.slice(i + 1, j < 0 ? undefined : j); };
  const blocks = (pl) => { const out = []; for (const l of pl) { if (/^### /.test(l)) out.push({ head: l.slice(4).trim(), body: [] }); else if (out.length) out[out.length - 1].body.push(l); } return out; };
  const priorities = blocks(part('Priorities')).map((b) => b.head);
  for (const p of products) if (!priorities.some((h) => h.toLowerCase() === String(p).toLowerCase())) bad.push('Priorities needs a "### ' + p + '" heading (every active product, even when there is nothing to do)');
  const proposals = [];
  blocks(part('Proposals')).forEach((b, i) => {
    const m = /^P(\d+):\s*(.+)$/.exec(b.head), want = 'P' + (i + 1);
    if (!m || 'P' + m[1] !== want) { bad.push('proposal ' + (i + 1) + ' must be headed "### ' + want + ': <title>"'); return; }
    const field = (name) => { const k = b.body.findIndex((l) => new RegExp('^' + name + ':', 'i').test(l.trim())); return k < 0 ? null : { at: k, text: b.body[k].trim().slice(name.length + 1).trim() }; };
    const opt = field('Options'), rec = field('Recommendation'), cost = field('Cost');
    const options = opt ? b.body.slice(opt.at + 1).filter((l, k, a) => { const stop = a.findIndex((x) => /^(Recommendation|Cost):/i.test(x.trim())); return (stop < 0 || k < stop) && /^\s*-\s+\S/.test(l); }).map((l) => l.replace(/^\s*-\s+/, '').trim()) : [];
    if (options.length < 2) bad.push(want + ' needs "Options:" with at least two "- " options');
    if (!rec || !rec.text) bad.push(want + ' needs "Recommendation: …" (which option, and why)');
    if (!cost || !cost.text) bad.push(want + ' needs "Cost: …" (the cost, or "none", or "not known")');
    proposals.push({ id: want, title: m[2].trim(), options, recommendation: rec ? rec.text : '', cost: cost ? cost.text : '' });
  });
  return { ok: !bad.length, problems: bad, proposals, priorities };
}

// ---- the owner's marks on proposals (memos/proposal-marks.jsonl, append only; the latest mark of a proposal wins)
export const marksFile = (memosDir) => path.join(memosDir, 'proposal-marks.jsonl');
export function readMarks(memosDir) {
  const f = marksFile(memosDir); if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
export function latestMarks(memosDir) {
  const out = {}; for (const m of readMarks(memosDir)) out[m.week + '/' + m.proposal] = m;
  return out;
}
