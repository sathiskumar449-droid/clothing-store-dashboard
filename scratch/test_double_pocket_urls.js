import assert from 'assert';
import { getCategoryUrl } from '../lib/categoryUrls.js';

console.log("=== Testing getCategoryUrl for Double Pocket Shirts ===");

const expectedUrl = 'https://www.supercollections.in/product-category/shirts/double-pocket-shirts/?utm_source=whatsapp';

const testCases = [
    'Double Pocket Shirts',
    'double pocket shirts',
    'Double Pocket Shirt',
    'double pocket shirt',
    'Double Pocket',
    'double pocket',
    'double pocket shirts archives',
    'Double Pocket Shirts Archives'
];

for (const tc of testCases) {
    const url = getCategoryUrl(tc);
    console.log(`Input: "${tc}" => URL: ${url}`);
    assert.strictEqual(url, expectedUrl, `Failed for input: "${tc}"`);
}

console.log("\n=== Testing getCategoryUrl for Double Pocket Checks Shirts ===");

const expectedChecksUrl = 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/?utm_source=whatsapp';

const checksTestCases = [
    'Double Pocket Checks Shirts',
    'double pocket checks shirts',
    'Double Pocket Checks Shirt',
    'double pocket checks shirt',
    'Double Pocket Check Shirts',
    'double pocket check shirts',
    'Double Pocket Check Shirt',
    'double pocket check shirt',
    'Double Pocket Checked Shirts',
    'double pocket checked shirt',
    'Double Pocket Checks',
    'double pocket checks',
    'Double Pocket Check',
    'double pocket check',
    'Double Pocket Checks Shirts Archives',
    'double pocket checks shirts archives',
    'Double Pocket Check Shirts Archives',
    'double pocket check shirts archives',
    'Double Pocket Checks Shirt Archives',
    // also fallback substring matches:
    'Double pocket checks combo',
    'Double pocket check full sleeve'
];

for (const ctc of checksTestCases) {
    const url = getCategoryUrl(ctc);
    console.log(`Input: "${ctc}" => URL: ${url}`);
    assert.strictEqual(url, expectedChecksUrl, `Failed for input: "${ctc}"`);
}

// Also test other shirt categories added
const otherTests = [
    { input: 'Oxford Shirts', expected: 'https://www.supercollections.in/product-category/shirts/oxford-shirts/?utm_source=whatsapp' },
    { input: 'Five Sleeve Shirts', expected: 'https://www.supercollections.in/product-category/shirts/five-sleeve-shirts/?utm_source=whatsapp' },
    { input: 'Checked Shirts', expected: 'https://www.supercollections.in/product-category/shirts/checked-shirts/?utm_source=whatsapp' },
    { input: 'Cotton Lenin Plain Full Sleeve', expected: 'https://www.supercollections.in/product-category/shirts/cotton-lenin-plain-full-sleeve/?utm_source=whatsapp' }
];

for (const ot of otherTests) {
    const url = getCategoryUrl(ot.input);
    console.log(`Input: "${ot.input}" => URL: ${url}`);
    assert.strictEqual(url, ot.expected, `Failed for input: "${ot.input}"`);
}

// Verify that T-Shirts still map correctly
const tShirtTests = [
    { input: 't-shirts', expected: 'https://www.supercollections.in/product-category/t-shirts-2/?utm_source=whatsapp' },
    { input: 't shirts', expected: 'https://www.supercollections.in/product-category/t-shirts-2/?utm_source=whatsapp' },
    { input: 'tshirt', expected: 'https://www.supercollections.in/product-category/t-shirts-2/?utm_source=whatsapp' },
    { input: 'Five Sleeve T-Shirts', expected: 'https://www.supercollections.in/product-category/t-shirts-2/five-sleeve-t-shirts/?utm_source=whatsapp' }
];

for (const tt of tShirtTests) {
    const url = getCategoryUrl(tt.input);
    console.log(`Input: "${tt.input}" => URL: ${url}`);
    assert.strictEqual(url, tt.expected, `Failed for input: "${tt.input}"`);
}

console.log("\n✅ ALL DOUBLE POCKET & SHIRT URL TESTS PASSED PERFECTLY!");
