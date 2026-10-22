import { addWhatsAppUTM } from './utils.js';
import { supabase } from './supabase.js';

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
    'casual shirt': 'https://www.supercollections.in/product-category/shirts/casual-shirts/',
    'cotton shirts': 'https://www.supercollections.in/product-category/shirts/cotton-shirts/',
    'cotton shirt': 'https://www.supercollections.in/product-category/shirts/cotton-shirts/',
    'party wear shirts': 'https://www.supercollections.in/product-category/shirts/party-wear-shirts/',
    'party wear shirt': 'https://www.supercollections.in/product-category/shirts/party-wear-shirts/',
    'party wear': 'https://www.supercollections.in/product-category/shirts/party-wear-shirts/',
    'partywear shirts': 'https://www.supercollections.in/product-category/shirts/party-wear-shirts/',
    'partywear shirt': 'https://www.supercollections.in/product-category/shirts/party-wear-shirts/',
    'partywear': 'https://www.supercollections.in/product-category/shirts/party-wear-shirts/',
    'plain shirts': 'https://www.supercollections.in/product-category/shirts/plain-shirts/',
    'plain shirt': 'https://www.supercollections.in/product-category/shirts/plain-shirts/',
    'printed shirts': 'https://www.supercollections.in/product-category/shirts/printed-shirts/',
    'printed shirt': 'https://www.supercollections.in/product-category/shirts/printed-shirts/',
    'white shirts': 'https://www.supercollections.in/product-category/shirts/white-shirts/',
    'white shirt': 'https://www.supercollections.in/product-category/shirts/white-shirts/',
    'big size shirts': 'https://www.supercollections.in/product-category/shirts/big-size-shirts/',
    'big size shirt': 'https://www.supercollections.in/product-category/shirts/big-size-shirts/',
    'chava shirts': 'https://www.supercollections.in/product-category/shirts/chava-shirts/',
    'chava shirt': 'https://www.supercollections.in/product-category/shirts/chava-shirts/',
    'chava': 'https://www.supercollections.in/product-category/shirts/chava-shirts/',
    'chava-shirts': 'https://www.supercollections.in/product-category/shirts/chava-shirts/',
    'chava-shirt': 'https://www.supercollections.in/product-category/shirts/chava-shirts/',
    'chava print shirts': 'https://www.supercollections.in/product-category/shirts/chava-shirts/',
    'chava print shirt': 'https://www.supercollections.in/product-category/shirts/chava-shirts/',
    'chava print': 'https://www.supercollections.in/product-category/shirts/chava-shirts/',
    'lenin plain shirts': 'https://www.supercollections.in/product-category/shirts/lenin-plain-shirts/',
    'lenin plain shirt': 'https://www.supercollections.in/product-category/shirts/lenin-plain-shirts/',
    'micro stripes shirts': 'https://www.supercollections.in/product-category/shirts/micro-stripes-shirts/',
    'stripe shirts': 'https://www.supercollections.in/product-category/shirts/stripe-shirts/',
    'stripe shirt': 'https://www.supercollections.in/product-category/shirts/stripe-shirts/',
    'stripes shirts': 'https://www.supercollections.in/product-category/shirts/stripe-shirts/',
    'stripes shirt': 'https://www.supercollections.in/product-category/shirts/stripe-shirts/',
    'striped shirts': 'https://www.supercollections.in/product-category/shirts/stripe-shirts/',
    'striped shirt': 'https://www.supercollections.in/product-category/shirts/stripe-shirts/',
    'double pocket shirts': 'https://www.supercollections.in/product-category/shirts/double-pocket-shirts/',
    'double pocket shirt': 'https://www.supercollections.in/product-category/shirts/double-pocket-shirts/',
    'double pocket': 'https://www.supercollections.in/product-category/shirts/double-pocket-shirts/',
    'double pocket shirts archives': 'https://www.supercollections.in/product-category/shirts/double-pocket-shirts/',
    'double pocket checks shirts': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket checks shirt': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket check shirts': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket check shirt': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket checked shirts': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket checked shirt': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket checks': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket check': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket checks shirts archives': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'double pocket check shirts archives': 'https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/',
    'oxford shirts': 'https://www.supercollections.in/product-category/shirts/oxford-shirts/',
    'oxford shirt': 'https://www.supercollections.in/product-category/shirts/oxford-shirts/',
    'five sleeve shirts': 'https://www.supercollections.in/product-category/shirts/five-sleeve-shirts/',
    'five sleeve shirt': 'https://www.supercollections.in/product-category/shirts/five-sleeve-shirts/',
    'cotton lenin plain full sleeve': 'https://www.supercollections.in/product-category/shirts/cotton-lenin-plain-full-sleeve/',
    'cotton lenin plain full sleeve shirts': 'https://www.supercollections.in/product-category/shirts/cotton-lenin-plain-full-sleeve/',
    'cotton lenin plain full sleeve shirt': 'https://www.supercollections.in/product-category/shirts/cotton-lenin-plain-full-sleeve/',
    'baggy shirts': 'https://www.supercollections.in/product-category/shirts/baggy-shirts/',
    'baggy shirt': 'https://www.supercollections.in/product-category/shirts/baggy-shirts/',
    'chinese collar shirts': 'https://www.supercollections.in/product-category/shirts/chinese-collar-shirts/',
    'chinese collar shirt': 'https://www.supercollections.in/product-category/shirts/chinese-collar-shirts/',
    'full sleeve premium linen shirts': 'https://www.supercollections.in/product-category/shirts/full-sleeve-premium-linen-shirts/',
    'full sleeve premium linen shirt': 'https://www.supercollections.in/product-category/shirts/full-sleeve-premium-linen-shirts/',
    'korean linen shirts': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'korean linen shirt': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'korean linen': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'korean shirts': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'korean shirt': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'linen shirts': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'linen shirt': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'linen': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'lenin shirts': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'lenin shirt': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'lenin': 'https://www.supercollections.in/product-category/shirts/korean-linen-shirts/',
    'korean plain linen shirts': 'https://www.supercollections.in/product-category/shirts/korean-plain-linen-shirts/',
    'korean plain linen shirt': 'https://www.supercollections.in/product-category/shirts/korean-plain-linen-shirts/',
    'checked shirts': 'https://www.supercollections.in/product-category/shirts/checked-shirts/',
    'checked shirt': 'https://www.supercollections.in/product-category/shirts/checked-shirts/',
    'check shirts': 'https://www.supercollections.in/product-category/shirts/checked-shirts/',
    'check shirt': 'https://www.supercollections.in/product-category/shirts/checked-shirts/',
    'checks shirts': 'https://www.supercollections.in/product-category/shirts/checked-shirts/',
    'checks shirt': 'https://www.supercollections.in/product-category/shirts/checked-shirts/',
    '2xl shirts': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    '2xl shirt': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    '2xl': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    '2xl-shirts': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    '2xl-shirt': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    '2xl shirts archives': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    'xxl shirts': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    'xxl shirt': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    'xxl': 'https://www.supercollections.in/product-category/shirts/2xl-shirts/',
    'dobby checks': 'https://www.supercollections.in/product-category/shirts/dobby-checks/',
    'dobby check': 'https://www.supercollections.in/product-category/shirts/dobby-checks/',
    'dobby checks shirts': 'https://www.supercollections.in/product-category/shirts/dobby-checks/',
    'dobby check shirts': 'https://www.supercollections.in/product-category/shirts/dobby-checks/',
    'dobby checks shirt': 'https://www.supercollections.in/product-category/shirts/dobby-checks/',
    'dobby check shirt': 'https://www.supercollections.in/product-category/shirts/dobby-checks/',

    't-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    't shirts': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    't shirt': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    't-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'polo t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'polo t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'polo t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'polo t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'polo tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'polo tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirts/',
    'brand t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/brand-t-shirt/',
    'black t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/black-t-shirts/',
    'white t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/white-t-shirt/',
    'white t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/white-t-shirt/',
    'white t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/white-t-shirt/',
    'white t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/white-t-shirt/',
    'white tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/white-t-shirt/',
    'white tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/white-t-shirt/',
    'five sleeve t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/five-sleeve-t-shirts/',
    'football t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/football-t-shirts/',
    'football t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/football-t-shirts/',
    'football t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/football-t-shirts/',
    'football t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/football-t-shirts/',
    'football tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/football-t-shirts/',
    'football': 'https://www.supercollections.in/product-category/t-shirts-2/football-t-shirts/',
    'polo t-shirts (pocket)': 'https://www.supercollections.in/product-category/t-shirts-2/polo-t-shirts-pocket/',
    'round neck t- shirts': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',
    'round neck t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',
    'round neck t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',
    'round neck t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',
    'round neck t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',
    'round neck tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',
    'round neck tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',
    'round neck': 'https://www.supercollections.in/product-category/t-shirts-2/round-neck-t-shirts/',
    'high neck t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'high neck t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'high neck t- shirt': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'high neck t- shirts': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'high neck t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'high neck t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'high neck tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'high neck tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'high neck': 'https://www.supercollections.in/product-category/t-shirts-2/high-neck-t-shirt/',
    'stripe t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'stripe t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'stripe t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'stripe t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'stripe tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'stripe tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'striped t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'striped t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'striped t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'striped t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'stripes t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'stripes t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'mars fabric tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'mars fabric t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'stripe t shirts/mars fabric tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/stripe-t-shirts/',
    'zipper t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/zipper-t-shirts/',
    'zipper t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/zipper-t-shirts/',
    'zipper t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/zipper-t-shirts/',
    'zipper t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/zipper-t-shirts/',
    'zipper tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/zipper-t-shirts/',
    'zipper tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/zipper-t-shirts/',
    'zipper': 'https://www.supercollections.in/product-category/t-shirts-2/zipper-t-shirts/',
    'full hand t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full hand t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full hand t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full hand t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full hand tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full hand tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full hand': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full sleeve t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full sleeve t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full sleeve t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'full sleeve t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/full-hand-t-shirts/',
    'sleeveless t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/sleeveless-t-shirts/',
    'sleeveless t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/sleeveless-t-shirts/',
    'sleeveless t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/sleeveless-t-shirts/',
    'sleeveless t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/sleeveless-t-shirts/',
    'sleeveless tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/sleeveless-t-shirts/',
    'sleeveless tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/sleeveless-t-shirts/',
    'sleeveless': 'https://www.supercollections.in/product-category/t-shirts-2/sleeveless-t-shirts/',
    'half and half t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/half-and-half-t-shirts/',
    'half and half t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/half-and-half-t-shirts/',
    'half and half t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/half-and-half-t-shirts/',
    'half and half t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/half-and-half-t-shirts/',
    'half and half tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/half-and-half-t-shirts/',
    'half and half tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/half-and-half-t-shirts/',
    'half & half t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/half-and-half-t-shirts/',
    'cod t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/cod-t-shirts/',
    'cod t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/cod-t-shirts/',
    'acid wash t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash shirts': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash shirt': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',
    'acid wash t shirts archives': 'https://www.supercollections.in/product-category/t-shirts-2/acid-wash-t-shirts/',

    'dry fit t-shirts': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dry fit t-shirt': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dry fit t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dry fit t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dry fit tshirts': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dry fit tshirt': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dry fit': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dryfit': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dry-fit': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',
    'dry fit t shirts archives': 'https://www.supercollections.in/product-category/t-shirts-2/dry-fit-t-shirts/',

    'pants': 'https://www.supercollections.in/product-category/pants/',
    'gurkha pants': 'https://www.supercollections.in/product-category/pants/gurkha-pants/',
    'lycra pants': 'https://www.supercollections.in/product-category/pants/lycra-pants/',
    'polo fit pants': 'https://www.supercollections.in/product-category/pants/polo-fit-pants/',
    'mom fit pant': 'https://www.supercollections.in/product-category/pants/mom-fit-pant/',
    'mom fit pants': 'https://www.supercollections.in/product-category/pants/mom-fit-pant/',
    'cargo big size pants': 'https://www.supercollections.in/product-category/pants/cargo-big-size-pants/',
    'cargo big size pant': 'https://www.supercollections.in/product-category/pants/cargo-big-size-pants/',
    'big size cargo pants': 'https://www.supercollections.in/product-category/pants/cargo-big-size-pants/',
    'big size cargo pant': 'https://www.supercollections.in/product-category/pants/cargo-big-size-pants/',
    'jeans pant': 'https://www.supercollections.in/product-category/pants/jean-pant/',
    'jeans pants': 'https://www.supercollections.in/product-category/pants/jean-pant/',
    'jean pant': 'https://www.supercollections.in/product-category/pants/jean-pant/',
    'jean pants': 'https://www.supercollections.in/product-category/pants/jean-pant/',
    'jeans': 'https://www.supercollections.in/product-category/pants/jean-pant/',
    'jean': 'https://www.supercollections.in/product-category/pants/jean-pant/',
    'offer jeans pant': 'https://www.supercollections.in/product-category/pants/offer-jeans-pant/',
    'offer jeans': 'https://www.supercollections.in/product-category/pants/offer-jeans-pant/',
    'offer jeans pants': 'https://www.supercollections.in/product-category/pants/offer-jeans-pant/',
    'traveller /travel pant': 'https://www.supercollections.in/product-category/pants/traveller-travel-pant/',
    'traveller travel pant': 'https://www.supercollections.in/product-category/pants/traveller-travel-pant/',
    'travel pant': 'https://www.supercollections.in/product-category/pants/traveller-travel-pant/',
    'traveller pant': 'https://www.supercollections.in/product-category/pants/traveller-travel-pant/',
    'travel pants': 'https://www.supercollections.in/product-category/pants/traveller-travel-pant/',
    'traveller pants': 'https://www.supercollections.in/product-category/pants/traveller-travel-pant/',

    'linen pants': 'https://www.supercollections.in/product-category/pants/linen-pants/',
    'linen pant': 'https://www.supercollections.in/product-category/pants/linen-pants/',
    'lenin pants': 'https://www.supercollections.in/product-category/pants/linen-pants/',
    'lenin pant': 'https://www.supercollections.in/product-category/pants/linen-pants/',
    'linen-pants': 'https://www.supercollections.in/product-category/pants/linen-pants/',
    'linen-pant': 'https://www.supercollections.in/product-category/pants/linen-pants/',
    'linen pants archives': 'https://www.supercollections.in/product-category/pants/linen-pants/',

    'bootcut pants': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'bootcut pant': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'boot cut pants': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'boot cut pant': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'bootcut': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'boot cut': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',

    'embroidered shirts': 'https://www.supercollections.in/product-category/shirts/embroidered-shirts/',
    'embroidered shirt': 'https://www.supercollections.in/product-category/shirts/embroidered-shirts/',
    'half and half shirts': 'https://www.supercollections.in/product-category/shirts/half-and-half-shirts/',
    'half and half shirt': 'https://www.supercollections.in/product-category/shirts/half-and-half-shirts/',
    'linen half sleeve shirt': 'https://www.supercollections.in/product-category/shirts/linen-half-sleeve-shirt/',
    'lenin half sleeve shirt': 'https://www.supercollections.in/product-category/shirts/linen-half-sleeve-shirt/',
    'korean stripes shirt': 'https://www.supercollections.in/product-category/shirts/korean-stripes-shirt/',
    'korean stripes shirts': 'https://www.supercollections.in/product-category/shirts/korean-stripes-shirt/',
    'lenin white shirts': 'https://www.supercollections.in/product-category/shirts/lenin-white-shirts/',
    'lenin white shirt': 'https://www.supercollections.in/product-category/shirts/lenin-white-shirts/',
    'linen white shirts': 'https://www.supercollections.in/product-category/shirts/lenin-white-shirts/',
    'linen white shirt': 'https://www.supercollections.in/product-category/shirts/lenin-white-shirts/',

    'track pants': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    'track pant': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    'trak pants': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    'trak pant': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3pcs track pants': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3pcs track pant': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3pcs trak pants': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3pcs trak pant': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3 pcs track pants': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3 pcs track pant': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3 pcs trak pants': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3 pcs trak pant': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3pc track pants': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3pc track pant': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3pc trak pants': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    '3pc trak pant': 'https://www.supercollections.in/product-category/track-pants/3pcs-track-pants/',
    'cargo pants': 'https://www.supercollections.in/product-category/cargo-pants/',
    'cargo pant': 'https://www.supercollections.in/product-category/cargo-pants/',
    'cargo': 'https://www.supercollections.in/product-category/cargo-pants/',
    'cargo track pants': 'https://www.supercollections.in/product-category/cargo-pants/',
    'cargo track pant': 'https://www.supercollections.in/product-category/cargo-pants/',
    'baggy track pants': 'https://www.supercollections.in/product-category/track-pants/baggy-track-pants/',
    'baggy track pant': 'https://www.supercollections.in/product-category/track-pants/baggy-track-pants/',
    'gap jogger fit track pant': 'https://www.supercollections.in/product-category/track-pants/gap-jogger-fit-track-pant/',
    'gap jogger fit': 'https://www.supercollections.in/product-category/track-pants/gap-jogger-fit-track-pant/',
    'adidas popcorn track pant': 'https://www.supercollections.in/product-category/track-pants/adidas-popcorn-track-pant/',
    'popcorn track pant': 'https://www.supercollections.in/product-category/track-pants/adidas-popcorn-track-pant/',

    'shorts': 'https://www.supercollections.in/product-category/shorts/',
    'bermuda shorts': 'https://www.supercollections.in/product-category/shorts/barmuda-shorts/',
    'barmuda shorts': 'https://www.supercollections.in/product-category/shorts/barmuda-shorts/',
    'imported shorts': 'https://www.supercollections.in/product-category/imported-shorts/',
    'max shorts': 'https://www.supercollections.in/product-category/shorts/max-shorts/',
    'max short': 'https://www.supercollections.in/product-category/shorts/max-shorts/',
    'max': 'https://www.supercollections.in/product-category/shorts/max-shorts/',
    'shorts-shorts': 'https://www.supercollections.in/product-category/shorts/shorts-shorts/',
    'shorts shorts': 'https://www.supercollections.in/product-category/shorts/shorts-shorts/',
    'new arrivals': 'https://www.supercollections.in/product-category/new-arrivals/',

    'hoody': 'https://www.supercollections.in/product-category/t-shirts-2/hoody/',
    'hoodie': 'https://www.supercollections.in/product-category/t-shirts-2/hoody/',
    'hoodies': 'https://www.supercollections.in/product-category/t-shirts-2/hoody/',

    'side panel t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirt/',
    'side panel t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirt/',
    'side panel': 'https://www.supercollections.in/product-category/t-shirts-2/t-shirt/',
    'collar t shirts': 'https://www.supercollections.in/product-category/t-shirts-2/polo-t-shirts-pocket/',
    'collar t shirt': 'https://www.supercollections.in/product-category/t-shirts-2/polo-t-shirts-pocket/',
    'men': 'https://www.supercollections.in/product-category/men/',
    'cotton pants': 'https://www.supercollections.in/product-category/pants/polo-fit-pants/',
    'cotton pant': 'https://www.supercollections.in/product-category/pants/polo-fit-pants/',
    'formal shirts': 'https://www.supercollections.in/product-category/shirts/oxford-shirts/',
    'striped shirts': 'https://www.supercollections.in/product-category/shirts/stripe-shirts/',
    'striped shirt': 'https://www.supercollections.in/product-category/shirts/stripe-shirts/',
    'one inch striped shirt': 'https://www.supercollections.in/product-category/shirts/korean-stripes-shirt/',
    'one inch striped shirts': 'https://www.supercollections.in/product-category/shirts/korean-stripes-shirt/'
};

