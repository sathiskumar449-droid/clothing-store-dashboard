import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { getOutfitMatches } from './api/matchOutfit.js';
import { handleWhatsAppWebhook, verifyWebhook, receiveWebhook, handleRazorpayWebhook } from './api/webhook.js';
import { addProduct, getProducts, updateProduct, deleteProduct, syncProducts, handleWooWebhook } from './api/products.js';
import { getOrders, updateOrderStatus } from './api/orders.js';
import { getAllChats, getChatHistory, sendChatMessage, toggleBot, deleteChat, renameChat } from './api/chats.js';
import { getWooSettings, saveWooSettings } from './api/settings.js';

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


// =============================
// ✅ Test Route
// =============================
app.get('/', (req, res) => {
    res.send('🔥 Clothing Store Backend Working');
});


// =============================
// 👕 Outfit Matching API
// =============================
app.get('/api/matches', getOutfitMatches);


// =============================
// 📦 Products API
// =============================
app.post('/api/products', addProduct);
app.get('/api/products', getProducts);
app.put('/api/products/:id', updateProduct);
app.delete('/api/products/:id', deleteProduct);
app.post('/api/products/sync', syncProducts);
app.post('/api/webhook/woocommerce', handleWooWebhook);

// =============================
// 📦 Orders API
// =============================
app.get('/api/orders', getOrders);
app.put('/api/orders/:id/status', updateOrderStatus);


// =============================
// 💬 Chats API
// =============================
app.get('/api/chats', getAllChats);
app.get('/api/chats/:phone', getChatHistory);
app.post('/api/chats/:phone/message', sendChatMessage);
app.post('/api/chats/:phone/toggle-bot', toggleBot);
app.delete('/api/chats/:phone', deleteChat);
app.put('/api/chats/:phone/rename', renameChat);


// =============================
// ⚙️ Settings API
// =============================
app.get('/api/settings/woo', getWooSettings);
app.post('/api/settings/woo', saveWooSettings);


// =============================
// 📲 WhatsApp Webhook
// =============================

// 👉 Meta verification (GET) — checks hub.mode, hub.verify_token, hub.challenge
app.get('/webhook', verifyWebhook);

// 👉 Incoming WhatsApp messages (POST)
app.post('/webhook', receiveWebhook);

// 👉 Razorpay Payment Webhook (POST)
app.post('/api/webhook/razorpay', handleRazorpayWebhook);


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