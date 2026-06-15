import { handleSalesAssistantJS } from '../api/webhook.js';

// Mock products representing the store inventory including image healing cases
const mockProducts = [
    { id: 1, name: 'Premium Plain Shirt', price: '699', stock: '10', sizes: 'M,L,XL', category: 'Casual Shirt', color: 'Black', imageUri: 'https://supercollections.in/plain_shirt.jpg' },
    { id: 2, name: 'Premium Printed Shirt', price: '799', stock: '5', sizes: 'S,M,L', category: 'Casual Shirt', color: 'White', imageUri: 'https://supercollections.in/printed_shirt.jpg' },
    { id: 3, name: 'Formal Cotton Pant', price: '999', stock: '8', sizes: '30,32,34', category: 'Formal Pant', color: 'Navy', imageUri: 'https://supercollections.in/navy_pant.jpg' },
    { id: 4, name: 'Cargo Track Pant', price: '599', stock: '12', sizes: 'M,L,XL', category: 'Cargo Pant', color: 'Green', imageUri: 'https://supercollections.in/cargo_pant.jpg' },
    { id: 5, name: 'Sports Football Jersey', price: '499', stock: '15', sizes: 'S,M,L,XL', category: 'Sports Jersey', color: 'Blue', imageUri: 'https://supercollections.in/jersey.jpg' },
    // Products for self-healing test:
    { id: 1714, name: 'POLO FIT WHITE PANTS', price: '899', stock: '5', sizes: '32,34', category: 'Formal Pant', color: 'White', imageUri: 'null' },
    { id: 1717, name: 'POLOFIT WHITE PANT', price: '899', stock: '5', sizes: '32,34', category: 'Formal Pant', color: 'White', imageUri: 'https://supercollections.in/white_pants_healed.jpg' }
];

const runTest = (testName, userMessage, initialSession) => {
    console.log(`\n==============================================`);
    console.log(`🧪 TEST CASE: ${testName}`);
    console.log(`👉 User Sent  : "${userMessage}"`);
    console.log(`👉 Init State  : ${initialSession.state}`);
    console.log(`👉 Init Cart   : ${JSON.stringify(initialSession.cart)}`);
    console.log(`----------------------------------------------`);

    // Create a deep copy of the session to avoid modifying test parameters
    const session = JSON.parse(JSON.stringify(initialSession));

    const response = handleSalesAssistantJS('1234567890', userMessage, mockProducts, session);

    console.log(`👈 Reply Text  : ${response.replyText || 'N/A'}`);
    if (response.sendButtons) {
        console.log(`👈 Buttons     : ${response.sendButtons.body} | Buttons: ${response.sendButtons.buttons.map(b => b.title).join(', ')}`);
    }
    if (response.sendImages && response.sendImages.length > 0) {
        console.log(`👈 Images      : ${JSON.stringify(response.sendImages)}`);
    }
    console.log(`👈 Result State: ${session.state}`);
    console.log(`👈 Result Cart : ${JSON.stringify(session.cart)}`);
    console.log(`👈 Is Handoff  : ${!!response.isHumanHandoff}`);
};

// Test 1: Typo FAQ - delivery spelling error
const session1 = {
    state: 'AWAITING_CHECKOUT_DETAILS',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
runTest('Typo FAQ matching - deleivery', 'How many days take deleivery time', session1);

// Test 2: Typo FAQ - delcirvy spelling error
const session2 = {
    state: 'AWAITING_CHECKOUT_DETAILS',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
runTest('Typo FAQ matching - delcirvy', 'Evlo days agum delcirvy aga', session2);

// Test 3: Shipping charges typo/synonyms
const session3 = {
    state: 'AWAITING_CHECKOUT_DETAILS',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
runTest('Shipping Charges synonym matching', 'Shipping amount?', session3);

// Test 4: Clear Cart intent
const session4 = {
    state: 'AWAITING_CHECKOUT_DETAILS',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
runTest('Clear Cart command (resets state & cart)', 'clear cart please', session4);

// Test 5: Standard shopping flow check (make sure numbers still work)
const session5 = {
    state: 'AWAITING_SUBCATEGORY_SELECTION',
    cart: [],
    subCategories: ['Formal Pant', 'Cargo Pant'],
    selectedParentCategory: 'Pants'
};
runTest('Standard number choice fallback (bypasses intent routing)', '1', session5);

// Test 6: Greeting with items in cart -> AWAITING_PENDING_CART_DECISION
const sessionGreeting = {
    state: 'AWAITING_CATEGORY',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
runTest('Greeting with pending cart items', 'hi bro', sessionGreeting);

// Test 7: Decision: Checkout (1)
const sessionDecisionCheckout = {
    state: 'AWAITING_PENDING_CART_DECISION',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
runTest('Pending cart decision - Select Checkout', '1', sessionDecisionCheckout);

// Test 8: Decision: Continue Shopping (2)
const sessionDecisionContinue = {
    state: 'AWAITING_PENDING_CART_DECISION',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
runTest('Pending cart decision - Select Continue', 'continue', sessionDecisionContinue);

// Test 9: Decision: Clear Cart (3)
const sessionDecisionClear = {
    state: 'AWAITING_PENDING_CART_DECISION',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
runTest('Pending cart decision - Select Clear', '3', sessionDecisionClear);

// Test 10: Recommendation Image Healing
// Adding Casual Shirt to cart, and triggering recommendation. Casual Shirt tag is CASUAL_SHIRT.
// Target tags: JEANS, COTTON_PANT, PANT. Formal Pant (White) has tag FORMAL_PANT/PANT.
// POLO FIT WHITE PANTS (1714) has imageUri: "null", but POLOFIT WHITE PANT (1717) has a valid image and is the same category/color.
// Let's test if the size selection uses the healed image URL for 1714.
const sessionHeal = {
    state: 'AWAITING_MODEL_SELECTION',
    searchProducts: [mockProducts[5]], // 1714 POLO FIT WHITE PANTS
    cart: []
};
runTest('Self-Healing image in size selection', '1', sessionHeal);
