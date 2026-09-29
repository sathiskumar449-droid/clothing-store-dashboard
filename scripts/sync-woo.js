// scripts/sync-woo.js
// Standalone script to sync WooCommerce products directly to Supabase from the local machine.
// This bypasses Cloudflare datacenter IP blocks because requests originate from a residential/local IP.

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GENERIC_CATEGORIES = ['men', 'menu', 'general', 'uncategorized', 'new arrival', 'new arrivals'];

function getPrimaryCategory(categories) {
    if (!Array.isArray(categories) || categories.length === 0) return 'General';
    const specific = categories.find(c => !GENERIC_CATEGORIES.includes((c.name || '').toLowerCase().trim()));
    return specific ? specific.name.trim() : (categories[0]?.name?.trim() || 'General');
}

function mapWooStockToSupabase(p) {
    const stockStatus = p._effective_stock_status ?? p.stock_status;
    const stockQty = p._effective_stock_quantity !== undefined ? p._effective_stock_quantity : p.stock_quantity;
    const managed = p.manage_stock;

    if (stockStatus === 'outofstock' || stockStatus === 'onbackorder') {
        return '0';
    } else if (stockStatus === 'instock' && managed && stockQty !== null && stockQty !== undefined) {
        return String(Math.max(0, Number(stockQty)));
    } else if (stockStatus === 'instock') {
        return '1';
    } else {
        return '0';
    }
}

function mapWooProductToDb(p) {
    const sizeAttr = p.attributes?.find(a => a.name?.toLowerCase() === 'size');
    const sizes = sizeAttr ? (Array.isArray(sizeAttr.options) ? sizeAttr.options : []) : [];

    const colorAttr = p.attributes?.find(a => a.name?.toLowerCase() === 'color');
    const color = colorAttr ? (Array.isArray(colorAttr.options) ? colorAttr.options[0] : colorAttr.options) : null;

    return {
        id: p.id,
        name: p.name,
        code: p.sku || String(p.id),
        category: getPrimaryCategory(p.categories),
        categories: (p.categories || []).map(c => (c.name || '').trim()).filter(Boolean),
        pattern: p.pattern || null,
        color: color || p.color || null,
        price: p.price !== undefined ? String(p.price) : '0',
        stock: mapWooStockToSupabase(p),
        sizes: sizes,
        image_uri: (() => {
            const src = p.images?.[0]?.src || null;
            if (!src) return null;
            return src.replace(/^(https?:\/\/)www\./i, '$1');
        })(),
        permalink: p.permalink || null,
        status: p.status || 'publish'
    };
}

