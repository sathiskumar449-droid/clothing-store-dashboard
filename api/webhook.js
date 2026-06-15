// api/webhook.js  — Supabase version (replaces fs-based implementation)
import axios from 'axios';
import dotenv from 'dotenv';
import { supabase } from '../lib/supabase.js';

dotenv.config();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_ID || process.env.PHONE_NUMBER_ID;

// ✅ Startup diagnostic — visible in Vercel logs immediately on cold start
console.log('[STARTUP] ENV CHECK:');
console.log('  WHATSAPP_TOKEN exists:', !!WHATSAPP_TOKEN);
console.log('  PHONE_NUMBER_ID exists:', !!PHONE_NUMBER_ID);
console.log('  VERIFY_TOKEN exists:', !!VERIFY_TOKEN);
console.log('  SUPABASE_URL exists:', !!process.env.SUPABASE_URL);

const processed = new Set();
export const userSessions = {}; // In-memory per-user conversation state

// =============================
// Database Helpers  (all async — Supabase)
// =============================

export async function getProducts() {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('created_at', { ascending: true });

        if (error) throw error;

        // Return in the same shape as the original JSON array
        return (data || []).map(row => ({
            id: row.id,
            name: row.name,
            code: row.code,
            category: row.category,
            pattern: row.pattern,
            color: row.color,
            price: row.price,
            stock: row.stock,
            sizes: row.sizes || [],
            imageUri: row.image_uri
        }));
    } catch (error) {
        console.error('❌ Error reading products:', error.message);
        return [];
    }
}

