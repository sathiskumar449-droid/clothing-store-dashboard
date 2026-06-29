// api/products.js  — Supabase version (replaces fs-based implementation)
import { supabase } from '../lib/supabase.js';
import { verifyWooWebhookSignature } from '../lib/wooWebhookAuth.js';

const WOOCOMMERCE_WEBHOOK_SECRET = process.env.WOOCOMMERCE_WEBHOOK_SECRET;

console.log('[WooCommerce Product Webhook] WOOCOMMERCE_WEBHOOK_SECRET configured:', !!WOOCOMMERCE_WEBHOOK_SECRET);

// ✅ Get all products
export const getProducts = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('created_at', { ascending: true });

        if (error) throw error;

        // Map snake_case DB columns to the camelCase shape every other consumer of a
        // product object expects (dbRowToProduct is also used by addProduct/updateProduct
        // below, and webhook.js's own getProducts() does the same image_uri -> imageUri
        // mapping for the bot) — this endpoint was the one place still leaking raw rows.
        res.json((data || []).map(dbRowToProduct));
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
        id:        row.id,
        name:      row.name,
        code:      row.code,
        category:  row.category,
        pattern:   row.pattern,
        color:     row.color,
        price:     row.price,
        stock:     row.stock,
        sizes:     row.sizes    || [],
        imageUri:  row.image_uri,
        permalink: row.permalink || null
    };
}

// Generic umbrella categories ("Men") and marketing tags ("New Arrival") aren't real
// WooCommerce category pages, so skip them when picking the primary category — otherwise a
// product like ["New Arrival", "white shirts"] gets stored with category "New Arrival",
// which has no entry in lib/categoryUrls.js and falls all the way back to the generic shop page.
const GENERIC_CATEGORIES = ['men', 'menu', 'general', 'uncategorized', 'new arrival', 'new arrivals'];

// Returns the most specific WooCommerce category (skips generic umbrella ones like "Men").
const getPrimaryCategory = (categories) => {
    if (!Array.isArray(categories) || categories.length === 0) return 'General';
    const specific = categories.find(c => !GENERIC_CATEGORIES.includes((c.name || '').toLowerCase().trim()));
    return specific ? specific.name.trim() : (categories[0]?.name?.trim() || 'General');
};

