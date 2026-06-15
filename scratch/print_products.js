import { getProducts } from '../api/webhook.js';

const products = await getProducts();
console.log(`Loaded ${products.length} products:`);
products.forEach(p => {
    console.log(`- ID: ${p.id} | Name: "${p.name}" | Category: "${p.category}" | Color: "${p.color}" | ImageURI: "${p.imageUri}" | Stock: ${p.stock}`);
});
process.exit(0);
