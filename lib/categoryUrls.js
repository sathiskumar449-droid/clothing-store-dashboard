import { addWhatsAppUTM } from './utils.js';

// Maps WooCommerce subcategory names (as stored in our products table) to their live
// supercollections.in category page URLs. WooCommerce slugs are NOT derivable from the
// category name here - there's no per-category URL field on a product row.
//
// Rebuilt by cross-referencing product_cat-sitemap.xml against the distinct `category` values
// actually present in the products table (queried directly from Supabase). The previous mapping
// had drifted from both: it pointed most Shirts/T-Shirts/Pants categories at a /men/ parent path
// the site no longer uses (categories now live flat under /shirts/, /t-shirts-2/, /pants/,
// /track-pants/), and several keys didn't match the live category names at all (e.g. "lenin
// plain" vs. the actual "Lenin Plain Shirts", "polo fit pant" vs. "Polo Fit Pants") - so
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
    't shirts': 'https://www.supercollections.in/product-category/t-shirts-2/',
    'tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/',
    't shirt': 'https://www.supercollections.in/product-category/t-shirts-2/',
    'brand t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/brand-t-shirt/',
    'black t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/black-t-shirts/',
    'five sleeve t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/five-sleeve-t-shirts/',
    'football t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/football-t-shirts/',
    'polo t-shirts (pocket)': 'https://www.supercollections.in/product-category/t-shirts-2/polo-t-shirts-pocket/',
    'round neck t- shirts': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-round-neck-t-shirts/',
    'stripe t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/',
    'stripe t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/',
    'mars fabric tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/',
    'mars fabric t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/',
    'stripe t shirts/mars fabric tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/',

    'pants': 'https://www.supercollections.in/product-category/pants/',
    'gurkha pants': 'https://www.supercollections.in/product-category/pants/gurkha-pants/',
    'lycra pants': 'https://www.supercollections.in/product-category/pants/lycra-pants/',
    'polo fit pants': 'https://www.supercollections.in/product-category/pants/polo-fit-pants/',

    'track pants': 'https://www.supercollections.in/product-category/track-pants/',
    'cargo track pants': 'https://www.supercollections.in/product-category/track-pants/cargo-track-pants/',

    'imported shorts': 'https://www.supercollections.in/product-category/imported-shorts/',
    'new arrivals': 'https://www.supercollections.in/product-category/new-arrivals/'
};

// Sent whenever a subcategory has no entry above - either a category added in WooCommerce after
// this mapping was last updated, or a non-specific umbrella value like "Men"/"General" that was
// never meant to have its own page - so the CTA button always points somewhere valid.
const FALLBACK_SHOP_URL = 'https://www.supercollections.in/shop/';

const PARENT_CATEGORY_URLS = {
    shirts: CATEGORY_URLS['shirts'],
    't-shirts': CATEGORY_URLS['t-shirts'],
    pants: CATEGORY_URLS['pants'],
    'track pants': CATEGORY_URLS['track pants'],
    'imported shorts': CATEGORY_URLS['imported shorts'],
    'new arrivals': CATEGORY_URLS['new arrivals']
};

function normalizeCategoryKey(categoryName) {
    return (categoryName || '')
        .toLowerCase()
        .trim()
        .replace(/\s*\/\s*/g, '/')
        .replace(/\s+/g, ' ');
}

function getParentFallbackUrl(key) {
    if (key.includes('track') || key.includes('cargo')) return PARENT_CATEGORY_URLS['track pants'];
    if (key.includes('short')) return PARENT_CATEGORY_URLS['imported shorts'];
    if (key.includes('new arrival')) return PARENT_CATEGORY_URLS['new arrivals'];
    if (key.includes('t-shirt') || key.includes('t shirts') || key.includes('t shirt') || key.includes('tshirt')) {
        return PARENT_CATEGORY_URLS['t-shirts'];
    }
    if (key.includes('pant') || key.includes('trouser') || key.includes('jean')) return PARENT_CATEGORY_URLS['pants'];
    if (key.includes('shirt')) return PARENT_CATEGORY_URLS['shirts'];
    return null;
}

// Case-insensitive, whitespace-normalized lookup. Falls back to the best parent category URL
// before using the generic shop page, so composite names like "Stripe T Shirts/mars Fabric tShirt"
// still open a relevant collection page.
export function getCategoryUrl(categoryName) {
    const key = normalizeCategoryKey(categoryName);
    const exactUrl = CATEGORY_URLS[key];
    if (exactUrl) return addWhatsAppUTM(exactUrl);

    const segments = key.split(/[\/|,]+/).map(part => part.trim()).filter(Boolean);
    for (const segment of segments) {
        if (CATEGORY_URLS[segment]) {
            return addWhatsAppUTM(CATEGORY_URLS[segment]);
        }
    }

    const parentUrl = getParentFallbackUrl(key);
    if (parentUrl) {
        console.warn(`[categoryUrls] No exact URL mapping for category "${categoryName}" - falling back to parent category URL.`);
        return addWhatsAppUTM(parentUrl);
    }

    console.warn(`[categoryUrls] No URL mapping for category "${categoryName}" - falling back to shop page. Add an entry to lib/categoryUrls.js.`);
    return addWhatsAppUTM(FALLBACK_SHOP_URL);
}
