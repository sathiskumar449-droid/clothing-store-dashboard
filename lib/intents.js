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

// ─── Local matcher functions (one per intent, checked in priority order) ───

// Smoke test to verify the lib/intents.js -> webhook.js wiring end-to-end.
// Remove or repurpose once the wiring has been confirmed in production.
function matchTestPing(t) {
    if (t === 'test-intents-ping') {
        return { replyText: '🏓 New intents file is working!', sendImages: [] };
    }
    return null;
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
        'order status', 'delivery', 'track', 'tracking',
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
        'எப்போ வரும்', 'வரலை', 'வரல'
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
        replyText: "👕 ஆமா sir! நம்ம Super Collections-ல நிறைய \ncollections இருக்கு! 😊\n\nகீழே உள்ள categories choose பண்ணுங்க:\n\n1️⃣ Shirts\n2️⃣ T-Shirts  \n3️⃣ Pants\n4️⃣ Track Pants\n5️⃣ Imported Shorts\n6️⃣ New Arrivals\n\nஉங்களுக்கு பிடிச்ச category number reply பண்ணுங்க,\nஇல்லன்னா நேரடியா website visit பண்ணுங்க:\n🌐 https://supercollections.in/shop/",
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

export async function detectNewFaqIntent(text, session) {
    const t = (text || '').toLowerCase().trim();

    return (
        matchTestPing(t) ||
        (await matchCouponCode(t)) ||
        matchOrderDelivery(t) ||
        matchContact(t) ||
        matchCollection(t) ||
        matchOrderGuidance(t) ||
        null
    );
}