export async function saveProducts(products) {
    try {
        for (const p of products) {
            const { error } = await supabase
                .from('products')
                .update({ stock: String(p.stock) })
                .eq('id', p.id);

            if (error) {
                console.error(`❌ Error updating stock for product ${p.id}:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Error saving products:', error.message);
    }
}

export async function getOrders() {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .order('date', { ascending: false, nullsFirst: false });

        if (error) throw error;

        return (data || []).map(dbRowToOrder);
    } catch (error) {
        console.error('❌ Error reading orders:', error.message);
        return [];
    }
}

export async function saveOrders(orders) {
    // saveOrders is called after mutating the in-memory array.
    // We upsert the full array so any status changes are persisted.
    try {
        for (const order of orders) {
            const { error } = await supabase
                .from('orders')
                .update({ status: order.status })
                .eq('id', order.id || order.orderId);

            if (error) {
                console.error(`❌ Error updating order status:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Error saving orders:', error.message);
    }
}

// ── helper for getOrders ──────────────────────────────────────
function dbRowToOrder(row) {
    const base = {
        id: row.id,
        status: row.status,
        customerPhone: row.customer_phone,
        customerName: row.customer_name,
        customerAddress: row.customer_address,
        items: row.items || [],
        totalPrice: row.total_price,
        date: row.date
    };
    if (row.order_id) base.orderId = row.order_id;
    if (row.shirt_name) base.shirtName = row.shirt_name;
    if (row.pant_name) base.pantName = row.pant_name;
    if (row.customer_details) base.customerDetails = row.customer_details;
    if (row.payment_method) base.paymentMethod = row.payment_method;
    return base;
}

// =============================
// Chats Database Helpers  (async — Supabase)
// =============================

export async function getChats() {
    try {
        const { data, error } = await supabase
            .from('chats')
            .select('*');

        if (error) throw error;

        // Return as an object keyed by customerPhone (same shape as the old chats.json)
        const chatsObj = {};
        for (const row of (data || [])) {
            chatsObj[row.customer_phone] = {
                customerPhone: row.customer_phone,
                customerName: row.customer_name,
                lastMessage: row.last_message,
                lastUpdated: row.last_updated,
                botPaused: row.bot_paused,
                messages: row.messages || []
            };
        }
        return chatsObj;
    } catch (error) {
        console.error('❌ Error reading chats:', error.message);
        return {};
    }
}

export async function saveChats(chats) {
    try {
        for (const phone of Object.keys(chats)) {
            const chat = chats[phone];
            const { error } = await supabase
                .from('chats')
                .upsert({
                    customer_phone: phone,
                    customer_name: chat.customerName || 'Customer',
                    last_message: chat.lastMessage || '',
                    last_updated: chat.lastUpdated || new Date().toISOString(),
                    bot_paused: chat.botPaused || false,
                    messages: chat.messages || []
                }, { onConflict: 'customer_phone' });

            if (error) {
                console.error(`❌ Error saving chat for ${phone}:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Error saving chats:', error.message);
    }
}

export async function getSession(phone) {
    try {
        const { data, error } = await supabase
            .from('chats')
            .select('last_message')
            .eq('customer_phone', `session_${phone}`)
            .maybeSingle();

        if (error) throw error;

        if (data && data.last_message) {
            return JSON.parse(data.last_message);
        }
    } catch (err) {
        console.error(`❌ Error reading session for ${phone}:`, err.message);
    }

    return {
        state: "AWAITING_CATEGORY",
        cart: [],
        history: [],
        searchProducts: [],
        selectedColor: null,
        selectedSize: null,
        lastRecommendation: null,
        awaitingRecommendationResponse: false,
        awaitingCartAdditionConfirmation: false,
        pendingProduct: null
    };
}

export async function saveSession(phone, session) {
    try {
        const { error } = await supabase
            .from('chats')
            .upsert({
                customer_phone: `session_${phone}`,
                customer_name: 'Session State',
                last_message: JSON.stringify(session),
                last_updated: new Date().toISOString(),
                bot_paused: false,
                messages: []
            }, { onConflict: 'customer_phone' });

        if (error) throw error;
    } catch (err) {
        console.error(`❌ Error saving session for ${phone}:`, err.message);
    }
}

export async function deleteSession(phone) {
    try {
        const { error } = await supabase
            .from('chats')
            .delete()
            .eq('customer_phone', `session_${phone}`);

        if (error) throw error;
    } catch (err) {
        console.error(`❌ Error deleting session for ${phone}:`, err.message);
    }
}

export async function logChatMessage(customerPhone, sender, text, type = 'text', imageUrl = null, messageId = null) {
    try {
        // Fetch current row (or create default)
        const { data: rows, error: fetchError } = await supabase
            .from('chats')
            .select('*')
            .eq('customer_phone', customerPhone)
            .maybeSingle();

        if (fetchError) throw fetchError;

        const existing = rows || {
            customer_phone: customerPhone,
            customer_name: 'Customer',
            last_message: '',
            last_updated: new Date().toISOString(),
            bot_paused: false,
            messages: []
        };

        // Try to resolve customer name from active session in database
        let customerName = existing.customer_name;
        const dbSession = await getSession(customerPhone);
        if (dbSession?.orderDetails?.customerName) {
            customerName = dbSession.orderDetails.customerName;
        }

        // Trim messages to last 100
        const messages = Array.isArray(existing.messages) ? existing.messages : [];
        messages.push({
            sender,
            type,
            text,
            imageUrl,
            messageId,
            timestamp: new Date().toISOString()
        });
        if (messages.length > 100) messages.shift();

        const lastMessage = type === 'image' ? `📷 Image${text ? ': ' + text : ''}` : text;

        const { error: upsertError } = await supabase
            .from('chats')
            .upsert({
                customer_phone: customerPhone,
                customer_name: customerName,
                last_message: lastMessage,
                last_updated: new Date().toISOString(),
                bot_paused: existing.bot_paused,
                messages
            }, { onConflict: 'customer_phone' });

        if (upsertError) throw upsertError;
    } catch (error) {
        console.error('❌ Error logging chat message:', error.message);
    }
}

// =============================
// WhatsApp API Helpers
// =============================

async function sendRequest(payload) {
    // ── Guard: env vars missing ──────────────────────────────────────
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        console.error('❌ [sendRequest] BLOCKED — env vars missing!');
        console.error('   WHATSAPP_TOKEN  :', WHATSAPP_TOKEN ? 'SET' : '❌ MISSING');
        console.error('   PHONE_NUMBER_ID :', PHONE_NUMBER_ID ? 'SET' : '❌ MISSING');
        return;
    }

    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

    console.log(`[BOT -> USER] ▶ Sending to ${payload.to} | type=${payload.type}`);
    console.log(`[BOT -> USER]   URL: ${url}`);
    console.log(`[BOT -> USER]   Token starts: ${WHATSAPP_TOKEN.slice(0, 15)}...`);

    try {
        const response = await axios.post(url, {
            messaging_product: 'whatsapp',
            ...payload
        }, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[BOT -> USER] ✅ Success! message_id:`, response.data?.messages?.[0]?.id);
    } catch (error) {
        console.error('❌ [sendRequest] WhatsApp API Error!');
        console.error('   HTTP Status  :', error.response?.status);
        console.error('   Error body   :', JSON.stringify(error.response?.data, null, 2));
        console.error('   Raw message  :', error.message);
        
        try {
            await supabase.from('chats').upsert({
                customer_phone: `error_${payload.to}`,
                customer_name: 'WhatsApp API Error',
                last_message: JSON.stringify({
                    status: error.response?.status,
                    data: error.response?.data,
                    message: error.message
                }),
                last_updated: new Date().toISOString(),
                bot_paused: false,
                messages: []
            }, { onConflict: 'customer_phone' });
        } catch (dbErr) {
            console.error('❌ Failed to save error to Supabase:', dbErr.message);
        }
    }
}

export async function sendText(to, text) {
    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
    };

    try {
        console.log(`[sendText] Request URL: ${url}`);
        console.log(`[sendText] Phone number: ${to}`);
        console.log(`[sendText] Payload being sent:`, JSON.stringify(payload, null, 2));

        if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
            throw new Error(`Environment variables missing! WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'exists' : 'missing'}, PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? 'exists' : 'missing'}`);
        }

        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`[sendText] Meta API response:`, JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        if (error.response) {
            console.error(`[sendText] Meta API errors:`, JSON.stringify(error.response.data, null, 2));
        } else {
            console.error(`[sendText] Error message:`, error.message);
        }
        console.error(`[sendText] Full error stack:`, error.stack || error);
        throw error;
    }
}

export async function uploadMedia(imageUrl) {
    try {
        console.log(`[uploadMedia] Downloading image from WooCommerce: ${imageUrl}`);
        const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const contentType = imageRes.headers['content-type'] || 'image/jpeg';
        
        console.log(`[uploadMedia] Creating native Blob and FormData for upload`);
        const formData = new FormData();
        const blob = new Blob([imageRes.data], { type: contentType });
        
        let filename = 'image.jpg';
        try {
            const urlObj = new URL(imageUrl);
            filename = urlObj.pathname.split('/').pop() || 'image.jpg';
        } catch (_) {}

        formData.append('file', blob, filename);
        formData.append('messaging_product', 'whatsapp');
        formData.append('type', contentType);

        const uploadUrl = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/media`;
        console.log(`[uploadMedia] Sending POST to Meta Media API: ${uploadUrl}`);
        
        const res = await axios.post(uploadUrl, formData, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'multipart/form-data'
            }
        });

        console.log(`[uploadMedia] ✅ Media uploaded successfully! ID: ${res.data?.id}`);
        return res.data?.id;
    } catch (err) {
        console.error('❌ [uploadMedia] Error uploading media:', err.message);
        if (err.response) {
            console.error('   Meta Upload Error response:', JSON.stringify(err.response.data, null, 2));
        }
        return null;
    }
}

export async function sendImage(to, imageUrl, caption = '') {
    console.log(`[sendImage] Processing image send request to ${to} for ${imageUrl}`);
    
    // First try uploading to Meta to obtain a media_id
    const mediaId = await uploadMedia(imageUrl);
    
    if (mediaId) {
        console.log(`[sendImage] Sending image via Meta media id: ${mediaId}`);
        await sendRequest({ to, type: 'image', image: { id: mediaId, caption } });
    } else {
        // Fallback to link if upload failed
        console.log(`[sendImage] Falling back to sending via direct link: ${imageUrl}`);
        await sendRequest({ to, type: 'image', image: { link: imageUrl, caption } });
    }
}

async function sendButtons(to, bodyText, buttons) {
    await sendRequest({
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: bodyText },
            action: {
                buttons: buttons.map(b => ({
                    type: 'reply',
                    reply: { id: b.id, title: b.title }
                }))
            }
        }
    });
}

// =============================
// Intent Detection (moved below helpers to support routing)

// =============================
// Pure JS Sales Flow (Gemini Removed)
// =============================

// Normalize user query by correcting common spelling variations and typos
const normalizeQuery = (queryText) => {
    let t = queryText.toLowerCase().trim();
    
    const replacements = {
        'shit': 'shirt',
        'shits': 'shirts',
        'shrit': 'shirt',
        'shrits': 'shirts',
        'phant': 'pant',
        'phants': 'pants',
        'lenin': 'linen',
        'coton': 'cotton',
        'palin': 'plain',
        'tshirt': 't-shirt',
    };
    
    let words = t.split(/\s+/);
    words = words.map(w => replacements[w] || w);
    return words.join(' ');
};

// Normalize size strings to a standardized format (strip spaces, dashes, underscores, and the word "size")
const normalizeSize = (s) => {
    if (!s) return '';
    return s.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/size/g, '')
        .replace(/[-_]/g, '')
        .trim();
};

// Salesperson classification rules based on name and category
const getProductTag = (product) => {
    const name = (product.name || '').toLowerCase();
    const category = (product.category || '').toLowerCase();

    // 1. Pants, Jeans, Tracks, Cargos
    if (name.includes('formal pant') || category.includes('formal pant')) {
        return 'FORMAL_PANT';
    }
    if (name.includes('cargo') || category.includes('cargo')) {
        return 'CARGO_PANT';
    }
    if (name.includes('track') || name.includes('trach') || category.includes('track') || category.includes('trach')) {
        return 'TRACK_PANT';
    }
    if (name.includes('jeans') || category.includes('jeans')) {
        return 'JEANS';
    }
    if (name.includes('cotton pant') || name.includes('chinos') || category.includes('cotton pant')) {
        return 'COTTON_PANT';
    }
    if (name.includes('pant') || name.includes('phant') || category.includes('pant') || category.includes('pants')) {
        return 'PANT';
    }

    // 2. Shirts and T-Shirts
    if (name.includes('football') || name.includes('jersey') || name.includes('neymar') || name.includes('dhoni') || name.includes('ronaldo') || name.includes('ipl') || category.includes('jersey')) {
        return 'SPORTS_JERSEY';
    }
    if (name.includes('formal shirt') || category.includes('formal shirt')) {
        return 'FORMAL_SHIRT';
    }
    if (name.includes('casual shirt') || category.includes('casual shirt') || name.includes('linen') || name.includes('cotton') || name.includes('plain shirt') || name.includes('printed shirt') || category.includes('lenin') || category.includes('linen')) {
        return 'CASUAL_SHIRT';
    }
    if (name.includes('t-shirt') || name.includes('tshirt') || name.includes('polo') || category.includes('t-shirt') || category.includes('tshirt') || category.includes('t-shirts')) {
        return 'TSHIRT';
    }
    if (name.includes('shirt') || category.includes('shirt') || category.includes('shirts')) {
        return 'SHIRT';
    }

    return 'OTHER';
};

// Target recommendation pairing tags
const getTargetRecommendationTags = (tag) => {
    switch (tag) {
        case 'FORMAL_SHIRT':
            return ['FORMAL_PANT', 'PANT'];
        case 'CASUAL_SHIRT':
            return ['JEANS', 'COTTON_PANT', 'PANT'];
        case 'TSHIRT':
            return ['TRACK_PANT'];
        case 'FORMAL_PANT':
            return ['FORMAL_SHIRT', 'SHIRT'];
        case 'CARGO_PANT':
            return ['TRACK_PANT', 'TSHIRT'];
        case 'TRACK_PANT':
            return ['TSHIRT'];
        case 'JEANS':
        case 'COTTON_PANT':
            return ['CASUAL_SHIRT', 'SHIRT'];
        case 'SHIRT':
            return ['PANT', 'JEANS', 'COTTON_PANT', 'CARGO_PANT'];
        case 'PANT':
            return ['CASUAL_SHIRT', 'SHIRT', 'TSHIRT'];
        case 'SPORTS_JERSEY':
            return ['TRACK_PANT'];
        default:
            return [];
    }
};

// Helper to retrieve fallback/self-healing image URI if the database row has 'null' or missing image
const getProductImageUri = (product, allProducts = []) => {
    if (product.imageUri && product.imageUri.startsWith('http') && product.imageUri !== 'null' && product.imageUri !== 'undefined') {
        return product.imageUri;
    }
    // Try to find a duplicate entry with the same name that has a valid WooCommerce image URL
    const backup = allProducts.find(p => 
        p.name === product.name && 
        p.imageUri && p.imageUri.startsWith('http') && p.imageUri !== 'null' && p.imageUri !== 'undefined'
    );
    if (backup) return backup.imageUri;

    // Fuzzier match: same category and color
    const backup2 = allProducts.find(p => 
        p.category === product.category && 
        p.color === product.color && 
        p.imageUri && p.imageUri.startsWith('http') && p.imageUri !== 'null' && p.imageUri !== 'undefined'
    );
    if (backup2) return backup2.imageUri;

    return null;
};

// Recommendation engine linking tags and categories
const getSmartRecommendation = (addedProduct, allProducts, excludedIds = []) => {
    if (!addedProduct) return null;
    const addedTag = getProductTag(addedProduct);
    const targetTags = getTargetRecommendationTags(addedTag);

    const isExcluded = (id) => excludedIds.some(eid => String(eid) === String(id));
    const hasValidImage = (p) => {
        const img = getProductImageUri(p, allProducts);
        return img && img.startsWith('http') && img !== 'null' && img !== 'undefined';
    };

    // 1. Try to find a matching product with the target tags AND a valid image
    for (const tag of targetTags) {
        const matched = allProducts.find(p => 
            p.id !== addedProduct.id && 
            !isExcluded(p.id) &&
            Number(p.stock) > 0 && 
            getProductTag(p) === tag &&
            hasValidImage(p)
        );
        if (matched) return matched;
    }

    // 2. Fallback to matching product with target tags (even without image)
    for (const tag of targetTags) {
        const matched = allProducts.find(p => 
            p.id !== addedProduct.id && 
            !isExcluded(p.id) &&
            Number(p.stock) > 0 && 
            getProductTag(p) === tag
        );
        if (matched) return matched;
    }

    // 3. Generic cross-category fallback if no specific smart tag match found (prefer valid image)
    const currentParent = getParentCategory(addedProduct.category);
    const otherParents = Array.from(new Set(
        allProducts
            .filter(p => Number(p.stock) > 0 && p.id !== addedProduct.id && !isExcluded(p.id))
            .map(p => getParentCategory(p.category))
    )).filter(p => p !== currentParent);

    if (otherParents.length > 0) {
        let targetParent = null;
        if (currentParent.toLowerCase().includes('shirt')) {
            targetParent = otherParents.find(p => p.toLowerCase().includes('pant') || p.toLowerCase().includes('jeans'));
        } else {
            targetParent = otherParents.find(p => p.toLowerCase().includes('shirt'));
        }
        if (!targetParent) {
            targetParent = otherParents[0];
        }
        // First try finding match with image
        const matchWithImg = allProducts.find(p => 
            getParentCategory(p.category) === targetParent && 
            Number(p.stock) > 0 && 
            p.id !== addedProduct.id && 
            !isExcluded(p.id) &&
            hasValidImage(p)
        );
        if (matchWithImg) return matchWithImg;

        // Fallback without image
        return allProducts.find(p => getParentCategory(p.category) === targetParent && Number(p.stock) > 0 && p.id !== addedProduct.id && !isExcluded(p.id));
    }

    return null;
};

// Formats a recommendation message with interactive choice options
const getRecommendationMessage = (addedProduct, recommendedProduct, currentParent) => {
    const addedName = `${addedProduct.color ? addedProduct.color + ' ' : ''}${addedProduct.name}`;
    const recName = `${recommendedProduct.color ? recommendedProduct.color + ' ' : ''}${recommendedProduct.name}`;
    const isShirtAdded = currentParent.toLowerCase().includes('shirt');
    const matchMsg = isShirtAdded
        ? `Bro 🔥 Intha *${addedName}*-ku *${recName}* super best match aagum!`
        : `Bro 🔥 Intha *${addedName}* potu *${recName}* potaa perfect combo aagum!`;

    const sizeList = (Array.isArray(recommendedProduct.sizes)
        ? recommendedProduct.sizes
        : String(recommendedProduct.sizes).split(',').map(s => s.trim())
    ).filter(Boolean);
    const sizesText = sizeList.map(s => s.toUpperCase()).join(' ');

    return `${matchMsg}\n\n` +
           `💰 ₹${recommendedProduct.price}\n` +
           `📦 Stock: ${recommendedProduct.stock} pcs\n\n` +
           `📐 Available Sizes:\n` +
           `${sizesText}\n\n` +
           `Choose:\n\n` +
           `1️⃣ Select Size\n` +
           `2️⃣ Show Another Match\n` +
           `3️⃣ Skip`;
};

// Dynamically group subcategories into top-level parent categories based on noun rules
const getParentCategory = (categoryName) => {
    if (!categoryName) return 'General';
    const catLower = categoryName.toLowerCase().trim();
    
    const rules = [
        { keywords: ['t-shirt', 't shirt', 'tshirt'], parent: 'T-Shirts' },
        { keywords: ['shirt'], parent: 'Shirts' },
        { keywords: ['pant', 'phant'], parent: 'Pants' },
        { keywords: ['shorts'], parent: 'Shorts' },
        { keywords: ['jeans'], parent: 'Jeans' },
        { keywords: ['saree'], parent: 'Sarees' },
        { keywords: ['frock'], parent: 'Frocks' },
        { keywords: ['suit'], parent: 'Suits' },
        { keywords: ['kurti', 'kurta'], parent: 'Kurtis' }
    ];
    
    for (const rule of rules) {
        if (rule.keywords.some(kw => catLower.includes(kw))) {
            return rule.parent;
        }
    }
    
    // Capitalize properly
    return categoryName.split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
};

// Dynamically get emoji based on parent category
const getCategoryEmoji = (parentCategory) => {
    const name = parentCategory.toLowerCase();
    if (name.includes('shirt')) return '👕';
    if (name.includes('pant') || name.includes('phant') || name.includes('jeans')) return '👖';
    if (name.includes('shorts')) return '🩳';
    if (name.includes('saree') || name.includes('frock') || name.includes('suit') || name.includes('kurti')) return '👗';
    return '🛍️';
};

// Helper to calculate active category counts
const getCategoryCounts = (products) => {
    const categoryCounts = {};
    products.forEach(p => {
        if (Number(p.stock) > 0) {
            const parent = getParentCategory(p.category);
            categoryCounts[parent] = (categoryCounts[parent] || 0) + 1;
        }
    });
    return categoryCounts;
};

// Helper to sort parent categories
const getSortedParents = (categoryCounts) => {
    const parents = Object.keys(categoryCounts).filter(cat => categoryCounts[cat] > 0);
    parents.sort((a, b) => {
        const order = { 'Shirts': 1, 'Pants': 2, 'T-Shirts': 3, 'Jeans': 4, 'Shorts': 5 };
        const orderA = order[a] || 99;
        const orderB = order[b] || 99;
        if (orderA !== orderB) return orderA - orderB;
        return a.localeCompare(b);
    });
    return parents;
};

// Helper to initiate checkout
const startCheckout = (session) => {
    if (!session.cart || session.cart.length === 0) {
        session.state = "AWAITING_CATEGORY";
        return { replyText: "Cart empty bro 😊 Mudhalla category search pannunga.", sendImages: [] };
    }
    let cartSummary = `🛒 *Your Cart:*\n\n`;
    session.cart.forEach((item, i) => {
        cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.name} (${item.size}) - ₹${item.price}\n`;
    });
    const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price), 0);
    cartSummary += `\n💰 Total: ₹${cartTotal}\n\n📝 Order confirm panna details fill pannuga:\n\n*Name, Phone, Address*\n\nExample:\nRavi, 9876543210, 12 Anna Nagar Chennai`;
    session.state = "AWAITING_CHECKOUT_DETAILS";
    session.orderDetails = { customerName: '', customerPhone: '', customerAddress: '', paymentMethod: 'UPI' };
    return { replyText: cartSummary, sendImages: [] };
};

// =============================
// Intent Detection & Routing Layer
// =============================

