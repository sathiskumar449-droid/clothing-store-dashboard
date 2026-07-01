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

// Fully owns any coupon-code question, whether or not a coupon is currently
// active. Must never return null for a coupon keyword match — webhook.js's
// own "discount"/"coupon" keyword match (detectIntent ~line 3110 and the FAQ
// chain ~line 5524) would otherwise catch it with an unrelated "fixed
// pricing" reply, since those checks run right after this one returns null.
async function matchCouponCode(t) {
    const keywords = ['coupon', 'coupon code', 'discount code', 'offer code', 'promo code'];
    if (!keywords.some(k => t.includes(k))) return null;

    const { data, error } = await supabase
        .from('store_settings')
        .select('coupon_code, coupon_enabled, free_shipping_with_coupon')
        .eq('id', 1)
        .single();

    if (error || !data) {
        console.error('[intents] matchCouponCode: store_settings lookup failed', error);
        return {
            replyText: "🎟️ Sorry, I couldn't check our current offers right now. Please try again shortly, or contact us directly.",
            sendImages: []
        };
    }

    if (!data.coupon_enabled || !data.coupon_code) {
        return {
            replyText: "🎟️ No active coupon right now, but keep an eye out — we run offers often! 😊",
            sendImages: []
        };
    }

    const shippingLine = data.free_shipping_with_coupon
        ? '🚚 Use this code for *FREE shipping*!'
        : '🛒 Use this code to get a discount!';

    return {
        replyText: `🎟️ Yes! We have an active offer right now:\n\n*Coupon Code: ${data.coupon_code}*\n\n${shippingLine}\n\nEnter it at checkout to apply it automatically. ✅`,
        sendImages: []
    };
}

export async function detectNewFaqIntent(text, session) {
    const t = (text || '').toLowerCase().trim();

    return (
        matchTestPing(t) ||
        (await matchCouponCode(t)) ||
        null
    );
}
