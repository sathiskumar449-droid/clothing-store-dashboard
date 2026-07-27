import axios from 'axios';
import { supabase } from '../lib/supabase.js';

// Utilities copied from api/woocommerce-order-webhook.js to keep row shape identical
function normalizeIndianPhone(rawPhone) {
    if (!rawPhone) return null;
    const digits = String(rawPhone).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;
}

function buildCustomerAddress(billing) {
    if (!billing) return '';
    const parts = [billing.address_1, billing.address_2, billing.city, billing.state]
        .map(p => (p || '').trim())
        .filter(Boolean);
    const line = parts.join(', ');
    return billing.postcode ? `${line}${line ? ', Pin: ' : 'Pin: '}${billing.postcode}` : line;
}

function extractMetaValue(metaData, keyPattern) {
    if (!Array.isArray(metaData)) return null;
    const entry = metaData.find(m => keyPattern.test(String(m.key || '').toLowerCase()));
    return entry ? String(entry.value) : null;
}

function getOrderSource(order) {
    const utmSource = extractMetaValue(order.meta_data, /^_wc_order_attribution_utm_source$/);
    return (utmSource || '').toLowerCase().trim() === 'whatsapp' ? 'whatsapp' : 'website';
}

function mapWooOrderStatus(status) {
    switch (String(status || '').toLowerCase()) {
        case 'pending':
        case 'on-hold':
            return 'pending';
        case 'processing':
            return 'processing';
        case 'completed':
            return 'completed';
        case 'cancelled':
        case 'failed':
        case 'refunded':
            return 'cancelled';
        default:
            return 'confirmed';
    }
}

function buildOrderRow(order) {
    const firstName = order.billing?.first_name || '';
    const lastName = order.billing?.last_name || '';
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

    const mappedStatus = mapWooOrderStatus(order.status);
    const phone = normalizeIndianPhone(order.billing?.phone) || '';
    return {
        id: `WOO-${order.id}`,
        customer_phone: phone,
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
        status: mappedStatus,
        date: order.date_created_gmt ? `${order.date_created_gmt}Z` : (order.date_created || new Date().toISOString()),
        source: 'website',
        order_source: getOrderSource(order)
    };
}

// POST /api/sync-woocommerce-orders
export const syncWooOrders = async (req, res) => {
    try {
        let siteUrl, consumerKey, consumerSecret;

        // 1. Try to load credentials from Supabase settings table
        try {
            const { data: settingsRows, error: settingsError } = await supabase
                .from('settings')
                .select('*')
                .in('key', ['woo_site_url', 'woo_consumer_key', 'woo_consumer_secret']);

            if (!settingsError) {
                const settings = {};
                (settingsRows || []).forEach(r => {
                    if (r.key === 'woo_site_url') settings.siteUrl = r.value;
                    if (r.key === 'woo_consumer_key') settings.consumerKey = r.value;
                    if (r.key === 'woo_consumer_secret') settings.consumerSecret = r.value;
                });
                siteUrl = settings.siteUrl;
                consumerKey = settings.consumerKey;
                consumerSecret = settings.consumerSecret;
            }
        } catch (_) {
            // Settings table error — will fall back to env vars below
        }

        // 2. Fall back to environment variables if DB settings are missing
        if (!siteUrl)        siteUrl        = process.env.WOO_SITE_URL;
        if (!consumerKey)    consumerKey    = process.env.WOO_CONSUMER_KEY;
        if (!consumerSecret) consumerSecret = process.env.WOO_CONSUMER_SECRET;

        if (!siteUrl || !consumerKey || !consumerSecret) {
            return res.status(400).json({
                success: false,
                message: 'WooCommerce settings not configured. Add WOO_SITE_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET to Vercel environment variables.'
            });
        }

        const perPage = 100;
        let page = 1;
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const rowsToUpsert = [];

        // Loop through pages until fewer than perPage returned
        while (true) {
            const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wc/v3/orders`;
            const params = {
                consumer_key: consumerKey,
                consumer_secret: consumerSecret,
                after: twoDaysAgo,
                per_page: perPage,
                page
            };

            const resp = await axios.get(url, { params, timeout: 20000 });
            const orders = Array.isArray(resp.data) ? resp.data : [];
            if (orders.length === 0) break;

            for (const order of orders) {
                const row = buildOrderRow(order);
                rowsToUpsert.push(row);
            }

            if (orders.length < perPage) break;
            page += 1;
        }

        if (rowsToUpsert.length === 0) {
            return res.json({ success: true, message: 'No orders in the last 2 days', synced: 0 });
        }

        const { error: upsertError } = await supabase
            .from('orders')
            .upsert(rowsToUpsert, { onConflict: 'id' });

        if (upsertError) {
            console.error('Sync upsert error:', upsertError.message);
            return res.status(500).json({ success: false, message: upsertError.message });
        }

        return res.json({ success: true, synced: rowsToUpsert.length });
    } catch (err) {
        console.error('❌ Sync Woo Orders Error:', err.message || err);
        return res.status(500).json({ success: false, message: err.message || String(err) });
    }
};
