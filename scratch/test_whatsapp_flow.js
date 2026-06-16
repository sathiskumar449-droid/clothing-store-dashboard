import dotenv from 'dotenv';
import assert from 'assert';
import {
    handleSalesAssistantJS
} from '../api/webhook.js';

// Load environmental configuration
dotenv.config();

// Mock products representing Shirts and Pants of various categories
const mockProducts = [
    { id: 1, name: "Printed Shirt Red", category: "Printed Shirts", color: "Red", price: "499", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/shirt1.jpg" },
    { id: 2, name: "Linen Shirt White", category: "Linen Shirts", color: "White", price: "599", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/shirt2.jpg" },
    { id: 3, name: "Plain Shirt Blue", category: "Plain Shirts", color: "Blue", price: "449", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/shirt3.jpg" },
    { id: 4, name: "Polo Fit Pant Black", category: "Polo Fit Pant", color: "Black", price: "699", stock: "10", sizes: ["28 SIZE", "30 SIZE", "32 SIZE"], imageUri: "https://example.com/pant1.jpg" },
    { id: 5, name: "Jeans Blue", category: "Jeans", color: "Blue", price: "799", stock: "10", sizes: ["32 SIZE", "34 SIZE", "36 SIZE"], imageUri: "https://example.com/pant2.jpg" },
    { id: 6, name: "Cargo Track Pant Grey", category: "Cargo Pant", color: "Grey", price: "549", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/pant3.jpg" },
    { id: 7, name: "Trouser Black", category: "Formal Pant", color: "Black", price: "649", stock: "10", sizes: ["32 SIZE", "34 SIZE", "36 SIZE"], imageUri: "https://example.com/pant4.jpg" },
    { id: 8, name: "Jogger Navy", category: "Track Pant", color: "Navy", price: "499", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/pant5.jpg" },
    { id: 9, name: "T-Shirt Yellow", category: "T-Shirts", color: "Yellow", price: "299", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/shirt4.jpg" }
];

async function runTests() {
    console.log("=== Running Comprehensive WhatsApp Order Flow Tests ===");

    // Test 1: Category Recommendation Rules & Removed Recommended Label
    console.log("\nTesting recommendation matching rules & check Recommended label is removed...");
    
    const session1 = {
        state: "AWAITING_MODEL_SELECTION",
        searchProducts: [mockProducts[0]], // Printed Shirt Red
        cart: []
    };
    
    let res = await handleSalesAssistantJS("12345", "1", mockProducts, session1);
    console.log("Response text for Shirt selection:\n", res.replyText);
    
    // Check that recommendations are NOT in the replyText
    assert.ok(!res.replyText.includes("Recommended:"), "Recommended label should be removed");
    assert.ok(!res.replyText.includes("1. Polo Fit Pant Black"), "Should not display recommended products text in size prompt");
    assert.ok(!res.replyText.includes("2. Jeans Blue"), "Should not display recommended products text in size prompt");

    // Test 2: Size Normalization and Dynamic Guide for Pants
    console.log("\nTesting dynamic guide (e.g. 28-2 format guide for Pants)...");
    
    const sessionSize = {
        state: "AWAITING_PRODUCT_SIZE_QTY",
        orderingQueue: [
            { displayNum: 1, product: mockProducts[3] } // Polo Fit Pant Black
        ],
        orderingIndex: 0,
        orderingCart: [],
        cart: [],
        crossSellShown: false
    };
    
    // Trigger size/qty request from model selection state instead to get first prompt
    const sessionModelPants = {
        state: "AWAITING_MODEL_SELECTION",
        searchProducts: [mockProducts[3]], // Polo Fit Pant Black
        cart: []
    };
    res = await handleSalesAssistantJS("12345", "1", mockProducts, sessionModelPants);
    console.log("Pants size selection prompt:\n", res.replyText);
    
    // Assert it suggests 28-2 format (since it is a pant)
    assert.ok(res.replyText.includes("Reply in this format:\n\n28-2"), "Pants should suggest 28-2 guide format");
    assert.ok(res.replyText.includes("(Size 28, Qty 2)"), "Pants should explain size 28, qty 2");
    
    // Trigger size/qty request for shirt to check standard guide
    const sessionModelShirt = {
        state: "AWAITING_MODEL_SELECTION",
        searchProducts: [mockProducts[0]], // Printed Shirt Red
        cart: []
    };
    res = await handleSalesAssistantJS("12345", "1", mockProducts, sessionModelShirt);
    console.log("Shirt size selection prompt:\n", res.replyText);
    assert.ok(res.replyText.includes("Reply in this format:\n\nM-2"), "Shirts should suggest M-2 guide format");
    assert.ok(res.replyText.includes("(Size M, Qty 2)"), "Shirts should explain size M, qty 2");

    // Test 3: Multiple selections images restriction
    console.log("\nTesting images are shown ONLY for the first configured product...");
    
    const sessionMultiple = {
        state: "AWAITING_PRODUCT_SIZE_QTY",
        orderingQueue: [
            { displayNum: 1, product: mockProducts[0] }, // Printed Shirt Red (1st item)
            { displayNum: 2, product: mockProducts[1] }  // Linen Shirt White (2nd item)
        ],
        orderingIndex: 0,
        orderingCart: [],
        cart: [],
        crossSellShown: false
    };
    
    // User replies with size/qty for the first product
    res = await handleSalesAssistantJS("12345", "M-2", mockProducts, sessionMultiple);
    console.log("Response prompt for the second product:\n", JSON.stringify(res, null, 2));
    
    // Assert next prompt does NOT send next product images
    assert.strictEqual(sessionMultiple.orderingIndex, 1, "Ordering index should increment to 1");
    assert.deepStrictEqual(res.sendImages, [], "Should NOT send next next product images");

    // Test 4: Multiple selections collage generation and size validation
    console.log("\nTesting multiple selections initial collage generation...");
    const sessionMultipleInit = {
        state: "AWAITING_MODEL_SELECTION",
        searchProducts: [mockProducts[0], mockProducts[3]], // Printed Shirt Red, Polo Fit Pant Black
        cart: []
    };
    // User selects both products (1 and 2)
    res = await handleSalesAssistantJS("12345", "1,2", mockProducts, sessionMultipleInit);
    console.log("Response for multiple selections initial prompt:\n", JSON.stringify(res, null, 2));
    
    // Check that we got a collage image (since queue length > 1)
    assert.strictEqual(res.orderingQueue.length, 2, "Queue should contain 2 items");
    assert.strictEqual(res.orderingIndex, 0, "Ordering index should be 0");
    assert.strictEqual(res.sendImages.length, 1, "Should send 1 collage image");
    assert.ok(res.sendImages[0].url.includes("collages"), "Should send a collage URL from supabase storage");

    console.log("\nTesting pants size normalization validation (e.g. 28-2 matching 28 SIZE)...");
    const sessionPantValidation = {
        state: "AWAITING_PRODUCT_SIZE_QTY",
        orderingQueue: [
            { displayNum: 1, product: mockProducts[3] } // Polo Fit Pant Black (has size "28 SIZE")
        ],
        orderingIndex: 0,
        orderingCart: [],
        cart: [],
        crossSellShown: false
    };
    res = await handleSalesAssistantJS("12345", "28-2", mockProducts, sessionPantValidation);
    console.log("Response for valid pants size:\n", JSON.stringify(res, null, 2));
    assert.strictEqual(sessionPantValidation.orderingCart.length, 1, "Should successfully add 1 item to orderingCart");
    assert.strictEqual(sessionPantValidation.orderingCart[0].size, "28 SIZE", "Normalized size should map back to 28 SIZE");

    console.log("\nTesting invalid size format error prompt with dynamic examples...");
    const sessionInvalidShirt = {
        state: "AWAITING_PRODUCT_SIZE_QTY",
        orderingQueue: [
            { displayNum: 1, product: mockProducts[0] } // Printed Shirt Red (Shirt)
        ],
        orderingIndex: 0,
        orderingCart: [],
        cart: []
    };
    res = await handleSalesAssistantJS("12345", "invalid_input", mockProducts, sessionInvalidShirt);
    assert.ok(res.replyText.includes("e.g., M-2"), "Shirt invalid format error should suggest M-2");

    const sessionInvalidPant = {
        state: "AWAITING_PRODUCT_SIZE_QTY",
        orderingQueue: [
            { displayNum: 1, product: mockProducts[3] } // Polo Fit Pant Black (Pant)
        ],
        orderingIndex: 0,
        orderingCart: [],
        cart: []
    };
    res = await handleSalesAssistantJS("12345", "invalid_input", mockProducts, sessionInvalidPant);
    assert.ok(res.replyText.includes("e.g., 28-2"), "Pant invalid format error should suggest 28-2");

    console.log("\n✅ All recommended label removal, dynamic format guidance, enqueued images restrictions, collage generation, and size validation tests passed successfully!");
}

runTests().catch(err => {
    console.error("\n❌ Test Suite Failed:", err);
    process.exit(1);
});
