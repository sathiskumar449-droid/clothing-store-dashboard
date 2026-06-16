import dotenv from 'dotenv';
import { supabase } from '../lib/supabase.js';

dotenv.config();

async function checkProducts() {
    console.log("=== Querying Supabase Products ===");
    
    // Fetch all products
    const { data: products, error } = await supabase
        .from('products')
        .select('*');

    if (error) {
        console.error("Error fetching products:", error);
        return;
    }

    console.log(`Total products in database: ${products.length}`);

    // Print all polo fit pants
    const plainShirts = products.filter(p => p.name.toLowerCase().includes('polofit') || p.name.toLowerCase().includes('polo fit'));
    console.log(`\nFound ${plainShirts.length} products with "polofit" or "polo fit" in the name:`);
    plainShirts.forEach(p => {
        console.log(`  - ID: ${p.id} | Name: "${p.name}" | Category: "${p.category}" | Stock: ${p.stock}`);
    });

    // Check unique categories and product counts
    const counts = {};
    products.forEach(p => {
        counts[p.category] = (counts[p.category] || 0) + 1;
    });

    console.log("\nUnique Categories and counts in database:");
    Object.keys(counts).forEach(cat => {
        console.log(`  - "${cat}": ${counts[cat]} products`);
    });
}

checkProducts();
