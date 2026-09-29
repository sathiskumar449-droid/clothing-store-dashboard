import assert from 'assert';
import { getCategoryUrl } from '../lib/categoryUrls.js';
import { detectNewFaqIntent } from '../lib/intents.js';

console.log("=== Testing 2XL Shirts Category URLs and Intents ===");

const expected2XLUrl = 'https://www.supercollections.in/product-category/shirts/2xl-shirts/?utm_source=whatsapp';

// 1. Test getCategoryUrl
const urlTestCases = [
    '2XL Shirts',
    '2xl shirts',
    '2XL Shirt',
    '2xl shirt',
    '2xl',
    '2xl-shirts',
    '2xl-shirt',
    '2xl shirts archives',
    'xxl shirts',
    'xxl shirt',
    'xxl',
    'XXL Shirt'
];

for (const tc of urlTestCases) {
    const url = getCategoryUrl(tc);
    console.log(`[URL Test] "${tc}" => ${url}`);
    assert.strictEqual(url, expected2XLUrl, `Failed for input: "${tc}"`);
}

// Test Dobby Checks URL
const expectedDobbyUrl = 'https://www.supercollections.in/product-category/shirts/dobby-checks/?utm_source=whatsapp';
assert.strictEqual(getCategoryUrl('Dobby Checks'), expectedDobbyUrl);
assert.strictEqual(getCategoryUrl('dobby checks'), expectedDobbyUrl);
console.log('[URL Test] Dobby Checks passed');

// 2. Test detectNewFaqIntent for direct 2XL shirt queries
async function runIntentTests() {
    const directQueries = [
        '2xl shirt',
        '2xl shirts',
        '2xl-shirt',
        '2xl-shirts',
        'xxl shirt',
        'xxl shirts',
        'shirt 2xl',
        'shirts 2xl',
        '2xl size shirt',
        '2xl shirt venum',
        '2xl shirt iruka'
    ];

    for (const query of directQueries) {
        const session = { state: 'AWAITING_MAIN_MENU_SELECTION' };
        const res = await detectNewFaqIntent(query, session, []);
        console.log(`[Intent Test] "${query}" =>`, res?.replyText?.split('\n')[0]);
        assert(res, `Expected response for "${query}"`);
        assert(res.replyText.includes(expected2XLUrl), `Expected 2XL URL in response for "${query}", got: ${res.replyText}`);
        assert(res.replyText.includes('2XL Shirts'), `Expected "2XL Shirts" in response for "${query}"`);
    }

    // 3. Test two-step: bare "2xl" -> ask shirt/tshirt -> reply "1" or "shirt"
    console.log('\n--- Testing two-step size flow ---');
    const sessionStep = { state: 'AWAITING_MAIN_MENU_SELECTION' };
    const step1 = await detectNewFaqIntent('2xl', sessionStep, []);
    console.log('Step 1 ("2xl") =>', step1?.replyText?.split('\n')[0]);
    assert.strictEqual(sessionStep.state, 'AWAITING_SIZE_CATEGORY_CHOICE');
    assert.strictEqual(sessionStep.pendingLetterSize, '2XL');

    // User replies "1"
    const step2Choice1 = await detectNewFaqIntent('1', sessionStep, []);
    console.log('Step 2 ("1") =>', step2Choice1?.replyText?.split('\n')[0]);
    assert(step2Choice1.replyText.includes(expected2XLUrl));

    // Reset session for replying "shirt"
    const sessionStepText = { state: 'AWAITING_SIZE_CATEGORY_CHOICE', pendingLetterSize: '2XL' };
    const step2ChoiceShirt = await detectNewFaqIntent('shirt', sessionStepText, []);
    console.log('Step 2 ("shirt") =>', step2ChoiceShirt?.replyText?.split('\n')[0]);
    assert(step2ChoiceShirt.replyText.includes(expected2XLUrl));

    // Reset session for replying "2xl shirt"
    const sessionStepBoth = { state: 'AWAITING_SIZE_CATEGORY_CHOICE', pendingLetterSize: '2XL' };
    const step2ChoiceBoth = await detectNewFaqIntent('2xl shirt', sessionStepBoth, []);
    console.log('Step 2 ("2xl shirt") =>', step2ChoiceBoth?.replyText?.split('\n')[0]);
    assert(step2ChoiceBoth.replyText.includes(expected2XLUrl));

    // 4. Test rich response with 2XL products (Image Grid / Collage Flow)
    console.log('\n--- Testing 2XL Shirts with products (Image Grid) ---');
    const mockProducts = [
        { id: 101, name: '2XL Cotton Plain Shirt (Navy)', category: '2XL Shirts', categories: ['2XL Shirts', 'Shirts'], stock: '5', imageUri: 'https://supercollections.in/sample1.jpg' },
        { id: 102, name: '2XL Linen Shirt (White)', category: '2XL Shirts', categories: ['2XL Shirts', 'Shirts'], stock: '3', imageUri: 'https://supercollections.in/sample2.jpg' },
        { id: 103, name: 'T-Shirt Round Neck (Black)', category: 'Round Neck T-Shirts', categories: ['T-Shirts'], stock: '10', imageUri: 'https://supercollections.in/sample3.jpg' }
    ];

    const sessionWithProducts = { state: 'AWAITING_MAIN_MENU_SELECTION' };
    const richRes = await detectNewFaqIntent('2xl shirts', sessionWithProducts, mockProducts);
    console.log('Rich response for "2xl shirts":', {
        sendCtaUrl: richRes?.sendCtaUrl,
        sendImages: richRes?.sendImages,
        selectedSubCategory: sessionWithProducts.selectedSubCategory,
        selectedParentCategory: sessionWithProducts.selectedParentCategory
    });

    assert(richRes, 'Expected rich response for "2xl shirts"');
    assert.strictEqual(sessionWithProducts.selectedSubCategory, '2XL Shirts');
    assert.strictEqual(sessionWithProducts.selectedParentCategory, 'Shirts');
    assert(richRes.sendCtaUrl, 'Expected sendCtaUrl in response');
    assert.strictEqual(richRes.sendCtaUrl.buttonText, 'Shop 2XL Shirts');
    assert.strictEqual(richRes.sendCtaUrl.url, expected2XLUrl);
    assert(Array.isArray(richRes.sendImages), 'Expected sendImages array');

    console.log('\n✅ ALL 2XL SHIRTS TESTS PASSED SUCCESSFULLY!');
}

runIntentTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
