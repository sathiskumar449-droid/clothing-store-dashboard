// Maps WooCommerce subcategory names (as stored in our products table) to their live
// supercollections.in category page URLs. WooCommerce slugs are NOT derivable from the
// category name here — some are nested under /men/, some are flat, and a few carry typos
// baked into the live slug (e.g. "FOOTBALL T SHIRT" -> "ffotball") that don't match the name
// at all. This mapping was built by cross-referencing the product_cat-sitemap.xml against the
// distinct category names actually present in the products table, with ambiguous cases
// (e.g. duplicate "Round Neck" pages) verified by fetching each candidate page directly.
const CATEGORY_URLS = {
    'casual shirts': 'https://www.supercollections.in/product-category/men/casual-shirts/',
    'cotton shirts': 'https://www.supercollections.in/product-category/men/cotton-shirts/',
    'plain shirts': 'https://www.supercollections.in/product-category/men/plain-shirts/',
    'printed shirts': 'https://www.supercollections.in/product-category/men/printed-shirts/',
    'polo t-shirts (pocket)': 'https://www.supercollections.in/product-category/men/polo-t-shirts/',
    't-shirts': 'https://www.supercollections.in/product-category/men/t-shirts/',
    'track pant': 'https://www.supercollections.in/product-category/men/track-pant/',
    'round neck t shirt': 'https://www.supercollections.in/product-category/men/t-shirts/round-neck-t-shirt/',
    'mens callor white t shirt': 'https://www.supercollections.in/product-category/men/mens-callor-white-t-shirt/',
    'football t shirt': 'https://www.supercollections.in/product-category/ffotball/',
    'polo fit pant': 'https://www.supercollections.in/product-category/polo-fit-pant/',
    'big size shirt': 'https://www.supercollections.in/product-category/big-size-shirt/',
    'chava print': 'https://www.supercollections.in/product-category/chava-print/',
    'five sleeve t shirt': 'https://www.supercollections.in/product-category/five-sleeve-t-shirt/',
    'imported shorts': 'https://www.supercollections.in/product-category/imported-shorts/',
    'kurga pant': 'https://www.supercollections.in/product-category/kurga-pant/',
    'laycra pant': 'https://www.supercollections.in/product-category/laycra-pant/',
    'lenin plain': 'https://www.supercollections.in/product-category/lenin-plain/',
    'micro stripes': 'https://www.supercollections.in/product-category/micro-stripes/',
    'stripes shirts': 'https://www.supercollections.in/product-category/stripes-shirts/',
    'white shirts': 'https://www.supercollections.in/product-category/white-shirts/'
};

// Sent whenever a subcategory has no entry above (e.g. a category added in WooCommerce after
// this mapping was last updated) so the CTA button always points somewhere valid.
const FALLBACK_SHOP_URL = 'https://www.supercollections.in/shop/';

// Case-insensitive, whitespace-normalized lookup. Falls back to the main shop page (and logs a
// warning) instead of ever sending a broken/empty link.
export function getCategoryUrl(categoryName) {
    const key = (categoryName || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const url = CATEGORY_URLS[key];
    if (!url) {
        console.warn(`[categoryUrls] No URL mapping for category "${categoryName}" — falling back to shop page. Add an entry to lib/categoryUrls.js.`);
        return FALLBACK_SHOP_URL;
    }
    return url;
}
