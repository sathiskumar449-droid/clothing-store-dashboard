import dotenv from 'dotenv';
import assert from 'assert';
import crypto from 'crypto';
import { handleRazorpayWebhook } from '../api/webhook.js';

dotenv.config();

async function runTests() {
    console.log("=== Running Razorpay Integration Tests ===");

    // Test 1: Signature Verification Check
    console.log("\nTesting signature verification...");
    
    const secret = "test_webhook_secret_12345";
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;

    const payload = JSON.stringify({
        event: "payment_link.paid",
        payload: {
            payment_link: {
                entity: {
                    status: "paid",
                    notes: {
                        orderId: "ORD-9999999"
                    }
                }
            }
        }
    });

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

    // Mock Express Request & Response
    let statusSet = null;
    let bodySent = null;
    let responseCode = null;

    const req = {
        headers: {
            'x-razorpay-signature': expectedSignature
        },
        body: JSON.parse(payload),
        rawBody: payload
    };

    const res = {
        status: (code) => {
            statusSet = code;
            return {
                send: (msg) => { bodySent = msg; }
            };
        },
        sendStatus: (code) => {
            responseCode = code;
            return code;
        }
    };

    await handleRazorpayWebhook(req, res);
    
    console.log("Response code received:", responseCode || statusSet);
    // Since ORD-9999999 does not exist in the database, it should gracefully skip database update and return sendStatus(200)
    assert.strictEqual(responseCode, 200, "Webhook should return status 200");
    assert.strictEqual(statusSet, null, "Verification should succeed and not return 400 error");

    // Test 2: Invalid Signature Verification Check
    console.log("\nTesting invalid signature verification...");
    const reqInvalid = {
        headers: {
            'x-razorpay-signature': 'invalid_sig'
        },
        body: JSON.parse(payload),
        rawBody: payload
    };

    await handleRazorpayWebhook(reqInvalid, res);
    console.log("Status set for invalid signature:", statusSet);
    assert.strictEqual(statusSet, 400, "Should return 400 for invalid signature");
    
    console.log("\n✅ Razorpay signature verification and webhook routing tests passed successfully!");
}

runTests().catch(err => {
    console.error("❌ Test failed:", err);
    process.exit(1);
});
