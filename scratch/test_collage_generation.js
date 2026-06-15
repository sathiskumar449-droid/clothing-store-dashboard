import { getProducts } from '../api/webhook.js';
import { createProductCollage } from '../lib/collage.js';

async function test() {
    console.log("🚀 Starting collage generation test...");
    const products = await getProducts();
    if (products.length === 0) {
        console.error("❌ No products found in Supabase to test with!");
        process.exit(1);
    }

    // Let's take the first 5 products that have valid images
    const testProducts = products.filter(p => p.imageUri && p.imageUri.startsWith('http')).slice(0, 5);
    
    if (testProducts.length === 0) {
        console.warn("⚠️ No products with HTTP images found. Using first 5 products anyway (should fallback to placeholders).");
        testProducts.push(...products.slice(0, 5));
    }

    console.log(`📄 Selected ${testProducts.length} products for test collage:`);
    testProducts.forEach((p, idx) => {
        console.log(`  - #${idx + 1}: ${p.name} | Image: ${p.imageUri}`);
    });

    console.log("🎨 Creating collage (start index = 1)...");
    const collageUrl = await createProductCollage(testProducts, 1, products);

    if (collageUrl) {
        console.log(`\n✅ Collage successfully created!`);
        console.log(`🔗 Public URL: ${collageUrl}`);
    } else {
        console.error(`\n❌ Failed to create collage!`);
    }

    process.exit(0);
}

test();
