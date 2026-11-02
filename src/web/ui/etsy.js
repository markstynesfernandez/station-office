// ui/etsy.js — E7a: the own-shop Etsy connection on the Station page (owner decision 2, 19/10/2026; DECISIONS.md "E7a").
// The top-bar Etsy button opens a dialog: on the live Station, "Connect Etsy" (the authorize link opens Etsy in a new tab;
// after approving, the owner pastes the browser's address back here), then the shop's name, the scopes granted and its
// live listings with their ids, "Refresh listings" and "Disconnect". The dev Station runs the mock Etsy and shows no
// Connect button. The server never sends a token to the page (GET /api/etsy). Pure builders are tested in node.
import { esc } from './format.js';

export const isLive = (st) => !!(st && st.available && st.mode === 'live');

// the button label in the top bar
export function etsyButtonLabel(st) {
  if (!st || !st.available) return 'Etsy: unavailable';
  if (st.needsReconnect) return 'Etsy: reconnect';
  if (st.connected) return 'Etsy: ' + (st.shop && st.shop.name ? st.shop.name : 'connected') + (st.mode === 'mock' ? ' (mock)' : '');
  return st.mode === 'mock' ? 'Etsy: mock (dev)' : 'Etsy: not connected';
}

const money = (p) => (p ? (p.currency || '') + ' ' + Number(p.amount).toFixed(2) : '—');
// the connection, the scopes and the listings (ids first: the owner matches them to the approval queue)
export function etsyStatusHtml(st) {
  if (!st || !st.available) return '<p>Etsy is not available on this Station: ' + esc((st && st.reason) || 'no client') + '</p>';
  const rows = st.listings ? st.listings.items : null;
  return (st.mode === 'mock' ? '<p class="etsy-mock"><b>MOCK Etsy (dev Station)</b>: FIXTURE shop and listings, no real call. Connect on the live Station.</p>' : '')
    + (st.connected
      ? '<p><b>Connected shop:</b> ' + esc(st.shop ? st.shop.name : '—') + (st.shop && st.shop.id ? ' <span class="muted">(shop id ' + esc(st.shop.id) + ')</span>' : '') + '<br><b>Scopes granted:</b> ' + esc((st.scopes || []).join(', ') || '—') + ' <span class="muted">(read only)</span>'
        + (st.connectedAt ? '<br><span class="muted">connected ' + esc(st.connectedAt) + '</span>' : '') + '</p>'
        + (rows ? '<table class="etsy-listings"><thead><tr><th>listing id</th><th>title</th><th>price</th><th>state</th></tr></thead><tbody>'
          + (rows.length ? rows.map((l) => '<tr><td><code>' + esc(l.id) + '</code></td><td>' + esc(l.title) + '</td><td>' + esc(money(l.price)) + '</td><td>' + esc(l.state || '') + '</td></tr>').join('') : '<tr><td colspan="4">no active listings</td></tr>')
          + '</tbody></table><p class="muted">read ' + esc(st.listings.at) + '; shown for at most ' + esc(st.listingsTtlMin) + ' minutes (Etsy\'s terms: listing data at most 6 hours old)</p>'
          : '<p class="muted">Listings not read yet, or older than ' + esc(st.listingsTtlMin) + ' minutes: Refresh listings reads them again.</p>')
      : st.needsReconnect ? '<p><b>The Etsy connection has expired or cannot be read.</b> Disconnect, then connect again.</p>'
        : '<p>Not connected. The Station asks Etsy for read access only (' + esc((st.requestedScopes || []).join(', ')) + ') to your own shop and its listings.</p>')
    + '<p class="muted small">Etsy calls today: ' + esc(st.callsToday) + ' of ' + esc(st.limits ? st.limits.perDay : '?') + '. ' + esc(st.notice || '') + '</p>';
}

// the connect steps, shown with the authorize link
export function connectStepsHtml(start) {
  return '<ol class="etsy-steps"><li><a href="' + esc(start.authorizeUrl) + '" target="_blank" rel="noopener noreferrer">Open Etsy\'s permission page</a> (a new tab) and sign in to Etsy as the shop owner if asked.</li>'
    + '<li>Check it asks for <b>' + esc(start.scopes.join(', ')) + '</b> only, then allow access.</li>'
    + '<li>Etsy sends the tab to <code>' + esc(start.redirectUri) + '</code>. Nothing runs there, so the tab shows an error page: that is expected. Copy the <b>whole address</b> from that tab\'s address bar.</li>'
    + '<li>Paste it below and press Finish within ' + esc(Math.round(start.expiresInS / 60)) + ' minutes.</li></ol>';
}

export function createEtsyPanel({ ctl, button }) {
  let st = null;
  async function refresh() {
    try { st = await (await fetch('/api/etsy')).json(); } catch (_) { st = null; }
    if (button) { button.textContent = etsyButtonLabel(st); button.classList.toggle('badge-on', !!(st && st.connected)); }
    return st;
  }
  async function open() {
    await refresh();
    if (!st || !st.available) { await ctl.dialog({ title: 'Etsy', intro: etsyStatusHtml(st), confirm: 'Close' }); return; }
    if (st.connected || st.needsReconnect) {
      const v = await ctl.dialog({ title: 'Etsy · your shop', intro: etsyStatusHtml(st), confirm: 'Go',
        fields: [{ name: 'what', label: 'What next', type: 'select', value: st.needsReconnect ? 'disconnect' : 'refresh', options: [{ value: 'refresh', label: 'Refresh listings (one read of your listings)' }, { value: 'disconnect', label: 'Disconnect Etsy (deletes the stored token)' }] }] });
      if (!v) return;
      if (v.what === 'refresh') await ctl.act('/api/etsy/listings', { at: Date.now() }, { ok: 'Etsy listings read again' });
      else if (await ctl.dialog({ title: 'Disconnect Etsy?', intro: '<p>The stored token is deleted. The Station stops reading your shop until you connect again.</p>', confirm: 'Disconnect', danger: true })) await ctl.act('/api/etsy/disconnect', { at: Date.now() }, { ok: 'Etsy disconnected' });
      await refresh(); return;
    }
    if (!isLive(st)) { await ctl.dialog({ title: 'Etsy', intro: etsyStatusHtml(st), confirm: 'Close' }); return; }
    const go = await ctl.dialog({ title: 'Connect Etsy', intro: etsyStatusHtml(st), confirm: 'Connect Etsy' });
    if (!go) return;
    const start = await ctl.act('/api/etsy/connect/start', { at: Date.now() }, { quiet: true });
    if (!start || !start.authorizeUrl) return;
    const v = await ctl.dialog({ title: 'Connect Etsy · approve on Etsy', intro: connectStepsHtml(start), confirm: 'Finish connecting',
      fields: [{ name: 'pasted', label: 'The address from the Etsy tab', type: 'textarea', rows: 3, required: true, placeholder: start.redirectUri + '?code=…&state=…' }] });
    if (!v) return;
    const done = await ctl.act('/api/etsy/connect/finish', { pasted: v.pasted }, { ok: (r) => 'Etsy connected: ' + ((r && r.shop && r.shop.name) || 'your shop') });
    await refresh();
    if (done) await ctl.dialog({ title: 'Etsy · connected', intro: etsyStatusHtml(st), confirm: 'Close' });
  }
  if (button) button.addEventListener('click', open);
  return { refresh, open, get status() { return st; } };
}
