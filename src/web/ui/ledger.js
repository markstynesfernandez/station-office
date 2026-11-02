// ui/ledger.js — the hub's viewer (the memory core): notebook memory (entries, last recalled by), the engine's spend
// ledger (newest first) and, after an import, the legacy station's ledger as read-only history (E4).
import { esc, money, dateTime, when } from './format.js';

export function createLedgerView({ root }) {
  const body = root.querySelector('#ledger-body');
  const h3 = (t) => '<h3 class="muted" style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase">' + t + '</h3>';
  const note = (t, top = 4) => '<div class="muted" style="font-size:10.5px;margin:' + top + 'px 0 12px">' + t + '</div>';
  const ledgerTable = (rows) => '<table class="tbl"><tr><th>finished</th><th>agent</th><th>model</th><th>tokens</th><th>usd</th></tr>' + rows.map((r) => '<tr><td class="m">' + dateTime(r.at) + '</td><td>' + esc(r.agent) + '</td><td class="m">' + esc(r.model || '') + '</td><td class="m">' + (r.tokens ?? '—') + '</td><td class="m">' + money(r.usd) + '</td></tr>').join('') + '</table>';
  async function get(url) { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch (_) { return null; } }
  async function render(snap) {
    const h = snap.hub, dev = !!(snap.instance && snap.instance.name === 'dev');   // L1: the dev ledger is marked as such
    const [eng, leg] = await Promise.all([get('/api/office/ledger?limit=60'), h.legacyLedger ? get('/api/office/ledger?source=legacy&limit=40') : null]);
    const rows = eng ? eng.rows : [];
    const byAgent = Object.entries(h.notebooks.byAgent).map(([n, c]) => '<tr><td>' + esc(n) + '</td><td class="m">' + c + '</td></tr>').join('');
    const recent = h.recent.map((n) => '<tr><td>' + esc(n.agent) + '</td><td>' + esc(n.kind) + '</td><td>' + esc(n.body) + '</td><td class="m">' + (n.lastUsedAt ? dateTime(n.lastUsedAt) : '—') + '</td><td class="m">' + (n.useCount ?? '—') + '</td></tr>').join('');
    body.innerHTML = '<div class="ledger-grid"><div>' + h3('Notebooks · ' + h.notebooks.entries + ' entries · last recalled by ' + esc(h.notebooks.lastRecalledBy || '—') + (h.notebooks.lastRecalledAt ? ' · ' + esc(when(h.notebooks.lastRecalledAt, snap.generatedAt)) : '') + (h.notebooks.legacy ? ' · legacy, read only' : ''))
      + '<table class="tbl"><tr><th>agent</th><th>entries</th></tr>' + byAgent + '</table>' + note('source: ' + esc(h.notebooks.source))
      + '<table class="tbl"><tr><th>agent</th><th>kind</th><th>record</th><th>last used</th><th>uses</th></tr>' + recent + '</table></div>'
      + '<div>' + (dev ? '<div class="badge badge-dev" style="display:inline-block;margin:0 0 6px">DEV ledger · scratch data, not the station\'s spend</div>' : '') + h3((dev ? 'Dev ledger · ' : 'Ledger · ') + h.ledger.rows + ' rows · last ' + (h.ledger.last ? esc(h.ledger.last.agent) + ' ' + esc(when(h.ledger.last.at, snap.generatedAt)) + ' ' + money(h.ledger.last.usd) : '—'))
      + (rows.length ? ledgerTable(rows) : '<div class="muted">No engine spend yet.</div>') + note('source: ' + esc(h.ledger.source) + ' · newest 60 of ' + h.ledger.rows + ' · the engine\'s own spend, counted in its caps')
      + (leg ? h3('Legacy ledger · ' + leg.total + ' rows · ' + money(leg.usd) + ' · read only') + ledgerTable(leg.rows) + note('source: ' + esc(leg.source) + ' · newest ' + leg.rows.length + ' of ' + leg.total) : '')
      + '</div></div>';
  }
  return { render, show: () => root.classList.remove('hidden'), hide: () => root.classList.add('hidden'), isOpen: () => !root.classList.contains('hidden') };
}
