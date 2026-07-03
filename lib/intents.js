// lib/intents.js
//
// This file is for NEW intents added going forward. Existing intents stay in
// api/webhook.js. When adding a new intent, add it here — never in webhook.js —
// to keep the growing complexity isolated.
//
// detectNewFaqIntent(text, session) is checked BEFORE api/webhook.js's existing
// detectIntent(), so anything matched here takes priority. It returns a reply
// object in the same shape webhook.js already returns for FAQ-style replies
// (e.g. { replyText, sendImages, sendButtons }), or null if nothing matches —
// in which case webhook.js falls through to its existing behavior unchanged.
//
// Because matches here run first, a matcher must return null for any message
// it doesn't want to fully own — otherwise it silently shadows an existing,
// already-tuned reply in webhook.js's detectIntent/handleIntent chain.

import { supabase } from './supabase.js';
import { addWhatsAppUTM, SIZE_QTY_STRUCTURED_STATES, buildGuidedFallbackReply } from './utils.js';
import { getCategoryUrl } from './categoryUrls.js';
// Circular import (api/webhook.js imports detectNewFaqIntent from this file) — safe here because
// every one of these is only ever called from inside a matcher function at request time, never at
// this module's own top-level evaluation, so by the time any of them actually runs both modules
// have finished loading. Reusing buildSpecificProductReply directly (rather than duplicating its
// formatting AND getProductImageUri's ~50-line fuzzy image-fallback chain that it calls internally)
// keeps a single source of truth — see matchColorQuery below.
import {
    getParentCategory, buildSpecificProductReply,
    extractParenColor, searchTermMatches, COLOR_KEYWORDS, COMPOUND_COLOR_KEYWORDS
} from '../api/webhook.js';

// ─── Local matcher functions (one per intent, checked in priority order) ───

// Smoke test to verify the lib/intents.js -> webhook.js wiring end-to-end.
// Remove or repurpose once the wiring has been confirmed in production.
function matchTestPing(t) {
    if (t === 'test-intents-ping') {
        return { replyText: '🏓 New intents file is working!', sendImages: [] };
    }
    return null;
}

// ─── SIZE-BASED PRODUCT ROUTING ───
// A customer often just types a bare size ("38", "M", "large") expecting a helpful salesperson to
// point them at the right category. NUMBER sizes (waist/chest measurements) only ever mean Pants;
// LETTER sizes are ambiguous between Shirts and T-Shirts, so those either reuse whatever category
// the customer was just looking at (session.selectedParentCategory, set by api/webhook.js's
// category/search flows) or ask which one before answering.

const PANTS_NUMBER_MIN = 26;
const PANTS_NUMBER_MAX = 50;
const PANTS_NUMBER_PHRASE_PATTERN = /\bsize\s*[:\-]?\s*(\d{2})\b|\b(\d{2})\s*size\b/i;

// Extracts a waist-size number (26-50) from a bare "38" or "size 38"/"38 size" phrase. Returns
// null for anything else, including numbers outside that plausible range — so it never swallows
// an unrelated bare number (a subcategory-list index, a partial phone number, an order ID, etc.).
function extractPantsNumberSize(t) {
    const trimmed = (t || '').trim();
    let n = null;
    if (/^\d{2}$/.test(trimmed)) {
        n = parseInt(trimmed, 10);
    } else {
        const m = trimmed.match(PANTS_NUMBER_PHRASE_PATTERN);
        if (m) n = parseInt(m[1] || m[2], 10);
    }
    return (n !== null && n >= PANTS_NUMBER_MIN && n <= PANTS_NUMBER_MAX) ? n : null;
}

// Distinctive multi-letter tokens (XL, XXL, 2XL, 3XL, XS, XXXL) are safe to match anywhere in the
// message. Single-letter S/M/L are only accepted bare (the WHOLE message) or paired with the word
// "size", since a stray "s"/"m"/"l" inside ordinary text is too easy to misread as a size. Full
// words (small/medium/large/"extra large"/"extra small") are accepted too since customers often
// type those instead of the letter.
const LETTER_TOKEN_PATTERN = /\b(xxxl|xxl|3xl|2xl|xl|xs)\b/i;
const LETTER_SML_WITH_WORD_PATTERN = /\bsize\s*[:\-]?\s*(s|m|l)\b|\b(s|m|l)\s*size\b/i;
const LETTER_WORD_MAP = { 'extra small': 'XS', small: 'S', medium: 'M', large: 'L', 'extra large': 'XL' };

