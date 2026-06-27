import api from './axiosInstance';

// GET /orders — params may include { startDate, endDate } (ISO strings) to scope the
// query to a date range; axios omits undefined keys, so calling with {} behaves exactly
// like the old no-filter call.
export const getOrders = (params = {}) => api.get('/orders', { params });

// PUT /orders/:id/status
export const updateOrderStatus = (id, status) =>
  api.put(`/orders/${id}/status`, { status });
