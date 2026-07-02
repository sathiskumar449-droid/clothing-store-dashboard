// api/order-stats.js
// Returns WhatsApp-vs-website order counts/revenue for a single day, used by the dashboard's
// "WhatsApp Orders" / "Website Orders" stat cards.
import { supabase } from '../lib/supabase.js';

// Day boundaries are computed in IST (Asia/Kolkata), matching dashboard-web's dateFilter.js
// convention, so "today" lines up with the owner's own calendar day rather than UTC.
function istDayBounds(dateStr) {
    return {
        start: `${dateStr}T00:00:00+05:30`,
        end: `${dateStr}T23:59:59.999+05:30`
    };
}

function todayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // en-CA -> YYYY-MM-DD
}

export async function getOrderStats(req, res) {
    try {
        const date = req.query.date || todayIST();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ success: false, message: 'Invalid date, expected YYYY-MM-DD' });
        }

        const { start, end } = istDayBounds(date);

        const { data, error } = await supabase
            .from('orders')
            .select('order_source, total_price')
            .gte('date', start)
            .lte('date', end);

        if (error) throw error;

        const stats = {
            whatsapp_orders: 0,
            website_orders: 0,
            whatsapp_revenue: 0,
            website_revenue: 0
        };

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
