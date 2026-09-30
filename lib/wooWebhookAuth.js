// lib/wooWebhookAuth.js
// Shared HMAC-SHA256 verification for incoming WooCommerce webhooks (orders, products, ...) — one
// implementation so every webhook handler checks the x-wc-webhook-signature header the same way,
// against the same raw-body convention (req.rawBody, captured by server.js's express.json verify
// hook before JSON parsing).
import crypto from 'crypto';

export function verifyWooWebhookSignature(rawBody, signatureHeader, secret) {
    const cleanSecret = (secret || '').trim();
    const cleanSig = (signatureHeader || '').trim();
    if (!cleanSecret || !cleanSig) {
        console.warn('[WooWebhookAuth] Missing secret or signature header');
        return false;
    }
    const expected = crypto.createHmac('sha256', cleanSecret).update(rawBody || '').digest('base64');
    const expectedBuf = Buffer.from(expected);
    const givenBuf = Buffer.from(cleanSig);
    if (expectedBuf.length !== givenBuf.length) {
        console.warn(`[WooWebhookAuth] Signature length mismatch (expected: ${expectedBuf.length}, received: ${givenBuf.length})`);
        return false;
    }
    return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

