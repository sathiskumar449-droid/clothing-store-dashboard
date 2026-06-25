// api/woocommerce-order-webhook.js
// Receives WooCommerce "Order updated" webhooks and sends an order confirmation
// to the customer over WhatsApp once the order reaches processing/completed.
import crypto from 'crypto';
import { sendText, logChatMessage } from './webhook.js';
import { supabase } from '../lib/supabase.js';

const WOOCOMMERCE_WEBHOOK_SECRET = process.env.WOOCOMMERCE_WEBHOOK_SECRET;

console.log('[Woo Order Webhook] WOOCOMMERCE_WEBHOOK_SECRET configured:', !!WOOCOMMERCE_WEBHOOK_SECRET);

// Best-effort, single-instance dedup so a WooCommerce retry — or an admin re-saving an
// order that's already processing/completed (which re-fires "order.updated") — doesn't
// send the customer a second confirmation. Not durable across cold starts/instances;
// acceptable since a duplicate message is a UX nuisance, not a correctness problem.
const notifiedOrders = new Set();

function verifySignature(rawBody, signatureHeader, secret) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest('base64');
    const expectedBuf = Buffer.from(expected);
    const givenBuf = Buffer.from(signatureHeader || '');
    if (expectedBuf.length !== givenBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

// WooCommerce billing.phone is whatever the customer typed (spaces, dashes, leading 0,
// sometimes already with a country code) — normalize to the bare international format
// (e.g. "919876543210") expected by the WhatsApp `to` field used elsewhere in webhook.js.
function normalizeIndianPhone(rawPhone) {
    if (!rawPhone) return null;
    const digits = String(rawPhone).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;
}

// Joins WooCommerce's billing address fields into the same single free-text line the
// WhatsApp checkout flow stores in customer_address (see api/webhook.js's order-confirm step).
function buildCustomerAddress(billing) {
    if (!billing) return '';
    const parts = [billing.address_1, billing.address_2, billing.city, billing.state]
        .map(p => (p || '').trim())
        .filter(Boolean);
    const line = parts.join(', ');
    return billing.postcode ? `${line}${line ? ', Pin: ' : 'Pin: '}${billing.postcode}` : line;
}

// WooCommerce variation attributes (size/color) ride along in each line item's meta_data as
// {key, value} pairs — pull them out the same way mapWooProductToDb() does for products.
function extractMetaValue(metaData, keyPattern) {
    if (!Array.isArray(metaData)) return null;
    const entry = metaData.find(m => keyPattern.test(String(m.key || '').toLowerCase()));
    return entry ? String(entry.value) : null;
}

// This handler only ever reaches here for "processing"/"completed" orders (see the status
// check above), so map onto the dashboard's two "order is real" statuses — matching the
// STATUS_OPTIONS dashboard-web/src/pages/OrdersPage.jsx already knows how to render/filter.
function mapWooStatusToDashboardStatus(wooStatus) {
    return wooStatus === 'completed' ? 'delivered' : 'confirmed';
}

// Shapes a WooCommerce order into the exact same row shape the WhatsApp-bot checkout flow
// writes (see the `newOrder` object in api/webhook.js) so the dashboard renders it identically.
function buildOrderRow(order, phone) {
    const firstName = order.billing?.first_name || '';
    const lastName = order.billing?.last_name || '';
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

    return {
        id: `WOO-${order.id}`,
        customer_phone: phone || '',
        customer_name: `${firstName} ${lastName}`.trim() || 'Customer',
        customer_address: buildCustomerAddress(order.billing),
        items: lineItems.map(item => ({
            productId: item.product_id,
            product: item.name,
            color: extractMetaValue(item.meta_data, /colou?r/) || '',
            size: extractMetaValue(item.meta_data, /size/) || 'N/A',
            price: Number(item.price),
            qty: item.quantity || 1
        })),
        total_price: Number(order.total) || 0,
        status: mapWooStatusToDashboardStatus(order.status),
        date: order.date_created || new Date().toISOString(),
        source: 'website'
    };
}

function buildOrderConfirmationMessage(order) {
    const orderNumber = order.number || order.id;
    const firstName = order.billing?.first_name || '';
    const lastName = order.billing?.last_name || '';
    const customerName = `${firstName} ${lastName}`.trim() || 'Customer';
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

    const divider = '──────────────────────';
    let msg = `${divider}\n`;
    msg += `🎉 *Order Confirmed!*\n`;
    msg += `${divider}\n\n`;
    msg += `📦 Order #${orderNumber}\n`;
    msg += `👤 ${customerName}\n\n`;
    msg += `🛍️ *Items:*\n`;
    lineItems.forEach((item, i) => {
        msg += `${i + 1}. ${item.name} x${item.quantity} - ₹${item.total}\n`;
    });
    msg += `\n💰 *Total: ₹${order.total}*\n`;
    msg += `${divider}\n\n`;
    msg += `Thank you for shopping with Super Collections! 🙏`;
    return msg;
}

export async function handleWooOrderWebhook(req, res) {
    const topic = req.headers['x-wc-webhook-topic'] || '';
    console.log(`[Woo Order Webhook] Received — topic="${topic}"`);

    // 1. Signature verification
    if (WOOCOMMERCE_WEBHOOK_SECRET) {
        const signature = req.headers['x-wc-webhook-signature'];
        if (!signature) {
            console.error('[Woo Order Webhook] ❌ Missing x-wc-webhook-signature header — rejecting');
            return res.status(400).send('Missing signature');
        }

        const rawBody = req.rawBody || '';
        if (!verifySignature(rawBody, signature, WOOCOMMERCE_WEBHOOK_SECRET)) {
            console.error('[Woo Order Webhook] ❌ Signature mismatch — rejecting (possible spoofed request)');
            return res.status(400).send('Invalid signature');
        }
        console.log('[Woo Order Webhook] ✅ Signature verified');
    } else {
        console.warn('[Woo Order Webhook] ⚠️ WOOCOMMERCE_WEBHOOK_SECRET not configured — signature verification bypassed');
    }

    // 2. Process order
    try {
        const order = req.body;

        // WooCommerce sends a near-empty payload when the webhook is first created/saved in admin
        if (topic.includes('webhook.test') || !order || !order.id) {
            console.log('[Woo Order Webhook] Test/empty payload — acknowledging without action');
            return res.sendStatus(200);
        }

        console.log(`[Woo Order Webhook] Order #${order.number || order.id} status="${order.status}"`);

        if (order.status !== 'processing' && order.status !== 'completed') {
            console.log(`[Woo Order Webhook] Skipping — status "${order.status}" is not processing/completed`);
            return res.sendStatus(200);
        }

        const dedupeKey = `${order.id}_${order.status}`;
        if (notifiedOrders.has(dedupeKey)) {
            console.log(`[Woo Order Webhook] Skipping — already notified for ${dedupeKey}`);
            return res.sendStatus(200);
        }

        const phone = normalizeIndianPhone(order.billing?.phone);

        // Save to the dashboard's orders table regardless of whether we can message the
        // customer — a missing/bad phone shouldn't mean the owner never sees the order. Upsert
        // (not insert) so a later status webhook for the same order, e.g. processing -> completed,
        // updates this row instead of creating a duplicate. Failure here must never block the
        // WhatsApp confirmation below, so it's caught and logged rather than thrown.
        try {
            const { error: orderInsertError } = await supabase
                .from('orders')
                .upsert([buildOrderRow(order, phone)], { onConflict: 'id' });
            if (orderInsertError) {
                console.error(`[Woo Order Webhook] ❌ Failed to save order #${order.id} to dashboard:`, orderInsertError.message);
            } else {
                console.log(`[Woo Order Webhook] ✅ Saved order #${order.id} to dashboard (orders table)`);
            }
        } catch (dbErr) {
            console.error(`[Woo Order Webhook] ❌ Unexpected error saving order #${order.id}:`, dbErr.message);
        }

        if (!phone) {
            console.error(`[Woo Order Webhook] ❌ No usable billing phone on order #${order.id} — cannot notify customer`);
            return res.sendStatus(200);
        }

        const message = buildOrderConfirmationMessage(order);

        await sendText(phone, message);
        await logChatMessage(phone, 'bot', message);
        notifiedOrders.add(dedupeKey);

        console.log(`[Woo Order Webhook] ✅ Sent order confirmation for #${order.number || order.id} to ${phone}`);
        return res.sendStatus(200);
    } catch (err) {
        console.error('[Woo Order Webhook] ❌ Processing error:', err.message);
        return res.sendStatus(200); // ack anyway so WooCommerce doesn't retry-storm
    }
}