function detectIntent(text, products = []) {
    const t = text.toLowerCase().trim();

    // 1. HUMAN Intent
    const humanKeywords = ['owner', 'human', 'customer support', 'call me', 'agent', 'support', 'talk to owner', 'contact owner', 'connect to human', 'chat with owner', 'human mode'];
    if (humanKeywords.some(k => t.includes(k))) {
        return { type: 'HUMAN' };
    }

    // 2. CHECKOUT Intent
    const checkoutKeywords = ['checkout', 'place order', 'confirm order', 'buy now', 'buy', 'order confirm'];
    if (checkoutKeywords.some(k => t === k || t.includes('checkout') || t.includes('place order') || t.includes('confirm order') || t.includes('buy now'))) {
        return { type: 'CHECKOUT' };
    }

    // 3. CLEAR CART Intent
    const clearCartKeywords = ['clear cart', 'empty cart', 'reset cart', 'remove all', 'delete cart', 'cart clear'];
    if (clearCartKeywords.some(k => t.includes(k))) {
        return { type: 'CLEAR_CART' };
    }

    // Helper helper for checking word existence with fuzzy support
    const words = t.split(/\s+/).map(w => w.replace(/[?,.!:;()]/g, '').trim()).filter(Boolean);
    const matchesGroup = (wordsArr, group) => {
        return wordsArr.some(w => {
            return group.some(g => {
                if (w === g) return true;
                if (g.length > 3 && w.includes(g)) return true;
                if (w.length > 3 && g.includes(w)) return true;
                return false;
            });
        });
    };

    // 4. FAQ Intent

    // ─── DELIVERY TIME Combination Match ───
    const delivTimeGroupA = ['when', 'time', 'day', 'days', 'date', 'eppo', 'epo', 'naal', 'naalu', 'agum', 'varum', 'received', 'receive', 'get', 'arrive', 'reach', 'varala', 'varuga'];
    const delivTimeGroupB = ['deliv', 'delei', 'delci', 'delve', 'delvi', 'dlvr', 'order', 'parcel', 'package', 'dress', 'shirt', 'pant', 'item', 'product'];
    const isDeliveryTime = (matchesGroup(words, delivTimeGroupA) && matchesGroup(words, delivTimeGroupB)) ||
                           t.includes('delivery duration') || t.includes('how long') || t.includes('how many days');

    if (isDeliveryTime) {
        return { type: 'FAQ', reply: '🚚 Delivery usually 2-5 working days bro.' };
    }

    // ─── SHIPPING CHARGES Combination Match ───
    const shipChargeGroupA = ['charge', 'charges', 'rate', 'fee', 'fees', 'amount', 'cost', 'price', 'evlo', 'evvalavu', 'how much', 'cash', 'kasu', 'kaasu', 'rupees', 'rs'];
    const shipChargeGroupB = ['ship', 'delivery', 'delei', 'delci', 'delve', 'delvi', 'dlvr', 'courier', 'post', 'parcel'];
    const isShippingCharge = (matchesGroup(words, shipChargeGroupA) && matchesGroup(words, shipChargeGroupB)) ||
                             t.includes('shipping fee') || t.includes('delivery amount') || t.includes('shipping amount');

    if (isShippingCharge) {
        return { type: 'FAQ', reply: '🚚 Delivery charge ₹80 bro.' };
    }

    // ─── COD Combination Match ───
    const codGroupA = ['cod', 'cash', 'pay on delivery', 'payment on delivery', 'pod', 'delivery cash'];
    const codGroupB = ['available', 'iruka', 'irukka', 'delivery', 'deliv', 'delei', 'delci'];
    const isCOD = matchesGroup(words, ['cod', 'cashondelivery']) ||
                  (matchesGroup(words, codGroupA) && matchesGroup(words, codGroupB));

    if (isCOD) {
        return { type: 'FAQ', reply: 'Sorry bro 😊 COD available illa.\nGPay / UPI mattum available.' };
    }

    // ─── RETURN / EXCHANGE / REFUND Match ───
    const returnKeywords = ['return', 'exchange', 'refund', 'replace', 'maatunga', 'maatuga', 'size match', 'wrong size', 'size wrong', 'size issue', 'size change', 'change size', 'damage', 'torn', 'defect', 'stain', 'hole', 'quality', 'bad quality'];
    if (returnKeywords.some(k => t.includes(k))) {
        if (t.includes('size match') || t.includes('size wrong') || t.includes('wrong size') || t.includes('size poda')) {
            return { type: 'FAQ', reply: '📌 Size issue bro?\n\n7 days exchange available.\nOrder ID + product photo anuppunga.' };
        }
        if (t.includes('refund')) {
            return { type: 'FAQ', reply: '💰 Refund process:\n\nOrder ID anuppunga bro.\nCheck pannitu 3-5 days la refund arrange panrom.' };
        }
        if (t.includes('damage') || t.includes('torn') || t.includes('defect') || t.includes('hole') || t.includes('stain')) {
            return { type: 'FAQ', reply: '📸 Product photo + Order ID anuppunga bro.\n\nCheck pannitu exchange arrange panrom. 😊' };
        }
        return { type: 'FAQ', reply: '✅ 7 days Return / Exchange available bro.\n\nOrder ID + product photo anuppunga.' };
    }

    // ─── PAYMENT METHODS Match ───
    const paymentKeywords = ['payment', 'pay', 'gpay', 'upi', 'google pay', 'googlepay', 'phonepe', 'phone pay', 'bank transfer', 'account number', 'upi id', 'gpay number', 'screenshot', 'pay panna', 'gpay details'];
    if (paymentKeywords.some(k => t.includes(k))) {
        return { type: 'FAQ', reply: '💳 Payment details bro:\n\nGPay / UPI: yourupi@okaxis\n\nPayment pannitu screenshot anuppunga 😊' };
    }

    // ─── DISCOUNT / OFFERS Match ───
    const discountKeywords = ['discount', 'offer', 'sale', 'coupon', 'rate kam', 'cheap', 'kammiya', 'kammi', 'price drop', 'less price', 'best price'];
    if (discountKeywords.some(k => t.includes(k))) {
        return { type: 'FAQ', reply: 'Sorry bro 😊 Fixed price taan. Already best price la iruku! 🔥' };
    }

    // ─── STORE INFO Match ───
    const storeKeywords = ['address', 'location', 'shop', 'store', 'enga', 'where', 'phone number', 'contact number', 'kodu'];
    if (storeKeywords.some(k => t.includes(k))) {
        return { type: 'FAQ', reply: '🏪 Super Collections\n\nOnline orders mattum bro. WhatsApp la order pannunga! 😊' };
    }


    // 4. GREETING Intent
    const greetKeywords = ['hi', 'hello', 'hey', 'vanakkam', 'hai', 'hii', 'yo', 'sup'];
    if (greetKeywords.some(k => t === k || t === k + ' bro' || t === k + ' anna')) {
        return { type: 'GREETING' };
    }

    // 5. Category vs Search Intent
    const parentCategories = ['Shirts', 'Pants', 'T-Shirts', 'Jeans', 'Shorts'];
    const foundCategory = parentCategories.find(cat => {
        const catSingular = cat.endsWith('s') ? cat.slice(0, -1) : cat;
        const regex = new RegExp(`\\b${catSingular}(s)?\\b`, 'i');
        return regex.test(t);
    });

    if (foundCategory) {
        const descriptors = [
            'black', 'white', 'red', 'blue', 'green', 'yellow', 'grey', 'gray', 'navy', 'pink',
            'printed', 'check', 'checked', 'stripes', 'striped', 'pattern', 'linen', 'cotton', 'denim',
            'under', 'below', 'less than', 'above', 'price', 'budget', '500', '600', '1000'
        ];
        const hasDescriptor = descriptors.some(desc => t.includes(desc));
        const words = t.split(/\s+/).filter(w => w !== 'show' && w !== 'me' && w !== 'want' && w !== 'bro' && w !== 'anna');
        
        if (hasDescriptor || words.length > 2) {
            return { type: 'SEARCH', query: t };
        } else {
            return { type: 'CATEGORY', category: foundCategory };
        }
    }

    const searchKeywords = ['printed', 'linen', 'cotton', 'cargo', 'black', 'white', 'green', 'blue', 'red', 'under', 'below', 'budget'];
    if (searchKeywords.some(kw => t.includes(kw))) {
        return { type: 'SEARCH', query: t };
    }

    return { type: 'UNKNOWN' };
}

function matchParentCategory(text, parentCategories) {
    const t = text.toLowerCase().trim();
    const mappings = {
        'shirt': 'Shirts',
        'shirts': 'Shirts',
        'pant': 'Pants',
        'pants': 'Pants',
        'phant': 'Pants',
        'phants': 'Pants',
        'jeans': 'Jeans',
        'jean': 'Jeans',
        'tshirt': 'T-Shirts',
        'tshirts': 'T-Shirts',
        't-shirt': 'T-Shirts',
        't-shirts': 'T-Shirts',
        'shorts': 'Shorts',
        'short': 'Shorts'
    };

    for (const key of Object.keys(mappings)) {
        if (t.includes(key)) {
            const matchedName = mappings[key];
            if (parentCategories.includes(matchedName)) {
                return matchedName;
            }
        }
    }
    return parentCategories.find(cat => t.includes(cat.toLowerCase()));
}

