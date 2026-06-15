import { getProducts } from '../api/webhook.js';

const products = await getProducts();
const matched = products.filter(p => p.name.toLowerCase().includes('polo') || p.name.toLowerCase().includes('pant'));
console.log(`Found ${matched.length} matching products:`);
matched.forEach(p => {
    console.log(`- ID: ${p.id} | Name: "${p.name}" | imageUri: "${p.imageUri}"`);
});
process.exit(0);
