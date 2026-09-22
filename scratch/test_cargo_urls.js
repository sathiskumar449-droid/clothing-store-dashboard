import { getCategoryUrl } from '../lib/categoryUrls.js';

console.log('=== CARGO URL VERIFICATION TESTS ===');
const testCases = [
    'cargo pant',
    'cargo pants',
    'Cargo Pant',
    'Cargo Pants',
    'cargo',
    'cargo track pant',
    'Cargo Track Pants',
    'black cargo pant'
];

let failed = false;
for (const tc of testCases) {
    const url = getCategoryUrl(tc);
    console.log(`Input: "${tc}" => ${url}`);
    if (!url.includes('product-category/cargo-pants/')) {
        console.error(`❌ Test failed for "${tc}": expected /product-category/cargo-pants/ but got ${url}`);
        failed = true;
    }
}

if (failed) {
    console.error('\n❌ CARGO URL TESTS FAILED!');
    process.exit(1);
} else {
    console.log('\n✅ ALL CARGO URL TESTS PASSED PERFECTLY!');
}
