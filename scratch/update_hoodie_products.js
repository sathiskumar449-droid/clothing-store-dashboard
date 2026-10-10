import { supabase } from '../lib/supabase.js';

const newHoodies = [
    {
        id: 20446,
        name: 'Hoodie - White',
        code: 'HOODIE-004',
        category: 'Hoody',
        categories: ['Hoody'],
        price: '399',
        stock: '10',
        sizes: ['M', 'L', 'XL', 'XXL'],
        image_uri: 'https://www.supercollections.in/wp-content/uploads/2026/10/WhatsApp-Image-2026-10-10-at-7.22.02-AM-600x600.jpeg',
        permalink: 'https://www.supercollections.in/product/hoodie-off-white/',
        status: 'publish',
        created_at: new Date().toISOString()
    },
    {
        id: 20445,
        name: 'Hoodie - Royal Blue',
        code: 'HOODIE-003',
        category: 'Hoody',
        categories: ['Hoody'],
        price: '399',
        stock: '10',
        sizes: ['M', 'L', 'XL', 'XXL'],
        image_uri: 'https://www.supercollections.in/wp-content/uploads/2026/10/WhatsApp-Image-2026-10-10-at-7.22.02-AM-1-600x600.jpeg',
        permalink: 'https://www.supercollections.in/product/hoodie-royal-blue/',
        status: 'publish',
        created_at: new Date().toISOString()
    },
    {
        id: 20444,
        name: 'Hoodie - Coral Red',
        code: 'HOODIE-002',
        category: 'Hoody',
        categories: ['Hoody'],
        price: '399',
        stock: '10',
        sizes: ['M', 'L', 'XL', 'XXL'],
        image_uri: 'https://www.supercollections.in/wp-content/uploads/2026/10/WhatsApp-Image-2026-10-10-at-7.22.03-AM-600x600.jpeg',
        permalink: 'https://www.supercollections.in/product/hoodie-coral-red/',
        status: 'publish',
        created_at: new Date().toISOString()
    },
    {
        id: 20443,
        name: 'Hoodie - Light Grey Melange',
        code: 'HOODIE-001',
        category: 'Hoody',
        categories: ['Hoody'],
        price: '399',
        stock: '10',
        sizes: ['M', 'L', 'XL', 'XXL'],
        image_uri: 'https://www.supercollections.in/wp-content/uploads/2026/10/WhatsApp-Image-2026-10-10-at-7.22.03-AM-1-600x600.jpeg',
        permalink: 'https://www.supercollections.in/product/hoodie-light-grey-melange/',
        status: 'publish',
        created_at: new Date().toISOString()
    }
];

const oldHoodieIds = [14158, 14159, 14160, 14161, 14162, 14163, 14193, 14211];

async function updateProducts() {
    console.log('1. Deleting old 8 hoodies from Supabase...');
    const { error: delError } = await supabase
        .from('products')
        .delete()
        .in('id', oldHoodieIds);

    if (delError) {
        console.error('Delete error:', delError);
    } else {
        console.log('Successfully deleted old hoodies:', oldHoodieIds);
    }

    console.log('2. Upserting 4 new hoodies into Supabase...');
    const { data: upsertData, error: upsertError } = await supabase
        .from('products')
        .upsert(newHoodies, { onConflict: 'id' })
        .select();

    if (upsertError) {
        console.error('Upsert error:', upsertError);
    } else {
        console.log('Successfully inserted/updated new hoodies count:', upsertData.length);
        for (const p of upsertData) {
            console.log(`  + ${p.id} | ${p.name} | ${p.price} | ${p.category} | ${p.image_uri}`);
        }
    }

    console.log('3. Clearing collage_cache for hoody...');
    try {
        const { data: delCache, error: cacheErr } = await supabase
            .from('collage_cache')
            .delete()
            .ilike('cache_key', '%hood%');
        console.log('Cleared collage cache for hoody. Error:', cacheErr?.message || 'none');
    } catch (e) {
        console.error('Cache clear error:', e.message);
    }

    console.log('4. Checking current hoody products in DB:');
    const { data: finalHoodies } = await supabase
        .from('products')
        .select('*')
        .ilike('category', '%hood%');
    console.log(`Total hoodies now in DB: ${finalHoodies.length}`);
    finalHoodies.forEach(h => console.log(`  * ${h.id} | ${h.name} | stock: ${h.stock} | status: ${h.status}`));
}

updateProducts();
