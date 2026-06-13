import api from './axiosInstance';

// GET /orders
export const getOrders = () => api.get('/orders');

// PUT /orders/:id/status
export const updateOrderStatus = (id, status) =>
  api.put(`/orders/${id}/status`, { status });