function extractLetterSize(t) {
    const trimmed = (t || '').trim().toLowerCase();
    if (!trimmed) return null;
    for (const [word, code] of Object.entries(LETTER_WORD_MAP)) {
        if (trimmed === word || trimmed === `${word} size`) return code;
    }
    const tokenMatch = trimmed.match(LETTER_TOKEN_PATTERN);
    if (tokenMatch) return tokenMatch[1].toUpperCase();
    if (/^(s|m|l)$/i.test(trimmed)) return trimmed.toUpperCase();
    const smlMatch = trimmed.match(LETTER_SML_WITH_WORD_PATTERN);
    if (smlMatch) return (smlMatch[1] || smlMatch[2]).toUpperCase();
    return null;
}

const sizeCategoryReplyText = (emoji, name, link) =>
    `${emoji} ${name} இந்த size-la இருக்கு! 👇 எல்லா options பாக்க link click பண்ணுங்க:\n${link}`;

const ASK_SHIRT_OR_TSHIRT_REPLY = `👕 எந்த category size venum?\n1️⃣ Shirt\n2️⃣ T-Shirt\nNumber அனுப்புங்க 👇`;

// Follow-up to ASK_SHIRT_OR_TSHIRT_REPLY: only fires while session.state is armed for it (set by
// matchSizeQuery below when it asks the question). A clean "1"/"2" answers it; anything else means
// the customer moved on, so this clears the pending flag and hands back the standard guided
// fallback (which also resets state to AWAITING_MAIN_MENU_SELECTION) instead of leaving them stuck
// unable to do anything but answer a question they've abandoned.
function matchSizeCategoryChoice(t, session) {
    if (!session || session.state !== 'AWAITING_SIZE_CATEGORY_CHOICE') return null;

    if (t === '1' || t === '2') {
        session.state = 'AWAITING_SUBCATEGORY_SELECTION';
        const isShirt = t === '1';
        return {
            replyText: sizeCategoryReplyText('👔', isShirt ? 'Shirt' : 'T-Shirt', getCategoryUrl(isShirt ? 'shirts' : 't-shirts')),
            sendImages: []
        };
    }

    return buildGuidedFallbackReply(session);
}

// Bare-size messages ("38", "M size", "large") routed to the right category link. Skipped
// entirely while the session is mid-flow collecting a size/qty for one specific pending product
// (SIZE_QTY_STRUCTURED_STATES) — that free-text reply must reach api/webhook.js's own
// AWAITING_SIZE_SELECTION/AWAITING_PRODUCT_SIZE/AWAITING_PRODUCT_QTY/AWAITING_CART_CONFIRM
// handling, not this. Also returns null for anything that isn't a clean size signal (quantity
// phrases like "4 pieces", measurements like "38 length 46") so those still fall through to
// api/webhook.js's own generic size/qty FAQ reply.
function matchSizeQuery(t, session) {
    if (session && SIZE_QTY_STRUCTURED_STATES.includes(session.state)) return null;

    const pantsSize = extractPantsNumberSize(t);
    if (pantsSize !== null) {
        return {
            replyText: `👖 Pants இந்த size-la இருக்கு! 👇 எல்லா options பாக்க link click பண்ணுங்க:\n${getCategoryUrl('pants')}`,
            sendImages: []
        };
    }

    const letterSize = extractLetterSize(t);
    if (letterSize) {
        const context = session && (session.selectedParentCategory === 'Shirts' || session.selectedParentCategory === 'T-Shirts')
            ? session.selectedParentCategory
            : null;
        if (context) {
            const emoji = context === 'Shirts' ? '👔' : '👕';
            return {
                replyText: sizeCategoryReplyText(emoji, context, getCategoryUrl(context === 'Shirts' ? 'shirts' : 't-shirts')),
                sendImages: []
            };
        }
        if (session) session.state = 'AWAITING_SIZE_CATEGORY_CHOICE';
        return { replyText: ASK_SHIRT_OR_TSHIRT_REPLY, sendImages: [] };
    }

    return null;
}

