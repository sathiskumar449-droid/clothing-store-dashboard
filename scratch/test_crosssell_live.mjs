import 'dotenv/config';
import * as wh from '../api/webhook.js';

const isShirtCategory = (cat, name = '') => {
    const parent = wh.getParentCategory(cat);
    if (parent === 'Shirts') return true;
    const catLower = (cat || '').toLowerCase();
    const nameLower = (name || '').toLowerCase();
    return (catLower.includes('shirt') || nameLower.includes('shirt')) &&
        !catLower.includes('t-shirt') && !catLower.includes('t shirt') && !catLower.includes('tshirt') &&
        !nameLower.includes('t-shirt') && !nameLower.includes('t shirt') && !nameLower.includes('tshirt');
};

const isTShirtCategory = (cat, name = '') => {
    const parent = wh.getParentCategory(cat);
    if (parent === 'T-Shirts') return true;
    const catLower = (cat || '').toLowerCase();
    const nameLower = (name || '').toLowerCase();
    return catLower.includes('t-shirt') || catLower.includes('t shirt') || catLower.includes('tshirt') ||
        nameLower.includes('t-shirt') || nameLower.includes('t shirt') || nameLower.includes('tshirt');
};

const isPantOrJeansCategory = (cat, name = '') => {
    const parent = wh.getParentCategory(cat);
    if (parent === 'Pants' || parent === 'Jeans') return true;
    const catLower = (cat || '').toLowerCase();
    const nameLower = (name || '').toLowerCase();
    return catLower.includes('pant') || catLower.includes('phant') || catLower.includes('jeans') ||
        nameLower.includes('pant') || nameLower.includes('phant') || nameLower.includes('jeans') ||
        nameLower.includes('polofit');
};

const isPoloFitPant = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    const matchesPolo = nameLower.includes('polo fit') || nameLower.includes('polofit') || catLower.includes('polo fit') || catLower.includes('polofit');
    const matchesPant = nameLower.includes('pant') || nameLower.includes('pants') || nameLower.includes('polofit') || catLower.includes('pant') || catLower.includes('pants') || wh.getParentCategory(p.category) === 'Pants';
    return matchesPolo && matchesPant;
};

const isJeans = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    return nameLower.includes('jeans') || nameLower.includes('jean') || catLower.includes('jeans') || catLower.includes('jean') || wh.getParentCategory(p.category) === 'Jeans';
};

const isCargoTrackPant = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    return nameLower.includes('cargo track') || catLower.includes('cargo track') ||
        (nameLower.includes('cargo') && nameLower.includes('track')) ||
        (catLower.includes('cargo') && catLower.includes('track'));
};

const isTrouser = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    return nameLower.includes('trouser') || catLower.includes('trouser');
};

const isJogger = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    return nameLower.includes('jogger') || catLower.includes('jogger');
};

const isFormalPantProduct = (p) => {
    const nameLower = (p?.name || '').toLowerCase();
    const catLower = (p?.category || '').toLowerCase();
    return nameLower.includes('formal pant') || catLower.includes('formal pant') || isTrouser(p);
};

const isCottonPantProduct = (p) => {
    const nameLower = (p?.name || '').toLowerCase();
    const catLower = (p?.category || '').toLowerCase();
    return nameLower.includes('cotton pant') || catLower.includes('cotton pant') || nameLower.includes('chinos') || catLower.includes('chinos');
};

const isBottomWearProduct = (p) => {
    return isPantOrJeansCategory(p?.category, p?.name) || isPoloFitPant(p) || isJeans(p) || isFormalPantProduct(p) || isCottonPantProduct(p) || isCargoTrackPant(p) || isTrouser(p) || isJogger(p);
};

function getCrossSellOffer(addedProduct, allProducts, excludedIds = []) {
    if (!addedProduct) return null;
    const hasValidPrice = (p) => p.price && String(p.price).trim() !== '' && !isNaN(parseFloat(String(p.price).replace(/[^\d.]/g, '')));
    const isExcluded = (id) => excludedIds.some(eid => String(eid) === String(id));

    let offerLabel = 'Matching Styles';
    let promoCategory = wh.getParentCategory(addedProduct.category);
    let matcher = () => false;
    const addedParent = wh.getParentCategory(addedProduct.category);

    if (addedParent === 'T-Shirts') {
        offerLabel = 'Matching Track Pants & Cargo Pants';
        promoCategory = 'Pants';
        matcher = (candidate) => {
            const catLower = (candidate.category || '').toLowerCase();
            const nameLower = (candidate.name || '').toLowerCase();
            const isTrackPant = catLower.includes('track') || nameLower.includes('track') || catLower.includes('trach') || nameLower.includes('trach');
            const isCargoPant = catLower.includes('cargo') || nameLower.includes('cargo');
            return isTrackPant || isCargoPant || isTrouser(candidate) || isJogger(candidate);
        };
    } else if (addedParent === 'Pants') {
        const isTrackOrCargoPant = isCargoTrackPant(addedProduct) || isJogger(addedProduct) || isTrouser(addedProduct) ||
            (addedProduct.category || '').toLowerCase().includes('track') ||
            (addedProduct.name || '').toLowerCase().includes('track') ||
            (addedProduct.category || '').toLowerCase().includes('trach') ||
            (addedProduct.name || '').toLowerCase().includes('trach') ||
            (addedProduct.category || '').toLowerCase().includes('cargo') ||
            (addedProduct.name || '').toLowerCase().includes('cargo');
        if (isTrackOrCargoPant) {
            offerLabel = 'Matching T-Shirts';
            promoCategory = 'T-Shirts';
            matcher = (candidate) => isTShirtCategory(candidate.category, candidate.name);
        } else {
            offerLabel = 'Matching Shirts';
            promoCategory = 'Shirts';
            matcher = (candidate) => isShirtCategory(candidate.category, candidate.name) && !isTShirtCategory(candidate.category, candidate.name);
        }
    } else if (addedParent === 'Shirts') {
        offerLabel = 'Matching Pants';
        promoCategory = 'Pants';
        matcher = (candidate) => isBottomWearProduct(candidate);
    } else {
        offerLabel = 'Matching Pants';
        promoCategory = 'Pants';
        matcher = (candidate) => isBottomWearProduct(candidate);
    }

    const candidates = allProducts.filter(candidate => {
        if (candidate.id === addedProduct.id) return false;
        if (isExcluded(candidate.id)) return false;
        if (Number(candidate.stock) <= 0) return false;
        if (!hasValidPrice(candidate)) return false;
        return matcher(candidate);
    });

    return { offerLabel, promoCategory, candidates };
}

const products = await wh.getProducts();
const inStock = products.filter(p => Number(p.stock) > 0);

// one representative product per real category
const seen = new Set();
const reps = [];
for (const p of inStock) {
    const cat = p.category || 'NONE';
    if (!seen.has(cat)) {
        seen.add(cat);
        reps.push(p);
    }
}

console.log(`\nTesting ${reps.length} representative products (one per category):\n`);
for (const rep of reps) {
    const offer = getCrossSellOffer(rep, inStock, [rep.id]);
    const firstCand = offer.candidates[0];
    console.log(`ADDED: "${rep.name}" [cat="${rep.category}"]`);
    console.log(`  -> promoCategory=${offer.promoCategory}  offerLabel=${offer.offerLabel}  candidates=${offer.candidates.length}`);
    if (firstCand) console.log(`  -> firstCandidate: "${firstCand.name}" [cat="${firstCand.category}"]`);
    console.log('');
}
process.exit(0);
