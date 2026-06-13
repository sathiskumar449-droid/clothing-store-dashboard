import { getOrders } from './ordersApi';

/**
 * Derive customer list from orders.
 * Groups by phone number, counts orders, tracks last order.
 */
export const getCustomers = async () => {
  const response = await getOrders();
  const orders = response.data;

  const customerMap = {};

  orders.forEach((order) => {
    const phone =
      order.customerPhone || order.customer || 'unknown';
    const name =
      order.customerName ||
      order.customerDetails ||
      'Customer';
    const date = order.date || order.createdAt || '';
    const total = order.totalPrice || 0;
    const orderId = order.id || order.orderId || '';

    if (!customerMap[phone]) {
      customerMap[phone] = {
        phone,
        name,
        orderCount: 0,
        totalSpent: 0,
        lastOrderDate: date,
        lastOrderId: orderId,
      };
    }

    customerMap[phone].orderCount += 1;
    customerMap[phone].totalSpent += total;

    // Keep the most recent order date
    if (date && date > customerMap[phone].lastOrderDate) {
      customerMap[phone].lastOrderDate = date;
      customerMap[phone].lastOrderId = orderId;
      customerMap[phone].name = name; // use latest name
    }
  });

  return Object.values(customerMap).sort(
    (a, b) => b.orderCount - a.orderCount
  );
};
