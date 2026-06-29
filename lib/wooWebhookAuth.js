// lib/wooWebhookAuth.js
// Shared HMAC-SHA256 verification for incoming WooCommerce webhooks (orders, products, ...) — one
// implementation so every webhook handler checks the x-wc-webhook-signature header the same way,
// against the same raw-body convention (req.rawBody, captured by server.js's express.json verify
// hook before JSON parsing).
import crypto from 'crypto';

export function verifyWooWebhookSignature(rawBody, signatureHeader, secret) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest('base64');
    const expectedBuf = Buffer.from(expected);
    const givenBuf = Buffer.from(signatureHeader || '');
    if (expectedBuf.length !== givenBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, givenBuf);
}
