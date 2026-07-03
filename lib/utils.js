// lib/utils.js
// Shared, dependency-free helpers used across api/ and lib/.

// Matches supercollections.in with or without the "www." subdomain — mirrors
// PROXY_ALLOWED_HOSTS in api/webhook.js, which recognizes the same two hostnames.
const SUPERCOLLECTIONS_URL_RE = /^https?:\/\/(www\.)?supercollections\.in(\/|$|\?)/i;

// Tags every supercollections.in link the bot sends with utm_source=whatsapp, so orders placed
// after clicking through show up as WhatsApp-sourced traffic in WooCommerce's Order Attribution.
// Non-supercollections.in URLs (YouTube guide video, etc.) are returned unchanged.
export function addWhatsAppUTM(url) {
    if (!url || !SUPERCOLLECTIONS_URL_RE.test(url)) return url;
    if (/[?&]utm_source=/.test(url)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}utm_source=whatsapp`;
}

// States where the customer is actively answering a structured size/qty prompt for one specific
// pending product (the button-driven size/qty flow) — a free-text size/qty match arriving during
// one of these must reach that flow's own handling (api/webhook.js), never a generic size/qty
// reply from lib/intents.js or api/webhook.js's own FAQ fallback. Shared here (rather than defined
// once and imported the other way) so lib/intents.js can check it too without a circular import
// back to api/webhook.js (webhook.js already imports from lib/intents.js).
export const SIZE_QTY_STRUCTURED_STATES = ['AWAITING_SIZE_SELECTION', 'AWAITING_PRODUCT_SIZE', 'AWAITING_PRODUCT_QTY', 'AWAITING_CART_CONFIRM'];

// Shared order-guide video link — used by api/webhook.js's product-reply builders
// (buildSpecificProductReply etc.) and by GUIDED_FALLBACK_REPLY below, so every "how do I order"
// pointer in the bot goes to the same video.
export const ORDER_GUIDE_VIDEO_URL = 'https://youtube.com/shorts/7FRdStr8AKk';

// Single guided fallback for every "negative" case across the bot — nothing recognizable in the
// message, a genuine catalog-unmatched term, a named item/category/subcategory with zero stock,
// or (see lib/intents.js's size matcher) a size question with no way to resolve which category it
// belongs to. Tamil wording requested — do not translate back to English. The numbering here (1-6
// + "7" for Order Status) matches api/webhook.js's CATEGORY_LINKS/MAIN_MENU_SELECT exactly, NOT
// the separate TOP_CATEGORY_MENU_NAMES numbering (which has 7 slots incl. "Men") — so
// buildGuidedFallbackReply() below must route a follow-up bare digit through
// AWAITING_MAIN_MENU_SELECTION specifically, or "1" after this message won't resolve to anything
// and the customer loops back to this same fallback.
export const GUIDED_FALLBACK_REPLY = `😇 மன்னிக்கவும் Sir, சரியாக புரியல.

கீழே உள்ளதில் ஒன்றை தேர்வு செய்யுங்க (எண் அனுப்புங்க):

1️⃣ 👕 Shirt
2️⃣ 👕 T-Shirt
3️⃣ 👖 Pant
4️⃣ 🩳 Track Pants
5️⃣ 🩳 Imported Shorts
6️⃣ ✨ New Arrivals

📦 Order Status theriya *7* அனுப்புங்க
📍 Shop Location theriya *location* type பண்ணுங்க

📹 Order போட தெரியலையா? Video பாருங்க: ${ORDER_GUIDE_VIDEO_URL}`;

// Sends GUIDED_FALLBACK_REPLY and arms the session to actually accept the numbered reply it just
// asked for — without this, a customer typing "1" right after gets no match (session.state was
// left wherever the failed flow abandoned it) and lands right back on this same fallback.
export function buildGuidedFallbackReply(session) {
    session.state = "AWAITING_MAIN_MENU_SELECTION";
    return { replyText: GUIDED_FALLBACK_REPLY, sendImages: [] };
}
