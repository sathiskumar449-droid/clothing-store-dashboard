// Shared date-filter shape used by DashboardPage and OrdersPage:
//   { mode: 'all' | 'today' | 'week' | 'month' | 'custom', date?: 'YYYY-MM-DD' }
// 'all' is the default and matches the original unfiltered behavior.
export const DEFAULT_DATE_FILTER = { mode: 'all' };

// Converts a filter into { startDate, endDate } ISO strings for the orders API, or {}
// for 'all' (no query params -> backend returns everything, unchanged from before).
// Boundaries are computed from the browser's local time so "Today" / the date picker
// line up with the owner's own calendar day rather than UTC.
export function getDateRangeParams(filter) {
  if (!filter || filter.mode === 'all') return {};

  const now = new Date();
  let start;
  let end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (filter.mode === 'today') {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
  } else if (filter.mode === 'week') {
    // Week starts Monday.
    const day = now.getDay();
    const diffToMonday = day === 0 ? 6 : day - 1;
    start = new Date(now);
    start.setDate(now.getDate() - diffToMonday);
    start.setHours(0, 0, 0, 0);
  } else if (filter.mode === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  } else if (filter.mode === 'custom' && filter.date) {
    start = new Date(`${filter.date}T00:00:00`);
    end = new Date(`${filter.date}T23:59:59.999`);
  } else {
    return {};
  }

  return { startDate: start.toISOString(), endDate: end.toISOString() };
}
