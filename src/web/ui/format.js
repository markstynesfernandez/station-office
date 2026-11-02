// ui/format.js — small formatting helpers shared by the panels. UK/Irish English. ONE date format everywhere
// (owner, round 1): dd/mm/yyyy and 24h, with relative time in brackets where useful, e.g. "16/10/2026 09:42 (8h ago)".
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// money hiding (the presenter view, which may be shown outside the station): every amount the page prints goes through
// money() or price(), which print "—" while hidden; scrubMoney() is the safety net for amounts inside other text
let moneyHidden = false;
export const setMoneyHidden = (v) => { moneyHidden = !!v; };
export const isMoneyHidden = () => moneyHidden;
export const money = (v, cur = '$') => (moneyHidden || v == null || Number.isNaN(Number(v)) ? '—' : cur + (Number(v) < 0.01 && Number(v) > 0 ? Number(v).toFixed(4) : Number(v).toFixed(2)));
export const price = (s) => (moneyHidden ? '—' : s);
export const MONEY_RE = /(?:US\$|\$|€|£)\s?\d[\d,]*(?:\.\d+)?(?:\s?[–-]\s?\d[\d,]*(?:\.\d+)?)?|\b(?:EUR|USD|GBP)\s?\d[\d,]*(?:\.\d+)?(?:\s?[–-]\s?\d[\d,]*(?:\.\d+)?)?/g;
export const hasMoney = (s) => new RegExp(MONEY_RE.source).test(String(s || ''));
export const scrubMoney = (s) => String(s).replace(MONEY_RE, '—');
const z = (n) => String(n).padStart(2, '0');
const ok = (ms) => ms != null && ms !== '' && !Number.isNaN(Number(ms));
export const hhmm = (ms) => { if (!ok(ms)) return '—'; const d = new Date(ms); return z(d.getHours()) + ':' + z(d.getMinutes()); };
export const dmy = (ms) => { if (!ok(ms)) return '—'; const d = new Date(ms); return z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + d.getFullYear(); };
export const dateTime = (ms) => (ok(ms) ? dmy(ms) + ' ' + hhmm(ms) : '—');
export const ymd = (d) => d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
export const dmyFromYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(s || '—'); };
// relative time: "8h ago", "in 3d"
export function ago(ms, now = Date.now()) {
  if (!ok(ms)) return '—';
  const diff = now - ms, s = Math.round(Math.abs(diff) / 1000);
  const v = s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 48 * 3600 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd';
  return diff >= 0 ? v + ' ago' : 'in ' + v;
}
// the standard date-time with relative time in brackets
export const when = (ms, now = Date.now()) => (ok(ms) ? dateTime(ms) + ' (' + ago(ms, now) + ')' : '—');
export function duration(ms) { if (ms == null) return '—'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); if (h < 48) return h + 'h ' + (m % 60) + 'm'; return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'; }
export const statusLabel = { idle: 'idle', working: 'working', waiting: 'waiting for approval', error: 'error' };
export const jobStatusLabel = { backlog: 'backlog', in_progress: 'in progress', waiting: 'waiting for my approval', done: 'done', blocked: 'blocked', rejected: 'rejected', parked: 'parked', legacy: 'unfinished', archived: 'archived' };
export const deptColour = (key, palette) => (palette.departments[key] || palette.departments.default);
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// a status pill (blocked / rejected / done / waiting / backlog) used wherever a job shows instead of a progress %
export const statusPill = (j) => '<span class="pill pill-' + esc(j.lane || j.status) + '">' + esc(j.flag === 'stopped' ? 'stopped' : j.lane || jobStatusLabel[j.status] || j.status) + '</span>';
// imported from the legacy station (E4): read-only history, never engine work
export const legacyTag = (o) => (o && o.kind === 'legacy' ? '<span class="leg" title="imported from the legacy station (read only)">legacy</span>' : '');
export const synthTag = (o) => (o && o.synthetic ? '<span class="syn" title="' + esc('synthetic test state: ' + (o.syntheticWhat || '')) + '">synthetic</span>' : '');
