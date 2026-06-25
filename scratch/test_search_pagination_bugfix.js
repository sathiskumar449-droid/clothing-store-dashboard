import dotenv from 'dotenv';
import assert from 'assert';
import { handleSalesAssistantJS } from '../api/webhook.js';

dotenv.config();

// Pagination ("Next Page" / "Manage Pages") was removed entirely per user request — every
// matching product now renders as its own card in a single response, no page cap. This test
// covers what's left: all matches show up at once, with images, and a leftover category from
// earlier in the conversation never leaks into the result label.
// Variant #1 deliberately has NO imageUri of its own (mirrors real prod row id 3597) to confirm
// the image-fallback fix still kicks in.
const sleeveVariants = [
    { id: 3597, name: "five sleeve t shirt", category: "Men", categories: ["Men"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: null },
    { id: 3564, name: "five sleeve t shirt (black)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-black.jpg" },
    { id: 3603, name: "five sleeve t shirt (orange)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-orange.jpg" },
    { id: 3610, name: "five sleeve t shirt (brown)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-brown.jpg" },
    { id: 3617, name: "five sleeve t shirt (purple)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-purple.jpg" },
    { id: 3622, name: "five sleeve t shirt (mint rose)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-mint.jpg" },
    { id: 3625, name: "five sleeve t shirt (cream)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-cream.jpg" },
    { id: 3638, name: "five sleeve t shirt (petrol blue)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-petrol.jpg" },
    { id: 3639, name: "five sleeve t shirt (navy blue)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-navy.jpg" },
    { id: 3654, name: "five sleeve t shirt (olive green)", category: "five sleeve t shirt", categories: ["five sleeve t shirt"], color: null, price: "399", stock: "10", sizes: ["M", "L"], imageUri: "https://example.com/sleeve-olive.jpg" }
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

    console.log("\n--- search 'I want Five Sleeve T Shirt' ---");
    const res = await handleSalesAssistantJS("919999911111", "I want Five Sleeve T Shirt", mockProducts, session);
    console.log("replyText:", res.replyText);
    console.log("card count:", res.sendProductCards?.length);
    console.log("card image headers:", res.sendProductCards?.map(c => c.imageUrl || 'MISSING'));
    console.log("sendButtons:", res.sendButtons);

    assert.ok(res.sendProductCards, "should render per-product cards");
    assert.strictEqual(res.sendProductCards.length, 10, "all 10 matching variants should be sent at once, no page cap");
    assert.ok(!/\(Page \d+\/\d+\)/.test(res.replyText), `label must not show page numbers anymore, got: ${res.replyText}`);
    assert.ok(res.replyText.toLowerCase().includes("five sleeve"), `label should reference the search, got: ${res.replyText}`);
    assert.ok(!res.replyText.toLowerCase().includes("kurga"), "label must NOT leak the leftover category");
    assert.ok(!res.sendButtons, "there must be no 'Manage Pages' / Next-Prev buttons");
    res.sendProductCards.forEach((c, i) => {
        assert.ok(c.imageUrl, `card ${i} ("${c.body}") must have an image header`);
    });

    console.log("\n✅ All matching products are sent as cards in one response, with images, and no pagination UI.");
}

run().catch(err => {
    console.error("\n❌ Test failed:", err);
    process.exit(1);
});
