import dotenv from 'dotenv';
import assert from 'assert';
import { handleSalesAssistantJS } from '../api/webhook.js';

dotenv.config();

// Search results now always send exactly ONE representative card (the first match in existing
// order), regardless of how many products matched — no pagination, no list, no "Manage Pages".
// Variant #1 deliberately has NO imageUri of its own (mirrors real prod row id 3597) to confirm
// the image-fallback fix still kicks in when that happens to be the picked product.
const sleeveVariants = [
    { id: 3597, name: "five sleeve t shirt", category: "Men", categories: ["Men"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: null },
    { id: 3564, name: "five sleeve t shirt (black)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-black.jpg" },
    { id: 3603, name: "five sleeve t shirt (orange)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-orange.jpg" }
];

// Unrelated category, used to simulate leftover category-browsing session state.
const kurgaPant = [
    { id: 9001, name: "Kurga Pant Black", category: "kurga pant", categories: ["kurga pant"], color: "Black", price: "599", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/kurga1.jpg" },
    { id: 9002, name: "Kurga Pant Beige", category: "kurga pant", categories: ["kurga pant"], color: "Beige", price: "599", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/kurga2.jpg" }
];

const mockProducts = [...sleeveVariants, ...kurgaPant];

async function run() {
    // Session carries leftover category-browsing state from earlier in the conversation: the
    // customer had been browsing "kurga pant" before starting this new search.
    const session = {
        state: "AWAITING_SUBCATEGORY_SELECTION",
        cart: [],
        selectedSubCategory: "kurga pant",
        selectedParentCategory: "Pants",
        searchProducts: []
    };

    console.log("\n--- search 'I want Five Sleeve T Shirt' (3 matches) ---");
    const res = await handleSalesAssistantJS("919999911111", "I want Five Sleeve T Shirt", mockProducts, session);
    console.log("replyText:", res.replyText);
    console.log("card count:", res.sendProductCards?.length);
    console.log("card:", res.sendProductCards?.[0]);
    console.log("sendButtons:", res.sendButtons);

    assert.ok(res.sendProductCards, "should render a product card");
    assert.strictEqual(res.sendProductCards.length, 1, "exactly ONE card must be sent, regardless of how many products matched");
    assert.ok(!/\(Page \d+\/\d+\)/.test(res.replyText), `label must not show page numbers, got: ${res.replyText}`);
    assert.ok(res.replyText.toLowerCase().includes("five sleeve"), `label should reference the search, got: ${res.replyText}`);
    assert.ok(!res.replyText.toLowerCase().includes("kurga"), "label must NOT leak the leftover category");
    assert.ok(!res.sendButtons, "there must be no pagination buttons");
    // Picked product (id 3597) has no image of its own — confirms the sibling-name fallback
    // in getProductImageUri() still resolves an image for the single picked card.
    assert.strictEqual(session.searchProducts.length, 1, "session.searchProducts should be trimmed to the single picked product");
    assert.ok(res.sendProductCards[0].imageUrl, "the single card must have an image header");

    console.log("\n✅ Exactly one card is sent, with an image, and no pagination UI.");
}

run().catch(err => {
    console.error("\n❌ Test failed:", err);
    process.exit(1);
});
