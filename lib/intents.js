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

// Only answers when an active coupon exists — otherwise returns null so the
// existing "fixed pricing" reply in webhook.js (textLower.includes("coupon"),
// ~line 5524) still handles the message unchanged.
async function matchCouponCode(t) {
    const keywords = ['coupon', 'coupon code', 'discount code', 'offer code', 'promo code'];
    if (!keywords.some(k => t.includes(k))) return null;

    const { data, error } = await supabase
        .from('store_settings')
        .select('coupon_code, coupon_enabled, free_shipping_with_coupon')
        .eq('id', 1)
        .single();

    if (error || !data || !data.coupon_enabled || !data.coupon_code) {
        return null;
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
