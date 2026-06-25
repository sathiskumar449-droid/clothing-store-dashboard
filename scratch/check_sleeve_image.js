import { getProducts, getProductImageUri } from '../api/webhook.js';

const products = await getProducts();
const matched = products.filter(p => p.name.toLowerCase().includes('sleeve'));
console.log(`Found ${matched.length} matching products:`);
matched.forEach(p => {
    const resolved = getProductImageUri(p, products);
    console.log(`- id=${p.id} name="${p.name}" rawImageUri=${p.imageUri ? 'SET' : 'NULL'} resolved=${resolved || 'NULL (no header)'}`);
});
process.exit(0);
