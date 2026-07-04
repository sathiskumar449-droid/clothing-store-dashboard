// api/order-stats.js
// Returns WhatsApp-vs-website order counts/revenue for a date range, used by the dashboard's
// "WhatsApp Orders" / "Website Orders" stat cards. order_source is set at webhook time from
// WooCommerce's own Order Attribution meta (see getOrderSource in
// api/woocommerce-order-webhook.js) — not guessed from chat activity, which was tried before
// and reverted for being unreliable.
import { supabase } from '../lib/supabase.js';

// Mirrors dashboard-web's utils/dateFilter.js: when the dashboard's date filter is 'all' (the
// default), no startDate/endDate is sent, so this endpoint falls back to "today" in IST rather
// than all-time history — computed explicitly in Asia/Kolkata, the same IST handling already
// established for order dates elsewhere (see "Fix WooCommerce orders stored a day ahead in IST").
function todayIstBounds() {
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // -> YYYY-MM-DD
    return {
        startDate: `${todayIst}T00:00:00+05:30`,
        endDate: `${todayIst}T23:59:59.999+05:30`
    };
}

export async function getOrderStats(req, res) {
    try {
        let { startDate, endDate } = req.query;
        if (!startDate && !endDate) {
            ({ startDate, endDate } = todayIstBounds());
        }

        let query = supabase.from('orders').select('order_source, total_price');
        if (startDate) query = query.gte('date', startDate);
        if (endDate) query = query.lte('date', endDate);

        const { data, error } = await query;
        if (error) throw error;

        const stats = {
            whatsapp_orders: 0,
            website_orders: 0,
            whatsapp_revenue: 0,
            website_revenue: 0
        };

        // Anything other than the exact "whatsapp" tag (including old pre-UTM orders, which
        // default to "website" — see getOrderSource) is counted as a website order by design.
        for (const row of data || []) {
            const total = Number(row.total_price) || 0;
            if (row.order_source === 'whatsapp') {
                stats.whatsapp_orders += 1;
                stats.whatsapp_revenue += total;
            } else {
                stats.website_orders += 1;
                stats.website_revenue += total;
            }
        }

        res.json(stats);
    } catch (error) {
        console.error('❌ Get Order Stats Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
}