// ─── COLOUR-CONTEXT PRODUCT ROUTING ───
// A customer who just viewed/asked about a category and then sends a bare colour ("Dark green",
// "Black") means "in THAT category". Without scoping, the existing free-text SEARCH in
// api/webhook.js scores colour words against the WHOLE catalog and can return a product from a
// completely different subcategory that happens to share the colour word (e.g. "cargo track (lime
// green)" for a customer who was just looking at Cotton Pants and typed "dark green").

// "dark"/"light" prefix a base colour word customers use that COLOR_KEYWORDS/COMPOUND_COLOR_KEYWORDS
// don't literally contain (the catalog might list "Olive Green", not "Dark Green") — extractColorOnlyTerm
// returns both the full phrase (tried first, for an exact/near match) and the bare base colour word
// (tried second, so "dark green" still finds "Olive Green" within the category instead of no match
// at all or a cross-category guess).
const COLOR_INTENSIFIERS = ['dark', 'light'];

// Returns { full, base } when the ENTIRE trimmed message is just a colour phrase — never a partial
// match — so "cotton pant black" (a real product query) is left alone for normal SEARCH to handle.
function extractColorOnlyTerm(t) {
    const trimmed = (t || '').trim().toLowerCase();
    if (!trimmed) return null;
    if (COMPOUND_COLOR_KEYWORDS.includes(trimmed)) return { full: trimmed, base: trimmed };
    if (COLOR_KEYWORDS.includes(trimmed)) return { full: trimmed, base: trimmed };
    for (const intensifier of COLOR_INTENSIFIERS) {
        const prefix = `${intensifier} `;
        if (trimmed.startsWith(prefix)) {
            const rest = trimmed.slice(prefix.length);
            if (COLOR_KEYWORDS.includes(rest) || COMPOUND_COLOR_KEYWORDS.includes(rest)) {
                return { full: trimmed, base: rest };
            }
        }
    }
    return null;
}

// In-stock products to search: the exact subcategory the customer was just looking at
// (session.selectedSubCategory, e.g. "Cotton Pants") takes priority over the broader parent group
// (session.selectedParentCategory, e.g. "Pants") — Cotton Pants and Track Pants share the same
// parent, so parent-only scoping would still let a colour resolve to the wrong subcategory. Returns
// an empty array (never the whole catalog) when there's no context at all, so the caller can tell
// "no context" apart from "context but zero products" and fall through cleanly either way.
function getContextCategoryProducts(session, products) {
    if (!session) return [];
    const inStock = (products || []).filter(p => Number(p.stock) > 0);
    if (session.selectedSubCategory) {
        const scoped = inStock.filter(p => p.category === session.selectedSubCategory ||
            (Array.isArray(p.categories) && p.categories.includes(session.selectedSubCategory)));
        if (scoped.length > 0) return scoped;
    }
    if (session.selectedParentCategory) {
        return inStock.filter(p => getParentCategory(p.category) === session.selectedParentCategory);
    }
    return [];
}

// Mirrors api/webhook.js's own SEARCH-case colour match exactly (parenthesised colour is
// authoritative; falls back to the looser searchTermMatches only when no product in this category
// carries a parenthesised colour at all) so a category-scoped match looks identical to the
// unscoped one a customer would get by asking with the product name attached. Returns null —
// never an arbitrary first product — when nothing in categoryProducts matches term, so a caller
// trying `full` then `base` can tell "no match" apart from "matched" cleanly.
function findColorMatchInCategory(term, categoryProducts) {
    const parenFiltered = categoryProducts.filter(p => {
        const parenColor = extractParenColor(p.name);
        return parenColor && parenColor.includes(term);
    });
    const colorFiltered = parenFiltered.length > 0
        ? parenFiltered
        : categoryProducts.filter(p => searchTermMatches(p, term));

    if (colorFiltered.length === 0) return null;
    const exactParenMatch = colorFiltered.find(p => extractParenColor(p.name) === term);
    return exactParenMatch || colorFiltered[0];
}

