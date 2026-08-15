/**
 * Putting data into markup, for the three pages that build their lists as strings.
 *
 * Everything they render came from somewhere else: names scraped off a Meet page, titles typed by
 * whoever booked the call, whole records read out of a file somebody else wrote. One helper, in
 * one place, because the two copies this replaces had already drifted apart — the popup's and the
 * report's escaped the angle brackets and left the quotes, which is only safe until the next value
 * goes into an attribute.
 *
 * Needs a DOM, so nothing in the service worker imports this.
 */

/** Text as markup: entities for the brackets, and for the quotes an attribute would end on. */
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : s;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The two letters an avatar stands for: first and last initial, or the first two characters. */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  const two = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : String(name || '').slice(0, 2);
  return (two || '?').toUpperCase();
}
