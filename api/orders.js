// api/orders.js  — Supabase version (replaces fs-based implementation)
import { supabase } from '../lib/supabase.js';

// ✅ Get all orders — optionally filtered to a date range via ?startDate=&endDate=
// (ISO timestamps, inclusive on both ends). Filtering happens in the Supabase query itself
// rather than in-memory so the "Today"/date-picker views on the dashboard stay fast as the
// orders table grows, instead of always pulling every row.
export const getOrders = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        let query = supabase
            .from('orders')
            .select('*')
            .order('date', { ascending: false, nullsFirst: false });

        if (startDate) query = query.gte('date', startDate);
        if (endDate) query = query.lte('date', endDate);

        const { data, error } = await query;

        if (error) throw error;

        // Cross-reference each order's customer_phone against the chats table (no FK between the
        // two, so this can't be done as a single embedded Supabase select) — lets the dashboard
        // tell a WooCommerce order placed by a known WhatsApp contact apart from a first-time
        // website visitor.
        const phones = [...new Set(data.map(row => row.customer_phone).filter(Boolean))];
        let chatPhones = new Set();
        if (phones.length > 0) {
            const { data: chatRows, error: chatsError } = await supabase
                .from('chats')
                .select('customer_phone')
                .in('customer_phone', phones);
            if (chatsError) throw chatsError;
            chatPhones = new Set(chatRows.map(row => row.customer_phone));
        }

        // Return in the same format as the original JSON array
        res.json(data.map(row => dbRowToOrder(row, chatPhones)));
    } catch (error) {
        console.error('❌ Get Orders Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ✅ Update order status
export const updateOrderStatus = async (req, res) => {
    try {
        const orderId    = req.params.id;
        const { status } = req.body;

        const { data, error } = await supabase
            .from('orders')
            .update({ status })
            .eq('id', orderId)
            .select()
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ success: false, message: 'Order not found' });
            }
            throw error;
        }

        res.json({
            success: true,
            message: 'Order status updated successfully',
            order: dbRowToOrder(data)
        });
    } catch (error) {
        console.error('❌ Update Order Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────
// Helper: map DB row → original JSON shape
// Handles both new-style and legacy flat orders
// ─────────────────────────────────────────────────────────────
function dbRowToOrder(row, chatPhones = new Set()) {
    const base = {
        id:             row.id,
        status:         row.status,
        customerPhone:  row.customer_phone,
        customerName:   row.customer_name,
        customerAddress:row.customer_address,
        items:          row.items || [],
        totalPrice:     row.total_price,
        date:           row.date,
        source:         row.source || 'whatsapp',
        isWhatsAppUser: chatPhones.has(row.customer_phone)
    };

    // Attach legacy fields if they exist (non-null) so the dashboard still works
    if (row.order_id)        base.orderId        = row.order_id;
    if (row.shirt_name)      base.shirtName      = row.shirt_name;
    if (row.shirt_code)      base.shirtCode      = row.shirt_code;
    if (row.shirt_price)     base.shirtPrice     = row.shirt_price;
    if (row.shirt_size)      base.shirtSize      = row.shirt_size;
    if (row.shirt_color)     base.shirtColor     = row.shirt_color;
    if (row.pant_name)       base.pantName       = row.pant_name;
    if (row.pant_code)       base.pantCode       = row.pant_code;
    if (row.pant_price)      base.pantPrice      = row.pant_price;
    if (row.pant_size)       base.pantSize       = row.pant_size;
    if (row.pant_color)      base.pantColor      = row.pant_color;
    if (row.customer_details)base.customerDetails= row.customer_details;
    if (row.payment_method)  base.paymentMethod  = row.payment_method;
    if (row.created_at)      base.createdAt      = row.created_at;

    return base;
}