// Bare-colour messages ("Dark green", "Black") answered with a specific product from whatever
// category the customer was just looking at. Returns null — deferring entirely to api/webhook.js's
// existing unscoped SEARCH colour handling — in every case where this can't confidently answer:
// no colour-only message, no category context at all, or a colour that genuinely isn't in that
// category (never falls back to "closest" product outside the category, and never picks the first
// product in the category as a guess).
function matchColorQuery(t, session, products) {
    const colorInfo = extractColorOnlyTerm(t);
    if (!colorInfo) return null;

    const categoryProducts = getContextCategoryProducts(session, products);
    if (categoryProducts.length === 0) return null;

    const match = findColorMatchInCategory(colorInfo.full, categoryProducts) ||
        (colorInfo.base !== colorInfo.full ? findColorMatchInCategory(colorInfo.base, categoryProducts) : null);
    if (!match) return null;

    return buildSpecificProductReply(match, products);
}

async function getCouponSettings() {
    const { data, error } = await supabase
        .from('store_settings')
        .select('coupon_code, coupon_enabled, free_shipping_with_coupon')
        .eq('id', 1)
        .single();

    if (error || !data) {
        console.error('[intents] getCouponSettings: store_settings lookup failed', error);
        return null;
    }
    return data;
}

// Fully owns any coupon-code question, whether or not a coupon is currently
// active. Must never return null for a coupon keyword match — webhook.js's
// own "discount"/"coupon"/"offer" keyword match (detectIntent ~line 3110 and
// the FAQ chain ~line 5524) would otherwise catch it with an unrelated
// "fixed pricing" reply, since those checks run right after this one returns
// null. Wrapped in try/catch so a thrown error (not just a returned Supabase
// error) still yields a coupon-specific reply instead of falling through.
async function matchCouponCode(t) {
    console.log('[intents] matchCouponCode: checking text =', JSON.stringify(t));

    const keywords = [
        'coupon', 'coupen', 'coupon code', 'coupen code',
        'discount code', 'offer code', 'promo code', 'code iruka', 'offer'
    ];
    if (!keywords.some(k => t.includes(k))) return null;

    try {
        const settings = await getCouponSettings();

        if (!settings) {
            return {
                replyText: "🎟️ Sorry, I couldn't check our current offers right now. Please try again shortly, or contact us directly.",
                sendImages: []
            };
        }

        if (!settings.coupon_enabled || !settings.coupon_code) {
            return {
                replyText: "🎟️ No active coupon right now, but keep an eye out — we run offers often! 😊",
                sendImages: []
            };
        }

        const shippingLine = settings.free_shipping_with_coupon
            ? '🚚 Use this code for *FREE shipping*!'
            : '🛒 Use this code to get a discount!';

        return {
            replyText: `🎟️ Yes! We have an active offer right now:\n\n*Coupon Code: ${settings.coupon_code}*\n\n${shippingLine}\n\nEnter it at checkout to apply it automatically. ✅`,
            sendImages: []
        };
    } catch (err) {
        console.error('[intents] matchCouponCode: unexpected error', err);
        return {
            replyText: "🎟️ Sorry, I couldn't check our current offers right now. Please try again shortly, or contact us directly.",
            sendImages: []
        };
    }
}

function matchOrderDelivery(t) {
    const keywords = [
        // Bare 'track' was removed — it matched product searches for Track Pants (e.g. "track
        // pant", "Adidas Popcorn Track Pant") as a false positive, hijacking them into this FAQ
        // before they ever reached product search. 'tracking' alone is unambiguous enough to
        // keep, and the phrases below cover the legitimate "track my order" intent without the
        // bare word.
        'order status', 'delivery', 'tracking',
        'track order', 'track my order', 'order track',
        'track panniten', 'track status', 'package track', 'parcel track',
        'order eppo varum', 'parcel eppo', 'kada varum',
        'order varudha', 'dispatch', 'shipped',
        'order reach', 'delivery days', 'evalo days',
        'working days', 'order update', 'parcel status',
        'order check', 'status check', 'order enquiry',
        '7-9 days', '5-7 days', 'delivery time',
        'order panniten', 'order achu', 'order confirm',
        'when will', 'delivery date', 'receive',
        'parcel varum', 'speed post', 'courier',
        'eppo receive', 'receive agum', 'receive agula',
        'varala innu', 'innu varala', 'order varala',
        'parcel varala', 'innu receive', 'still not received',
        'not received', 'not delivered', 'varala',
        'varale', 'receive aagala', 'receive aagula',
        'kadaikalai', 'kadaikala', 'pacel', 'parsil',
        'order innu', 'innu order', 'eppo varum',
        'எப்போ வரும்', 'வரலை', 'வரல',
        'when i receive', 'when will i get my order', 'delivery eppo',
        'product eppo varum', 'how many days for delivery'
    ];
    if (!keywords.some(k => t.includes(k))) return null;

    return {
        replyText: "📦 *Order Status & Delivery Info:*\n\n⏱️ *Delivery Time:*\n- Tamil Nadu — 5-7 working days\n- Other states — 7-9 working days\n\n📲 *Tracking:*\nOrder complete aana piragu tracking ID உங்கள் mobile number ku SMS வரும்!\n\n📞 *Order Enquiries:*\n- +91 8825325096\n- +91 7418755096\n🕘 Available: 9 AM – 7 PM",
        sendImages: []
    };
}