// Sent whenever a subcategory has no entry above - either a category added in WooCommerce after
// this mapping was last updated, or a non-specific umbrella value like "Men"/"General" that was
// never meant to have its own page - so the CTA button always points somewhere valid.
const FALLBACK_SHOP_URL = 'https://www.supercollections.in/shop/';

const PARENT_CATEGORY_URLS = {
    shirts: CATEGORY_URLS['shirts'],
    't-shirts': CATEGORY_URLS['t-shirts'],
    'white t-shirts': CATEGORY_URLS['white t-shirts'],
    'stripe t-shirts': CATEGORY_URLS['stripe t-shirts'],
    'zipper t-shirts': CATEGORY_URLS['zipper t-shirts'],
    'full hand t-shirts': CATEGORY_URLS['full hand t-shirts'],
    'sleeveless t-shirts': CATEGORY_URLS['sleeveless t-shirts'],
    'half and half t-shirts': CATEGORY_URLS['half and half t-shirts'],
    'round neck t-shirts': CATEGORY_URLS['round neck t-shirts'],
    'football t-shirts': CATEGORY_URLS['football t-shirts'],
    pants: CATEGORY_URLS['pants'],
    'linen pants': 'https://www.supercollections.in/product-category/pants/linen-pants/',
    'linen pant': 'https://www.supercollections.in/product-category/pants/linen-pants/',
    'bootcut pants': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'bootcut pant': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'boot cut pants': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'boot cut pant': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'bootcut': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'boot cut': 'https://www.supercollections.in/product-category/pants/bootcut-pants/',
    'cargo pants': CATEGORY_URLS['cargo pants'],
    'cargo pant': CATEGORY_URLS['cargo pants'],
    'cargo': CATEGORY_URLS['cargo pants'],
    'track pants': CATEGORY_URLS['3pcs track pants'],
    'track pant': CATEGORY_URLS['3pcs track pants'],
    '3pcs track pants': CATEGORY_URLS['3pcs track pants'],
    'shorts': CATEGORY_URLS['shorts'],
    'bermuda shorts': CATEGORY_URLS['bermuda shorts'],
    'barmuda shorts': CATEGORY_URLS['barmuda shorts'],
    'imported shorts': CATEGORY_URLS['imported shorts'],
    'max shorts': CATEGORY_URLS['max shorts'],
    'new arrivals': CATEGORY_URLS['new arrivals'],
    'hoody': CATEGORY_URLS['hoody'],
    'korean linen shirts': CATEGORY_URLS['korean linen shirts'],
    'chava shirts': CATEGORY_URLS['chava shirts'],
    'chava': CATEGORY_URLS['chava shirts'],
    'acid wash t-shirts': CATEGORY_URLS['acid wash t-shirts'],
    'acid wash': CATEGORY_URLS['acid wash']
};

