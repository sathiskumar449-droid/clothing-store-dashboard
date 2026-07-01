import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { getOutfitMatches } from './api/matchOutfit.js';
import { handleWhatsAppWebhook, verifyWebhook, receiveWebhook, handleRazorpayWebhook, handleImageProxy } from './api/webhook.js';
import { addProduct, getProducts, updateProduct, deleteProduct, syncProducts, handleWooWebhook } from './api/products.js';
import { handleWooOrderWebhook } from './api/woocommerce-order-webhook.js';
import { getOrders, updateOrderStatus } from './api/orders.js';
import { getAllChats, getChatHistory, sendChatMessage, toggleBot, deleteChat, renameChat, editChatMessage, deleteChatMessage } from './api/chats.js';
import { getWooSettings, saveWooSettings, getStoreSettings, saveStoreSettings } from './api/settings.js';

dotenv.config();

const app = express();


// =============================
// ✅ Middleware
// =============================
app.use(cors());
app.use(express.json({
    limit: '50mb',
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));
app.use(express.urlencoded({ extended: true }));

// Gate on the owner dashboard's own routes only (products/orders/chats/settings) — these
// have no other auth and are otherwise reachable by anyone who finds the URL, which is how
// an arbitrary WhatsApp message got sent to a customer through /api/chats/:phone/message
// with no trace of it in this codebase. The WhatsApp/Razorpay/WooCommerce webhooks and the
// image proxy are deliberately excluded: they're called by external services (Meta,
// Razorpay, WooCommerce) that can't send this header and already verify requests their own
// way (signature/HMAC checks, or Meta's verify-token handshake).
function requireApiKey(req, res, next) {
    // .trim() on both sides — env vars set via a piped `echo` (rather than `printf`) pick up
    // a trailing newline that's invisible in dashboards/logs but breaks a strict `!==` match.
    const expected = (process.env.DASHBOARD_API_KEY || '').trim();
    if (!expected) {
        console.error('[Auth] DASHBOARD_API_KEY is not configured — rejecting dashboard request');
        return res.status(500).json({ success: false, message: 'Server misconfigured' });
    }
    if ((req.headers['x-api-key'] || '').trim() !== expected) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    next();
}


// =============================
// ✅ Test Route
// =============================
app.get('/', (req, res) => {
    res.send('🔥 Clothing Store Backend Working');
});


// =============================
// 👕 Outfit Matching API
// =============================
app.get('/api/matches', requireApiKey, getOutfitMatches);


// =============================
// 📦 Products API
// =============================
app.post('/api/products', requireApiKey, addProduct);
app.get('/api/products', requireApiKey, getProducts);
app.put('/api/products/:id', requireApiKey, updateProduct);
app.delete('/api/products/:id', requireApiKey, deleteProduct);
app.post('/api/products/sync', requireApiKey, syncProducts);
app.post('/api/webhook/woocommerce', handleWooWebhook);

// =============================
// 📦 Orders API
// =============================
app.get('/api/orders', requireApiKey, getOrders);
app.put('/api/orders/:id/status', requireApiKey, updateOrderStatus);


// =============================
// 💬 Chats API
// =============================
app.get('/api/chats', requireApiKey, getAllChats);
app.get('/api/chats/:phone', requireApiKey, getChatHistory);
app.post('/api/chats/:phone/message', requireApiKey, sendChatMessage);
app.post('/api/chats/:phone/toggle-bot', requireApiKey, toggleBot);
app.delete('/api/chats/:phone', requireApiKey, deleteChat);
app.put('/api/chats/:phone/rename', requireApiKey, renameChat);
app.put('/api/chats/:phone/messages/:index', requireApiKey, editChatMessage);
app.delete('/api/chats/:phone/messages/:index', requireApiKey, deleteChatMessage);


// =============================
// ⚙️ Settings API
// =============================
app.get('/api/settings/woo', requireApiKey, getWooSettings);
app.post('/api/settings/woo', requireApiKey, saveWooSettings);
app.get('/api/settings/store', requireApiKey, getStoreSettings);
app.post('/api/settings/store', requireApiKey, saveStoreSettings);


// =============================
// 📲 WhatsApp Webhook
// =============================

// 👉 Meta verification (GET) — checks hub.mode, hub.verify_token, hub.challenge
app.get('/webhook', verifyWebhook);

// 👉 Incoming WhatsApp messages (POST)
app.post('/webhook', receiveWebhook);

// 👉 Razorpay Payment Webhook (POST)
app.post('/api/webhook/razorpay', handleRazorpayWebhook);

// 👉 WooCommerce "Order updated" Webhook — sends order confirmation via WhatsApp (POST)
app.post('/api/woocommerce-order-webhook', handleWooOrderWebhook);

// 👉 Image proxy — lets Meta's WhatsApp media fetcher pull product images via our domain
// instead of supercollections.in directly (see handleImageProxy in api/webhook.js for why)
app.get('/api/image-proxy', handleImageProxy);


// =============================
// ❌ Error Handler
// =============================
app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err);

    res.status(500).json({
        success: false,
        message: err.message || 'Internal Server Error'
    });
});


// =============================
// 🚀 Server Start (local dev only)
// =============================
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
    });
}

// ✅ Vercel needs the app exported as default
export default app;