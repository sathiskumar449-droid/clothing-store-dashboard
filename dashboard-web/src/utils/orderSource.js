// Whether an order should be attributed to the WhatsApp bot — see api/orders.js's
// isWhatsAppReferred (true only when the customer has an actual customer-sent chat message,
// not just the automated post-purchase notification every WooCommerce order gets logged).
export function getSourceBadge(order) {
  if (order.isWhatsAppReferred) {
    return { label: '💬 WhatsApp', className: 'bg-emerald-100 text-emerald-700' };
  }
  return { label: '🌐 Website', className: 'bg-blue-100 text-blue-700' };
}