function normalizeCategoryKey(categoryName) {
    return (categoryName || '')
        .toLowerCase()
        .trim()
        .replace(/\bt\s*-\s*shirts?\b/g, 't-shirts')
        .replace(/\bt\s*-\s*shirt\b/g, 't-shirt')
        .replace(/\s*\/\s*/g, '/')
        .replace(/\s+/g, ' ');
}

function getParentFallbackUrl(key) {
    if (key.includes('chava')) return CATEGORY_URLS['chava shirts'];
    if (key.includes('acid')) return CATEGORY_URLS['acid wash t-shirts'];
    if (key.includes('high neck')) return CATEGORY_URLS['high neck t-shirt'];
    if (key.includes('zipper')) return CATEGORY_URLS['zipper t-shirts'];
    if (key.includes('stripe') && (key.includes('t-shirt') || key.includes('t shirt') || key.includes('tshirt') || !key.includes('shirt'))) return CATEGORY_URLS['stripe t-shirts'];
    if (key.includes('sleeveless')) return CATEGORY_URLS['sleeveless t-shirts'];
    if (key.includes('full hand') || (key.includes('full sleeve') && (key.includes('t-shirt') || key.includes('t shirt') || key.includes('tshirt')))) return CATEGORY_URLS['full hand t-shirts'];
    if (key.includes('half and half') && (key.includes('t-shirt') || key.includes('t shirt') || key.includes('tshirt'))) return CATEGORY_URLS['half and half t-shirts'];
    if (key.includes('round neck')) return CATEGORY_URLS['round neck t-shirts'];
    if (key.includes('football')) return CATEGORY_URLS['football t-shirts'];
    if (key.includes('cargo')) return PARENT_CATEGORY_URLS['cargo pants'];
    if (key.includes('track') || key.includes('trak')) {
        if (key.includes('popcorn') || key.includes('adidas')) return CATEGORY_URLS['adidas popcorn track pant'];
        if (key.includes('baggy')) return CATEGORY_URLS['baggy track pants'];
        if (key.includes('gap') || key.includes('jogger')) return CATEGORY_URLS['gap jogger fit track pant'];
        return CATEGORY_URLS['3pcs track pants'];
    }
    if (key.includes('max')) return CATEGORY_URLS['max shorts'];
    if (key.includes('short')) return PARENT_CATEGORY_URLS['shorts'];
    if (key.includes('new arrival')) return PARENT_CATEGORY_URLS['new arrivals'];
    if (/\bt\s*[-_ ]\s*shirts?\b/i.test(key) || /\bt[-_ ]?shirts?\b/i.test(key) || key.startsWith('t shirt') || key.startsWith('t-shirt') || key.startsWith('tshirt') || key.includes('t-shirt') || key.includes('tshirt') || key.includes(' t shirt')) {
        return PARENT_CATEGORY_URLS['t-shirts'];
    }
    if (key.includes('hood')) return CATEGORY_URLS['hoody'];
    if ((key.includes('linen') || key.includes('lenin')) && (key.includes('pant') || key.includes('trouser'))) return CATEGORY_URLS['linen pants'];
    if (key.includes('bootcut') || key.includes('boot cut')) return CATEGORY_URLS['bootcut pants'];
    if (key.includes('pant') || key.includes('trouser') || key.includes('jean')) return PARENT_CATEGORY_URLS['pants'];
    if (key.includes('korean')) return CATEGORY_URLS['korean linen shirts'];
    if (key.includes('shirt')) return PARENT_CATEGORY_URLS['shirts'];
    return null;
}

