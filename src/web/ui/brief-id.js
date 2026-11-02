// ui/brief-id.js — L2 fix (19/10/2026): the owner brief id from the form's title, shared by the page (shown read-only in the form) and
// the server (lib/owner-brief-form.mjs), so both always agree. An id is <today>--<slug>, at most 60 characters in all (lib/common.mjs
// isListingId), so the slug is at most 48: lowercase a-z 0-9 and single hyphens, accents dropped, cut at a word boundary when it is
// longer, no hyphen at either end. Pure.
export const ID_MAX = 60;
export const SLUG_MAX = ID_MAX - '2026-01-01--'.length;
export function slugOf(title) {
  let s = String(title || '').toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX) { const cut = s.slice(0, SLUG_MAX + 1), at = cut.lastIndexOf('-'); s = (at > 0 ? cut.slice(0, at) : s.slice(0, SLUG_MAX)).replace(/-+$/, ''); }
  return s;
}
export const briefIdOf = (title, today) => { const s = slugOf(title); return s ? today + '--' + s : ''; };
