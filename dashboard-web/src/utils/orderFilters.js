// A WhatsApp-bot order is anything that isn't a WooCommerce website order.
// source is 'whatsapp' by DB default for bot orders; WOO- ids are the website ones.
export function isWhatsAppOrder(order) {
  const id = String(order.id || order.orderId || '');
  return order.source === 'whatsapp' || !id.startsWith('WOO-');
}