async function attachVariationStock(product, { siteUrl, consumerKey, consumerSecret }) {
    try {
        const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wc/v3/products/${product.id}/variations?per_page=100&consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`;
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*'
            }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const variations = await resp.json();

        let effectiveQty = 0;
        for (const v of variations) {
            if (v.stock_status === 'outofstock' || v.stock_status === 'onbackorder') continue;
            if (v.manage_stock && v.stock_quantity !== null && v.stock_quantity !== undefined) {
                effectiveQty += Math.max(0, Number(v.stock_quantity));
            } else if (v.stock_status === 'instock' && !v.manage_stock) {
                effectiveQty += 1;
            }
        }

        product._effective_stock_quantity = effectiveQty;
        product._effective_stock_status = effectiveQty > 0 ? 'instock' : 'outofstock';
    } catch (e) {
        console.warn(`  ⚠️ Could not fetch variations for product ${product.id}: ${e.message}`);
    }
}

async function runSync() {
    console.log('\n🚀 Starting Local WooCommerce → Supabase Sync...');
    const startTime = Date.now();

    // 1. Fetch credentials
    console.log('📦 Reading WooCommerce credentials from Supabase settings table...');
    const { data: settingsRows, error: settingsError } = await supabase
        .from('settings')
        .select('key, value')
        .in('key', ['woo_site_url', 'woo_consumer_key', 'woo_consumer_secret']);

    if (settingsError || !settingsRows || settingsRows.length === 0) {
        throw new Error('Failed to read WooCommerce credentials from Supabase settings: ' + settingsError?.message);
    }

    const creds = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
    const siteUrl = creds.woo_site_url;
    const consumerKey = creds.woo_consumer_key;
    const consumerSecret = creds.woo_consumer_secret;

    if (!siteUrl || !consumerKey || !consumerSecret) {
        throw new Error('WooCommerce credentials incomplete in Supabase settings table.');
    }

    console.log(`🔗 Store URL: ${siteUrl}`);

    // 2. Fetch products page by page
    const baseUrl = `${siteUrl.replace(/\/$/, '')}/wp-json/wc/v3/products`;
    let allProducts = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const url = `${baseUrl}?status=publish&per_page=100&page=${page}&consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`;
        console.log(`📥 Fetching page ${page} from WooCommerce...`);

        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*'
            }
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`WooCommerce API Error HTTP ${resp.status}: ${body.substring(0, 200)}`);
        }

        const products = await resp.json();
        if (Array.isArray(products) && products.length > 0) {
            allProducts = allProducts.concat(products);
            console.log(`   Page ${page}: got ${products.length} products (total so far: ${allProducts.length})`);
            if (products.length < 100) {
                hasMore = false;
            } else {
                page++;
            }
        } else {
            hasMore = false;
        }
    }

    console.log(`\n✅ Total published products fetched: ${allProducts.length}`);

    if (allProducts.length === 0) {
        console.log('⚠️ 0 products fetched. Exiting sync without modifying database.');
        return;
    }

    // 3. Process variable products
    const variableProducts = allProducts.filter(p => p.type === 'variable');
    if (variableProducts.length > 0) {
        console.log(`🔄 Fetching variations for ${variableProducts.length} variable products...`);
        // Process in batches of 5 to avoid overwhelming WooCommerce
        const batchSize = 5;
        for (let i = 0; i < variableProducts.length; i += batchSize) {
            const chunk = variableProducts.slice(i, i + batchSize);
            await Promise.all(chunk.map(p => attachVariationStock(p, { siteUrl, consumerKey, consumerSecret })));
            process.stdout.write(`   Processed ${Math.min(i + batchSize, variableProducts.length)} / ${variableProducts.length} variable products...\r`);
        }
        console.log('\n   Variation stock attached.');
    }

    // 4. Map products to DB schema
    const dbProducts = allProducts.map(mapWooProductToDb);

    // 5. Upsert to Supabase in batches of 50
    console.log(`💾 Upserting ${dbProducts.length} products to Supabase...`);
    const upsertBatchSize = 50;
    for (let i = 0; i < dbProducts.length; i += upsertBatchSize) {
        const batch = dbProducts.slice(i, i + upsertBatchSize);
        const { error: upsertError } = await supabase
            .from('products')
            .upsert(batch, { onConflict: 'id' });

        if (upsertError) {
            throw new Error(`Failed to upsert batch starting at index ${i}: ${upsertError.message}`);
        }
    }
    console.log('✅ Upsert completed successfully!');

    // 6. Reconciliation: remove products that are no longer published in WooCommerce
    console.log('🔍 Checking for stale / unpublished products...');
    const { data: existingRows, error: existingError } = await supabase.from('products').select('id');
    if (existingError) throw existingError;

    const liveIds = new Set(dbProducts.map(p => p.id));
    const staleIds = (existingRows || []).map(r => r.id).filter(id => !liveIds.has(id));
    const staleRatio = existingRows?.length > 0 ? staleIds.length / existingRows.length : 0;

    let deletedCount = 0;
    if (staleIds.length > 0 && staleRatio <= 0.5) {
        const { error: deleteError } = await supabase.from('products').delete().in('id', staleIds);
        if (deleteError) throw deleteError;
        deletedCount = staleIds.length;
        console.log(`🗑️ Removed ${deletedCount} stale product(s) no longer in WooCommerce: ${staleIds.join(', ')}`);
    } else if (staleIds.length > 0) {
        console.warn(`⚠️ Skipped deleting ${staleIds.length} missing products as a safety guard (stale ratio: ${Math.round(staleRatio * 100)}%).`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 SYNC FINISHED in ${elapsed}s!`);
    console.log(`📊 Total Synced: ${dbProducts.length} products | Removed: ${deletedCount} deleted products\n`);
}

runSync().catch(err => {
    console.error('\n❌ Sync Failed:', err.message);
    process.exit(1);
});