function matchContact(t) {
    const keywords = [
        'contact', 'number', 'phone', 'call',
        'number kudunga', 'number sollu', 'number send',
        'contact pannuvathu', 'reach pannuvathu',
        'how to contact', 'support number',
        'customer care', 'helpline', 'call panna',
        'number iruka', 'contact details',
        'phone number', 'mobile number',
        '8668066503', '8825325096'
    ];
    if (!keywords.some(k => t.includes(k))) return null;

    return {
        replyText: "📞 *Contact Our Team:*\n\n- +91 8825325096\n- +91 7418755096\n\n🕘 Available: 9 AM – 7 PM\n\nநாங்க உங்களுக்கு help பண்ண ready! 😊",
        sendImages: []
    };
}

function matchCollection(t) {
    const keywords = [
        'collection', 'collections', 'collection pakalam',
        'collection pakalama', 'collection iruka',
        'collection kaattu', 'collection sollu',
        'new collection', 'latest collection',
        'என்ன collection', 'collection paru',
        'collection venum', 'dress collection',
        'shirt collection', 'pants collection',
        'collection pakka', 'what collection'
    ];
    if (!keywords.some(k => t.includes(k))) return null;

    return {
        replyText: `👕 ஆமா sir! நம்ம Super Collections-ல நிறைய \ncollections இருக்கு! 😊\n\nகீழே உள்ள categories choose பண்ணுங்க:\n\n1️⃣ Shirts\n2️⃣ T-Shirts  \n3️⃣ Pants\n4️⃣ Track Pants\n5️⃣ Imported Shorts\n6️⃣ New Arrivals\n\nஉங்களுக்கு பிடிச்ச category number reply பண்ணுங்க,\nஇல்லன்னா நேரடியா website visit பண்ணுங்க:\n🌐 ${addWhatsAppUTM('https://supercollections.in/shop/')}`,
        sendImages: []
    };
}

function matchOrderGuidance(t) {
    const keywords = [
        'order epdi', 'order panna', 'how to order',
        'order pannuvathu epdi', 'order guide', 'purchase',
        'buy panna', 'order panrathu', 'epaddi order',
        'order viduvadhu', 'order process', 'order steps',
        'order panlama', 'order pannalam'
    ];
    if (!keywords.some(k => t.includes(k))) return null;

    return {
        replyText: "🛍️ Order panna romba simple sir!\n\n📹 *Indha video parunga — step by step காட்டியிருக்கோம்:*\nhttps://youtube.com/shorts/7FRdStr8AKk\n\nEdhavadhu doubt irundha:\n📞 *8825325096 / 7418755096* contact pannunga! 😊",
        sendImages: []
    };
}

export async function detectNewFaqIntent(text, session, products) {
    const t = (text || '').toLowerCase().trim();

    return (
        matchTestPing(t) ||
        matchSizeCategoryChoice(t, session) ||
        matchSizeQuery(t, session) ||
        matchColorQuery(t, session, products) ||
        (await matchCouponCode(t)) ||
        matchOrderDelivery(t) ||
        matchContact(t) ||
        matchCollection(t) ||
        matchOrderGuidance(t) ||
        null
    );
}