function getStatePrompt(session, products) {
    switch (session.state) {
        case "AWAITING_CATEGORY": {
            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            session.parentCategories = parents;

            let replyText = "Welcome to Super Collections bro 😊\n\nEnna category venum?\n\n";
            parents.forEach((cat, idx) => {
                const emoji = getCategoryEmoji(cat);
                replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga bro 😊";

            return { replyText, sendImages: [], listContext: { type: 'categories', data: parents } };
        }
        case "AWAITING_SUBCATEGORY_SELECTION": {
            const selectedParent = session.selectedParentCategory;
            const subcategoryCounts = {};
            products.forEach(p => {
                if (Number(p.stock) > 0 && getParentCategory(p.category) === selectedParent) {
                    const sub = p.category || 'General';
                    subcategoryCounts[sub] = (subcategoryCounts[sub] || 0) + 1;
                }
            });
            const subs = Object.keys(subcategoryCounts).filter(sub => subcategoryCounts[sub] > 0);
            subs.sort((a, b) => a.localeCompare(b));
            session.subCategories = subs;

            let replyText = `*${selectedParent}:*\n\n`;
            subs.forEach((sub, sIdx) => {
                const capSub = sub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                replyText += `${sIdx + 1}️⃣ ${capSub} (${subcategoryCounts[sub]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga bro! 😊";

            return { replyText, sendImages: [], listContext: { type: 'subcategories', data: subs, selectedParentCategory: selectedParent } };
        }
        case "AWAITING_MODEL_SELECTION": {
            const selectedSub = session.selectedSubCategory;
            const emoji = getCategoryEmoji(session.selectedParentCategory || '');
            const capSub = selectedSub ? selectedSub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Products';
            
            let replyText = `${emoji} *${capSub} - Available Stock:*\n\n`;
            session.searchProducts.forEach((p, pIdx) => {
                let displayName = p.name;
                if (p.color && !displayName.toLowerCase().includes(p.color.toLowerCase())) {
                    displayName = `${p.color} ${displayName}`;
                }
                replyText += `*${pIdx + 1}.* ${displayName}\n`;
                replyText += `   💰 ₹${p.price}  |  📦 Stock: ${p.stock}\n\n`;
            });
            replyText += `👆 number mattum reply pannunga bro! 😊`;

            return {
                replyText,
                sendImages: [],
                listContext: { type: 'products', data: session.searchProducts, selectedSubCategory: selectedSub, selectedParentCategory: session.selectedParentCategory }
            };
        }
        case "AWAITING_SIZE_SELECTION": {
            const product = session.pendingProduct;
            if (!product) return { replyText: "Enna shopping panriga bro? Category select pannunga.", sendImages: [] };
            const sizeList = (Array.isArray(product.sizes)
                ? product.sizes
                : String(product.sizes).split(',').map(s => s.trim())
            ).filter(Boolean);
            const sizesText = sizeList.map(s => `* ${s.toUpperCase()}`).join('\n');
            const replyText = `${product.color ? product.color + ' ' : ''}${product.name}\n💰 ₹${product.price}\n📦 Stock: ${product.stock} pcs\n\n📐 Available Sizes:\n${sizesText}\n\nEntha size venum bro? 😊`;

            return {
                replyText,
                sendImages: [{ url: getProductImageUri(product, products), caption: product.name }],
                pendingProduct: product
            };
        }
        case "AWAITING_RECOMMENDATION_CHOICE": {
            const product = session.pendingProduct;
            if (!product) return { replyText: "Enna shopping panriga bro? Category select pannunga.", sendImages: [] };
            const originalProduct = products.find(p => p.id === session.originalProductId) || 
                                    (session.cart.length > 0 ? products.find(p => p.id === session.cart[session.cart.length - 1].id) : null);
            const currentParent = originalProduct ? getParentCategory(originalProduct.category) : "General";
            const recName = `${product.color ? product.color + ' ' : ''}${product.name}`;
            const replyText = getRecommendationMessage(originalProduct || { name: 'product', color: '' }, product, currentParent);

             return {
                replyText,
                sendImages: [{ url: getProductImageUri(product, products), caption: recName }],
                pendingProduct: product,
                listContext: {
                    type: 'recommendation_choice',
                    pendingProduct: product,
                    originalProductId: originalProduct ? originalProduct.id : null,
                    recommendedIds: session.recommendedIds ? [...session.recommendedIds] : [product.id]
                }
            };
        }
        case "AWAITING_CART_CONFIRM": {
            const product = session.pendingProduct;
            if (!product) return { replyText: "Enna shopping panriga bro? Category select pannunga.", sendImages: [] };
            return {
                sendButtons: {
                    body: `✅ ${product.name} - ${session.selectedSize}\n\nCart la add pannalama bro?`,
                    buttons: [
                        { id: 'yes', title: '✅ YES' },
                        { id: 'no', title: '❌ NO' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_MORE_ITEMS": {
            return {
                sendButtons: {
                    body: `Vera ethachu pakkiriya bro?`,
                    buttons: [
                        { id: 'yes', title: '🛍️ YES' },
                        { id: 'no_checkout', title: '🛒 NO - Checkout' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_PENDING_CART_DECISION": {
            let cartSummary = `🛒 *Pending Items in Cart:*\n\n`;
            session.cart.forEach((item, i) => {
                cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.name} (${item.size}) - ₹${item.price}\n`;
            });
            const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price), 0);
            cartSummary += `\n💰 Total: ₹${cartTotal}\n\nUnga order cart-la pending iruku, bro! Complete panrigla illai cancel panrigla? 😊`;
            return {
                sendButtons: {
                    body: cartSummary,
                    buttons: [
                        { id: 'checkout', title: '🛒 CHECKOUT' },
                        { id: 'continue', title: '🛍️ CONTINUE' },
                        { id: 'clear', title: '❌ CLEAR' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_CHECKOUT_DETAILS": {
            let cartSummary = `🛒 *Your Cart:*\n\n`;
            session.cart.forEach((item, i) => {
                cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.name} (${item.size}) - ₹${item.price}\n`;
            });
            const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price), 0);
            cartSummary += `\n💰 Total: ₹${cartTotal}\n\n📝 Order confirm panna details fill pannuga:\n\n*Name, Phone, Address*\n\nExample:\nRavi, 9876543210, 12 Anna Nagar Chennai`;
            return { replyText: cartSummary, sendImages: [] };
        }
        default: {
            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            let replyText = "Enna Shopping Panriga?\n\n";
            parents.forEach((cat, idx) => {
                const emoji = getCategoryEmoji(cat);
                replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
            });
            return { replyText, sendImages: [] };
        }
    }
}

function handleIntent(intentResult, session, products) {
    switch (intentResult.type) {
        case 'CLEAR_CART': {
            session.cart = [];
            session.state = "AWAITING_CATEGORY";
            session.pendingProduct = null;
            session.selectedSize = null;
            session.searchProducts = [];
            session.isRecommendation = false;
            
            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            session.parentCategories = parents;

            let replyText = "Cart cleared bro! 😊 Category list-la irundhu select pannunga.\n\nEnna Shopping Panriga?\n\n";
            parents.forEach((cat, idx) => {
                const emoji = getCategoryEmoji(cat);
                replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga bro 😊";

            return { replyText, sendImages: [], listContext: { type: 'categories', data: parents } };
        }
        case 'HUMAN': {
            return {
                replyText: "Sure bro! 🙋‍♂️ Chat paused. Owner shortly connect pannuvanga.",
                sendImages: [],
                isHumanHandoff: true
            };
        }
        case 'CHECKOUT': {
            if (!session.cart || session.cart.length === 0) {
                let replyText = "Cart empty bro 😊 Mudhalla products-a cart la add pannunga.";
                if (session.state !== "AWAITING_CATEGORY") {
                    const statePrompt = getStatePrompt(session, products);
                    replyText += `\n\nContinue shopping bro 😊\n\n${statePrompt.replyText}`;
                    return {
                        replyText,
                        sendImages: statePrompt.sendImages || [],
                        sendButtons: statePrompt.sendButtons || null,
                        listContext: statePrompt.listContext || null
                    };
                }
                return { replyText, sendImages: [] };
            }
            return startCheckout(session);
        }
        case 'FAQ': {
            let replyText = intentResult.reply;
            if (session.state !== "AWAITING_CATEGORY") {
                const statePrompt = getStatePrompt(session, products);
                if (statePrompt.replyText) {
                    replyText += `\n\nContinue shopping bro 😊\n\n${statePrompt.replyText}`;
                } else {
                    replyText += `\n\nContinue shopping bro 😊`;
                }
                return {
                    replyText,
                    sendImages: statePrompt.sendImages || [],
                    sendButtons: statePrompt.sendButtons || null,
                    listContext: statePrompt.listContext || null
                };
            }
            return { replyText, sendImages: [] };
        }
        case 'GREETING': {
            if (session.cart && session.cart.length > 0) {
                session.state = "AWAITING_PENDING_CART_DECISION";
                return getStatePrompt(session, products);
            }
            session.state = "AWAITING_CATEGORY";
            session.pendingProduct = null;
            session.selectedSize = null;
            session.lastRecommendation = null;
            session.subCategories = null;
            session.selectedParentCategory = null;
            session.selectedSubCategory = null;
            session.isRecommendation = false;

            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            session.parentCategories = parents;

            let replyText = "Welcome to Super Collections bro 😊\n\nEnna category venum?\n\n";
            parents.forEach((cat, idx) => {
                const emoji = getCategoryEmoji(cat);
                replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga bro 😊";

            return { replyText, sendImages: [], listContext: { type: 'categories', data: parents } };
        }
        case 'CATEGORY': {
            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            const selectedParent = matchParentCategory(intentResult.category, parents);
            
            if (selectedParent) {
                session.selectedParentCategory = selectedParent;
                session.state = "AWAITING_SUBCATEGORY_SELECTION";
                session.pendingProduct = null;
                session.selectedSize = null;
                session.searchProducts = [];
                session.lastRecommendation = null;
                session.isRecommendation = false;

                const subcategoryCounts = {};
                products.forEach(p => {
                    if (Number(p.stock) > 0 && getParentCategory(p.category) === selectedParent) {
                        const sub = p.category || 'General';
                        subcategoryCounts[sub] = (subcategoryCounts[sub] || 0) + 1;
                    }
                });

                const subs = Object.keys(subcategoryCounts).filter(sub => subcategoryCounts[sub] > 0);
                subs.sort((a, b) => a.localeCompare(b));
                session.subCategories = subs;

                let replyText = `*${selectedParent}:*\n\n`;
                subs.forEach((sub, sIdx) => {
                    const capSub = sub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                    replyText += `${sIdx + 1}️⃣ ${capSub} (${subcategoryCounts[sub]})\n`;
                });
                replyText += "\nNumber mattum reply pannunga bro! 😊";

                return { replyText, sendImages: [], listContext: { type: 'subcategories', data: subs, selectedParentCategory: selectedParent } };
            }
            // If match fails, fall through to SEARCH
        }
        case 'SEARCH': {
            const query = intentResult.query || intentResult.category || '';
            const queryClean = query.toLowerCase().replace(/(?:under|below|less than)\s*₹?\s*\d+/, '').trim();
            const fillerWords = ['show', 'me', 'look', 'for', 'please', 'want', 'need', 'find', 'get', 'display', 'search', 'any', 'some', 'can', 'you', 'give', 'kudu', 'kammi', 'kattunga', 'kaatunga', 'katu', 'iruka', 'irukka'];
            const keywords = queryClean.split(/\s+/)
                .filter(word => word.length > 0 && word !== "bro" && word !== "anna" && !fillerWords.includes(word))
                .map(kw => (kw.endsWith('s') && kw.length > 3) ? kw.slice(0, -1) : kw);

            let maxPrice = null;
            const underMatch = query.toLowerCase().match(/(?:under|below|less than)\s*₹?\s*(\d+)/);
            if (underMatch) {
                maxPrice = parseInt(underMatch[1], 10);
            }

            let matched = products.filter(p => Number(p.stock) > 0);
            matched = matched.filter(p => {
                if (maxPrice && p.price) {
                    const parsedPrice = parseFloat(p.price.replace(/[^\d.]/g, ''));
                    if (isNaN(parsedPrice) || parsedPrice > maxPrice) return false;
                }
                if (keywords.length > 0) {
                    return keywords.every(kw => {
                        return (
                            p.name?.toLowerCase().includes(kw) ||
                            p.category?.toLowerCase().includes(kw) ||
                            (p.color && p.color.toLowerCase().includes(kw)) ||
                            (p.pattern && p.pattern.toLowerCase().includes(kw))
                        );
                    });
                }
                return true;
            });

            if (matched.length > 0) {
                let replyText = `🔍 *Search Results:* (Stock available)\n\n`;
                const displayProducts = matched.slice(0, 10);
                displayProducts.forEach((p, idx) => {
                    let displayName = p.name;
                    if (p.color && !displayName.toLowerCase().includes(p.color.toLowerCase())) {
                        displayName = `${p.color} ${displayName}`;
                    }
                    replyText += `*${idx + 1}.* ${displayName}\n`;
                    replyText += `   💰 ₹${p.price}  |  📦 Stock: ${p.stock}\n\n`;
                });
                replyText += `👆 number mattum reply pannunga bro! 😊`;

                session.searchProducts = displayProducts;
                session.state = "AWAITING_MODEL_SELECTION";
                session.pendingProduct = null;
                session.selectedSize = null;
                session.isRecommendation = false;

                return { replyText, sendImages: [], searchProducts: displayProducts, listContext: { type: 'products', data: displayProducts } };
            } else {
                let replyText = "Sorry bro, search matching products ippo stock illa. 😔";
                if (session.state !== "AWAITING_CATEGORY") {
                    const statePrompt = getStatePrompt(session, products);
                    replyText += `\n\nContinue shopping bro 😊\n\n${statePrompt.replyText}`;
                    return {
                        replyText,
                        sendImages: statePrompt.sendImages || [],
                        sendButtons: statePrompt.sendButtons || null,
                        listContext: statePrompt.listContext || null
                    };
                }
                return { replyText, sendImages: [] };
            }
        }
        default:
            return null;
    }
}

export function handleSalesAssistantJS(from, userMessage, products, session) {
    const normalizedMessage = normalizeQuery(userMessage);
    const textLower = normalizedMessage.toLowerCase();

    // Ensure session properties are initialized
    session.cart = session.cart || [];
    session.state = session.state || "AWAITING_CATEGORY";
    session.isRecommendation = session.isRecommendation || false;

    // Backward compatibility for stale recommendation states
    if (session.state === "AWAITING_RECOMMENDATION_CONFIRM" || session.state === "AWAITING_COMBO_CART_CONFIRM") {
        session.state = "AWAITING_MORE_ITEMS";
    }

    // ─── Intent Detection & Routing Layer ───
    const intentResult = detectIntent(textLower, products);
    if (intentResult.type !== 'UNKNOWN') {
        const intentResponse = handleIntent(intentResult, session, products);
        if (intentResponse) {
            return intentResponse;
        }
    }

    // Backward compatibility variables for existing state handler below
    const intent = intentResult.type;
    const isNumber = /^[1-9][0-9]?$/.test(textLower);

    let isValidSize = false;
    if (["AWAITING_SIZE_SELECTION", "AWAITING_CART_CONFIRM"].includes(session.state) && session.pendingProduct) {
        const product = session.pendingProduct;
        const availableSizes = Array.isArray(product.sizes)
            ? product.sizes.map(s => s.toLowerCase().trim())
            : String(product.sizes).toLowerCase().split(',').map(s => s.trim());
        const normalizedInput = normalizeSize(textLower);
        isValidSize = availableSizes.some(s => normalizeSize(s) === normalizedInput);
    }

    const isYesNo = ['yes', 'no', 'y', 'n', 'aama', 'illa', 'vendam', 'ok', 'okay', 'help_yes', 'help_no', 'skip'].includes(textLower);
    const hasCommas = userMessage.split(',').length >= 3;

    // Set triggers to false since explicit intents are handled by the router
    const isCheckoutTrigger = false;
    const isCategorySearch = false;
    const isGreeting = false;

    // 2. STATE-SPECIFIC HANDLERS

    // STATE: AWAITING_PENDING_CART_DECISION
    if (session.state === "AWAITING_PENDING_CART_DECISION") {
        const lowerInput = textLower.trim();
        const isCheckout = lowerInput === "checkout" || lowerInput === "complete" || lowerInput === "1" || lowerInput === "1️⃣" || lowerInput.includes("checkout") || lowerInput.includes("complete") || lowerInput.includes("order");
        const isContinue = lowerInput === "continue" || lowerInput === "shop" || lowerInput === "2" || lowerInput === "2️⃣" || lowerInput.includes("continue") || lowerInput.includes("shop");
        const isClear = lowerInput === "clear" || lowerInput === "cancel" || lowerInput === "delete" || lowerInput === "3" || lowerInput === "3️⃣" || lowerInput.includes("clear") || lowerInput.includes("cancel") || lowerInput.includes("delete");

        if (isCheckout) {
            return startCheckout(session);
        } else if (isContinue) {
            session.state = "AWAITING_CATEGORY";
            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            session.parentCategories = parents;

            let replyText = "Ok bro! 😊 Category list-la irundhu select pannunga.\n\nEnna Shopping Panriga?\n\n";
            parents.forEach((cat, idx) => {
                const emoji = getCategoryEmoji(cat);
                replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga bro 😊";
            return { replyText, sendImages: [], listContext: { type: 'categories', data: parents } };
        } else if (isClear) {
            session.cart = [];
            session.state = "AWAITING_CATEGORY";
            session.pendingProduct = null;
            session.selectedSize = null;
            session.searchProducts = [];
            session.isRecommendation = false;

            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            session.parentCategories = parents;

            let replyText = "Cart cleared bro! 😊 Category list-la irundhu select pannunga.\n\nEnna Shopping Panriga?\n\n";
            parents.forEach((cat, idx) => {
                const emoji = getCategoryEmoji(cat);
                replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga bro 😊";
            return { replyText, sendImages: [], listContext: { type: 'categories', data: parents } };
        } else if (!isGreeting && !isCategorySearch && !isCheckoutTrigger) {
            return {
                sendButtons: {
                    body: `⚠️ Wrong choice bro!\n\nUnga cart la items pending iruku. complete panrigla cancel panriglanu choose pannunga:`,
                    buttons: [
                        { id: 'checkout', title: '🛒 CHECKOUT' },
                        { id: 'continue', title: '🛍️ CONTINUE' },
                        { id: 'clear', title: '❌ CLEAR' }
                    ]
                },
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_HELP_CONFIRM
    if (session.state === "AWAITING_HELP_CONFIRM") {
        const yesKeywords = ['yes', 'aama', 'help_yes', 'y', 'aam', 'ok', 'okay', 'sari', 'sari bro', 'saree', 'sari da', 'seri', 'seri bro', 'seri da', 'aama bro'];
        const noKeywords = ['no', 'help_no', 'n', 'illai', 'illa', 'vendam', 'ethum venam', 'no bro', 'nothing', 'no thanks', 'no thank you'];

        if (yesKeywords.includes(textLower) || textLower.includes('yes') || textLower.includes('aama') || textLower.includes('sari') || textLower.includes('seri')) {
            session.state = "AWAITING_CATEGORY";
            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            session.parentCategories = parents;

            let replyText = "Welcome to Super Collections 😊\n\nEnna Shopping Panriga?\n\n";
            parents.forEach((cat, idx) => {
                const emoji = getCategoryEmoji(cat);
                replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga 😊";
            return { replyText, sendImages: [], listContext: { type: 'categories', data: parents } };
        } else if (noKeywords.includes(textLower) || textLower.includes('no') || textLower.includes('illa') || textLower.includes('vendam')) {
            session.state = "AWAITING_CATEGORY";
            session.pendingProduct = null;
            session.selectedSize = null;
            return {
                replyText: "🙏 Thanks bro! Super Collections support pannathuku nandri ❤️ Anytime message pannunga 😊",
                sendImages: []
            };
        } else {
            session.state = "AWAITING_CATEGORY";
        }
    }

    // STATE: AWAITING_CHECKOUT_DETAILS
    if (session.state === "AWAITING_CHECKOUT_DETAILS") {
        const parts = userMessage.split(',').map(s => s.trim());
        if (parts.length >= 3) {
            session.orderDetails.customerName = parts[0];
            session.orderDetails.customerPhone = parts[1];
            session.orderDetails.customerAddress = parts.slice(2).join(', ');
            session.isOrderConfirmed = true;
            return {
                sendImages: [],
                isOrderConfirmed: true,
                orderDetails: session.orderDetails
            };
        } else {
            return {
                replyText: `⚠️ Format correct ah anuppunga bro:\n\n*Name, Phone, Address*\n\nExample:\nRavi, 9876543210, 12 Anna Nagar Chennai`,
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_SUBCATEGORY_SELECTION (expects a number)
    if (session.state === "AWAITING_SUBCATEGORY_SELECTION" && isNumber) {
        const idx = parseInt(textLower, 10) - 1;
        if (session.subCategories && idx >= 0 && idx < session.subCategories.length) {
            const selectedSub = session.subCategories[idx];
            const matched = products.filter(p => Number(p.stock) > 0 && p.category === selectedSub);

            if (matched.length > 0) {
                session.selectedSubCategory = selectedSub;
                session.state = "AWAITING_MODEL_SELECTION";

                const emoji = getCategoryEmoji(session.selectedParentCategory || '');
                const capSub = selectedSub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                
                let replyText = `${emoji} *${capSub} - Available Stock:*\n\n`;
                const displayProducts = matched.slice(0, 15);
                displayProducts.forEach((p, pIdx) => {
                    let displayName = p.name;
                    if (p.color && !displayName.toLowerCase().includes(p.color.toLowerCase())) {
                        displayName = `${p.color} ${displayName}`;
                    }
                    replyText += `*${pIdx + 1}.* ${displayName}\n`;
                    replyText += `   💰 ₹${p.price}  |  📦 Stock: ${p.stock}\n\n`;
                });
                replyText += `👆 number mattum reply pannunga bro! 😊`;

                session.searchProducts = displayProducts;

                return {
                    replyText,
                    sendImages: [],
                    searchProducts: displayProducts,
                    listContext: { type: 'products', data: displayProducts, selectedSubCategory: selectedSub, selectedParentCategory: session.selectedParentCategory }
                };
            } else {
                session.state = "AWAITING_CATEGORY";
                return { replyText: "Sorry bro, intha subcategory la stock illa. 😔", sendImages: [] };
            }
        } else {
            const max = session.subCategories?.length || 1;
            return {
                replyText: `⚠️ Wrong choice bro! 1-larunthu ${max} varaikum iruka subcategory number-a mattum choose pannunga. 😊`,
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_MODEL_SELECTION (expects a number)
    if (session.state === "AWAITING_MODEL_SELECTION" && isNumber) {
        const idx = parseInt(textLower, 10) - 1;
        if (session.searchProducts && idx >= 0 && idx < session.searchProducts.length) {
            const product = session.searchProducts[idx];
            session.pendingProduct = product;
            session.state = "AWAITING_SIZE_SELECTION";

            const sizeList = (Array.isArray(product.sizes)
                ? product.sizes
                : String(product.sizes).split(',').map(s => s.trim())
            ).filter(Boolean);
            const sizesText = sizeList.map(s => `* ${s.toUpperCase()}`).join('\n');

            const replyText = `${product.color ? product.color + ' ' : ''}${product.name}\n💰 ₹${product.price}\n📦 Stock: ${product.stock} pcs\n\n📐 Available Sizes:\n${sizesText}\n\nEntha size venum bro? 😊`;

            return {
                replyText,
                sendImages: [{ url: getProductImageUri(product, products), caption: product.name }],
                pendingProduct: product
            };
        } else {
            const max = session.searchProducts?.length || 1;
            return {
                replyText: `⚠️ Wrong choice bro! 1-larunthu ${max} varaikum iruka product number-a mattum choose pannunga. 😊`,
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_RECOMMENDATION_CHOICE
    if (session.state === "AWAITING_RECOMMENDATION_CHOICE" && session.pendingProduct) {
        const product = session.pendingProduct;
        const choiceText = textLower.trim();

        const isChoice1 = choiceText === "1" || choiceText === "1️⃣" || choiceText.includes("select size") || choiceText === "select" || choiceText === "size";
        const isChoice2 = choiceText === "2" || choiceText === "2️⃣" || choiceText.includes("show another") || choiceText.includes("another match") || choiceText === "another" || choiceText === "show match" || choiceText === "match";
        const isChoice3 = choiceText === "3" || choiceText === "3️⃣" || choiceText === "skip" || choiceText.includes("skip recommendation") || choiceText === "no" || choiceText === "n" || choiceText === "illa" || choiceText === "vendam";

        if (isChoice1) {
            session.state = "AWAITING_SIZE_SELECTION";
            const sizeList = (Array.isArray(product.sizes)
                ? product.sizes
                : String(product.sizes).split(',').map(s => s.trim())
            ).filter(Boolean);
            const sizesText = sizeList.map(s => `* ${s.toUpperCase()}`).join('\n');

            return {
                replyText: `Entha size venum bro? 😊\n\nAvailable Sizes:\n${sizesText}`,
                sendImages: []
            };
        } else if (isChoice2) {
            const originalProduct = products.find(p => p.id === session.originalProductId) || 
                                    (session.cart.length > 0 ? products.find(p => p.id === session.cart[session.cart.length - 1].id) : null);

            if (!session.recommendedIds) {
                session.recommendedIds = [product.id];
            }

            const nextRecommended = getSmartRecommendation(originalProduct, products, session.recommendedIds);

            if (nextRecommended) {
                session.recommendedIds.push(nextRecommended.id);
                session.pendingProduct = nextRecommended;

                const recName = `${nextRecommended.color ? nextRecommended.color + ' ' : ''}${nextRecommended.name}`;
                const currentParent = originalProduct ? getParentCategory(originalProduct.category) : "General";
                const replyText = getRecommendationMessage(originalProduct || { name: 'product', color: '' }, nextRecommended, currentParent);

                return {
                    replyText,
                    sendImages: [{ url: getProductImageUri(nextRecommended, products), caption: recName }],
                    pendingProduct: nextRecommended,
                    listContext: {
                        type: 'recommendation_choice',
                        pendingProduct: nextRecommended,
                        originalProductId: originalProduct ? originalProduct.id : null,
                        recommendedIds: [...session.recommendedIds]
                    }
                };
            } else {
                const recName = `${product.color ? product.color + ' ' : ''}${product.name}`;
                return {
                    replyText: `⚠️ No other matches found in stock for this combo, bro! 😊\n\nChoose:\n1️⃣ Select Size (for ${recName})\n3️⃣ Skip`,
                    sendImages: []
                };
            }
        } else if (isChoice3) {
            session.pendingProduct = null;
            session.selectedSize = null;
            session.isRecommendation = false;
            session.recommendedIds = null;
            session.originalProductId = null;
            session.state = "AWAITING_MORE_ITEMS";
            return {
                sendButtons: {
                    body: `Ok bro! 😊\n\nVera ethachu pakkiriya bro?`,
                    buttons: [
                        { id: 'yes', title: '🛍️ YES' },
                        { id: 'no_checkout', title: '🛒 NO - Checkout' }
                    ]
                },
                sendImages: []
            };
        } else if (!isGreeting && !isCategorySearch && !isCheckoutTrigger) {
            const recName = `${product.color ? product.color + ' ' : ''}${product.name}`;
            return {
                replyText: `⚠️ Wrong choice bro! Match pannugala illa skip panringalanu crt ah choose pannuga. 😊\n\nChoose:\n1️⃣ Select Size (for ${recName})\n2️⃣ Show Another Match\n3️⃣ Skip`,
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_SIZE_SELECTION
    if (session.state === "AWAITING_SIZE_SELECTION" && session.pendingProduct) {
        const product = session.pendingProduct;

        // Check recommendation skip
        if (session.isRecommendation && (textLower === 'skip' || textLower === 'no' || textLower === 'n' || textLower === 'illa' || textLower === 'vendam')) {
            session.pendingProduct = null;
            session.selectedSize = null;
            session.isRecommendation = false;
            session.state = "AWAITING_MORE_ITEMS";
            return {
                sendButtons: {
                    body: `Ok bro! 😊\n\nVera ethachu pakkiriya bro?`,
                    buttons: [
                        { id: 'yes', title: '🛍️ YES' },
                        { id: 'no_checkout', title: '🛒 NO - Checkout' }
                    ]
                },
                sendImages: []
            };
        }

        const availableSizes = Array.isArray(product.sizes)
            ? product.sizes.map(s => s.toLowerCase().trim())
            : String(product.sizes).toLowerCase().split(',').map(s => s.trim());

        const normalizedInput = normalizeSize(textLower);
        const matchedSize = availableSizes.find(s => normalizeSize(s) === normalizedInput);

        if (matchedSize) {
            session.selectedSize = matchedSize.toUpperCase();
            session.state = "AWAITING_CART_CONFIRM";
            return {
                sendButtons: {
                    body: `✅ ${product.name} - ${session.selectedSize}\n\nCart la add pannalama bro?`,
                    buttons: [
                        { id: 'yes', title: '✅ YES' },
                        { id: 'no', title: '❌ NO' }
                    ]
                },
                selectedSize: session.selectedSize
            };
        } else {
            const sizeList = Array.isArray(product.sizes) ? product.sizes.join(', ') : product.sizes;
            let errorText = `❌ Intha size stock illa bro.\n\nAvailable sizes:\n${sizeList}`;
            if (session.isRecommendation) {
                errorText += `\n\nReply with a size or type "skip" to skip.`;
            }
            return {
                replyText: errorText,
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_CART_CONFIRM
    if (session.state === "AWAITING_CART_CONFIRM" && session.pendingProduct) {
        const product = session.pendingProduct;

        // Check if the user typed a size to change/update their selection!
        const availableSizes = Array.isArray(product.sizes)
            ? product.sizes.map(s => s.toLowerCase().trim())
            : String(product.sizes).toLowerCase().split(',').map(s => s.trim());
        const normalizedInput = normalizeSize(textLower);
        const matchedSize = availableSizes.find(s => normalizeSize(s) === normalizedInput);

        if (matchedSize) {
            session.selectedSize = matchedSize.toUpperCase();
            return {
                sendButtons: {
                    body: `✅ ${product.name} - ${session.selectedSize}\n\nCart la add pannalama bro?`,
                    buttons: [
                        { id: 'yes', title: '✅ YES' },
                        { id: 'no', title: '❌ NO' }
                    ]
                },
                selectedSize: session.selectedSize
            };
        }

        if (textLower === "yes" || textLower === "y" || textLower === "aama" || textLower === "add" || textLower === "ok" || textLower === "add cart") {
            session.cart.push({
                id: product.id,
                name: product.name,
                price: Number(product.price),
                color: product.color,
                size: session.selectedSize
            });

            const isRec = session.isRecommendation;
            session.isRecommendation = false;
            session.pendingProduct = null;
            session.selectedSize = null;

            if (isRec) {
                session.state = "AWAITING_MORE_ITEMS";
                return {
                    sendButtons: {
                        body: `✅ Recommended item add achu bro! 😊\n\nVera ethachu pakkiriya bro?`,
                        buttons: [
                            { id: 'yes', title: '🛍️ YES' },
                            { id: 'no_checkout', title: '🛒 NO - Checkout' }
                        ]
                    },
                    sendImages: [],
                    cart: session.cart
                };
            }

            // Standard product added -> Check for recommendation combo
            const currentParent = getParentCategory(product.category);
            const recommended = getSmartRecommendation(product, products);

            if (recommended) {
                session.pendingProduct = recommended;
                session.isRecommendation = true;
                session.state = "AWAITING_RECOMMENDATION_CHOICE";
                session.recommendedIds = [recommended.id];
                session.originalProductId = product.id;

                const recName = `${recommended.color ? recommended.color + ' ' : ''}${recommended.name}`;
                const replyText = getRecommendationMessage(product, recommended, currentParent);

                return {
                    replyText,
                    sendImages: [{ url: getProductImageUri(recommended, products), caption: recName }],
                    cart: session.cart,
                    pendingProduct: recommended,
                    listContext: {
                        type: 'recommendation_choice',
                        pendingProduct: recommended,
                        originalProductId: product.id,
                        recommendedIds: [recommended.id]
                    }
                };
            } else {
                session.state = "AWAITING_MORE_ITEMS";
                return {
                    sendButtons: {
                        body: `✅ Cart la add achu bro! 😊\n\nVera ethachu pakkiriya bro?`,
                        buttons: [
                            { id: 'yes', title: '🛍️ YES' },
                            { id: 'no_checkout', title: '🛒 NO - Checkout' }
                        ]
                    },
                    sendImages: [],
                    cart: session.cart
                };
            }
        } else if (textLower === "no" || textLower === "n" || textLower === "illai") {
            session.isRecommendation = false;
            session.pendingProduct = null;
            session.selectedSize = null;
            session.state = "AWAITING_MORE_ITEMS";
            return {
                sendButtons: {
                    body: `Ok bro! 😊 Cart la add pannala.\n\nVera ethachu pakkiriya bro?`,
                    buttons: [
                        { id: 'yes', title: '🛍️ YES' },
                        { id: 'no_checkout', title: '🛒 NO - Checkout' }
                    ]
                },
                sendImages: []
            };
        } else if (!isGreeting && !isCategorySearch && !isCheckoutTrigger) {
            return {
                replyText: `⚠️ Invalid response bro! YES or NO reply pannunga. 😊`,
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_MORE_ITEMS
    if (session.state === "AWAITING_MORE_ITEMS") {
        if (textLower === "yes" || textLower === "y" || textLower === "aama") {
            session.state = "AWAITING_CATEGORY";
            const cartCount = session.cart.length;
            const cartTotal = session.cart.reduce((sum, i) => sum + Number(i.price), 0);

            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            session.parentCategories = parents;

            let replyText = `Super bro! 😊 Cart la ${cartCount} item(s) iruku (₹${cartTotal})\n\nVera category search pannunga:\n\n`;
            parents.forEach((cat, idx) => {
                const emoji = getCategoryEmoji(cat);
                replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga bro 😊";

            return { replyText, sendImages: [], listContext: { type: 'categories', data: parents } };
        } else if (textLower === "no" || textLower === "n" || textLower === "illai" || textLower === "checkout" || textLower === "no_checkout") {
            return startCheckout(session);
        } else if (!isGreeting && !isCategorySearch && !isCheckoutTrigger) {
            return {
                replyText: `⚠️ Invalid response bro! YES or NO reply pannunga. 😊`,
                sendImages: []
            };
        }
    }

    // 3. GLOBAL HANDLERS (when not handled by active states)

    // ACKNOWLEDGEMENT HANDLER
    const ACK_LIST = [
        'ok', 'okay', 'otay', 'ok bro', 'ok anna', 'okey', 'ok da',
        'k', 'kk', 'hmm', 'hm', 'mm', 'mmm', 'oh ok', 'oh okay',
        'fine', 'fine bro', 'sure', 'sure bro', 'sure da',
        'thanks', 'thank you', 'thx', 'ty', 'thank u', 'thanks bro', 'thank you bro',
        'nandri', 'romba thanks', 'super thanks',
        'noted', 'got it', 'understood',
        'sari', 'sari bro', 'sari da', 'seri', 'seri bro', 'seri da', 'saree',
        '👍', '👌', '✅', '🙏', '😊'
    ];
    const isAck = ACK_LIST.includes(textLower)
        || /^[👍👌✅🙏]+$/.test(textLower)
        || (textLower.startsWith('👍') && textLower.length <= 5)
        || (textLower.startsWith('👌') && textLower.length <= 5)
        || (textLower.includes('thanks') && textLower.length <= 20)
        || (textLower.includes('nandri') && textLower.length <= 20);

    if (isAck) {
        session.state = "AWAITING_HELP_CONFIRM";
        return {
            sendButtons: {
                body: "Vera edhavadhu help venuma bro? 😊",
                buttons: [
                    { id: 'help_yes', title: '✅ YES' },
                    { id: 'help_no', title: '❌ NO' }
                ]
            },
            sendImages: []
        };
    }

    // COMPLAINT HANDLER
    if (intent === 'COMPLAINT' || (session.complaintMode && intent !== 'GREETING')) {
        session.complaintMode = true;
        if (textLower.includes('wrong') || textLower.includes('vera colour') || textLower.includes('vera color') || textLower.includes('wrong colour') || textLower.includes('wrong color') || textLower.includes('wrong item') || textLower.includes('wrong product') || textLower.includes('colour wrong') || textLower.includes('color wrong')) {
            return { replyText: '📸 Sorry bro 😔\n\nProduct photo + Order ID anuppunga bro.\nCheck pannitu udan sort out panrom.', sendImages: [] };
        }
        if (textLower.includes('damage') || textLower.includes('defect') || textLower.includes('torn') || textLower.includes('dirty') || textLower.includes('stain') || textLower.includes('hole') || textLower.includes('bad quality') || textLower.includes('quality illa') || textLower.includes('used item') || textLower.includes('packaging')) {
            return { replyText: '😔 Really sorry bro!\n\nPhoto / video anuppunga + Order ID.\nTeam check pannitu replacement arrange panrom.', sendImages: [] };
        }
        if (textLower.includes('not received') || textLower.includes('kedaikala') || textLower.includes('varala') || textLower.includes('receive pannala') || textLower.includes('delivery delay') || textLower.includes('still not') || textLower.includes('not yet') || textLower.includes('late achu') || textLower.includes('late aguthu') || textLower.includes('parcel varala') || textLower.includes('pakketla')) {
            return { replyText: '😔 Sorry for the delay bro.\n\nOrder ID anuppunga - tracking details check pannitu update sollrom. 📦', sendImages: [] };
        }
        if (textLower.includes('missing') || textLower.includes('item missing') || textLower.includes('parcel missing')) {
            return { replyText: '😔 Sorry bro! Order ID + unboxing photo irundha anuppunga.\nCheck pannitu sort out panrom.', sendImages: [] };
        }
        return { replyText: '😔 Sorry for the inconvenience bro.\n\nOrder ID anuppunga - udan check pannitu help panrom. 🙏', sendImages: [] };
    }

    // RETURN / EXCHANGE HANDLER
    if (intent === 'RETURN_EXCHANGE') {
        session.complaintMode = true;
        if (textLower.includes('size match agala') || textLower.includes('size match agulana') || textLower.includes('size wrong') || textLower.includes('size poda')) {
            return { replyText: '📌 Size issue bro?\n\n7 days exchange available.\nOrder ID + product photo anuppunga.', sendImages: [] };
        }
        if (textLower.includes('refund')) {
            return { replyText: '💰 Refund process:\n\nOrder ID anuppunga bro.\nCheck pannitu 3-5 days la refund arrange panrom.', sendImages: [] };
        }
        return { replyText: '✅ 7 days Return / Exchange available bro.\n\nOrder ID + product photo anuppunga. 🙏', sendImages: [] };
    }

    // Clear complaint mode if customer shifts to shopping
    if (intent === 'GREETING' || intent === 'PRODUCT_ENQUIRY' || intent === 'ORDER_PLACEMENT' || intent === 'ORDER_CONFIRMATION') {
        session.complaintMode = false;
    }

    // FAQ MATCHES
    if (textLower.includes("delivery eppo") || textLower.includes("delivery time") || textLower.includes("evlo naal") || textLower.includes("evvalavu naal") || textLower.includes("kku evlo naal") || textLower.includes("vanthudum")) {
        return { replyText: "🚚 Delivery usually 2-5 working days bro.", sendImages: [] };
    }
    if (textLower.includes("delivery charge") || textLower.includes("delivery rate") || textLower.includes("delivery fee") || textLower.includes("shipping charge") || textLower.includes("courier charge")) {
        return { replyText: "🚚 Delivery charge ₹80 bro.", sendImages: [] };
    }
    if (textLower.includes("delivery area") || textLower.includes("deliver panringa") || textLower.includes("tamilnadu") || textLower.includes("india delivery") || textLower.includes("all india")) {
        return { replyText: "✅ All India delivery available bro! 🚚", sendImages: [] };
    }
    if (textLower.includes("tracking") || textLower.includes("where is my order") || textLower.includes("order enga") || textLower.includes("track order") || textLower.includes("order status")) {
        return { replyText: "Order ID anuppunga bro. Tracking details check pannitu sollrom. 📦", sendImages: [] };
    }
    if (textLower.includes("size match agala") || textLower.includes("size match agulana") || textLower.includes("size chart") || textLower.includes("shirt small") || textLower.includes("shirt big") || textLower.includes("wrong size") || textLower.includes("size poda") || textLower.includes("size guide")) {
        return { replyText: "📌 Size Guide bro:\n\nS - 38 chest\nM - 40 chest\nL - 42 chest\nXL - 44 chest\n\nDoubt irundha order ID anuppunga, exchange arrange panrom! 😊", sendImages: [] };
    }
    if (textLower.includes("return") || textLower.includes("exchange") || textLower.includes("refund") || textLower.includes("replace") || textLower.includes("maatunga")) {
        return { replyText: "✅ 7 days Return / Exchange available bro.\n\nOrder ID + product photo anuppunga.", sendImages: [] };
    }
    if (textLower.includes("damage") || textLower.includes("torn") || textLower.includes("wrong colour") || textLower.includes("vera colour") || textLower.includes("wrong color") || textLower.includes("wrong product") || textLower.includes("defect")) {
        return { replyText: "📸 Product photo + Order ID anuppunga bro.\n\nCheck pannitu exchange arrange panrom. 😊", sendImages: [] };
    }
    if (textLower.includes("cod iruka") || textLower.includes("cash on delivery") || textLower.includes("cod available") || textLower === "cod") {
        return { replyText: "Sorry bro 😊 COD available illa.\nGPay / UPI mattum available.", sendImages: [] };
    }
    if (textLower === "gpay" || textLower.includes("gpay pannalama") || textLower.includes("upi address") || textLower.includes("google pay") || textLower.includes("payment details") || textLower.includes("pay panna") || textLower.includes("payment eppo") || textLower.includes("upi id") || textLower.includes("gpay number")) {
        return {
            replyText: "💳 Payment details bro:\n\nGPay / UPI: yourupi@okaxis\n\nPayment pannitu screenshot anuppunga 😊",
            sendImages: []
        };
    }
    if (textLower.includes("online pay") || textLower.includes("prepaid") || textLower.includes("netbanking") || textLower.includes("card")) {
        return { replyText: "💳 GPay / PhonePe / UPI available bro!\n\nUPI: yourupi@okaxis", sendImages: [] };
    }
    if (textLower.includes("discount") || textLower.includes("offer") || textLower.includes("sale") || textLower.includes("coupon") || textLower.includes("rate kam") || textLower.includes("cheap") || textLower.includes("kammiya")) {
        return { replyText: "Sorry bro 😊 Fixed price taan. Already best price la iruku! 🔥", sendImages: [] };
    }
    if (textLower.includes("bulk") || textLower.includes("wholesale") || textLower.includes("minimum order") || textLower.includes("lots")) {
        return { replyText: "Bulk order venumna directly call pannunga bro! 📞 Owner contact pannuvanga.", sendImages: [] };
    }
    if (textLower.includes("vere color") || textLower.includes("vera colour") || textLower.includes("other color") || textLower.includes("different color") || textLower.includes("color available") || textLower.includes("colour iruka")) {
        return { replyText: "Enna category venumnu sollunga bro 😊 Available colors list kaaturen!", sendImages: [] };
    }
    if (textLower.includes("quality") || textLower.includes("fabric") || textLower.includes("material") || textLower.includes("genuine") || textLower.includes("original")) {
        return { replyText: "💪 100% quality product bro! Super Collections - premium quality guaranteed 😊", sendImages: [] };
    }
    if (textLower.includes("shop address") || textLower.includes("store address") || textLower.includes("shop enga") || textLower.includes("location") || textLower.includes("contact number") || textLower.includes("phone number kodu")) {
        return { replyText: "🏪 Super Collections\n\nOnline orders mattum bro. WhatsApp la order pannunga! 😊", sendImages: [] };
    }

    // NOT INTERESTED
    const notInterestedKeywords = ["no bro", "ethum venam", "vendam", "later", "paravala"];
    if (notInterestedKeywords.some(kw => textLower.includes(kw))) {
        session.cart = [];
        session.state = "AWAITING_CATEGORY";
        session.pendingProduct = null;
        session.selectedSize = null;
        return {
            replyText: "🙏 Thanks bro.\n\nFuture la dress venumna anytime message pannunga.\n\nSuper Collections support pannathuku thanks 😊",
            sendImages: []
        };
    }

    // GREETING ("hi", "hello", etc.)
    if (isGreeting) {
        session.state = "AWAITING_CATEGORY";
        const categoryCounts = getCategoryCounts(products);
        const parents = getSortedParents(categoryCounts);
        session.parentCategories = parents;

        let replyText = "Welcome to Super Collections bro 😊\n\nEnna category venum?\n\n";
        parents.forEach((cat, idx) => {
            const emoji = getCategoryEmoji(cat);
            replyText += `${idx + 1}️⃣ ${emoji} ${cat} (${categoryCounts[cat]})\n`;
        });
        replyText += "\nNumber mattum reply pannunga bro 😊";

        return { replyText, sendImages: [], listContext: { type: 'categories', data: parents } };
    }

    // CHECKOUT INITIATION
    if (isCheckoutTrigger) {
        return startCheckout(session);
    }

    // NATURAL CATEGORY / PRODUCT SEARCH
    if (isCategorySearch) {
        let matched = products.filter(p => Number(p.stock) > 0);

        // Parse price threshold
        let maxPrice = null;
        const underMatch = textLower.match(/(?:under|below|less than)\s*₹?\s*(\d+)/);
        if (underMatch) {
            maxPrice = parseInt(underMatch[1], 10);
        }

        // Clean query text
        let queryClean = textLower.replace(/(?:under|below|less than)\s*₹?\s*\d+/, '').trim();
        const keywords = queryClean.split(/\s+/).filter(word => word.length > 0 && word !== "bro" && word !== "anna");

        // Filter active products
        matched = matched.filter(p => {
            if (maxPrice && p.price) {
                const parsedPrice = parseFloat(p.price.replace(/[^\d.]/g, ''));
                if (isNaN(parsedPrice) || parsedPrice > maxPrice) return false;
            }
            if (keywords.length > 0) {
                return keywords.every(kw => {
                    return (
                        p.name?.toLowerCase().includes(kw) ||
                        p.category?.toLowerCase().includes(kw) ||
                        (p.color && p.color.toLowerCase().includes(kw)) ||
                        (p.pattern && p.pattern.toLowerCase().includes(kw))
                    );
                });
            }
            return true;
        });

        if (matched.length > 0) {
            let replyText = `🔍 *Search Results:* (Stock available)\n\n`;
            
            const displayProducts = matched.slice(0, 10);
            displayProducts.forEach((p, idx) => {
                let displayName = p.name;
                if (p.color && !displayName.toLowerCase().includes(p.color.toLowerCase())) {
                    displayName = `${p.color} ${displayName}`;
                }
                replyText += `*${idx + 1}.* ${displayName}\n`;
                replyText += `   💰 ₹${p.price}  |  📦 Stock: ${p.stock}\n\n`;
            });
            replyText += `👆 number mattum reply pannunga bro! 😊`;
            
            session.searchProducts = displayProducts;
            session.state = "AWAITING_MODEL_SELECTION";
            
            return { replyText, sendImages: [], searchProducts: displayProducts, listContext: { type: 'products', data: displayProducts } };
        } else {
            return { replyText: "Sorry bro, search matching products ippo stock illa. 😔", sendImages: [] };
        }
    }

    // STATE: AWAITING_CATEGORY (expects a category number)
    if (session.state === "AWAITING_CATEGORY" && isNumber && session.parentCategories?.length > 0) {
        const idx = parseInt(textLower, 10) - 1;
        if (idx >= 0 && idx < session.parentCategories.length) {
            const selectedParent = session.parentCategories[idx];
            
            const subcategoryCounts = {};
            products.forEach(p => {
                if (Number(p.stock) > 0 && getParentCategory(p.category) === selectedParent) {
                    const sub = p.category || 'General';
                    subcategoryCounts[sub] = (subcategoryCounts[sub] || 0) + 1;
                }
            });

            const subs = Object.keys(subcategoryCounts).filter(sub => subcategoryCounts[sub] > 0);
            subs.sort((a, b) => a.localeCompare(b));

            session.subCategories = subs;
            session.selectedParentCategory = selectedParent;
            session.state = "AWAITING_SUBCATEGORY_SELECTION";

            let replyText = `*${selectedParent}:*\n\n`;
            subs.forEach((sub, sIdx) => {
                const capSub = sub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                replyText += `${sIdx + 1}️⃣ ${capSub} (${subcategoryCounts[sub]})\n`;
            });
            replyText += "\nNumber mattum reply pannunga bro! 😊";

            return { replyText, sendImages: [], listContext: { type: 'subcategories', data: subs, selectedParentCategory: selectedParent } };
        } else {
            const max = session.parentCategories.length;
            return {
                replyText: `⚠️ Wrong choice bro! 1-larunthu ${max} varaikum iruka category number-a mattum choose pannunga. 😊`,
                sendImages: []
            };
        }
    }

    // SMART FALLBACKS & GENERAL FALLBACKS
    if (session.state === "AWAITING_CHECKOUT_DETAILS") {
        return {
            replyText: `📝 Order details anuppunga bro:\n\n*Name, Phone, Address*\n\nExample:\nRavi, 9876543210, 12 Anna Nagar Chennai`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_MODEL_SELECTION") {
        return {
            replyText: `⚠️ Format correct ah choose pannunga bro! List-la iruka number (1, 2, 3...) mattum reply pannunga. 😊`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_SUBCATEGORY_SELECTION") {
        return {
            replyText: `⚠️ Format correct ah choose pannunga bro! List-la iruka number (1, 2, 3...) mattum reply pannunga. 😊`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_SIZE_SELECTION") {
        const sizeList = session.pendingProduct?.sizes
            ? (Array.isArray(session.pendingProduct.sizes) ? session.pendingProduct.sizes.join(', ') : session.pendingProduct.sizes)
            : 'S, M, L, XL';
        return {
            replyText: `Size sollunga bro 😊 Available: ${sizeList}`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CART_CONFIRM") {
        return {
            replyText: `⚠️ Invalid response bro! YES or NO reply pannunga. 😊`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_MORE_ITEMS") {
        return {
            replyText: `⚠️ Invalid response bro! YES or NO reply pannunga. 😊`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CATEGORY") {
        return {
            replyText: `⚠️ Format correct ah choose pannunga bro! List-la iruka category number (1, 2, 3...) mattum reply pannunga. 😊`,
            sendImages: []
        };
    }

    // Dynamic general fallback
    const categoryCounts = getCategoryCounts(products);
    const parents = getSortedParents(categoryCounts);
    session.parentCategories = parents;
    session.state = "AWAITING_CATEGORY";

    let menuList = "";
    parents.forEach((cat, idx) => {
        const emoji = getCategoryEmoji(cat);
        menuList += `• ${emoji} ${cat} (${categoryCounts[cat]})\n`;
    });

    return {
        replyText: `😊 Enna help venumnu sollunga bro!\n\nDress thedureenga?\n\n${menuList}\nOr delivery / payment / return pathi kelvi irundha kelunga!`,
        sendImages: [],
        listContext: { type: 'categories', data: parents }
    };
}

// =============================
// Core Message Handler (async — uses await for all DB calls)
// =============================

async function handleMessage(msg) {
    const text = msg.text?.body?.trim() || msg.interactive?.button_reply?.id?.trim() || '';
    const from = msg.from;

    console.log(`[handleMessage] from=${from} | text="${text}"`);

    if (!text) {
        console.log('[handleMessage] ⚠️ Empty text — ignoring.');
        return;
    }

    const logText = msg.text?.body?.trim() || msg.interactive?.button_reply?.title?.trim() || msg.interactive?.button_reply?.id?.trim() || '';
    await logChatMessage(from, 'customer', logText, 'text', null, msg.id);

    // Check if bot is paused
    const chats = await getChats();
    if (chats[from]?.botPaused) {
        console.log(`[handleMessage] Bot is PAUSED for ${from}. Skipping auto-reply.`);
        return;
    }

    console.log(`[handleMessage] Bot active for ${from} — processing...`);

    try {
        const products = await getProducts();
        const orders = await getOrders();
        console.log(`[handleMessage] Loaded ${products.length} products, ${orders.length} orders from Supabase.`);

        // Admin Commands
        if (text.toUpperCase().startsWith('ADMIN')) {
            const parts = text.toUpperCase().split(' ');
            const cmd = parts[1];

            if (cmd === 'ORDERS') {
                const activeOrders = orders.filter(o => o.status !== 'delivered' && o.status !== 'cancelled').slice(-10);
                if (activeOrders.length === 0) {
                    return await sendText(from, "No active orders found.");
                }
                let reply = `📋 *Recent Orders:*\n\n`;
                activeOrders.forEach(o => {
                    reply += `🆔 ${o.id || o.orderId}\n👤 ${o.customer || o.customerName || o.customerDetails}\n🛍️ ${o.items ? o.items.map(item => item.product).join(', ') : (o.product || o.shirtName)} (x${o.quantity || 1})\n📦 Status: ${o.status}\n\n`;
                });
                return await sendText(from, reply);
            }

            if (cmd === 'DELIVER' && parts[2]) {
                const id = parts[2];
                const order = orders.find(o => o.id === id || o.orderId === id);
                if (order) {
                    // Update status directly in Supabase
                    const { error } = await supabase.from('orders').update({ status: 'delivered' }).eq('id', id);
                    if (error) console.error('❌ Error updating order status:', error.message);
                    return await sendText(from, `✅ Order ${id} marked as delivered!`);
                }
                return await sendText(from, `❌ Order ${id} not found.`);
            }

            if (cmd === 'CANCEL' && parts[2]) {
                const id = parts[2];
                const order = orders.find(o => o.id === id || o.orderId === id);
                if (order && order.status !== 'cancelled') {
                    const { error } = await supabase.from('orders').update({ status: 'cancelled' }).eq('id', id);
                    if (error) console.error('❌ Error cancelling order:', error.message);

                    // Restore stock for each item
                    if (order.items && order.items.length > 0) {
                        for (const item of order.items) {
                            const product = products.find(p => String(p.id) === String(item.productId) || p.code === item.productId);
                            if (product) {
                                await supabase.from('products').update({ stock: String(Number(product.stock) + 1) }).eq('id', product.id);
                            }
                        }
                    }
                    return await sendText(from, `🚫 Order ${id} cancelled. Stock restored.`);
                }
                return await sendText(from, `❌ Order ${id} not found or already cancelled.`);
            }
            return;
        }

        const session = await getSession(from);

        // Recover state context if replying to a listed menu message
        const quotedMsgId = msg.context?.id;
        if (quotedMsgId && session.msgContext?.[quotedMsgId]) {
            const context = session.msgContext[quotedMsgId];
            console.log(`[handleMessage] Recovered context from quoted message ${quotedMsgId}:`, context);
            if (context.type === 'categories') {
                session.state = "AWAITING_CATEGORY";
                session.parentCategories = context.data;
            } else if (context.type === 'subcategories') {
                session.state = "AWAITING_SUBCATEGORY_SELECTION";
                session.subCategories = context.data;
                session.selectedParentCategory = context.selectedParentCategory;
            } else if (context.type === 'products') {
                session.state = "AWAITING_MODEL_SELECTION";
                session.searchProducts = context.data;
                session.selectedSubCategory = context.selectedSubCategory;
                session.selectedParentCategory = context.selectedParentCategory;
            } else if (context.type === 'recommendation_choice') {
                session.state = "AWAITING_RECOMMENDATION_CHOICE";
                session.pendingProduct = context.pendingProduct;
                session.originalProductId = context.originalProductId;
                session.recommendedIds = context.recommendedIds;
                session.isRecommendation = true;
            }
        }

        const aiResponse = handleSalesAssistantJS(from, text, products, session);

        // Handle human handoff if requested
        if (aiResponse.isHumanHandoff) {
            const { error: pauseError } = await supabase
                .from('chats')
                .update({ bot_paused: true })
                .eq('customer_phone', from);
            if (pauseError) {
                console.log(`❌ Error pausing bot for human handoff: ${pauseError.message}`);
            }
        }

        // Execute session side effects
        if (aiResponse.cart) session.cart = aiResponse.cart;
        if (aiResponse.selectedColor !== undefined) session.selectedColor = aiResponse.selectedColor;
        if (aiResponse.selectedSize !== undefined) session.selectedSize = aiResponse.selectedSize;
        if (aiResponse.searchProducts !== undefined) session.searchProducts = aiResponse.searchProducts;
        if (aiResponse.lastRecommendation !== undefined) session.lastRecommendation = aiResponse.lastRecommendation;
        if (aiResponse.awaitingRecommendationResponse !== undefined) session.awaitingRecommendationResponse = aiResponse.awaitingRecommendationResponse;
        if (aiResponse.awaitingCartAdditionConfirmation !== undefined) session.awaitingCartAdditionConfirmation = aiResponse.awaitingCartAdditionConfirmation;
        if (aiResponse.pendingProduct !== undefined) session.pendingProduct = aiResponse.pendingProduct;

        // Save session details to Supabase
        await saveSession(from, session);

        // Order Confirmed — save to Supabase + update stock
        if (aiResponse.isOrderConfirmed && aiResponse.orderDetails) {
            const orderId = 'ORD-' + Date.now();
            const orderDate = new Date();
            const dateStr = orderDate.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const timeStr = orderDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

            const cartItems = session.cart;
            const totalPrice = cartItems.reduce((sum, item) => sum + Number(item.price), 0);

            const newOrder = {
                id: orderId,
                customer_phone: from,
                customer_name: aiResponse.orderDetails.customerName || '',
                customer_address: aiResponse.orderDetails.customerAddress || '',
                items: cartItems.map(item => ({
                    productId: item.id || item.productId,
                    product: item.name,
                    color: item.color || '',
                    size: item.size || 'N/A',
                    price: item.price
                })),
                total_price: totalPrice,
                status: 'confirmed',
                date: orderDate.toISOString()
            };

            const { error: insertError } = await supabase.from('orders').insert([newOrder]);
            if (insertError) console.error('❌ Error inserting order:', insertError.message);

            // Decrement stock
            for (const item of cartItems) {
                const product = products.find(p => String(p.id) === String(item.id) || p.code === item.code);
                if (product) {
                    const newStock = Math.max(0, Number(product.stock) - 1);
                    await supabase.from('products').update({ stock: String(newStock) }).eq('id', product.id);
                }
            }

            // Build & send bill
            const divider = '──────────────────────';
            let bill = `${divider}\n`;
            bill += `🏪 *SUPER COLLECTIONS*\n`;
            bill += `${divider}\n`;
            bill += `🧾 *INVOICE / BILL*\n\n`;
            bill += `📋 *Order ID:* ${orderId}\n`;
            bill += `📅 *Date:* ${dateStr}  ${timeStr}\n`;
            bill += `${divider}\n`;
            bill += `👤 *Customer Details:*\n`;
            bill += `Name    : ${aiResponse.orderDetails.customerName}\n`;
            bill += `Phone   : ${aiResponse.orderDetails.customerPhone || from}\n`;
            bill += `Address : ${aiResponse.orderDetails.customerAddress}\n`;
            bill += `${divider}\n`;
            bill += `🛒 *Items Ordered:*\n\n`;
            cartItems.forEach((item, i) => {
                const colorPrefix = item.color ? `${item.color} ` : '';
                bill += `${i + 1}. ${colorPrefix}${item.name}\n`;
                bill += `   Size: ${item.size}  |  ₹${item.price}\n`;
            });
            bill += `${divider}\n`;
            bill += `💰 *Total: ₹${totalPrice}*\n`;
            bill += `${divider}\n`;
            bill += `💳 *Payment:* GPay / UPI\n`;
            bill += `📲 yourupi@okaxis\n\n`;
            bill += `📨 Payment screenshot anuppunga bro\n`;
            bill += `Owner shortly contact pannuvanga! 😊\n`;
            bill += `${divider}\n`;
            bill += `🙏 Thanks for shopping at\n`;
            bill += `*Super Collections!* ❤️`;

            await deleteSession(from);
            await sendText(from, bill);
            await logChatMessage(from, 'bot', bill);
            return;
        }

        // Send messages to user
        if (Array.isArray(aiResponse.sendImages)) {
            for (const img of aiResponse.sendImages) {
                if (img.url && img.url.startsWith('http')) {
                    await sendImage(from, img.url, img.caption || '');
                    await logChatMessage(from, 'bot', img.caption || '', 'image', img.url);
                }
            }
        }
        let sentMsgId = null;
        if (aiResponse.replyText) {
            const apiRes = await sendText(from, aiResponse.replyText);
            sentMsgId = apiRes?.messages?.[0]?.id;
            await logChatMessage(from, 'bot', aiResponse.replyText, 'text', null, sentMsgId);
        }

        // Store the context for this message
        if (sentMsgId && aiResponse.listContext) {
            session.msgContext = session.msgContext || {};
            session.msgContext[sentMsgId] = aiResponse.listContext;
            
            // Limit mapping size
            const keys = Object.keys(session.msgContext);
            if (keys.length > 20) {
                delete session.msgContext[keys[0]];
            }
            await saveSession(from, session);
        }
        if (aiResponse.sendButtons) {
            await sendButtons(from, aiResponse.sendButtons.body, aiResponse.sendButtons.buttons);
            let buttonMsg = aiResponse.sendButtons.body;
            if (aiResponse.sendButtons.buttons) {
                buttonMsg += '\n' + aiResponse.sendButtons.buttons.map(b => `[${b.title}]`).join(' ');
            }
            await logChatMessage(from, 'bot', buttonMsg);
        }

    } catch (err) {
        console.error('❌ Error handling message:', err);
        await sendText(from, "⚠️ Sorry, chinna error. Aprama try pannunga.");
    }
}

// =============================
// Webhook GET — Meta Verification
// =============================

export const verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log(`[WEBHOOK-VERIFY] mode="${mode}" | token="${token}" | expected="${VERIFY_TOKEN}"`);

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('[WEBHOOK-VERIFY] ✅ Verified! Sending challenge back to Meta.');
        return res.status(200).send(challenge);
    }

    console.log('[WEBHOOK-VERIFY] ❌ Verification failed — token mismatch or wrong mode.');
    return res.sendStatus(403);
};

// =============================
// Webhook POST — Incoming Messages
// =============================

export const receiveWebhook = async (req, res) => {
    try {
        const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg) {
            return res.sendStatus(200);
        }

        console.log(`[USER -> BOT] Message ID: ${msg.id}, Text: "${msg.text?.body}"`);

        if (processed.has(msg.id)) {
            console.log(`[USER -> BOT] Duplicate message ID ignored (in-memory): ${msg.id}`);
            return res.sendStatus(200);
        }
        processed.add(msg.id);

        // Database-backed deduplication (for multi-instance serverless concurrency)
        try {
            const { data: chatRow, error: dbErr } = await supabase
                .from('chats')
                .select('messages')
                .eq('customer_phone', msg.from)
                .maybeSingle();

            if (!dbErr && chatRow && Array.isArray(chatRow.messages)) {
                if (chatRow.messages.some(m => m.messageId === msg.id)) {
                    console.log(`[USER -> BOT] Duplicate message ID ignored (DB check): ${msg.id}`);
                    return res.sendStatus(200);
                }
            }
        } catch (dbErr) {
            console.error('❌ Database deduplication check failed:', dbErr.message);
        }

        await handleMessage(msg);
        res.sendStatus(200);
    } catch (err) {
        console.error('❌ Webhook Processing Error:', err.message);
        res.sendStatus(200); // Still respond 200 to prevent Meta from retrying
    }
};

// =============================
// Legacy combined handler (kept for backward compatibility)
// =============================

export const handleWhatsAppWebhook = async (req, res) => {
    if (req.method === 'GET') return verifyWebhook(req, res);
    return receiveWebhook(req, res);
};
