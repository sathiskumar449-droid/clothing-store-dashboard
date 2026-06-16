import { handleSalesAssistantJS } from '../api/webhook.js';
import axios from 'axios';
import assert from 'assert';

// Mock axios to prevent 401 unauthorized errors during local testing
axios.post = async (url, data) => {
    console.log(`[AXIOS POST MOCK] URL: ${url}`);
    return { data: { messages: [{ id: 'wamid.mockid' }] } };
};
axios.get = async (url) => {
    console.log(`[AXIOS GET MOCK] URL: ${url}`);
    return { data: Buffer.alloc(0), headers: { 'content-type': 'image/jpeg' } };
};

const mockProducts = [
    { id: 1, name: 'Premium Plain Shirt', price: '699', stock: '10', sizes: 'M,L,XL', category: 'Casual Shirt', color: 'Black', imageUri: 'https://supercollections.in/plain_shirt.jpg' },
    { id: 2, name: 'Premium Printed Shirt', price: '799', stock: '5', sizes: 'S,M,L', category: 'Casual Shirt', color: 'White', imageUri: 'https://supercollections.in/printed_shirt.jpg' },
    { id: 3, name: 'Polo Fit Pant', price: '999', stock: '8', sizes: '30,32,34', category: 'Pants', color: 'Blue', imageUri: 'https://supercollections.in/navy_pant.jpg' },
    { id: 4, name: 'Premium Denim Jeans', price: '1299', stock: '10', sizes: '30,32,34', category: 'Jeans', color: 'Blue', imageUri: 'https://supercollections.in/navy_jeans.jpg' }
];

async function runStep(phone, msg, session) {
    const response = await handleSalesAssistantJS(phone, msg, mockProducts, session);
    
    // Emulate handleMessage side-effects
    if (response.cart) session.cart = response.cart;
    if (response.selectedColor !== undefined) session.selectedColor = response.selectedColor;
    if (response.selectedSize !== undefined) session.selectedSize = response.selectedSize;
    if (response.searchProducts !== undefined) session.searchProducts = response.searchProducts;
    if (response.lastRecommendation !== undefined) session.lastRecommendation = response.lastRecommendation;
    if (response.awaitingRecommendationResponse !== undefined) session.awaitingRecommendationResponse = response.awaitingRecommendationResponse;
    if (response.awaitingCartAdditionConfirmation !== undefined) session.awaitingCartAdditionConfirmation = response.awaitingCartAdditionConfirmation;
    if (response.pendingProduct !== undefined) session.pendingProduct = response.pendingProduct;
    if (response.crossSellShown !== undefined) session.crossSellShown = response.crossSellShown;
    
    return response;
}

async function runTest() {
    let session = {
        state: "AWAITING_CATEGORY",
        cart: [],
        history: [],
        searchProducts: [],
        selectedColor: null,
        selectedSize: null,
        lastRecommendation: null,
        awaitingRecommendationResponse: false,
        awaitingCartAdditionConfirmation: false,
        pendingProduct: null,
        crossSellShown: false,
        fromCrossSell: false
    };

    const phone = "919942305574";

    // Start with "hi"
    console.log('--- Step 0: Greeting ---');
    await runStep(phone, "hi", session);
    assert.strictEqual(session.state, "AWAITING_CATEGORY");

    // 1. Add first product
    console.log('--- Step 1: Add first product ---');
    await runStep(phone, "1", session); // Category 1: Casual Shirt
    await runStep(phone, "1", session); // Product 1: Plain Shirt
    await runStep(phone, "M", session); // Size M
    const resAdd1 = await runStep(phone, "qty_1", session); // Qty 1

    assert.strictEqual(session.state, "AWAITING_POST_ADD_TO_CART_DECISION");
    assert.strictEqual(session.fromCrossSell, false);
    console.log('✅ Post-add-to-cart buttons shown correctly.');

    // 2. Select Checkout
    console.log('--- Step 2: Go to Checkout / Cart Summary ---');
    await runStep(phone, "cart_summary", session);
    assert.strictEqual(session.state, "AWAITING_CART_SUMMARY_DECISION");

    // 3. Click Shop Matches (view_matches)
    console.log('--- Step 3: Click Shop Matches ---');
    await runStep(phone, "view_matches", session);
    assert.strictEqual(session.state, "AWAITING_RECOMMENDATION_CHOICE");
    assert.strictEqual(session.fromCrossSell, true);
    console.log('✅ fromCrossSell is set to true when viewing matches.');

    // 4. Send "Hi" greeting to restart / cancel
    console.log('--- Step 4: Restart shopping with Greeting "Hi" ---');
    const resHi = await runStep(phone, "Hi", session);
    assert.strictEqual(session.state, "AWAITING_PENDING_CART_DECISION");
    assert.strictEqual(session.fromCrossSell, false);
    assert.strictEqual(session.crossSellShown, false);
    console.log('✅ fromCrossSell successfully reset to false on greeting.');

    // 5. Select Continue (continue shopping)
    console.log('--- Step 5: Continue shopping ---');
    await runStep(phone, "continue", session);
    assert.strictEqual(session.state, "AWAITING_CATEGORY");

    // 6. Add second product (different category)
    console.log('--- Step 6: Add second product ---');
    await runStep(phone, "1", session); // Select Category 1
    await runStep(phone, "1", session); // Select Product 1
    await runStep(phone, "L", session); // Select size L
    const resAdd2 = await runStep(phone, "qty_1", session); // Select qty 1

    // Expecting AWAITING_POST_ADD_TO_CART_DECISION, NOT cart summary bypass!
    assert.strictEqual(session.state, "AWAITING_POST_ADD_TO_CART_DECISION");
    assert.strictEqual(session.fromCrossSell, false);
    assert.ok(resAdd2.sendButtons.body.includes("Item added to cart"), "Should show added to cart options");
    assert.ok(resAdd2.sendButtons.buttons.some(b => b.id === 'choose_same_cat'), "Should show Same Category option");
    console.log('✅ Second product added normally without bypassing buttons. Success!');
}

runTest().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
