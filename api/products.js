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

// ─────────────────────────────────────────────────────────────
// Shared stock-mapping helper (used by BOTH syncProducts and handleWooWebhook)
//
// Priority rules:
//   1. outofstock / onbackorder  → always 0 (authoritative WooCommerce status)
//   2. instock + manage_stock=true + qty present → use qty (0 or more)
//   3. instock + no qty tracking (manage_stock=false or qty null) → 1 (available, qty unknown)
//   4. anything else → 0
//
// Variable products: the caller should pre-attach _effective_stock_status and
// _effective_stock_quantity (computed from variation-level data) before calling
// this helper. If those fields exist they take priority over the parent fields.
// ─────────────────────────────────────────────────────────────
function mapWooStockToSupabase(p) {
    const stockStatus = p._effective_stock_status ?? p.stock_status;
    const stockQty    = p._effective_stock_quantity !== undefined
                            ? p._effective_stock_quantity
                            : p.stock_quantity;
    const managed     = p.manage_stock;

    let stock;

    if (stockStatus === 'outofstock' || stockStatus === 'onbackorder') {
        stock = '0';
    } else if (stockStatus === 'instock' && managed && stockQty !== null && stockQty !== undefined) {
        stock = String(Math.max(0, Number(stockQty)));
    } else if (stockStatus === 'instock') {
        // No per-item quantity tracking — product is available but quantity unknown
        stock = '1';
    } else {
        stock = '0';
    }

    console.log(
        `[StockMap] id=${p.id} "${(p.name || '').substring(0, 35)}" ` +
        `stock_status=${stockStatus} qty=${stockQty} manage_stock=${managed} type=${p.type ?? '?'} → stock=${stock}`
    );

    return stock;
}

// Fetch WooCommerce credentials from the Supabase settings table so the webhook
// handler can make back-channel API calls for variable-product variation stock.
async function getWooCredentials() {
    const { data, error } = await supabase
        .from('settings')
        .select('key, value')
        .in('key', ['woo_site_url', 'woo_consumer_key', 'woo_consumer_secret']);
    if (error || !data) throw new Error('Failed to read WooCommerce credentials from Supabase');
    const m = Object.fromEntries(data.map(r => [r.key, r.value]));
    return { siteUrl: m.woo_site_url, consumerKey: m.woo_consumer_key, consumerSecret: m.woo_consumer_secret };
}

