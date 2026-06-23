import dotenv from 'dotenv';
import assert from 'assert';
import { handleSalesAssistantJS, getAllSubCategoriesList } from '../api/webhook.js';

dotenv.config();

const mockProducts = [
    { id: 101, name: "Printed Shirt Red", category: "Printed Shirts", color: "Red", price: "499", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/shirt1.jpg" },
    { id: 102, name: "Printed Shirt Blue", category: "Printed Shirts", color: "Blue", price: "499", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/shirt2.jpg" },
    { id: 103, name: "Football Neymar", category: "FOOTBALL T SHIRT", color: "Blue", price: "219", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/fb1.jpg" },
    { id: 104, name: "Football Messi", category: "FOOTBALL T SHIRT", color: "White", price: "219", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/fb2.jpg" },
    { id: 105, name: "Polo Jet Black", category: "Polo T-Shirts (pocket)", color: "Black", price: "199", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/polo1.jpg" },
    { id: 106, name: "Polo Violet", category: "Polo T-Shirts (pocket)", color: "Violet", price: "199", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/polo2.jpg" },
    { id: 107, name: "Track Pant Navy", category: "Track Pant", color: "Navy", price: "499", stock: "10", sizes: ["M", "L", "XL"], imageUri: "https://example.com/pant1.jpg" }
];

async function testViaSubcategoryNumberHandler(categoryName, label) {
    console.log(`\n--- [AWAITING_SUBCATEGORY_SELECTION handler] ${label} ---`);
    const session = {
        state: "AWAITING_SUBCATEGORY_SELECTION",
        subCategories: [categoryName],
        cart: []
    };
    const res = await handleSalesAssistantJS("919999900001", "1", mockProducts, session);
    console.log("sendCtaUrl:", JSON.stringify(res.sendCtaUrl, null, 2));
    console.log("sendImages:", res.sendImages);
    console.log("session.state after:", session.state);

    assert.ok(res.sendCtaUrl, `${label}: should return a sendCtaUrl object`);
    assert.ok(!res.sendList, `${label}: should NOT return a sendList`);
    assert.ok(res.sendCtaUrl.url.startsWith('https://www.supercollections.in/'), `${label}: URL should point to supercollections.in`);
    assert.ok(res.sendCtaUrl.buttonText.length <= 20, `${label}: button text must respect WhatsApp's 20-char limit`);
    assert.strictEqual(session.state, "AWAITING_SUBCATEGORY_SELECTION", `${label}: state should fall back to category menu, not AWAITING_MODEL_SELECTION`);
    // Collage generation itself is unchanged code (same createProductCollage call as before) and
    // depends on fetching real product images — our mock URLs 404, so we only check the shape here.
    assert.ok(Array.isArray(res.sendImages), `${label}: sendImages should be an array`);
    return res;
}

async function testViaCategoryJumpFallback(categoryName, label) {
    console.log(`\n--- [enterSubCategoryByIndex via category-jump fallback] ${label} ---`);
    const allSubs = getAllSubCategoriesList(mockProducts);
    const idx = allSubs.indexOf(categoryName);
    assert.ok(idx >= 0, `${label}: category should appear in the flat subcategory list`);

    // Session is currently viewing an unrelated, empty-on-purpose product list so the typed number
    // can never match a product there (maxVal=0) and must fall through to the category-jump
    // fallback, which is the enterSubCategoryByIndex code path.
    const session = {
        state: "AWAITING_MODEL_SELECTION",
        selectedSubCategory: "Track Pant",
        searchProducts: [],
        cart: []
    };
    const res = await handleSalesAssistantJS("919999900002", String(idx + 1), mockProducts, session);
    console.log("sendCtaUrl:", JSON.stringify(res.sendCtaUrl, null, 2));
    console.log("session.state after:", session.state);
    console.log("session.selectedSubCategory after:", session.selectedSubCategory);

    assert.ok(res.sendCtaUrl, `${label}: should return a sendCtaUrl object`);
    assert.ok(!res.sendList, `${label}: should NOT return a sendList`);
    assert.strictEqual(session.selectedSubCategory, categoryName, `${label}: should have jumped into the new category`);
    assert.strictEqual(session.state, "AWAITING_SUBCATEGORY_SELECTION", `${label}: state should fall back to category menu`);
    return res;
}

async function testSearchPathUnaffected() {
    console.log(`\n--- [SEARCH path] should still use the old list UI ---`);
    const session = { state: "AWAITING_SUBCATEGORY_SELECTION", cart: [] };
    const res = await handleSalesAssistantJS("919999900003", "printed shirts", mockProducts, session);
    console.log("sendList present:", !!res.sendList);
    console.log("sendCtaUrl present:", !!res.sendCtaUrl);
    assert.ok(res.sendList, "SEARCH path should still send the interactive product list");
    assert.ok(!res.sendCtaUrl, "SEARCH path should NOT send a CTA url");
}

async function run() {
    const r1 = await testViaSubcategoryNumberHandler("Printed Shirts", "Printed Shirts");
    assert.strictEqual(r1.sendCtaUrl.url, "https://www.supercollections.in/product-category/men/printed-shirts/");
    assert.ok(r1.sendCtaUrl.buttonText === "Shop Printed Shirts" || r1.sendCtaUrl.buttonText === "Shop Now");

    const r2 = await testViaSubcategoryNumberHandler("FOOTBALL T SHIRT", "FOOTBALL T SHIRT (unusual slug ffotball)");
    assert.strictEqual(r2.sendCtaUrl.url, "https://www.supercollections.in/product-category/ffotball/");

    const r3 = await testViaSubcategoryNumberHandler("Polo T-Shirts (pocket)", "Polo T-Shirts (pocket) (dropped suffix)");
    assert.strictEqual(r3.sendCtaUrl.url, "https://www.supercollections.in/product-category/men/polo-t-shirts/");

    await testViaCategoryJumpFallback("Printed Shirts", "Printed Shirts via enterSubCategoryByIndex");

    await testSearchPathUnaffected();

    console.log("\n✅ All subcategory-CTA scenarios passed.");
}

run().catch(err => {
    console.error("\n❌ Test failed:", err);
    process.exit(1);
});