// Auto-discovering cache loaded from WooCommerce sitemap (product_cat-sitemap.xml)
// Automatically discovers any new category uploaded on the website so it works immediately without manual mapping.
let sitemapCache = {};
let lastSitemapFetch = 0;
const SITEMAP_TTL = 30 * 60 * 1000; // 30 mins

export async function initCategoryUrlsFromDb() {
    try {
        const { data } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'category_urls_cache')
            .maybeSingle();
        if (data && data.value) {
            const parsed = JSON.parse(data.value);
            sitemapCache = { ...parsed, ...sitemapCache };
            console.log(`[categoryUrls] Loaded ${Object.keys(parsed).length} live category URLs from Supabase cache.`);
        }
    } catch (e) {
        console.warn('[categoryUrls] DB category URLs load skipped:', e.message);
    }
}

export async function refreshSitemapCategoryUrls() {
    try {
        const resp = await fetch('https://www.supercollections.in/product_cat-sitemap.xml', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!resp.ok) return;
        const xml = await resp.text();
        const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
        const map = {};
        for (const u of urls) {
            const clean = u.replace(/\/$/, '');
            const parts = clean.replace('https://www.supercollections.in/product-category/', '').split('/').filter(Boolean);
            if (parts.length > 0) {
                const slug = parts[parts.length - 1].toLowerCase();
                const normName = slug.replace(/-/g, ' ');
                map[normName] = u;
                map[slug] = u;
                if (normName.endsWith('s')) {
                    map[normName.slice(0, -1)] = u;
                } else {
                    map[normName + 's'] = u;
                }
            }
        }
        sitemapCache = { ...sitemapCache, ...map };
        lastSitemapFetch = Date.now();
        console.log(`[categoryUrls] Refreshed ${Object.keys(map).length} live category URLs from sitemap.`);

        // Persist to Supabase settings table so serverless cold starts never start with empty cache
        try {
            await supabase
                .from('settings')
                .upsert([{ key: 'category_urls_cache', value: JSON.stringify(sitemapCache) }], { onConflict: 'key' });
        } catch (dbErr) {
            console.warn('[categoryUrls] Failed to persist category URLs to DB:', dbErr.message);
        }
    } catch (e) {
        console.warn('[categoryUrls] Sitemap refresh skipped:', e.message);
    }
}

