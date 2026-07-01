// Classifies an order's traffic source for display — badges and dashboard stats both key off
// this. A non-WOO id means the WhatsApp bot itself created the order; a WOO- id means it came
// from WooCommerce, but isWhatsAppUser (see api/orders.js's chats-table cross-reference) tells
// us whether that website order was placed by someone who's also a known WhatsApp contact.
export function getSourceBadge(order) {
  const id = String(order.id || order.orderId || '');
  if (!id.startsWith('WOO-')) {
    return { label: '💬 WhatsApp Bot', className: 'bg-emerald-100 text-emerald-700' };
  }
  if (order.isWhatsAppUser) {
    return { label: '💬 WhatsApp User', className: 'bg-emerald-100 text-emerald-700' };
  }
  return { label: '🌐 Website', className: 'bg-blue-100 text-blue-700' };
}

// Whether an order counts toward the "WhatsApp" bucket in dashboard stats — bot orders, plus
// website orders placed by a known WhatsApp contact.
export function isWhatsAppAttributed(order) {
  const id = String(order.id || order.orderId || '');
  return !id.startsWith('WOO-') || Boolean(order.isWhatsAppUser);
}
