// Shared date-filter shape used by DashboardPage and OrdersPage:
//   { mode: 'all' | 'today' | 'yesterday' | 'last2days' | 'week' | 'month' | 'custom', date?: 'YYYY-MM-DD' }
// 'all' is the default and matches the original unfiltered behavior.
export const DEFAULT_DATE_FILTER = { mode: 'all' };

// Converts a filter into { startDate, endDate } ISO strings for the orders API, or {}
// for 'all' (no query params -> backend returns everything).
// Boundaries are computed from the browser's local time (IST) so that the filters
// align with the local calendar day rather than UTC day boundaries.
export function getDateRangeParams(filter) {
  if (!filter || filter.mode === 'all') return {};

  const now = new Date();
  let start = new Date(now);
  let end = new Date(now);

  if (filter.mode === 'today') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

  } else if (filter.mode === 'yesterday') {
    start.setDate(now.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(now.getDate() - 1);
    end.setHours(23, 59, 59, 999);

  } else if (filter.mode === 'last2days') {
    start.setDate(now.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

  } else if (filter.mode === 'week') {
    const day = now.getDay();
    const diffToMonday = day === 0 ? 6 : day - 1;
    start.setDate(now.getDate() - diffToMonday);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

  } else if (filter.mode === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

  } else if (filter.mode === 'custom' && filter.date) {
    start = new Date(`${filter.date}T00:00:00`);
    end = new Date(`${filter.date}T23:59:59.999`);

  } else {
    return {};
  }

  return { startDate: start.toISOString(), endDate: end.toISOString() };
}
