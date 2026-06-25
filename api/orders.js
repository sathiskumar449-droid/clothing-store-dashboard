// api/orders.js  — Supabase version (replaces fs-based implementation)
import { supabase } from '../lib/supabase.js';

// ✅ Get all orders
export const getOrders = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .order('date', { ascending: false, nullsFirst: false });

        if (error) throw error;

        // Return in the same format as the original JSON array
        res.json(data.map(dbRowToOrder));
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
function dbRowToOrder(row) {
    const base = {
        id:             row.id,
        status:         row.status,
        customerPhone:  row.customer_phone,
        customerName:   row.customer_name,
        customerAddress:row.customer_address,
        items:          row.items || [],
        totalPrice:     row.total_price,
        date:           row.date,
        source:         row.source || 'whatsapp'
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