// For a variable WooCommerce product, fetch all its variations and compute the
// true effective stock (parent product has manage_stock=false + qty=null; the
// per-size stock lives entirely in the child variations).
// Mutates the product object by attaching _effective_stock_quantity and
// _effective_stock_status so that mapWooStockToSupabase() can use them.
async function attachVariationStock(product, { siteUrl, consumerKey, consumerSecret }) {
    try {
        const base64 = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wc/v3/products/${product.id}/variations?per_page=100`;
        const resp = await fetch(url, { headers: { Authorization: `Basic ${base64}` } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const variations = await resp.json();

        let effectiveQty = 0;
        for (const v of variations) {
            if (v.stock_status === 'outofstock' || v.stock_status === 'onbackorder') continue;
            if (v.manage_stock && v.stock_quantity !== null && v.stock_quantity !== undefined) {
                effectiveQty += Math.max(0, Number(v.stock_quantity));
            } else if (v.stock_status === 'instock' && !v.manage_stock) {
                // Untracked variation that is marked instock → count as 1 available unit
                effectiveQty += 1;
            }
        }

        product._effective_stock_quantity = effectiveQty;
        product._effective_stock_status   = effectiveQty > 0 ? 'instock' : 'outofstock';
        console.log(
            `[Variations] id=${product.id} variations=${variations.length} ` +
            `effective_qty=${effectiveQty} → ${product._effective_stock_status}`
        );
    } catch (e) {
        console.warn(`[Variations] Could not fetch variations for product ${product.id}: ${e.message}`);
    }
}

// Helper: map a single WooCommerce product payload → database row schema.
// Stock is computed by mapWooStockToSupabase (shared with syncProducts).
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
        stock:       mapWooStockToSupabase(p),
        sizes:       sizes,
        image_uri:   p.images?.[0]?.src || null,
        permalink:   p.permalink || null,
        status:      p.status || 'publish'
    };
};

// ✅ Batch Sync products from WooCommerce — also the self-healing reconciliation point (no
// Vercel Cron on the Hobby plan: 10s function timeout and once-a-day-only cron schedules rule
// out a background job for a ~214-product catalog). The dashboard's "Refresh" button already
// does the slow part (fetching every published product + per-variation stock) in the OWNER'S
// BROWSER via getWooProducts() — that has no Vercel timeout at all, since it never touches a
// Vercel function until it POSTs the finished array here. This endpoint only does one bulk
// upsert plus one delete query, so it stays fast regardless of catalog size.
export const syncProducts = async (req, res) => {
    try {
        const { products } = req.body;

        if (!Array.isArray(products)) {
            return res.status(400).json({
                success: false,
                message: 'Products array required'
            });
        }

        // Safety guard — an empty payload (WooCommerce credentials expired, site unreachable
        // mid-fetch, etc.) must never be treated as "the store now has 0 products" and wipe
        // everything in the reconciliation step below. Bail out before touching Supabase at all.
        if (products.length === 0) {
            console.warn('[SyncProducts] Received an empty products array — skipping sync entirely (no upsert, no delete) to protect existing data.');
            return res.status(400).json({
                success: false,
                message: 'Received 0 products from WooCommerce — sync skipped to protect existing data. Check the WooCommerce connection and try again.'
            });
        }

        console.log(`🔄 Syncing ${products.length} products from WooCommerce...`);

        // mapWooProductToDb calls mapWooStockToSupabase which logs every product's
        // stock_status / qty / computed result — visible in Vercel logs.
        const dbProducts = products.map(p => mapWooProductToDb(p));

        console.log('[SyncProducts] First mapped row about to be upserted:', JSON.stringify(dbProducts[0]));

        // Batch upsert to Supabase
        const { data, error } = await supabase
            .from('products')
            .upsert(dbProducts, { onConflict: 'id' })
            .select();

        if (error) throw error;

        const sample = (data || []).find(r => r.id === dbProducts[0]?.id);
        console.log('[SyncProducts] Row returned by Supabase after upsert:', JSON.stringify(sample));

        // ─── Reconciliation: remove anything no longer live ───
        // getWooProducts() (dashboard-web/src/api/productsApi.js) fetches the FULL published
        // catalog with status=publish before calling this endpoint, so `products` here IS the
        // complete live catalog, not a partial slice — any Supabase row whose id isn't in it has
        // been deleted, trashed, or unpublished in WooCommerce since the last sync. This is
        // exactly how a handful of dead "white shirt" listings lingered in Supabase and kept
        // getting recommended by the bot with 404 links — syncProducts previously only ever
        // upserted, never removed anything.
        //
        // Guarded the same way the webhook's own status check is guarded: skip the delete if
        // more than half of today's known catalog would vanish — that smells like a bad/partial
        // fetch rather than the catalog actually shrinking that much. The upsert above still ran,
        // so nothing is lost by waiting for the owner's next Refresh click to retry the delete.
        const { data: existingRows, error: existingError } = await supabase.from('products').select('id');
        if (existingError) throw existingError;

        const knownIds = existingRows || [];
        const liveIds = new Set(dbProducts.map(p => p.id));
        const staleIds = knownIds.map(r => r.id).filter(id => !liveIds.has(id));
        const staleRatio = knownIds.length > 0 ? staleIds.length / knownIds.length : 0;

        let deletedCount = 0;
        if (staleIds.length > 0 && staleRatio <= 0.5) {
            const { error: deleteError } = await supabase.from('products').delete().in('id', staleIds);
            if (deleteError) throw deleteError;
            deletedCount = staleIds.length;
            console.log(`🗑️ [SyncProducts] Removed ${deletedCount} product(s) no longer published in WooCommerce: ${staleIds.join(', ')}`);
        } else if (staleIds.length > 0) {
            console.warn(`[SyncProducts] ${staleIds.length}/${knownIds.length} Supabase products (${Math.round(staleRatio * 100)}%) are missing from this sync's fetch — skipping delete as a safety guard.`);
        }

        console.log(`✅ Successfully synced ${dbProducts.length} products to database! (${deletedCount} removed)`);

        res.json({
            success: true,
            message: `Successfully synced ${dbProducts.length} products to database! Removed ${deletedCount} no-longer-published product(s).`,
            count: dbProducts.length,
            deleted: deletedCount
        });
    } catch (error) {
        console.error('❌ Sync Products Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
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

            // A status transition (trash/draft/pending/private) arrives as 'product.updated', not
            // 'product.deleted' — WooCommerce only fires product.deleted on a genuine permanent
            // delete. Previously this branch upserted the payload regardless of status, so
            // un-publishing a product (without permanently deleting it) left it fully visible to
            // the bot forever. Remove it from Supabase the moment it's no longer 'publish' instead.
            if (payload.status && payload.status !== 'publish') {
                const { error } = await supabase.from('products').delete().eq('id', payload.id);
                if (error) throw error;
                console.log(`🗑️ [WooCommerce Webhook] Product ${payload.id} (${payload.name}) status="${payload.status}" — removed from Supabase.`);
                return res.json({ success: true });
            }

            // Variable products carry stock at the variation level (parent has manage_stock=false,
            // stock_quantity=null). Fetch variation stock via back-channel API call so
            // mapWooStockToSupabase() gets accurate _effective_stock_* fields.
            if (payload.type === 'variable') {
                try {
                    const creds = await getWooCredentials();
                    await attachVariationStock(payload, creds);
                } catch (e) {
                    console.warn(`[WooWebhook] Could not enrich variation stock for product ${payload.id}: ${e.message} — falling back to parent stock_status`);
                }
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
