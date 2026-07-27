// Shared date-filter shape used by DashboardPage and OrdersPage:
//   { mode: 'all' | 'today' | 'yesterday' | 'last2days' | 'week' | 'month' | 'custom', date?: 'YYYY-MM-DD' }
// 'all' is the default and matches the original unfiltered behavior.
export const DEFAULT_DATE_FILTER = { mode: 'all' };

// Returns a 'YYYY-MM-DD' string in the browser's LOCAL timezone (IST for this store).
// We avoid toISOString() because that converts to UTC and shifts the day boundary
// by -5:30, causing yesterday's filter to include/exclude wrong orders in Supabase.
function toLocalDateStr(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Converts a filter into { startDate, endDate } local date strings (YYYY-MM-DD) for the
// orders API, or {} for 'all' (no query params → backend returns everything).
export function getDateRangeParams(filter) {
  if (!filter || filter.mode === 'all') return {};

  const now = new Date();

  if (filter.mode === 'today') {
    const d = toLocalDateStr(now);
    return { startDate: d, endDate: d };

  } else if (filter.mode === 'yesterday') {
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    const d = toLocalDateStr(yest);
    return { startDate: d, endDate: d };

  } else if (filter.mode === 'last2days') {
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    return { startDate: toLocalDateStr(yest), endDate: toLocalDateStr(now) };

  } else if (filter.mode === 'week') {
    const day = now.getDay();
    const diffToMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    return { startDate: toLocalDateStr(monday), endDate: toLocalDateStr(now) };

  } else if (filter.mode === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { startDate: toLocalDateStr(first), endDate: toLocalDateStr(now) };

  } else if (filter.mode === 'custom' && filter.date) {
    return { startDate: filter.date, endDate: filter.date };

  } else {
    return {};
  }
}
