// tracker.mjs — listings.csv reader: one row per listing ID. Sales are stored as TOTALS only (no buyer PII).
// Source: Virtual-workers/station/scripts/lib/tracker.mjs (owner-written). Copied: COLUMNS, STATUSES, the CSV parser
// (parseLine, records) and readTracker. NOT copied: writeTracker, ensureTracker, upsert (writers).
import fs from 'node:fs';

export const COLUMNS = [
  'listing_id', 'room', 'niche', 'product_key', 'brief_date',
  'design_file', 'print_files', 'qa_design', 'qa_listing',
  'status',            // packaged | blocked | approved | rejected_by_owner | published | retired | parked
  'status_reason', 'packaged_at', 'cost_usd',
  'owner_decision_at', 'published_at', 'etsy_listing_url',
  'sales_units_total', 'sales_revenue_total', 'sales_currency', 'sales_updated_at',
  'updated_at'
];
export const STATUSES = ['packaged', 'blocked', 'approved', 'rejected_by_owner', 'published', 'retired', 'parked'];   // 'parked' added in the source 16/10/2026

export function parseLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
// Split CSV text into records, honouring quoted newlines.
export function records(text) {
  const recs = []; let cur = '', q = false;
  for (const ch of text) {
    if (ch === '"') q = !q;
    if (!q && (ch === '\n')) { if (cur.replace(/\r$/, '').length) recs.push(cur.replace(/\r$/, '')); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) recs.push(cur);
  return recs;
}

export function readTracker(trackerFile) {
  if (!trackerFile || !fs.existsSync(trackerFile)) return [];
  const recs = records(fs.readFileSync(trackerFile, 'utf8'));
  if (!recs.length) return [];
  const head = parseLine(recs[0]);
  if (head.join(',') !== COLUMNS.join(',')) throw new Error('tracker header mismatch — refusing to read ' + trackerFile);
  return recs.slice(1).map((r) => Object.fromEntries(parseLine(r).map((v, i) => [head[i], v])));
}
