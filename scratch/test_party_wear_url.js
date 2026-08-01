import assert from 'assert';
import { getCategoryUrl } from '../lib/categoryUrls.js';

console.log("=== Testing getCategoryUrl for Party Wear Shirts ===");

const testCases = [
    'Party Wear Shirts',
    'party wear shirts',
    'Party Wear Shirt',
    'party wear shirt',
    'Party Wear',
    'partywear shirts',
    'partywear shirt',
    'partywear'
];

for (const testCat of testCases) {
    const url = getCategoryUrl(testCat);
    console.log(`Input: "${testCat}" => URL: ${url}`);
    assert.strictEqual(
        url,
        'https://www.supercollections.in/product-category/shirts/party-wear-shirts/?utm_source=whatsapp',
        `Failed for input: ${testCat}`
    );
}

console.log("✅ All Party Wear Shirts URL tests passed!");
