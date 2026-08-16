const DAY_MS = 86400000;

/** Inclusive local-day bounds for a preset covering exactly `days` calendar dates. */
export function presetBounds(days, now = new Date()) {
  const count = Math.max(1, Math.floor(Number(days) || 1));
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const from = new Date(now);
  from.setDate(from.getDate() - (count - 1));
  from.setHours(0, 0, 0, 0);
  return { from, to };
}

function localDateAsUtcMs(value) {
  const date = new Date(value);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Number of local calendar dates touched by an inclusive range. */
export function calendarDayCount(from, to) {
  const first = localDateAsUtcMs(from);
  const last = localDateAsUtcMs(to);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.floor(Math.abs(last - first) / DAY_MS) + 1;
}