// Background auto-refresh and warm cache on module load
initCategoryUrlsFromDb().catch(() => {});
if (typeof fetch !== 'undefined') {
    refreshSitemapCategoryUrls().catch(() => {});
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

    if (key.includes('cargo')) {
        return addWhatsAppUTM('https://www.supercollections.in/product-category/cargo-pants/');
    }

    // Keyword pattern matching for chava shirts
    if (key.includes('chava')) {
        return addWhatsAppUTM(CATEGORY_URLS['chava shirts']);
    }

    // Keyword pattern matching for acid wash t-shirts
    if (key.includes('acid')) {
        return addWhatsAppUTM(CATEGORY_URLS['acid wash t-shirts']);
    }

    // Keyword pattern matching for dry fit t-shirts
    if (key.includes('dry fit') || key.includes('dryfit') || key.includes('dry-fit')) {
        return addWhatsAppUTM(CATEGORY_URLS['dry fit t-shirts']);
    }

    // Keyword pattern matching for zipper t-shirts
    if (key.includes('zipper')) {
        return addWhatsAppUTM(CATEGORY_URLS['zipper t-shirts']);
    }

    // Keyword pattern matching for stripe t-shirts
    if (key.includes('stripe') && (key.includes('t-shirt') || key.includes('t shirt') || key.includes('tshirt') || !key.includes('shirt'))) {
        return addWhatsAppUTM(CATEGORY_URLS['stripe t-shirts']);
    }

    // Keyword pattern matching for stripe shirts
    if ((key.includes('stripe') || key.includes('striped')) && key.includes('shirt') && !key.includes('t-shirt') && !key.includes('t shirt') && !key.includes('tshirt') && !key.includes('korean')) {
        return addWhatsAppUTM('https://www.supercollections.in/product-category/shirts/stripe-shirts/');
    }

    // Keyword pattern matching for sleeveless t-shirts
    if (key.includes('sleeveless')) {
        return addWhatsAppUTM(CATEGORY_URLS['sleeveless t-shirts']);
    }

    // Keyword pattern matching for full hand t-shirts
    if (key.includes('full hand') || ((key.includes('full sleeve') || key.includes('full hand')) && (key.includes('t-shirt') || key.includes('t shirt') || key.includes('tshirt')))) {
        return addWhatsAppUTM(CATEGORY_URLS['full hand t-shirts']);
    }

    // Keyword pattern matching for half and half t-shirts
    if (key.includes('half and half') && (key.includes('t-shirt') || key.includes('t shirt') || key.includes('tshirt'))) {
        return addWhatsAppUTM(CATEGORY_URLS['half and half t-shirts']);
    }

    // Keyword pattern matching for round neck t-shirts
    if (key.includes('round neck')) {
        return addWhatsAppUTM(CATEGORY_URLS['round neck t-shirts']);
    }

    // Keyword pattern matching for football t-shirts
    if (key.includes('football')) {
        return addWhatsAppUTM(CATEGORY_URLS['football t-shirts']);
    }

    // Keyword pattern matching for polo t-shirts / t-shirts
    if (key.includes('polo') && (key.includes('t-shirt') || key.includes('t shirt') || key.includes('tshirt') || !key.includes('pant'))) {
        return addWhatsAppUTM(CATEGORY_URLS['t-shirts']);
    }

    // Keyword pattern matching for linen pants
    if ((key.includes('linen') || key.includes('lenin')) && (key.includes('pant') || key.includes('pants'))) {
        return addWhatsAppUTM(CATEGORY_URLS['linen pants']);
    }

    // Keyword pattern matching for bootcut pants
    if (key.includes('bootcut') || key.includes('boot cut')) {
        return addWhatsAppUTM(CATEGORY_URLS['bootcut pants']);
    }

    // Keyword pattern matching for linen/lenin/korean linen shirts
    if ((key.includes('linen') || key.includes('lenin') || key.includes('korean')) &&
        !key.includes('pant') && !key.includes('pants') &&
        !key.includes('half') && !key.includes('cotton') && !key.includes('plain linen')) {
        return addWhatsAppUTM(CATEGORY_URLS['korean linen shirts']);
    }

    // Keyword pattern matching for specific subcategories like party wear, double pocket
    if (key.includes('party wear') || key.includes('partywear')) {
        return addWhatsAppUTM('https://www.supercollections.in/product-category/shirts/party-wear-shirts/');
    }

    if ((key.includes('double pocket') || key.includes('doublepocket')) && (key.includes('check') || key.includes('checks'))) {
        return addWhatsAppUTM('https://www.supercollections.in/product-category/shirts/double-pocket-checks-shirts/');
    }

    if (key.includes('double pocket') || key.includes('doublepocket')) {
        return addWhatsAppUTM('https://www.supercollections.in/product-category/shirts/double-pocket-shirts/');
    }

    // Keyword pattern matching for 2xl shirts
    if ((key.includes('2xl') || key.includes('xxl')) && !key.includes('t-shirt') && !key.includes('tshirt') && !key.includes('t shirt') && !key.includes('pant') && !key.includes('short')) {
        return addWhatsAppUTM('https://www.supercollections.in/product-category/shirts/2xl-shirts/');
    }

    if (key.includes('dobby')) {
        return addWhatsAppUTM('https://www.supercollections.in/product-category/shirts/dobby-checks/');
    }

    // Keyword pattern matching for white t-shirts
    if (key.includes('white') && (key.includes('t-shirt') || key.includes('tshirt') || key.includes('t shirt'))) {
        return addWhatsAppUTM('https://www.supercollections.in/product-category/t-shirts-2/white-t-shirt/');
    }

    // Keyword pattern matching for 3pcs track pants / track pants
    if (key.includes('3pcs') || key.includes('3 pcs') || key.includes('3pc')) {
        return addWhatsAppUTM(CATEGORY_URLS['3pcs track pants']);
    }
    if ((key.includes('track') || key.includes('trak')) &&
        !key.includes('cargo') && !key.includes('popcorn') && !key.includes('adidas') &&
        !key.includes('baggy') && !key.includes('gap') && !key.includes('jogger')) {
        return addWhatsAppUTM(CATEGORY_URLS['3pcs track pants']);
    }

    // 1. Check dynamic sitemap cache (auto-synced from WordPress product_cat-sitemap.xml)
    if (sitemapCache[key]) {
        return addWhatsAppUTM(sitemapCache[key]);
    }
    const slugKey = key.replace(/\s+/g, '-');
    if (sitemapCache[slugKey]) {
        return addWhatsAppUTM(sitemapCache[slugKey]);
    }

    // 2. Auto-derive standard WooCommerce category URL for newly uploaded categories
    const cleanSlug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (cleanSlug) {
        const isTShirt = /\bt[-_ ]?shirts?\b/i.test(key) || /\btshirts?\b/i.test(key);
        const isShirt = /\bshirts?\b/i.test(key) && !isTShirt;
        const isTrack = /\btrack\b/i.test(key);
        const isPant = /\bpants?\b/i.test(key) && !isTrack;
        const isShort = /\bshorts?\b/i.test(key);

        if (isShirt) {
            return addWhatsAppUTM(`https://www.supercollections.in/product-category/shirts/${cleanSlug}/`);
        }
        if (isTShirt) {
            return addWhatsAppUTM(`https://www.supercollections.in/product-category/t-shirts-2/${cleanSlug}/`);
        }
        if (isPant) {
            return addWhatsAppUTM(`https://www.supercollections.in/product-category/pants/${cleanSlug}/`);
        }
        if (isTrack) {
            return addWhatsAppUTM(`https://www.supercollections.in/product-category/track-pants/${cleanSlug}/`);
        }
        if (isShort) {
            return addWhatsAppUTM(`https://www.supercollections.in/product-category/shorts/${cleanSlug}/`);
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
