// Maps WooCommerce subcategory names (as stored in our products table) to their live
// supercollections.in category page URLs. WooCommerce slugs are NOT derivable from the
// category name here — there's no per-category URL field on a product row.
//
// Rebuilt by cross-referencing product_cat-sitemap.xml against the distinct `category` values
// actually present in the products table (queried directly from Supabase). The previous mapping
// had drifted from both: it pointed most Shirts/T-Shirts/Pants categories at a /men/ parent path
// the site no longer uses (categories now live flat under /shirts/, /t-shirts-2/, /pants/,
// /track-pants/), and several keys didn't match the live category names at all (e.g. "lenin
// plain" vs. the actual "Lenin Plain Shirts", "polo fit pant" vs. "Polo Fit Pants") — so
// getCategoryUrl() was silently falling back to the generic shop page for most subcategories.
const CATEGORY_URLS = {
    'shirts': 'https://www.supercollections.in/product-category/shirts/',
    'casual shirts': 'https://www.supercollections.in/product-category/shirts/casual-shirts/',
    'cotton shirts': 'https://www.supercollections.in/product-category/shirts/cotton-shirts/',
    'plain shirts': 'https://www.supercollections.in/product-category/shirts/plain-shirts/',
    'printed shirts': 'https://www.supercollections.in/product-category/shirts/printed-shirts/',
    'white shirts': 'https://www.supercollections.in/product-category/shirts/white-shirts/',
    'big size shirts': 'https://www.supercollections.in/product-category/shirts/big-size-shirts/',
    'chava print shirts': 'https://www.supercollections.in/product-category/shirts/chava-print/',
    'lenin plain shirts': 'https://www.supercollections.in/product-category/shirts/lenin-plain-shirts/',
    'micro stripes shirts': 'https://www.supercollections.in/product-category/shirts/micro-stripes-shirts/',
    'stripes shirts': 'https://www.supercollections.in/product-category/shirts/stripes-shirts/',

    't-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/',
    'brand t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/brand-t-shirt/',
    'black t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/black-t-shirts/',
    'five sleeve t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/five-sleeve-t-shirts/',
    'football t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/football-t-shirts/',
    'polo t-shirts (pocket)': 'https://www.supercollections.in/product-category/t-shirts-2/polo-t-shirts-pocket/',
    'round neck t- shirts': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',

    'pants': 'https://www.supercollections.in/product-category/pants/',
    'gurkha pants': 'https://www.supercollections.in/product-category/pants/gurkha-pants/',
    'lycra pants': 'https://www.supercollections.in/product-category/pants/lycra-pants/',
    'polo fit pants': 'https://www.supercollections.in/product-category/pants/polo-fit-pants/',

    'track pants': 'https://www.supercollections.in/product-category/track-pants/',
    'cargo track pants': 'https://www.supercollections.in/product-category/track-pants/cargo-track-pants/',

    'imported shorts': 'https://www.supercollections.in/product-category/imported-shorts/',
    'new arrivals': 'https://www.supercollections.in/product-category/new-arrivals/'
};

// Sent whenever a subcategory has no entry above — either a category added in WooCommerce after
// this mapping was last updated, or a non-specific umbrella value like "Men"/"General" that was
// never meant to have its own page — so the CTA button always points somewhere valid.
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
