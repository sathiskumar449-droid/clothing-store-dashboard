import dotenv from 'dotenv';
import assert from 'assert';
import { handleSalesAssistantJS } from '../api/webhook.js';

dotenv.config();

// 10 "five sleeve t shirt" variants -> pageSize=9 gives exactly 2 pages (9 + 1), matching the
// bug report's "Page 1/2" / "Page 2/2". Variant #1 deliberately has NO imageUri of its own
// (mirrors real prod row id 3597) to confirm the image-fallback fix (Bug 1) kicks in.
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
    // Session carries leftover category-browsing pagination state from earlier in the
    // conversation: the customer had been browsing "kurga pant" page 2 before starting this
    // new search.
    const session = {
        state: "AWAITING_SUBCATEGORY_SELECTION",
        cart: [],
        selectedSubCategory: "kurga pant",
        selectedParentCategory: "Pants",
        currentPage: 1,
        searchProducts: []
    };

    console.log("\n--- Step 1: search 'I want Five Sleeve T Shirt' ---");
    const res1 = await handleSalesAssistantJS("919999911111", "I want Five Sleeve T Shirt", mockProducts, session);
    console.log("replyText:", res1.replyText);
    console.log("card count:", res1.sendProductCards?.length);
    console.log("card image headers:", res1.sendProductCards?.map(c => c.imageUrl || 'MISSING'));

    assert.ok(res1.sendProductCards, "Step1: should render per-product cards");
    assert.strictEqual(res1.sendProductCards.length, 9, "Step1: page 1 should hold 9 cards");
    assert.ok(res1.replyText.includes("Page 1/2"), `Step1: label should show Page 1/2, got: ${res1.replyText}`);
    assert.ok(res1.replyText.toLowerCase().includes("five sleeve"), `Step1: label should reference the search, got: ${res1.replyText}`);
    assert.ok(!res1.replyText.toLowerCase().includes("kurga"), "Step1: label must NOT leak the leftover category");
    res1.sendProductCards.forEach((c, i) => {
        assert.ok(c.imageUrl, `Step1: card ${i} ("${c.body}") must have an image header`);
    });
    assert.strictEqual(session.searchResultMode, 'cards', "Step1: session should be in cards mode");
    assert.strictEqual(session.searchPage, 0, "Step1: dedicated search page counter should be 0");
    // The leftover category-browse field must be left untouched by the search flow itself.
    assert.strictEqual(session.currentPage, 1, "Step1: category-browsing currentPage must NOT be touched by search");

    console.log("\n--- Step 2: click 'Next Page' ---");
    const res2 = await handleSalesAssistantJS("919999911111", "next_page", mockProducts, session);
    console.log("replyText:", res2.replyText);
    console.log("card count:", res2.sendProductCards?.length);
    console.log("card image headers:", res2.sendProductCards?.map(c => c.imageUrl || 'MISSING'));

    assert.ok(res2.sendProductCards, "Step2: Next Page should still render per-product cards");
    assert.strictEqual(res2.sendProductCards.length, 1, "Step2: page 2 should hold the remaining 1 card");
    assert.ok(res2.replyText.includes("Page 2/2"), `Step2: label should show Page 2/2, got: ${res2.replyText}`);
    assert.ok(res2.replyText.toLowerCase().includes("five sleeve"), `Step2: must stay within the search, got: ${res2.replyText}`);
    assert.ok(!res2.replyText.toLowerCase().includes("kurga"), `Step2 (the actual bug): must NOT jump to kurga pant, got: ${res2.replyText}`);
    assert.ok(res2.sendProductCards[0].imageUrl, "Step2: the lone card on page 2 must have an image header");
    assert.strictEqual(session.searchPage, 1, "Step2: dedicated search page counter should advance to 1");
    assert.strictEqual(session.currentPage, 1, "Step2: category-browsing currentPage must remain untouched");

    console.log("\n✅ Both bugs verified fixed: images present on every card, and pagination stayed within the search results.");
}

run().catch(err => {
    console.error("\n❌ Test failed:", err);
    process.exit(1);
});
