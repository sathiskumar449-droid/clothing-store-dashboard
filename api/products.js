// api/products.js  — Supabase version (replaces fs-based implementation)
import { supabase } from '../lib/supabase.js';

// ✅ Get all products
export const getProducts = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('created_at', { ascending: true });

        if (error) throw error;

        res.json(data);
    } catch (error) {
        console.error('❌ Get Products Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ✅ Add product
export const addProduct = async (req, res) => {
    try {
        const product = req.body;

        console.log('📦 Incoming Product:', product);

        if (!product.name) {
            return res.status(400).json({
                success: false,
                message: 'Product name required'
            });
        }

        // Generate numeric timestamp ID (mirrors the old JSON behaviour)
        const newProduct = {
            id:         Date.now(),
            name:       product.name,
            code:       product.code       || null,
            category:   product.category   || null,
            pattern:    product.pattern     || null,
            color:      product.color       || null,
            price:      product.price       !== undefined ? String(product.price) : null,
            stock:      product.stock       !== undefined ? String(product.stock) : '0',
            sizes:      Array.isArray(product.sizes) ? product.sizes : [],
            image_uri:  product.imageUri    || product.image_uri || null
        };

        const { data, error } = await supabase
            .from('products')
            .insert([newProduct])
            .select()
            .single();

        if (error) throw error;

        console.log('✅ Product Saved');

        // Shape the response to match the original JSON format
        res.json({
            success: true,
            message: 'Product added successfully',
            product: dbRowToProduct(data)
        });
    } catch (error) {
        console.error('❌ Add Product Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ✅ Update product
export const updateProduct = async (req, res) => {
    try {
        const productId = req.params.id;
        const updates   = req.body;

        // Build the update payload mapping camelCase → snake_case
        const dbUpdates = {};
        if (updates.name      !== undefined) dbUpdates.name      = updates.name;
        if (updates.code      !== undefined) dbUpdates.code      = updates.code;
        if (updates.category  !== undefined) dbUpdates.category  = updates.category;
        if (updates.pattern   !== undefined) dbUpdates.pattern   = updates.pattern;
        if (updates.color     !== undefined) dbUpdates.color     = updates.color;
        if (updates.price     !== undefined) dbUpdates.price     = String(updates.price);
        if (updates.stock     !== undefined) dbUpdates.stock     = String(updates.stock);
        if (updates.sizes     !== undefined) dbUpdates.sizes     = Array.isArray(updates.sizes) ? updates.sizes : [];
        if (updates.imageUri  !== undefined) dbUpdates.image_uri = updates.imageUri;
        if (updates.image_uri !== undefined) dbUpdates.image_uri = updates.image_uri;

        const { data, error } = await supabase
            .from('products')
            .update(dbUpdates)
            .eq('id', productId)
            .select()
            .single();

        if (error) {
            if (error.code === 'PGRST116') {   // PostgREST: no rows found
                return res.status(404).json({ success: false, message: 'Product not found' });
            }
            throw error;
        }

        res.json({
            success: true,
            message: 'Product updated successfully',
            product: dbRowToProduct(data)
        });
    } catch (error) {
        console.error('❌ Update Product Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ✅ Delete product
export const deleteProduct = async (req, res) => {
    try {
        const productId = req.params.id;

        // Check existence first so we can return a proper 404
        const { data: existing, error: fetchError } = await supabase
            .from('products')
            .select('id')
            .eq('id', productId)
            .maybeSingle();

        if (fetchError) throw fetchError;

        if (!existing) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        const { error } = await supabase
            .from('products')
            .delete()
            .eq('id', productId);

        if (error) throw error;

        res.json({ success: true, message: 'Product deleted successfully' });
    } catch (error) {
        console.error('❌ Delete Product Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────
// Helper: map DB row → original JSON shape
// ─────────────────────────────────────────────────────────────
function dbRowToProduct(row) {
    return {
        id:       row.id,
        name:     row.name,
        code:     row.code,
        category: row.category,
        pattern:  row.pattern,
        color:    row.color,
        price:    row.price,
        stock:    row.stock,
        sizes:    row.sizes    || [],
        imageUri: row.image_uri
    };
}