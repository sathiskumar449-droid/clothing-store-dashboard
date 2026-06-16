import { handleSalesAssistantJS } from '../api/webhook.js';

// Mock products representing the store inventory
const mockProducts = [
    { id: 1, name: 'Premium Plain Shirt', price: '699', stock: '10', sizes: 'M,L,XL', category: 'Casual Shirt', color: 'Black' },
    { id: 2, name: 'Formal Cotton Pant', price: '999', stock: '8', sizes: '30,32,34', category: 'Formal Pant', color: 'Navy' }
];

const runTest = async (testName, userMessage, initialSession) => {
    console.log(`\n==============================================`);
    console.log(`🧪 TEST CASE: ${testName}`);
    console.log(`👉 User Sent  : "${userMessage}"`);
    console.log(`👉 Init State  : ${initialSession.state}`);
    console.log(`👉 Init Cart   : ${JSON.stringify(initialSession.cart)}`);
    console.log(`----------------------------------------------`);

    // Create a deep copy of the session to avoid modifying test parameters
    const session = JSON.parse(JSON.stringify(initialSession));

    const response = await handleSalesAssistantJS('1234567890', userMessage, mockProducts, session);

    console.log(`👈 Reply Text  : ${response.replyText || 'N/A'}`);
    if (response.sendButtons) {
        console.log(`👈 Buttons     : ${response.sendButtons.body}`);
        console.log(`               Buttons options: ${JSON.stringify(response.sendButtons.buttons)}`);
    }
    if (response.sendList) {
        console.log(`👈 List Body   : ${response.sendList.body}`);
        console.log(`               List sections: ${JSON.stringify(response.sendList.sections)}`);
    }
    console.log(`👈 Result State: ${session.state}`);
    console.log(`👈 Result Cart : ${JSON.stringify(session.cart)}`);
    console.log(`👈 Delete Sess : ${!!response.shouldDeleteSession}`);
    return { response, session };
};

console.log("🚀 STARTING GLOBAL CANCEL FLOW TESTS...");

// 1. Cancel with empty cart
const sessionEmptyCart = {
    state: 'AWAITING_CATEGORY',
    cart: []
};
const res1 = await runTest('Cancel with empty cart', 'Cancel', sessionEmptyCart);

// 2. Select Continue Shopping in cancel empty cart screen
const res2 = await runTest('Continue Shopping after empty cart cancel', '1', res1.session);

// 3. Category selection check (Category restart fix)
const res3 = await runTest('Select Category after Restart', '1', res2.session);

// 4. Select Exit in cancel empty cart screen
const res4 = await runTest('Exit after empty cart cancel', '2', res1.session);

// 5. Cancel with items in cart
const sessionWithCart = {
    state: 'AWAITING_PRODUCT_SIZE',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
const res5 = await runTest('Cancel with items in cart', 'Cancel', sessionWithCart);

// 6. Select Continue Shopping in cancel pending cart screen
const res6 = await runTest('Continue Shopping after pending cart cancel', '1', res5.session);

// 7. Select Checkout in cancel pending cart screen
const res7 = await runTest('Checkout after pending cart cancel', '2', res5.session);

// 8. Select Clear Cart & Exit in cancel pending cart screen
const res8 = await runTest('Clear Cart & Exit after pending cart cancel', '3', res5.session);

// 9. Verify name, pincode, address checkout prompts have Cancel button
const sessionCheckoutName = {
    state: 'AWAITING_CHECKOUT_NAME',
    cart: [{ id: 1, name: 'Premium Plain Shirt', price: 699, color: 'Black', size: 'M' }]
};
const res9 = await runTest('Checkout Name fallback prompt has Cancel button', 'random invalid stuff', sessionCheckoutName);

console.log("\n🏁 ALL CANCEL FLOW TESTS FINISHED!");
