import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { getOutfitMatches } from './api/matchOutfit.js';
import { handleWhatsAppWebhook, verifyWebhook, receiveWebhook } from './api/webhook.js';
import { addProduct, getProducts, updateProduct, deleteProduct } from './api/products.js';
import { getOrders, updateOrderStatus } from './api/orders.js';
import { getAllChats, getChatHistory, sendChatMessage, toggleBot, deleteChat, renameChat } from './api/chats.js';

dotenv.config();

const app = express();


// =============================
// ✅ Middleware
// =============================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
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
app.post('/products', addProduct);

app.get('/products', getProducts);
app.put('/products/:id', updateProduct);
app.delete('/products/:id', deleteProduct);

// =============================
// 📦 Orders API
// =============================
app.get('/orders', getOrders);
app.put('/orders/:id/status', updateOrderStatus);


// =============================
// 💬 Chats API
// =============================
app.get('/chats', getAllChats);
app.get('/chats/:phone', getChatHistory);
app.post('/chats/:phone/message', sendChatMessage);
app.post('/chats/:phone/toggle-bot', toggleBot);
app.delete('/chats/:phone', deleteChat);
app.put('/chats/:phone/rename', renameChat);


// =============================
// 📲 WhatsApp Webhook
// =============================

// 👉 Meta verification (GET) — checks hub.mode, hub.verify_token, hub.challenge
app.get('/webhook', verifyWebhook);

// 👉 Incoming WhatsApp messages (POST)
app.post('/webhook', receiveWebhook);


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