import { getProducts } from '../api/webhook.js';
import fs from 'fs';

// To mock getSmartRecommendation, let's copy the code from webhook.js here to test it

// --- COPY OF LOGIC FROM WEBHOOK.JS ---
const getProductTag = (product) => {
    const name = (product.name || '').toLowerCase();
    const category = (product.category || '').toLowerCase();

    // 1. Pants, Jeans, Tracks, Cargos
    if (name.includes('formal pant') || category.includes('formal pant')) {
        return 'FORMAL_PANT';
    }
    if (name.includes('cargo') || category.includes('cargo')) {
        return 'CARGO_PANT';
    }
    if (name.includes('track') || name.includes('trach') || category.includes('track') || category.includes('trach')) {
        return 'TRACK_PANT';
    }
    if (name.includes('jeans') || category.includes('jeans')) {
        return 'JEANS';
    }
    if (name.includes('cotton pant') || name.includes('chinos') || category.includes('cotton pant')) {
        return 'COTTON_PANT';
    }
    if (name.includes('pant') || name.includes('phant') || category.includes('pant') || category.includes('pants')) {
        return 'PANT';
    }

    // 2. Shirts and T-Shirts
    if (name.includes('football') || name.includes('jersey') || name.includes('neymar') || name.includes('dhoni') || name.includes('ronaldo') || name.includes('ipl') || category.includes('jersey')) {
        return 'SPORTS_JERSEY';
    }
    if (name.includes('formal shirt') || category.includes('formal shirt')) {
        return 'FORMAL_SHIRT';
    }
    if (name.includes('casual shirt') || category.includes('casual shirt') || name.includes('linen') || name.includes('cotton') || name.includes('plain shirt') || name.includes('printed shirt') || category.includes('lenin') || category.includes('linen')) {
        return 'CASUAL_SHIRT';
    }
    if (name.includes('t-shirt') || name.includes('tshirt') || name.includes('polo') || category.includes('t-shirt') || category.includes('tshirt') || category.includes('t-shirts')) {
        return 'TSHIRT';
    }
    if (name.includes('shirt') || category.includes('shirt') || category.includes('shirts')) {
        return 'SHIRT';
    }

    return 'OTHER';
};

const getTargetRecommendationTags = (tag) => {
    switch (tag) {
        case 'FORMAL_SHIRT': return ['FORMAL_PANT', 'PANT'];
        case 'CASUAL_SHIRT': return ['JEANS', 'COTTON_PANT', 'PANT'];
        case 'TSHIRT': return ['TRACK_PANT'];
        case 'FORMAL_PANT': return ['FORMAL_SHIRT', 'SHIRT'];
        case 'CARGO_PANT': return ['TRACK_PANT', 'TSHIRT'];
        case 'TRACK_PANT': return ['TSHIRT'];
        case 'JEANS':
        case 'COTTON_PANT': return ['CASUAL_SHIRT', 'SHIRT'];
        case 'SHIRT': return ['PANT', 'JEANS', 'COTTON_PANT', 'CARGO_PANT'];
        case 'PANT': return ['CASUAL_SHIRT', 'SHIRT', 'TSHIRT'];
        case 'SPORTS_JERSEY': return ['TRACK_PANT'];
        default: return [];
    }
};

const getProductImageUri = (product, allProducts = []) => {
    if (product.imageUri && product.imageUri.startsWith('http') && product.imageUri !== 'null' && product.imageUri !== 'undefined') {
        return product.imageUri;
    }
    return null;
};

const getParentCategory = (categoryName) => {
    if (!categoryName) return 'General';
    const catLower = categoryName.toLowerCase().trim();
    if (catLower.includes('t-shirt') || catLower.includes('t shirt') || catLower.includes('tshirt')) return 'T-Shirts';
    if (catLower.includes('shirt')) return 'Shirts';
    if (catLower.includes('pant') || catLower.includes('phant')) return 'Pants';
    if (catLower.includes('shorts')) return 'Shorts';
    if (catLower.includes('jeans')) return 'Jeans';
    return categoryName;
};

const getSmartRecommendation = (addedProduct, allProducts, excludedIds = []) => {
    if (!addedProduct) return null;
    const addedTag = getProductTag(addedProduct);
    const targetTags = getTargetRecommendationTags(addedTag);

    const isExcluded = (id) => excludedIds.some(eid => String(eid) === String(id));
    const hasValidImage = (p) => {
        const img = getProductImageUri(p, allProducts);
        return img && img.startsWith('http') && img !== 'null' && img !== 'undefined';
    };
    const hasValidPrice = (p) => p.price && String(p.price).trim() !== '' && !isNaN(parseFloat(String(p.price).replace(/[^\d.]/g, '')));

    // 1. Try to find a matching product with the target tags AND a valid image
    for (const tag of targetTags) {
        const matched = allProducts.find(p => 
            p.id !== addedProduct.id && 
            !isExcluded(p.id) &&
            Number(p.stock) > 0 && 
            hasValidPrice(p) &&
            getProductTag(p) === tag &&
            hasValidImage(p)
        );
        if (matched) return matched;
    }

    // 2. Fallback to matching product with target tags (even without image)
    for (const tag of targetTags) {
        const matched = allProducts.find(p => 
            p.id !== addedProduct.id && 
            !isExcluded(p.id) &&
            Number(p.stock) > 0 && 
            hasValidPrice(p) &&
            getProductTag(p) === tag
        );
        if (matched) return matched;
    }

    // 3. Generic cross-category fallback if no specific smart tag match found (prefer valid image)
    const currentParent = getParentCategory(addedProduct.category);
    const otherParents = Array.from(new Set(
        allProducts
            .filter(p => Number(p.stock) > 0 && hasValidPrice(p) && p.id !== addedProduct.id && !isExcluded(p.id))
            .map(p => getParentCategory(p.category))
    )).filter(p => p !== currentParent);

    if (otherParents.length > 0) {
        let targetParent = null;
        if (currentParent.toLowerCase().includes('shirt')) {
            targetParent = otherParents.find(p => p.toLowerCase().includes('pant') || p.toLowerCase().includes('jeans'));
        } else {
            targetParent = otherParents.find(p => p.toLowerCase().includes('shirt'));
        }
        if (!targetParent) {
            targetParent = otherParents[0];
        }
        // First try finding match with image
        const matchWithImg = allProducts.find(p => 
            getParentCategory(p.category) === targetParent && 
            Number(p.stock) > 0 && 
            hasValidPrice(p) &&
            p.id !== addedProduct.id && 
            !isExcluded(p.id) &&
            hasValidImage(p)
        );
        if (matchWithImg) return matchWithImg;

        // Fallback without image
        return allProducts.find(p => getParentCategory(p.category) === targetParent && Number(p.stock) > 0 && hasValidPrice(p) && p.id !== addedProduct.id && !isExcluded(p.id));
    }

    return null;
};
// --- END OF COPY ---

async function runTest() {
    const products = await getProducts();
    // Simulate user buying "Printed shirt (Black and grey shade)"
    const testProduct = products.find(p => p.name.includes("Printed shirt (Black and grey shade)"));
    if (!testProduct) {
        console.log("Could not find test product");
        process.exit(1);
    }
    
    console.log("Test product:", testProduct.name, "| Tag:", getProductTag(testProduct), "| Targets:", getTargetRecommendationTags(getProductTag(testProduct)));
    const rec = getSmartRecommendation(testProduct, products);
    if (rec) {
        console.log("Recommended:", rec.name, "| Price:", rec.price, "| Image:", rec.imageUri);
    } else {
        console.log("No recommendation found!");
    }
    process.exit(0);
}

runTest();