// ✅ Batch Sync products from WooCommerce
export const syncProducts = async (req, res) => {
    try {
        const { products } = req.body;

        if (!Array.isArray(products)) {
            return res.status(400).json({
                success: false,
                message: 'Products array required'
            });
        }

        console.log(`🔄 Syncing ${products.length} products from WooCommerce...`);

        // Format products to match database schema
        const dbProducts = products.map(p => {
            // Find "Size" attribute options
            const sizeAttr = p.attributes?.find(a => a.name?.toLowerCase() === 'size');
            const sizes = sizeAttr ? (Array.isArray(sizeAttr.options) ? sizeAttr.options : []) : [];

            // Find "Color" attribute value
            const colorAttr = p.attributes?.find(a => a.name?.toLowerCase() === 'color');
            const color = colorAttr ? (Array.isArray(colorAttr.options) ? colorAttr.options[0] : colorAttr.options) : null;

            // Map WooCommerce fields
            return {
                id:          p.id, // WooCommerce numeric ID
                name:        p.name,
                code:        p.sku || String(p.id),
                category:    getPrimaryCategory(p.categories),
                categories:  (p.categories || []).map(c => (c.name || '').trim()).filter(Boolean),
                pattern:     p.pattern || null,
                color:       color || p.color || null,
                price:       p.price !== undefined ? String(p.price) : '0',
                stock:       p.stock_quantity !== null && p.stock_quantity !== undefined
                                ? String(p.stock_quantity)
                                : (p.stock_status === 'instock' ? '10' : '0'),
                sizes:       sizes,
                image_uri:   p.images?.[0]?.src || null,
                permalink:   p.permalink || null
            };
        });

        if (dbProducts.length > 0) {
            console.log('[SyncProducts] First mapped row about to be upserted:', JSON.stringify(dbProducts[0]));
        }

        // Batch upsert to Supabase
        const { data, error } = await supabase
            .from('products')
            .upsert(dbProducts, { onConflict: 'id' })
            .select();

        if (error) throw error;

        const sample = (data || []).find(r => r.id === dbProducts[0]?.id);
        console.log('[SyncProducts] Row returned by Supabase after upsert:', JSON.stringify(sample));

        console.log(`✅ Successfully synced ${dbProducts.length} products to database!`);

        res.json({
            success: true,
            message: `Successfully synced ${dbProducts.length} products to database!`,
            count: dbProducts.length
        });
    } catch (error) {
        console.error('❌ Sync Products Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Helper to map a single WooCommerce product payload into database schema
const mapWooProductToDb = (p) => {
    const sizeAttr = p.attributes?.find(a => a.name?.toLowerCase() === 'size');
    const sizes = sizeAttr ? (Array.isArray(sizeAttr.options) ? sizeAttr.options : []) : [];

    const colorAttr = p.attributes?.find(a => a.name?.toLowerCase() === 'color');
    const color = colorAttr ? (Array.isArray(colorAttr.options) ? colorAttr.options[0] : colorAttr.options) : null;

    return {
        id:          p.id,
        name:        p.name,
        code:        p.sku || String(p.id),
        category:    getPrimaryCategory(p.categories),
        categories:  (p.categories || []).map(c => (c.name || '').trim()).filter(Boolean),
        pattern:     p.pattern || null,
        color:       color || p.color || null,
        price:       p.price !== undefined ? String(p.price) : '0',
        stock:       p.stock_quantity !== null && p.stock_quantity !== undefined
                        ? String(p.stock_quantity)
                        : (p.stock_status === 'instock' ? '10' : '0'),
        sizes:       sizes,
        image_uri:   p.images?.[0]?.src || null,
        permalink:   p.permalink || null
    };
};

// ✅ WooCommerce Webhook Handler (Automatic Live Sync)
export const handleWooWebhook = async (req, res) => {
    const topic = req.headers['x-wc-webhook-topic'] || '';
    console.log(`🔌 [WooCommerce Webhook] Topic: "${topic}"`);

    // Signature verification — same HMAC-SHA256 check as api/woocommerce-order-webhook.js,
    // against the WooCommerce-configured secret for THIS webhook (Settings > Advanced >
    // Webhooks > the product.* webhook's own Secret field). If that secret doesn't match
    // WOOCOMMERCE_WEBHOOK_SECRET, every real WooCommerce call will start failing this check —
    // update the webhook's Secret in WooCommerce admin to match before relying on this.
    if (WOOCOMMERCE_WEBHOOK_SECRET) {
        const signature = req.headers['x-wc-webhook-signature'];
        if (!signature) {
            console.error('[WooCommerce Webhook] ❌ Missing x-wc-webhook-signature header — rejecting');
            return res.status(400).send('Missing signature');
        }

        const rawBody = req.rawBody || '';
        if (!verifyWooWebhookSignature(rawBody, signature, WOOCOMMERCE_WEBHOOK_SECRET)) {
            console.error('[WooCommerce Webhook] ❌ Signature mismatch — rejecting (possible spoofed request)');
            return res.status(400).send('Invalid signature');
        }
        console.log('[WooCommerce Webhook] ✅ Signature verified');
    } else {
        console.warn('[WooCommerce Webhook] ⚠️ WOOCOMMERCE_WEBHOOK_SECRET not configured — signature verification bypassed');
    }

    try {
        const payload = req.body;

        // WooCommerce verification test
        if (topic.includes('webhook.test') || topic.includes('should_deliver')) {
            return res.json({ success: true, message: 'Webhook registered successfully!' });
        }

        if (topic === 'product.created' || topic === 'product.updated') {
            if (!payload || !payload.id) {
                return res.status(400).json({ success: false, message: 'Invalid payload' });
            }

            const dbProduct = mapWooProductToDb(payload);
            console.log('[WooWebhook] Mapped row about to be upserted:', JSON.stringify(dbProduct));
            const { error } = await supabase
                .from('products')
                .upsert([dbProduct], { onConflict: 'id' });

            if (error) throw error;
            console.log(`✅ [WooCommerce Webhook] Product ${payload.id} (${payload.name}) synced successfully.`);
        } 
        
        else if (topic === 'product.deleted') {
            if (!payload || !payload.id) {
                return res.status(400).json({ success: false, message: 'Invalid payload' });
            }

            const { error } = await supabase
                .from('products')
                .delete()
                .eq('id', payload.id);

            if (error) throw error;
            console.log(`🗑️ [WooCommerce Webhook] Product ${payload.id} deleted successfully.`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ WooCommerce Webhook Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};
