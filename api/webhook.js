// api/webhook.js  — Supabase version (replaces fs-based implementation)
import axios from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import { createProductCollage, createRecommendationCollage, createPromoCollage } from '../lib/collage.js';
import { getCategoryUrl } from '../lib/categoryUrls.js';

dotenv.config();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_ID || process.env.PHONE_NUMBER_ID;

// AI message classifier (replaces keyword/substring intent matching for free-text browsing —
// see runAIClassifierRoute below). Gated behind USE_AI_CLASSIFIER so it can be toggled via Vercel
// env without a redeploy; the old keyword logic in detectIntent/handleIntent and the legacy
// fallthrough block in _handleSalesAssistantJS is left completely intact for instant rollback.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const USE_AI_CLASSIFIER = process.env.USE_AI_CLASSIFIER === 'true';

// ✅ Startup diagnostic — visible in Vercel logs immediately on cold start
console.log('[STARTUP] ENV CHECK:');
console.log('  WHATSAPP_TOKEN exists:', !!WHATSAPP_TOKEN);
console.log('  PHONE_NUMBER_ID exists:', !!PHONE_NUMBER_ID);
console.log('  VERIFY_TOKEN exists:', !!VERIFY_TOKEN);
console.log('  SUPABASE_URL exists:', !!process.env.SUPABASE_URL);
console.log('  ANTHROPIC_API_KEY exists:', !!ANTHROPIC_API_KEY);
console.log('  USE_AI_CLASSIFIER enabled:', USE_AI_CLASSIFIER);

const processed = new Set();
export const userSessions = {}; // In-memory per-user conversation state

// =============================
// Database Helpers  (all async — Supabase)
// =============================

export async function getWelcomeMessagePrefix() {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'welcome_message')
            .single();
        if (data && data.value && data.value.trim()) {
            return data.value.trim() + "\n\n";
        }
    } catch (err) {
        console.error("Failed to load welcome message from database:", err);
    }
    return "";
}

const ORDER_GUIDANCE_VIDEO_ENABLED = false;

// Top-level welcome menu shown on every greeting — 6 product categories + 3 utility options.
// Numbers 1-6 map 1:1 with CATEGORY_LINKS below; 7/8 route to the existing ORDER_HELP /
// CUSTOMER_SUPPORT intents (see handleIntent's MAIN_MENU_SELECT case) instead of new logic.
const MAIN_MENU_TEXT = `👋 Welcome to Super Collection!
We offer premium shirts, t-shirts, pants & more with FREE Shipping 🚚

Please reply with a number:

1️⃣ Shirts
2️⃣ T-Shirts
3️⃣ Pants
4️⃣ Track Pants
5️⃣ Imported Shorts
6️⃣ New Arrivals

7️⃣ Order Status
8️⃣ Talk to Support
9️⃣ Size Guide`;

// Sent when the customer replies "9" (9️⃣ Size Guide) to the main menu.
const SIZE_GUIDE_TEXT = `📏 Size Guide (in inches)

\`\`\`
Size  Chest  Length
S     38     28
M     40     29
L     42     30
XL    44     31
XXL   46     32
\`\`\`

💡 Tip: Chest measure panna armpit kulla irundhu round ah measure pannunga.
If in-between sizes la irundha, next size eduthukonga.`;

// Verified against the live https://www.supercollections.in/product_cat-sitemap.xml — note the
// T-Shirts parent category's real slug is "t-shirts-2" (not "t-shirts"), a pre-existing slug
// collision on the WooCommerce site, not a typo here.
const CATEGORY_LINKS = {
    "1": { name: "Shirts", label: "shirts", emoji: "👔", url: "https://www.supercollections.in/product-category/shirts/" },
    "2": { name: "T-Shirts", label: "t-shirts", emoji: "👕", url: "https://www.supercollections.in/product-category/t-shirts-2/" },
    "3": { name: "Pants", label: "pants", emoji: "👖", url: "https://www.supercollections.in/product-category/pants/" },
    "4": { name: "Track Pants", label: "track pants", emoji: "🏃", url: "https://www.supercollections.in/product-category/track-pants/" },
    "5": { name: "Imported Shorts", label: "imported shorts", emoji: "🩳", url: "https://www.supercollections.in/product-category/imported-shorts/" },
    "6": { name: "New Arrivals", label: "new arrivals", emoji: "✨", url: "https://www.supercollections.in/product-category/new-arrivals/" }
};
// Simplified 7-item "pick a category" quick menu shown by goToTopCategoryMenu() — replaces the
// old flat list of every WooCommerce subcategory across all parents at once. Mirrors MAIN_MENU_TEXT's
// category set (1-6 + New Arrivals) but adds "Men" as a catch-all 6th slot, since this menu (unlike
// the main welcome menu) has no separate utility options competing for numbers. The index in this
// array (0-based) + 1 must stay in sync with the numbers in TOP_CATEGORY_MENU_TEXT below.
const TOP_CATEGORY_MENU_NAMES = ['Shirts', 'T-Shirts', 'Pants', 'Track Pants', 'Imported Shorts', 'Men', 'New Arrivals'];
const TOP_CATEGORY_MENU_TEXT = `*Select a Category* 📋

1️⃣ Shirts
2️⃣ T-Shirts
3️⃣ Pants
4️⃣ Track Pants
5️⃣ Imported Shorts
6️⃣ Men
7️⃣ New Arrivals`;

const CUSTOMER_SUPPORT_MESSAGE = "Customer Support\n+91 8668066503\n+91 7418755096";
const ORDER_GUIDANCE_VIDEO_FALLBACK = "Order Guidance Video\nhttps://drive.google.com/file/d/1wXwDqhYUpB_uv6v38kl9Gdh6mX2fTykG/view?usp=drivesdk";

export async function getProducts() {
    try {
        // 'id' is a tiebreaker: rows sharing the same created_at (common with bulk imports)
        // otherwise have no guaranteed order between queries, which let the product array
        // order drift between requests and desync collage images (see prepareProductsPageResponse).
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('created_at', { ascending: true })
            .order('id', { ascending: true });

        if (error) throw error;

        return (data || []).map(row => {
            const cat = row.category || 'General';
            const allCats = Array.isArray(row.categories) && row.categories.length > 0
                ? row.categories
                : [cat];

            return {
                id: row.id,
                name: row.name,
                code: row.code,
                category: cat,
                categories: allCats,
                pattern: row.pattern,
                color: row.color,
                price: row.price,
                stock: row.stock,
                sizes: row.sizes || [],
                imageUri: row.image_uri,
                permalink: row.permalink || null
            };
        });
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

// Look up a single order by its id (or legacy order_id column) for WhatsApp order tracking replies
async function getOrderById(orderId) {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .or(`id.eq.${orderId},order_id.eq.${orderId}`)
            .limit(1);

        if (error) throw error;
        if (data && data.length > 0) return dbRowToOrder(data[0]);
        return null;
    } catch (error) {
        console.error('❌ Error looking up order by id:', error.message);
        return null;
    }
}

// =============================
// Chats Database Helpers  (async — Supabase)
// =============================

// Used for the chat list (dashboard sidebar) and the bot's per-message botPaused check —
// neither needs the (potentially large) `messages` JSONB blob, so it's left out of the
// select entirely rather than fetched and discarded. session_<phone> rows (bot session
// state, stored in this same table — see getSession/saveSession below) are filtered out
// at the query level with `.not(...)` instead of in JS after fetching every row.
// startDate/endDate (ISO timestamps, inclusive) optionally scope the result to chats whose
// last_updated falls in that range — used for the dashboard's "Active Chats" stat so it can
// reflect the selected date filter without the chats inbox itself losing access to older
// conversations (callers that need the full list just omit the args, as before).
// requireInboundMessage, when true, excludes rows whose `messages` array has no entry from
// the customer — e.g. a WooCommerce order-confirmation notification sent to someone who
// never actually messaged the bot. Uses a jsonb containment filter (`messages @> [{sender:
// "customer"}]`) so the (potentially large) messages blob still doesn't need to be selected
// or scanned in JS just to decide membership.
export async function getChats(startDate, endDate, requireInboundMessage = false) {
    try {
        let query = supabase
            .from('chats')
            .select('customer_phone, customer_name, last_message, last_updated, bot_paused')
            .not('customer_phone', 'like', 'session_%');

        if (startDate) query = query.gte('last_updated', startDate);
        if (endDate) query = query.lte('last_updated', endDate);
        // .contains() mis-serializes a jsonb array-of-objects value (sends it in postgres
        // array literal syntax instead of JSON, which Postgres then rejects with 22P02) —
        // .filter(..., 'cs', JSON.stringify(...)) sends the same `cs` containment operator
        // but with a proper JSON-encoded operand, which Postgres accepts.
        if (requireInboundMessage) query = query.filter('messages', 'cs', JSON.stringify([{ sender: 'customer' }]));

        const { data, error } = await query;

        if (error) throw error;

        // Return as an object keyed by customerPhone (same shape as the old chats.json)
        const chatsObj = {};
        for (const row of (data || [])) {
            chatsObj[row.customer_phone] = {
                customerPhone: row.customer_phone,
                customerName: row.customer_name,
                lastMessage: row.last_message,
                lastUpdated: row.last_updated,
                botPaused: row.bot_paused
            };
        }
        return chatsObj;
    } catch (error) {
        console.error('❌ Error reading chats:', error.message);
        return {};
    }
}

// Phone-filtered single-row lookup for one chat's full record (including its message
// history) — used by the chat detail view, which previously called getChats() and pulled
// every customer's full chat row just to pick one out of the resulting object.
export async function getChatByPhone(phone) {
    try {
        const { data, error } = await supabase
            .from('chats')
            .select('*')
            .eq('customer_phone', phone)
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;

        return {
            customerPhone: data.customer_phone,
            customerName: data.customer_name,
            lastMessage: data.last_message,
            lastUpdated: data.last_updated,
            botPaused: data.bot_paused,
            messages: data.messages || []
        };
    } catch (error) {
        console.error(`❌ Error reading chat for ${phone}:`, error.message);
        return null;
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
        state: "AWAITING_SUBCATEGORY_SELECTION",
        cart: [],
        history: [],
        searchProducts: [],
        selectedColor: null,
        selectedSize: null,
        lastRecommendation: null,
        awaitingRecommendationResponse: false,
        awaitingCartAdditionConfirmation: false,
        pendingProduct: null,
        orderingQueue: [],
        pendingSelections: {},
        pendingOrder: [],
        fromCrossSell: false,
        crossSellShown: false,
        cartCrossSellShown: false
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

// =============================
// Per-customer session lock
// =============================
// getSession/saveSession do a plain read-then-write of the whole session blob,
// which races when two webhook POSTs for the same customer overlap (e.g. two
// quick messages). acquireSessionLock claims the row with a single conditional
// UPDATE — Postgres serializes concurrent UPDATEs on the same row, so only one
// caller's WHERE clause can match at a time, making the claim atomic without a
// separate lock manager. A TTL lets a lock left behind by a crashed/timed-out
// invocation be reclaimed instead of permanently wedging that customer.
const SESSION_LOCK_TTL_MS = 15000;
const SESSION_LOCK_RETRY_DELAY_MS = 1500;
const SESSION_LOCK_MAX_RETRIES = 5;

async function acquireSessionLock(phone) {
    const key = `session_${phone}`;
    const nowIso = new Date().toISOString();
    const staleIso = new Date(Date.now() - SESSION_LOCK_TTL_MS).toISOString();

    try {
        // Make sure the row exists before attempting the conditional claim below.
        // ignoreDuplicates means this is a no-op (does not touch locked_at) if the row is already there.
        await supabase
            .from('chats')
            .upsert(
                { customer_phone: key, customer_name: 'Session State' },
                { onConflict: 'customer_phone', ignoreDuplicates: true }
            );

        const { data, error } = await supabase
            .from('chats')
            .update({ locked_at: nowIso })
            .eq('customer_phone', key)
            .or(`locked_at.is.null,locked_at.lt.${staleIso}`)
            .select('customer_phone');

        if (error) throw error;
        return Array.isArray(data) && data.length > 0;
    } catch (err) {
        console.error(`❌ Error acquiring session lock for ${phone}:`, err.message);
        return false;
    }
}

async function releaseSessionLock(phone) {
    try {
        const { error } = await supabase
            .from('chats')
            .update({ locked_at: null })
            .eq('customer_phone', `session_${phone}`);
        if (error) throw error;
    } catch (err) {
        console.error(`❌ Error releasing session lock for ${phone}:`, err.message);
    }
}

// Waits for another in-flight request for this customer to finish. Returns true if
// the lock was acquired (caller must release it); false if it gave up after retrying
// and is proceeding unlocked (fail-open, so a stuck/crashed lock can't drop messages forever).
async function waitForSessionLock(phone) {
    for (let attempt = 0; attempt < SESSION_LOCK_MAX_RETRIES; attempt++) {
        if (await acquireSessionLock(phone)) return true;
        console.log(`[Lock] Session for ${phone} busy, retrying (${attempt + 1}/${SESSION_LOCK_MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, SESSION_LOCK_RETRY_DELAY_MS));
    }
    console.warn(`[Lock] Could not acquire session lock for ${phone} after ${SESSION_LOCK_MAX_RETRIES} retries — proceeding without lock.`);
    return false;
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

        // Append message to history (no truncation to preserve complete chat history)
        const messages = Array.isArray(existing.messages) ? existing.messages : [];
        messages.push({
            sender,
            type,
            text,
            imageUrl,
            messageId,
            timestamp: new Date().toISOString()
        });

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
        return response.data;
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

async function sendList(to, bodyText, buttonText, sections, headerText = null, footerText = null) {
    const finalSections = sections ? JSON.parse(JSON.stringify(sections)) : [];
    const interactive = {
        type: 'list',
        body: { text: bodyText },
        action: {
            button: buttonText,
            sections: finalSections
        }
    };
    if (headerText) {
        interactive.header = { type: 'text', text: headerText };
    }
    if (footerText) {
        interactive.footer = { text: footerText };
    }
    return await sendRequest({
        to,
        type: 'interactive',
        interactive
    });
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

// Rich welcome card (logo + contact info + "Visit Website" CTA button) sent on greeting.
// Throws on failure so the caller can fall back to the plain text welcome message.
export async function sendCtaUrlWelcomeMessage(to) {
    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'cta_url',
            header: {
                type: 'image',
                image: { link: process.env.STORE_LOGO_URL }
            },
            body: {
                text: "Hi 👋 Welcome to *Super Collections*!\n\n📞 WhatsApp: +91 8668066503 / +91 7418755096\n🌐 supercollections.in"
            },
            footer: {
                text: "127 Srinivasa Street, Udumalpet - 642126"
            },
            action: {
                name: 'cta_url',
                parameters: {
                    display_text: 'Visit Website',
                    url: 'http://supercollections.in'
                }
            }
        }
    };

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error(`Environment variables missing! WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'exists' : 'missing'}, PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? 'exists' : 'missing'}`);
    }

    console.log(`[sendCtaUrlWelcomeMessage] Payload being sent:`, JSON.stringify(payload, null, 2));

    const response = await axios.post(url, payload, {
        headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(`[sendCtaUrlWelcomeMessage] Meta API response:`, JSON.stringify(response.data, null, 2));
    return response.data;
}

// Generic cta_url card used to send a customer to a subcategory's page on supercollections.in
// (see prepareProductsPageResponse's ctaOptions branch). Throws on failure so the caller can log
// it instead of silently dropping the message.
export async function sendCtaUrlMessage(to, bodyText, displayText, url) {
    const apiUrl = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'cta_url',
            body: { text: bodyText },
            action: {
                name: 'cta_url',
                parameters: {
                    display_text: displayText,
                    url
                }
            }
        }
    };

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error(`Environment variables missing! WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'exists' : 'missing'}, PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? 'exists' : 'missing'}`);
    }

    console.log(`[sendCtaUrlMessage] Payload being sent:`, JSON.stringify(payload, null, 2));

    const response = await axios.post(apiUrl, payload, {
        headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(`[sendCtaUrlMessage] Meta API response:`, JSON.stringify(response.data, null, 2));
    return response.data;
}

// Hosts we'll fetch on the store's behalf for /api/image-proxy — keeps the proxy from being an
// open relay for arbitrary URLs.
const PROXY_ALLOWED_HOSTS = new Set(['www.supercollections.in', 'supercollections.in']);

// cta_url interactive headers require Meta's own servers to fetch the image by link (passing a
// media id instead gets rejected with "header image must contain link" — error 131008), but
// Meta's fetcher gets a 503 trying to reach supercollections.in directly even though the same URL
// is reachable from here (error 131053). Rewriting the link to point at our own /api/image-proxy
// route sidesteps that: Meta fetches from our already-reachable Vercel domain, and we do the real
// fetch to supercollections.in server-side, where it works.
const getProxiedImageUrl = (rawUrl) => {
    const base = process.env.PUBLIC_BASE_URL ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
    if (!base || !rawUrl) return rawUrl;
    return `${base}/api/image-proxy?url=${encodeURIComponent(rawUrl)}`;
};

// Express handler for GET /api/image-proxy?url=<supercollections.in image URL> — fetches the
// image server-side (where supercollections.in is reachable) and re-serves the bytes, so Meta's
// WhatsApp media fetcher can pull it from our domain instead of failing against the store's host.
export async function handleImageProxy(req, res) {
    const target = req.query?.url;
    if (!target) {
        res.status(400).send('Missing url parameter');
        return;
    }

    let parsed;
    try {
        parsed = new URL(target);
    } catch {
        res.status(400).send('Invalid url parameter');
        return;
    }

    if (!PROXY_ALLOWED_HOSTS.has(parsed.hostname)) {
        res.status(403).send('Host not allowed');
        return;
    }

    try {
        const imageRes = await axios.get(target, { responseType: 'arraybuffer', timeout: 15000 });
        res.set('Content-Type', imageRes.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.from(imageRes.data));
    } catch (err) {
        console.error('[image-proxy] Failed to fetch upstream image:', err.message);
        res.status(502).send('Upstream fetch failed');
    }
}

// Per-product "See More" card used for SEARCH results (see buildProductCardsPageResponse) —
// same cta_url shape as sendCtaUrlMessage but with an image header showing that product's photo.
// imageUrl may be null (no resolvable image for this product); the header is omitted rather than
// sent with a broken link. Throws on failure so the caller can catch/log per-card instead of one
// broken card aborting the rest of the result page.
export async function sendProductCtaCard(to, imageUrl, bodyText, displayText, url) {
    const apiUrl = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    const interactive = {
        type: 'cta_url',
        body: { text: bodyText },
        action: {
            name: 'cta_url',
            parameters: {
                display_text: displayText,
                url
            }
        }
    };
    if (imageUrl) {
        interactive.header = { type: 'image', image: { link: getProxiedImageUrl(imageUrl) } };
    }

    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive
    };

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error(`Environment variables missing! WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'exists' : 'missing'}, PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? 'exists' : 'missing'}`);
    }

    console.log(`[sendProductCtaCard] Sending card -> url=${url} image=${imageUrl || 'none'}`);

    const response = await axios.post(apiUrl, payload, {
        headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(`[sendProductCtaCard] Meta API response:`, JSON.stringify(response.data, null, 2));
    return response.data;
}

// Video guide card (cta_url to Drive video) sent as part of the greeting sequence.
// Throws on failure so the caller can fall back to the plain text welcome message.
export async function sendVideoGuideCard(to) {
    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'cta_url',
            header: {
                type: 'text',
                text: '📹 Need Help Ordering?'
            },
            body: {
                text: 'Having trouble placing an order? Watch our step-by-step video guide.'
            },
            action: {
                name: 'cta_url',
                parameters: {
                    display_text: 'Watch Video',
                    url: 'https://drive.google.com/file/d/1wXwDqhYUpB_uv6v38kl9Gdh6mX2fTykG/view?usp=drivesdk'
                }
            }
        }
    };

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error(`Environment variables missing! WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'exists' : 'missing'}, PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? 'exists' : 'missing'}`);
    }

    console.log(`[sendVideoGuideCard] Payload being sent:`, JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[sendVideoGuideCard] Meta API response:`, JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        console.error(`[sendVideoGuideCard] Meta API error response:`, JSON.stringify(error.response?.data || error.message, null, 2));
        throw error;
    }
}

// Native WhatsApp location message (store pin) sent as part of the greeting sequence.
// Throws on failure so the caller can fall back to the plain text welcome message.
export async function sendLocationCard(to) {
    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'location',
        location: {
            latitude: Number(process.env.STORE_LATITUDE),
            longitude: Number(process.env.STORE_LONGITUDE),
            name: 'Super Collections',
            address: '127 Srinivasa Street, Udumalpet - 642126'
        }
    };

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error(`Environment variables missing! WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'exists' : 'missing'}, PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? 'exists' : 'missing'}`);
    }

    console.log(`[sendLocationCard] Payload being sent:`, JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[sendLocationCard] Meta API response:`, JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        console.error(`[sendLocationCard] Meta API error response:`, JSON.stringify(error.response?.data || error.message, null, 2));
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
        } catch (_) { }

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

async function sendButtons(to, bodyText, buttons, options = {}) {
    const { addCancel = true } = options;
    const finalButtons = buttons ? [...buttons] : [];
    const hasCancel = finalButtons.some(b =>
        b.id === 'cancel_shopping' ||
        b.id.toLowerCase().includes('cancel') ||
        b.title.toLowerCase().includes('cancel') ||
        ['cancel_continue_shopping', 'cancel_exit_shopping', 'cancel_clear_exit', 'cancel_checkout'].includes(b.id)
    );
    if (addCancel && !hasCancel) {
        finalButtons.push({ id: 'cancel_shopping', title: '❌ Cancel' });
    }

    if (finalButtons.length <= 3) {
        return await sendRequest({
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: bodyText },
                action: {
                    buttons: finalButtons.map(b => ({
                        type: 'reply',
                        reply: { id: b.id, title: b.title }
                    }))
                }
            }
        });
    } else {
        // Fallback: convert to list message
        const sections = [
            {
                title: "Options",
                rows: finalButtons.map((b, idx) => ({
                    id: b.id,
                    title: b.title.substring(0, 24),
                    description: `Select option: ${b.title}`
                }))
            }
        ];
        return await sendList(to, bodyText, "Select Option", sections);
    }
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

// Parse product selections from user message
function parseProductSelections(text) {
    if (text.includes('-')) {
        return [];
    }
    const matches = text.match(/\b\d+\b/g);
    if (!matches) return [];
    return [...new Set(matches.map(num => parseInt(num, 10)))];
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

// Strips a trailing "(color)" variant suffix, e.g. "five sleeve t shirt (black)" -> "five sleeve t shirt".
const stripVariantSuffix = (name) => (name || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();

// Helper to retrieve fallback/self-healing image URI if the database row has 'null' or missing image
const getProductImageUri = (product, allProducts = []) => {
    if (product.imageUri && product.imageUri.startsWith('http') && product.imageUri !== 'null' && product.imageUri !== 'undefined') {

        return product.imageUri;
    }

    const prodTag = getProductTag(product);

    // Try to find a duplicate entry with the same name that has a valid WooCommerce image URL
    const backup = allProducts.find(p =>
        p.name === product.name &&
        getProductTag(p) === prodTag &&
        p.imageUri && p.imageUri.startsWith('http') && p.imageUri !== 'null' && p.imageUri !== 'undefined'
    );
    if (backup) return getProductImageUri(backup, allProducts);

    // Same base name ignoring a trailing "(color)" suffix — catches generic/parent rows (e.g. a
    // plain "five sleeve t shirt" row with no image of its own, created by a sync/search gap)
    // that share a name root with color-specific siblings (e.g. "five sleeve t shirt (black)")
    // which do have a valid image.
    const baseName = stripVariantSuffix(product.name);
    if (baseName) {
        const backupBase = allProducts.find(p =>
            p.id !== product.id &&
            stripVariantSuffix(p.name) === baseName &&
            getProductTag(p) === prodTag &&
            p.imageUri && p.imageUri.startsWith('http') && p.imageUri !== 'null' && p.imageUri !== 'undefined'
        );
        if (backupBase) return getProductImageUri(backupBase, allProducts);
    }

    // Fuzzier match: same category and color
    const backup2 = allProducts.find(p =>
        p.category === product.category &&
        p.color === product.color &&
        getProductTag(p) === prodTag &&
        p.imageUri && p.imageUri.startsWith('http') && p.imageUri !== 'null' && p.imageUri !== 'undefined'
    );
    if (backup2) return getProductImageUri(backup2, allProducts);

    // Fuzzier match 2: same tag, shares color keyword
    const hasColor = product.color || (product.name || '').toLowerCase().match(/(?:white|black|red|blue|green|grey|gray|navy|sandal|yellow|pink|orange|purple|violet|cream|lavender|brown|khaki|olive)/)?.[0];
    if (hasColor) {
        const backup3 = allProducts.find(p => {
            if (p.id === product.id) return false;
            if (getProductTag(p) !== prodTag) return false;
            if (!p.imageUri || !p.imageUri.startsWith('http') || p.imageUri === 'null' || p.imageUri === 'undefined') return false;

            const pColor = p.color || (p.name || '').toLowerCase().match(/(?:white|black|red|blue|green|grey|gray|navy|sandal|yellow|pink|orange|purple|violet|cream|lavender|brown|khaki|olive)/)?.[0];
            return pColor === hasColor;
        });
        if (backup3) {
            return getProductImageUri(backup3, allProducts);
        }
    }

    return null;
};

// Recommendation engine linking tags and categories
const COLOR_MATCHES = {
    'white': ['black', 'navy', 'blue', 'grey', 'gray', 'green', 'olive', 'red', 'maroon', 'wine', 'pink', 'purple', 'khaki', 'brown', 'sandal', 'beige', 'cream'],
    'black': ['white', 'grey', 'gray', 'red', 'maroon', 'wine', 'yellow', 'blue', 'sky blue', 'khaki', 'sandal', 'beige', 'cream', 'olive', 'green'],
    'navy': ['white', 'grey', 'gray', 'sandal', 'beige', 'cream', 'khaki', 'yellow', 'pink', 'light pink', 'sky blue', 'red'],
    'blue': ['white', 'black', 'grey', 'gray', 'sandal', 'beige', 'cream', 'khaki'],
    'sky blue': ['white', 'black', 'grey', 'gray', 'navy', 'khaki', 'sandal', 'beige', 'cream', 'dark green'],
    'grey': ['black', 'white', 'navy', 'blue', 'red', 'maroon', 'wine', 'pink', 'olive', 'green', 'khaki', 'sandal', 'beige', 'cream'],
    'gray': ['black', 'white', 'navy', 'blue', 'red', 'maroon', 'wine', 'pink', 'olive', 'green', 'khaki', 'sandal', 'beige', 'cream'],
    'red': ['black', 'white', 'grey', 'gray', 'navy', 'sandal', 'beige', 'cream', 'khaki'],
    'maroon': ['black', 'white', 'grey', 'gray', 'navy', 'sandal', 'beige', 'cream', 'khaki'],
    'wine': ['black', 'white', 'grey', 'gray', 'navy', 'sandal', 'beige', 'cream', 'khaki'],
    'green': ['white', 'black', 'grey', 'gray', 'sandal', 'beige', 'cream', 'khaki', 'navy'],
    'olive': ['white', 'black', 'grey', 'gray', 'sandal', 'beige', 'cream', 'khaki', 'navy'],
    'dark green': ['white', 'black', 'grey', 'gray', 'sandal', 'beige', 'cream', 'khaki'],
    'sandal': ['navy', 'black', 'white', 'grey', 'gray', 'maroon', 'wine', 'red', 'olive', 'green', 'dark green', 'blue'],
    'beige': ['navy', 'black', 'white', 'grey', 'gray', 'maroon', 'wine', 'red', 'olive', 'green', 'dark green', 'blue'],
    'cream': ['navy', 'black', 'white', 'grey', 'gray', 'maroon', 'wine', 'red', 'olive', 'green', 'dark green', 'blue'],
    'khaki': ['navy', 'black', 'white', 'grey', 'gray', 'maroon', 'wine', 'red', 'olive', 'green', 'dark green', 'blue'],
    'yellow': ['black', 'white', 'grey', 'gray', 'navy'],
    'pink': ['navy', 'grey', 'gray', 'black', 'white'],
    'purple': ['black', 'white', 'grey', 'gray', 'navy'],
    'lavender': ['black', 'white', 'grey', 'gray', 'navy'],
    'violet': ['black', 'white', 'grey', 'gray', 'navy'],
    'brown': ['white', 'black', 'grey', 'gray', 'navy', 'sandal', 'beige', 'cream']
};

const DARK_COLORS = ['black', 'navy', 'dark green', 'maroon', 'brown', 'olive', 'charcoal', 'dark grey', 'dark gray', 'dark blue', 'wine'];
const LIGHT_COLORS = ['white', 'cream', 'beige', 'light grey', 'light gray', 'sky blue', 'lavender', 'pink', 'yellow', 'mint', 'peach'];

const isDarkColor = (colorName) => {
    const c = (colorName || '').toLowerCase().trim();
    return DARK_COLORS.some(dc => c.includes(dc));
};

const isLightColor = (colorName) => {
    const c = (colorName || '').toLowerCase().trim();
    return LIGHT_COLORS.some(lc => c.includes(lc));
};

const getRecommendationScore = (addedProduct, candidate, products) => {
    let score = 0;

    const addedTag = getProductTag(addedProduct);
    const candidateTag = getProductTag(candidate);
    const targetTags = getTargetRecommendationTags(addedTag);

    // Style compatibility score
    const targetIdx = targetTags.indexOf(candidateTag);
    if (targetIdx === 0) {
        score += 15;
    } else if (targetIdx > 0) {
        score += 10;
    } else {
        const addedParent = getParentCategory(addedProduct.category);
        const candidateParent = getParentCategory(candidate.category);
        if (
            (addedParent.toLowerCase().includes('shirt') && (candidateParent.toLowerCase().includes('pant') || candidateParent.toLowerCase().includes('jeans') || candidateParent.toLowerCase().includes('shorts'))) ||
            ((addedParent.toLowerCase().includes('pant') || addedParent.toLowerCase().includes('jeans') || addedParent.toLowerCase().includes('shorts')) && candidateParent.toLowerCase().includes('shirt'))
        ) {
            score += 5;
        }
    }

    // Color compatibility score
    const c1 = (addedProduct.color || '').toLowerCase().trim();
    const c2 = (candidate.color || '').toLowerCase().trim();

    if (c1 && c2) {
        if (COLOR_MATCHES[c1] && COLOR_MATCHES[c1].some(c => c2.includes(c) || c.includes(c2))) {
            score += 10;
        } else if (COLOR_MATCHES[c2] && COLOR_MATCHES[c2].some(c => c1.includes(c) || c.includes(c1))) {
            score += 10;
        } else if (['white', 'black', 'grey', 'gray', 'sandal', 'beige', 'cream', 'khaki'].some(c => c1.includes(c) || c2.includes(c))) {
            score += 5;
        } else if (c1 === c2) {
            score += 2;
        }

        // Color contrast bonus: dark added product paired with a light candidate (or vice versa)
        if ((isDarkColor(c1) && isLightColor(c2)) || (isLightColor(c1) && isDarkColor(c2))) {
            score += 20;
        }
    }

    return score;
};

// Picks `pickCount` random items from the top `poolSize` of a score-sorted list, so repeat
// visits don't always surface the identical top candidates.
const pickRandomTopCandidates = (sortedCandidates, poolSize = 8, pickCount = 4) => {
    const pool = sortedCandidates.slice(0, poolSize);
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, pickCount);
};

const getRecommendationsList = (addedProduct, allProducts, excludedIds = []) => {
    if (!addedProduct) return [];

    const isExcluded = (id) => excludedIds.some(eid => String(eid) === String(id));
    const hasValidImage = (p) => {
        const img = getProductImageUri(p, allProducts);
        return img && img.startsWith('http') && img !== 'null' && img !== 'undefined';
    };
    const hasValidPrice = (p) => p.price && String(p.price).trim() !== '' && !isNaN(parseFloat(String(p.price).replace(/[^\d.]/g, '')));

    const candidates = allProducts.filter(p => {
        if (p.id === addedProduct.id) return false;
        if (isExcluded(p.id)) return false;
        if (Number(p.stock) <= 0) return false;
        if (!hasValidPrice(p)) return false;
        if (!hasValidImage(p)) return false;

        const isAddedShirt = isShirtCategory(addedProduct.category, addedProduct.name);
        const isAddedTShirt = isTShirtCategory(addedProduct.category, addedProduct.name);

        const isCandPoloFit = isPoloFitPant(p);
        const isCandJeans = isJeans(p);
        const isCandCargo = isCargoTrackPant(p);
        const isCandTrouser = isTrouser(p);
        const isCandJogger = isJogger(p);

        if (isAddedShirt) {
            // Must be Polo Fit Pant or Jeans (Exclude Cargo Track Pant or Trouser)
            return isCandPoloFit || isCandJeans;
        }

        if (isAddedTShirt) {
            const candCatLower = (p.category || '').toLowerCase();
            const candNameLower = (p.name || '').toLowerCase();
            const isCandTrackPant = candCatLower.includes('track') || candNameLower.includes('track') || candCatLower.includes('trach') || candNameLower.includes('trach');
            const isCandCargoPant = candCatLower.includes('cargo') || candNameLower.includes('cargo');
            return isCandCargo || isCandTrouser || isCandJogger || isCandTrackPant || isCandCargoPant;
        }

        // For other added products (e.g. Pants/Jeans/Cargos/Trousers/Joggers recommending Tops):
        const isAddedPoloFit = isPoloFitPant(addedProduct);
        const isAddedJeans = isJeans(addedProduct);
        if (isAddedPoloFit || isAddedJeans) {
            return isShirtCategory(p.category, p.name);
        }

        const isAddedCargo = isCargoTrackPant(addedProduct);
        const isAddedTrouser = isTrouser(addedProduct);
        const isAddedJogger = isJogger(addedProduct);
        const addedCatLower = (addedProduct.category || '').toLowerCase();
        const addedNameLower = (addedProduct.name || '').toLowerCase();
        const isAddedTrackPant = addedCatLower.includes('track') || addedNameLower.includes('track') || addedCatLower.includes('trach') || addedNameLower.includes('trach');
        const isAddedCargoPant = addedCatLower.includes('cargo') || addedNameLower.includes('cargo');
        if (isAddedCargo || isAddedTrouser || isAddedJogger || isAddedTrackPant || isAddedCargoPant) {
            return isTShirtCategory(p.category, p.name);
        }

        // Default category swap fallback
        const addedParent = getParentCategory(addedProduct.category).toLowerCase();
        const candParent = getParentCategory(p.category).toLowerCase();
        const isAddedTop = addedParent.includes('shirt') || addedParent.includes('tshirt') || addedParent.includes('t-day') || addedParent.includes('t-shirt') || addedParent.includes('jersey') || addedParent.includes('polo');
        const isCandTop = candParent.includes('shirt') || candParent.includes('tshirt') || candParent.includes('t-day') || candParent.includes('t-shirt') || candParent.includes('jersey') || candParent.includes('polo');

        if (isAddedTop && !isCandTop) return true;
        if (!isAddedTop && isCandTop) return true;

        return false;
    });

    // Score and sort candidates
    return candidates
        .map(p => ({ product: p, score: getRecommendationScore(addedProduct, p, allProducts) }))
        .sort((a, b) => b.score - a.score)
        .map(item => item.product);
};

async function prepareRecommendationResponse(session, productsPool) {
    const idx = session.recommendationIndex || 0;
    const pool = session.recommendationPool || [];

    if (idx + 1 >= pool.length) {
        session.state = "AWAITING_MORE_ITEMS";
        return {
            sendButtons: {
                body: "Would you like to continue shopping?",
                buttons: [
                    { id: 'yes', title: '🛍️ YES' },
                    { id: 'no_checkout', title: '🛒 NO - Checkout' }
                ]
            },
            sendImages: []
        };
    }

    const id1 = pool[idx];
    const id2 = pool[idx + 1];

    const p1 = productsPool.find(p => p.id === id1);
    const p2 = productsPool.find(p => p.id === id2);

    if (!p1 || !p2) {
        session.state = "AWAITING_MORE_ITEMS";
        return { replyText: "Would you like to continue shopping? 😊", sendImages: [] };
    }

    const startNum = idx + 1;
    const collageUrl = await createRecommendationCollage(p1, p2, startNum, productsPool);

    const addedProduct = productsPool.find(p => p.id === session.originalProductId) || { name: 'selected product' };
    const addedName = `${addedProduct.color ? addedProduct.color + ' ' : ''}${addedProduct.name}`;

    let replyText = `🔥 *Best Matches For Your Selected Product: ${addedName}*\n\n`;
    replyText += `${startNum}. ${getShortProductName(p1)} - ₹${p1.price}\n`;
    replyText += `${startNum + 1}. ${getShortProductName(p2)} - ₹${p2.price}\n\n`;
    replyText += `Reply *${startNum}* or *${startNum + 1}*\n`;

    const buttons = [];
    if (idx + 3 <= pool.length) {
        replyText += `Or type *SHOW MORE* for other options.`;
        buttons.push({ id: 'show_more_recs', title: '👉 SHOW MORE' });
    }

    const response = {
        replyText,
        sendImages: collageUrl ? [{ url: collageUrl, caption: `Matches for ${addedName}` }] : [],
        listContext: {
            type: 'recommendations',
            pool: pool,
            currentPage: Math.floor(idx / 2),
            originalProductId: session.originalProductId
        }
    };

    if (buttons.length > 0) {
        response.sendButtons = {
            body: `Options:`,
            buttons
        };
    }

    return response;
}

// Formats a recommendation message with interactive choice options
const getRecommendationMessage = (addedProduct, recommendedProduct, currentParent) => {
    const addedName = `${addedProduct.color ? addedProduct.color + ' ' : ''}${addedProduct.name}`;
    const recName = `${recommendedProduct.color ? recommendedProduct.color + ' ' : ''}${recommendedProduct.name}`;
    const isShirtAdded = currentParent.toLowerCase().includes('shirt');
    const matchMsg = isShirtAdded
        ? `Complete the look! *${addedName}* pairs perfectly with *${recName}*. 🔥`
        : `Complete the look! *${addedName}* pairs perfectly with *${recName}*. 🔥`;

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

const isShirtCategory = (cat, name = '') => {
    const parent = getParentCategory(cat);
    if (parent === 'Shirts') return true;
    const catLower = (cat || '').toLowerCase();
    const nameLower = (name || '').toLowerCase();
    return (catLower.includes('shirt') || nameLower.includes('shirt')) &&
        !catLower.includes('t-shirt') && !catLower.includes('t shirt') && !catLower.includes('tshirt') &&
        !nameLower.includes('t-shirt') && !nameLower.includes('t shirt') && !nameLower.includes('tshirt');
};

const isTShirtCategory = (cat, name = '') => {
    const parent = getParentCategory(cat);
    if (parent === 'T-Shirts') return true;
    const catLower = (cat || '').toLowerCase();
    const nameLower = (name || '').toLowerCase();
    return catLower.includes('t-shirt') || catLower.includes('t shirt') || catLower.includes('tshirt') ||
        nameLower.includes('t-shirt') || nameLower.includes('t shirt') || nameLower.includes('tshirt');
};

const isPantOrJeansCategory = (cat, name = '') => {
    const parent = getParentCategory(cat);
    if (parent === 'Pants' || parent === 'Jeans') return true;
    const catLower = (cat || '').toLowerCase();
    const nameLower = (name || '').toLowerCase();
    return catLower.includes('pant') || catLower.includes('phant') || catLower.includes('jeans') ||
        nameLower.includes('pant') || nameLower.includes('phant') || nameLower.includes('jeans') ||
        nameLower.includes('polofit');
};

const isPoloFitPant = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    const matchesPolo = nameLower.includes('polo fit') || nameLower.includes('polofit') || catLower.includes('polo fit') || catLower.includes('polofit');
    const matchesPant = nameLower.includes('pant') || nameLower.includes('pants') || nameLower.includes('polofit') || catLower.includes('pant') || catLower.includes('pants') || getParentCategory(p.category) === 'Pants';
    return matchesPolo && matchesPant;
};

const isJeans = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    return nameLower.includes('jeans') || nameLower.includes('jean') || catLower.includes('jeans') || catLower.includes('jean') || getParentCategory(p.category) === 'Jeans';
};

const isCargoTrackPant = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    return nameLower.includes('cargo track') || catLower.includes('cargo track') ||
        (nameLower.includes('cargo') && nameLower.includes('track')) ||
        (catLower.includes('cargo') && catLower.includes('track'));
};

const isTrouser = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    return nameLower.includes('trouser') || catLower.includes('trouser');
};

const isJogger = (p) => {
    const nameLower = (p.name || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    return nameLower.includes('jogger') || catLower.includes('jogger');
};

export const getParentCategory = (categoryName) => {
    if (!categoryName) return 'General';
    const catLower = categoryName.toLowerCase().trim();

    // T-Shirts checked before Shirts to avoid 't-shirt'/'t shirt' matching the generic 'shirt' keyword.
    // ' t shirt' (with a LEADING space) is used instead of bare 't shirt' so the 't' must be a
    // standalone word — "chava print shirts" was wrongly matching because "print shirts" contains
    // the substring "t shirt" (the trailing 't' of 'print' + space + 'shirts'). The leading space
    // prevents that false match while still correctly catching "Five Sleeve T Shirt",
    // "Football T Shirt", and "Stripe T Shirts" where the 'T' is always preceded by a space.
    if (['t-shirt', 'tshirt', ' t shirt', 'round neck', 'polo t'].some(kw => catLower.includes(kw))) {
        return 'T-Shirts';
    }
    // 'casual' and 'plain' were removed: both are generic adjectives, not shirt-specific, and were
    // matching pant categories like "Casual Pant" before the Pants check below ever ran. Real shirt
    // categories ("Casual Shirts", "Plain Shirts", "Lenin Plain") still match via 'shirt'/'lenin'.
    if (['shirt', 'linen', 'lenin', 'chava', 'printed', 'stripes', 'cotton shirt'].some(kw => catLower.includes(kw))) {
        return 'Shirts';
    }
    // Shorts checked before the generic Pants list so categories like "Imported Shorts" get
    // their own parent instead of being lumped in with Pants.
    if (catLower.includes('shorts')) {
        return 'Shorts';
    }
    if (['pant', 'phant', 'jeans', 'trouser', 'track', 'cargo', 'lycra', 'laycra'].some(kw => catLower.includes(kw))) {
        return 'Pants';
    }
    if (catLower.includes('new arrival')) {
        return 'New Arrivals';
    }
    return categoryName;
};

// Dynamically get emoji based on parent category
const getCategoryEmoji = (parentCategory) => {
    const name = parentCategory.toLowerCase();
    if (name.includes('new arrival')) return '🆕';
    if (name.includes('shirt')) return '👕';
    if (name.includes('pant') || name.includes('phant') || name.includes('jeans')) return '👖';
    if (name.includes('shorts')) return '🩳';
    if (name.includes('saree') || name.includes('frock') || name.includes('suit') || name.includes('kurti')) return '👗';
    return '🛍️';
};

// Generic/umbrella WooCommerce category tags that should never be treated as a product's "real"
// category. Mirrors GENERIC_CATEGORIES in api/products.js (used by getPrimaryCategory when
// collapsing a product's full categories array into the singular category field at sync time)
// plus "New Arrival" — which getPrimaryCategory does NOT skip, so a product tagged both
// "New Arrival" and a real category (e.g. "POLO FIT PANT") can end up with category="New Arrival",
// silently losing its real category for any code that only looks at the singular field.
const GENERIC_CATEGORY_TAGS = ['men', 'menu', 'general', 'uncategorized', 'new arrival', 'new arrivals'];

// Returns the most specific real category for a product by checking its full categories array
// (falling back to the singular category field if categories is absent) and skipping generic
// umbrella tags — use this instead of product.category directly wherever the result feeds into
// classification logic (e.g. getParentCategory), since product.category can itself be a generic
// tag chosen as "primary" even when a real, more specific category is also present.
const getEffectiveCategory = (product) => {
    const cats = Array.isArray(product.categories) && product.categories.length > 0
        ? product.categories
        : [product.category];
    const specific = cats.find(c => c && !GENERIC_CATEGORY_TAGS.includes(c.toLowerCase().trim()));
    return specific || product.category || 'General';
};

// A product can carry multiple WooCommerce categories (e.g. ["New Arrival", "Polo Fit Pant"]),
// but only one of them is collapsed into the singular p.category field at sync time
// (see getPrimaryCategory in api/products.js). Matching subcategory selection against
// p.category alone silently drops products whose chosen subcategory wasn't picked as
// "primary" — checking the full categories array (case/whitespace-insensitive) catches all of them.
const productMatchesSubCategory = (p, subCategory) => {
    const target = (subCategory || '').toLowerCase().trim();
    const cats = Array.isArray(p.categories) && p.categories.length > 0
        ? p.categories
        : [p.category];
    return cats.some(c => (c || '').toLowerCase().trim() === target);
};

// Helper to calculate active category counts
export const getCategoryCounts = (products) => {
    const categoryCounts = {};
    products.forEach(p => {
        if (Number(p.stock) > 0) {
            const cats = Array.isArray(p.categories) && p.categories.length > 0
                ? p.categories
                : [p.category];
            const seenParents = new Set();
            cats.forEach(c => {
                const parent = getParentCategory(c);
                if (!seenParents.has(parent)) {
                    seenParents.add(parent);
                    categoryCounts[parent] = (categoryCounts[parent] || 0) + 1;
                }
            });
        }
    });
    return categoryCounts;
};

// Helper to sort parent categories
export const getSortedParents = (categoryCounts) => {
    const parents = Object.keys(categoryCounts).filter(cat => categoryCounts[cat] > 0 && cat !== 'General');
    parents.sort((a, b) => {
        const order = { 'New Arrivals': 1, 'Shirts': 2, 'T-Shirts': 3, 'Pants': 4 };
        const orderA = order[a] || 99;
        const orderB = order[b] || 99;
        if (orderA !== orderB) return orderA - orderB;
        return a.localeCompare(b);
    });
    return parents;
};

// Fixed group sort order used by getAllSubCategoriesList below (and by the per-parent
// subcategory browsing list) — anything whose getParentCategory() isn't one of these
// (e.g. New Arrivals leftovers) sorts last.
const SUBCATEGORY_GROUP_ORDER = ['Shirts', 'T-Shirts', 'Pants', 'Shorts'];

// Helper to compute the full flat list of WooCommerce subcategory names (in-stock only),
// excluding "New Arrival(s)" entirely and pre-sorted into the fixed group display order
// so this is the single source of truth for both the rendered menu and the numeric lookup.
export const getAllSubCategoriesList = (products) => {
    const counts = {};
    products.forEach(p => {
        if (Number(p.stock) > 0) {
            const sub = p.category || 'General';
            if (sub === 'General') return;
            counts[sub] = (counts[sub] || 0) + 1;
        }
    });
    const subs = Object.keys(counts).filter(sub => {
        if (counts[sub] <= 0) return false;
        const subLower = sub.toLowerCase().trim();
        if (subLower === 'men') return false;
        if (subLower === 'new arrival' || subLower === 'new arrivals') return false;
        return true;
    });
    subs.sort((a, b) => {
        const groupA = SUBCATEGORY_GROUP_ORDER.indexOf(getParentCategory(a));
        const groupB = SUBCATEGORY_GROUP_ORDER.indexOf(getParentCategory(b));
        const orderA = groupA === -1 ? SUBCATEGORY_GROUP_ORDER.length : groupA;
        const orderB = groupB === -1 ? SUBCATEGORY_GROUP_ORDER.length : groupB;
        if (orderA !== orderB) return orderA - orderB;
        return a.localeCompare(b);
    });
    return subs;
};

// Single entry point for "show category selection" outside the main greeting menu — replaces
// the old flat list of every subcategory across every parent category with the short 7-item
// TOP_CATEGORY_MENU_TEXT quick-pick (cart cleared, cancel flows, Shop Now, welcome-back, etc.).
// Selecting a number here routes straight into the Scenario A "Yes, available" reply
// (buildCategoryAvailableReply) for a sample product in that category — see the
// AWAITING_TOP_CATEGORY_SELECTION handler below — instead of a follow-up numbered subcategory list.
function goToTopCategoryMenu(session, products, bodyPrefix) {
    session.subCategories = null;
    session.selectedParentCategory = null;
    session.state = "AWAITING_TOP_CATEGORY_SELECTION";
    return {
        replyText: bodyPrefix !== undefined ? `${bodyPrefix}\n\n${TOP_CATEGORY_MENU_TEXT}` : TOP_CATEGORY_MENU_TEXT,
        sendImages: []
    };
}

// Resolves a 1-based index against the full flat subcategory menu (the same array used for the
// main "Select a Category" menu) and transitions the session into that subcategory's product
// flow. Used as a fallback when a number typed inside an unrelated product list doesn't match
// any product there but does match a category number — so the customer jumps straight into that
// category instead of seeing a confusing "invalid product number" error.
// Returns undefined if idx isn't a valid category index (caller should fall through to its own
// invalid-selection message); otherwise returns the response to send.
async function enterSubCategoryByIndex(session, products, idx, allSubs) {
    if (!(idx >= 0 && idx < allSubs.length)) return undefined;
    const selectedSub = allSubs[idx];
    const matched = products.filter(p => Number(p.stock) > 0 && productMatchesSubCategory(p, selectedSub));

    if (matched.length === 0) {
        return { replyText: "We are sorry, but this subcategory is currently out of stock. 😔", sendImages: [] };
    }

    session.selectedSubCategory = selectedSub;
    session.selectedParentCategory = getParentCategory(selectedSub);
    session.searchProducts = matched;

    // Every subcategory — regardless of how many products match — goes through the same
    // collage + "Shop [Category]" CTA flow (website redirect). A single-match shortcut into
    // the old size/qty/cart flow used to live here; removed so category browsing never
    // re-enters that dormant flow (see prepareProductsPageResponse's ctaOptions branch).
    session.state = "AWAITING_SUBCATEGORY_SELECTION";
    const emoji = getCategoryEmoji(session.selectedParentCategory || '');
    const capSub = selectedSub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    return await prepareProductsPageResponse(session, products, `${emoji} ${capSub}`, { subCategoryDisplayName: capSub });
}

// =============================
// Per-product size/qty selection (pendingSelections)
// =============================
// Each product being sized/qty'd is tracked independently in session.pendingSelections, keyed by
// product ID, instead of a single shared "current product" pointer. This means a customer can
// start configuring product A, then — before finishing it — select a different product B (e.g.
// by tapping an older "Select Product" list still visible in the chat), configure B, and come
// back to finish A, with no risk of B's flow inheriting or overwriting A's size/qty. Size and qty
// button/list replies embed the product ID directly (size_<id>_<value>, qty_<id>_<value>) so they
// route to the correct entry unambiguously, regardless of whatever session.state currently says.
// session.orderingQueue still holds products that were selected together but haven't been shown
// a size prompt yet — it's consumed one at a time as earlier entries in pendingSelections finish.

// session.pendingOrder is a plain array of product-ID strings in touch order (most-recently-
// touched at the end). This exists because pendingSelections is keyed by product ID, and product
// IDs are large-but-not-huge integers — JS engines enumerate integer-like string object keys in
// ASCENDING NUMERIC order regardless of insertion order (Object.keys/values on {"2751":a,"2716":b}
// returns ["2716","2751"], not insertion order), so Object.values() cannot be used to track
// recency here. markPendingTouched must be called whenever an entry is created or interacted with.
function markPendingTouched(session, pid) {
    session.pendingOrder = (session.pendingOrder || []).filter(id => id !== pid);
    session.pendingOrder.push(pid);
}

// Looks up the most recently touched pendingSelections entry still waiting on `step`
// ('AWAITING_PRODUCT_SIZE' or 'AWAITING_PRODUCT_QTY'). Used for rendering a "continue where you
// left off" prompt for a given step (e.g. from getStatePrompt's indirect callers) — NOT for
// resolving fresh typed replies, since recency alone can't tell a size reply from a qty reply
// when two products are pending in different steps (see resolveTypedPendingEntry below).
function getMostRecentPending(session, step) {
    const order = session.pendingOrder || [];
    for (let i = order.length - 1; i >= 0; i--) {
        const entry = session.pendingSelections[order[i]];
        if (entry && entry.step === step) return entry;
    }
    return null;
}

// Picks which pending entry a plain typed reply (no product ID) most likely targets. Recency
// alone isn't enough here: if product A is awaiting qty and product B (selected afterwards) is
// still awaiting size, typing "XL" must resolve to B even though A was touched more recently — "XL"
// only makes sense as a size. So this prefers whichever pending entry's current step the text
// actually looks valid for (a real size for a size-step entry, a parseable 1-99 number for a
// qty-step entry), breaking ties by recency, and only falls back to pure recency when the text
// doesn't cleanly validate against any pending entry (so the resulting error at least reflects
// whichever product the customer was last interacting with).
function resolveTypedPendingEntry(session, text) {
    const order = session.pendingOrder || [];
    const normalizedInput = normalizeSize(text);

    for (let i = order.length - 1; i >= 0; i--) {
        const entry = session.pendingSelections[order[i]];
        if (!entry || entry.step !== 'AWAITING_PRODUCT_SIZE') continue;
        const sizeList = (Array.isArray(entry.product.sizes)
            ? entry.product.sizes
            : String(entry.product.sizes).split(',').map(s => s.trim())
        ).filter(Boolean);
        if (sizeList.some(s => normalizeSize(s) === normalizedInput)) return entry;
    }

    const typedQty = parseInt(text, 10);
    if (!isNaN(typedQty) && typedQty > 0 && typedQty < 100) {
        for (let i = order.length - 1; i >= 0; i--) {
            const entry = session.pendingSelections[order[i]];
            if (entry && entry.step === 'AWAITING_PRODUCT_QTY') return entry;
        }
    }

    for (let i = order.length - 1; i >= 0; i--) {
        const entry = session.pendingSelections[order[i]];
        if (entry) return entry;
    }
    return null;
}

async function renderSizePrompt(entry, collageBatch, products) {
    const product = entry.product;
    const pid = String(product.id);
    const sizeList = (Array.isArray(product.sizes)
        ? product.sizes
        : String(product.sizes).split(',').map(s => s.trim())
    ).filter(Boolean);

    const body = `📐 *${product.name}*\n\nPlease select your size:`;

    let sendImages = [];
    if (collageBatch && collageBatch.length > 1) {
        const collageUrl = await createPromoCollage(collageBatch, products);
        if (collageUrl) sendImages = [{ url: collageUrl, caption: "Selected items" }];
    } else {
        const imgUri = getProductImageUri(product, products);
        if (imgUri) sendImages = [{ url: imgUri, caption: product.name }];
    }

    if (sizeList.length <= 3) {
        return {
            sendButtons: {
                body,
                buttons: sizeList.map(s => ({ id: `size_${pid}_${s.toUpperCase()}`, title: s.toUpperCase() }))
            },
            sendImages
        };
    }
    const sections = [
        {
            title: "Available Sizes",
            rows: sizeList.map(s => ({
                id: `size_${pid}_${s.toUpperCase()}`,
                title: s.toUpperCase(),
                description: `Select size ${s.toUpperCase()}`
            }))
        }
    ];
    return {
        sendList: { body, buttonText: "Choose Size", sections },
        sendImages
    };
}

function renderQtyPrompt(entry) {
    const product = entry.product;
    const pid = String(product.id);
    const size = entry.size || 'N/A';
    const body = `📐 *${product.name}*\nSelected Size: *${size}*\n\nPlease select the quantity you want to purchase:`;
    const sections = [
        {
            title: "Select Quantity",
            rows: Array.from({ length: 10 }, (_, i) => ({
                id: `qty_${pid}_${i + 1}`,
                title: String(i + 1),
                description: `Qty: ${i + 1}`
            }))
        }
    ];
    return {
        sendList: { body, buttonText: "Choose Qty", sections },
        sendImages: []
    };
}

// Adds newly selected products to the ordering flow and prompts for the first one's size (with a
// collage if more than one was selected together, matching the old "select 2+ products at once"
// UX). Any product already mid-flow in pendingSelections is left untouched.
async function enqueueProductsForOrdering(session, products, newProducts) {
    session.orderingQueue = session.orderingQueue || [];
    session.pendingSelections = session.pendingSelections || {};
    session.fromCrossSell = false;
    session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
    session.cartCrossSellShown = false;

    if (newProducts.length === 0) return promptNextQueuedProduct(session, products);

    const [first, ...rest] = newProducts;
    session.orderingQueue.push(...rest);

    const pid = String(first.id);
    if (session.pendingSelections[pid]) {
        // Already mid-flow for this exact product — don't restart it, just continue normally.
        markPendingTouched(session, pid);
        return promptNextQueuedProduct(session, products);
    }
    session.pendingSelections[pid] = { product: first, size: null, qty: null, step: 'AWAITING_PRODUCT_SIZE' };
    markPendingTouched(session, pid);
    session.state = "AWAITING_PRODUCT_SIZE";
    return await renderSizePrompt(session.pendingSelections[pid], newProducts.length > 1 ? newProducts : null, products);
}

// Pops the next not-yet-started product off the queue and shows its size prompt. Returns null if
// the queue is empty — callers decide what "nothing left to prompt" means in their context.
async function promptNextQueuedProduct(session, products) {
    session.orderingQueue = session.orderingQueue || [];
    session.pendingSelections = session.pendingSelections || {};

    while (session.orderingQueue.length > 0) {
        const product = session.orderingQueue.shift();
        const pid = String(product.id);
        if (session.pendingSelections[pid]) continue; // already in progress — don't duplicate
        session.pendingSelections[pid] = { product, size: null, qty: null, step: 'AWAITING_PRODUCT_SIZE' };
        markPendingTouched(session, pid);
        session.state = "AWAITING_PRODUCT_SIZE";
        return await renderSizePrompt(session.pendingSelections[pid], null, products);
    }
    return null;
}

// Validates a size reply against `entry`'s product and, on success, advances that entry to the qty
// step. Shared by the button-reply path (product ID known from the payload) and the typed-text
// fallback path (product ID inferred as the most recently prompted pending entry).
// session.state is kept in sync with entry.step — the typed-text fallback (which has no product ID
// of its own) relies on session.state to decide whether to look for an AWAITING_PRODUCT_SIZE or
// AWAITING_PRODUCT_QTY entry, so it must reflect whichever entry was most recently touched. This
// entry is also marked touched in pendingOrder, since a button reply can target an entry that
// isn't the most-recently-created one (e.g. going back to size an earlier product after a later
// one), and a subsequent plain-typed reply must still resolve to whichever one was just acted on.
function applySizeSelection(session, entry, sizeInput) {
    const product = entry.product;
    markPendingTouched(session, String(product.id));
    const normalizedInput = normalizeSize(sizeInput);
    const sizeList = (Array.isArray(product.sizes)
        ? product.sizes
        : String(product.sizes).split(',').map(s => s.trim())
    ).filter(Boolean);
    const matchedSize = sizeList.find(s => normalizeSize(s) === normalizedInput);

    if (!matchedSize) {
        const rawSizes = sizeList.map(s => s.toUpperCase());
        const sizeButtonsOrList = sizeList.length <= 3 ? `Choose from: ${rawSizes.join(', ')}` : `Please select a size from the options below.`;
        session.state = entry.step;
        return {
            replyText: `❌ This size is currently out of stock or invalid.\n\nAvailable sizes for ${product.name}:\n${rawSizes.join(', ')}\n\n${sizeButtonsOrList}`,
            sendImages: []
        };
    }

    entry.size = matchedSize.toUpperCase();
    entry.step = 'AWAITING_PRODUCT_QTY';
    session.state = entry.step;
    return renderQtyPrompt(entry);
}

// Validates a qty reply (already known to be a valid 1-99 integer) against `entry`, finalizes it
// straight into the cart, and either prompts the next queued product's size or — once nothing is
// left pending — runs the same post-add-to-cart / cross-sell flow the old single-queue code did.
async function applyQtySelection(session, products, entry, qty) {
    const product = entry.product;
    session.cart = session.cart || [];
    session.cart.push({
        id: product.id,
        name: product.name,
        product: product.name,
        size: entry.size || 'M',
        qty,
        price: Number(product.price),
        color: product.color || ''
    });
    const pid = String(product.id);
    delete session.pendingSelections[pid];
    session.pendingOrder = (session.pendingOrder || []).filter(id => id !== pid);

    const nextPrompt = await promptNextQueuedProduct(session, products);
    if (nextPrompt) return nextPrompt;

    if (session.pendingOrder.length > 0) {
        // Other product(s) are still mid-flow (e.g. an interleaved selection) — they already have
        // their own live prompt to answer, so just acknowledge this one rather than re-prompting.
        // Sync session.state to the last-remaining (most recently touched) entry so a plain typed
        // reply (no product ID) still resolves to the right one via getMostRecentPending.
        const lastPid = session.pendingOrder[session.pendingOrder.length - 1];
        session.state = session.pendingSelections[lastPid].step;
        const addedName = `${product.color ? product.color + ' ' : ''}${product.name}`;
        return { replyText: `✅ *${addedName}* (${entry.size}) x${qty} added to cart.`, sendImages: [] };
    }

    // Check if this addition came from a cross-sell suggestion
    if (session.fromCrossSell) {
        session.fromCrossSell = false;
        return await showCartSummaryWithCrossSell(session, products);
    }

    // Otherwise, normal post add-to-cart flow: check for matching deals using existing cross-sell logic
    if (!session.crossSellShown) {
        const uniqueProducts = [...new Map(products.map(p => [p.id, p])).values()];
        const excludedIds = session.cart.map(item => item.id);
        const offer = getCrossSellOffer(product, uniqueProducts, excludedIds);
        const candidates = offer?.candidates || [];

        if (candidates.length > 0) {
            let promoCategory = offer?.promoCategory || 'Pants';
            session.promoCategory = promoCategory;

            const sortedCandidates = candidates
                .map(p => ({ product: p, score: getRecommendationScore(product, p, uniqueProducts) }))
                .sort((a, b) => b.score - a.score)
                .map(item => item.product);

            let promoCandidates = pickRandomTopCandidates(sortedCandidates);

            if (new Set(promoCandidates.map(p => p.id)).size !== promoCandidates.length) {
                const uniquePromoCandidates = [];
                const seenIds = new Set();
                for (const p of promoCandidates) {
                    if (!seenIds.has(p.id)) {
                        seenIds.add(p.id);
                        uniquePromoCandidates.push(p);
                    }
                }
                promoCandidates = uniquePromoCandidates;
            }

            let collageUrl = null;
            if (promoCandidates.length > 1) {
                collageUrl = await createPromoCollage(promoCandidates, uniqueProducts);
            } else if (promoCandidates.length === 1) {
                collageUrl = getProductImageUri(promoCandidates[0], uniqueProducts);
            }

            session.subCategories = null;
            session.selectedParentCategory = null;
            session.state = "AWAITING_TOP_CATEGORY_SELECTION";
            session.pendingProduct = null;
            session.isRecommendation = false;
            session.crossSellShown = true;
            session.cartCrossSellShown = true;

            const addedName = `${product.color ? product.color + ' ' : ''}${product.name}`;

            let promoEmoji = '🛍️';
            if (promoCategory === 'Shirts') promoEmoji = '👕';
            if (promoCategory === 'Pants' || promoCategory === 'Jeans') promoEmoji = '👖';
            if (promoCategory === 'T-Shirts') promoEmoji = '👕';
            if (promoCategory === 'Shorts') promoEmoji = '🩳';

            const promoKeyword = promoCategory.toUpperCase();

            let bodyText = `✅ *${addedName}* added to cart.\n\n`;
            bodyText += `🔥 Special Offer!\n`;
            bodyText += `Matching Collection Available`;

            return {
                sendButtons: {
                    body: bodyText,
                    buttons: [
                        { id: promoKeyword, title: `${promoEmoji} VIEW ${promoKeyword}` },
                        { id: 'CHECKOUT', title: '🛒 CHECKOUT' }
                    ]
                },
                sendImages: collageUrl ? [{ url: collageUrl, caption: `${promoCategory} trending collection` }] : [],
                cart: session.cart
            };
        }
    }

    session.state = "AWAITING_POST_ADD_TO_CART_DECISION";
    return await getStatePrompt(session, products);
}

// Routes a size_<id>_<value> button/list reply directly to its pendingSelections entry,
// independent of session.state. Returns null if productId isn't a recognized pending entry (e.g.
// a stale button from a long-finished flow), so the caller falls through to normal routing.
function handleSizeReply(session, productId, sizeValue) {
    session.pendingSelections = session.pendingSelections || {};
    const entry = session.pendingSelections[productId];
    if (!entry) return null;
    return applySizeSelection(session, entry, sizeValue);
}

// Routes a qty_<id>_<value> button/list reply directly to its pendingSelections entry,
// independent of session.state. Returns null if productId isn't a recognized pending entry.
async function handleQtyReply(session, products, productId, qty) {
    session.pendingSelections = session.pendingSelections || {};
    const entry = session.pendingSelections[productId];
    if (!entry) return null;
    return await applyQtySelection(session, products, entry, qty);
}

// True when the session is sitting at the top-level category menu — either the new 7-item quick
// menu (AWAITING_TOP_CATEGORY_SELECTION) or the idle/default AWAITING_SUBCATEGORY_SELECTION state
// with no parent chosen yet (a fresh/reset session defaults to the latter — see getSession).
const isAtTopLevelMenu = (session) => session.state === "AWAITING_TOP_CATEGORY_SELECTION" ||
    (session.state === "AWAITING_SUBCATEGORY_SELECTION" && !session.selectedParentCategory);

// True when the customer is just browsing a category/product list (subcategory menu or product
// list) rather than mid-way through a required multi-step input like checkout. Unlike
// isAtTopLevelMenu, this is also true once a parent category is selected (e.g. browsing "Shirts"
// subcategories or viewing a product list) — there's no specific data the customer still owes the
// bot, so an FAQ answer doesn't need to drag the whole category/product menu back into the reply.
const isPassivelyBrowsing = (session) => session.state === "AWAITING_SUBCATEGORY_SELECTION" ||
    session.state === "AWAITING_MODEL_SELECTION" || session.state === "AWAITING_TOP_CATEGORY_SELECTION";

const isFormalPantProduct = (p) => {
    const nameLower = (p?.name || '').toLowerCase();
    const catLower = (p?.category || '').toLowerCase();
    return nameLower.includes('formal pant') || catLower.includes('formal pant') || isTrouser(p);
};

const isCottonPantProduct = (p) => {
    const nameLower = (p?.name || '').toLowerCase();
    const catLower = (p?.category || '').toLowerCase();
    return nameLower.includes('cotton pant') || catLower.includes('cotton pant') || nameLower.includes('chinos') || catLower.includes('chinos');
};

const isBottomWearProduct = (p) => {
    return isPantOrJeansCategory(p?.category, p?.name) || isPoloFitPant(p) || isJeans(p) || isFormalPantProduct(p) || isCottonPantProduct(p) || isCargoTrackPant(p) || isTrouser(p) || isJogger(p);
};

function getCrossSellOffer(addedProduct, allProducts, excludedIds = []) {
    if (!addedProduct) return null;

    // getEffectiveCategory (not addedProduct.category directly) — addedProduct.category can be a
    // generic umbrella tag like "New Arrival" chosen as "primary" at sync time even when the
    // product also carries a real category (e.g. "POLO FIT PANT") in its full categories array.
    // Using the raw singular field here previously made such products fall through every branch
    // below into the default "Pants" bucket regardless of what they actually were.
    const effectiveCategory = getEffectiveCategory(addedProduct);
    console.log('[getCrossSellOffer] addedProduct.name=', addedProduct.name, '| addedProduct.category=', addedProduct.category, '| effectiveCategory=', effectiveCategory, '| getParentCategory=', getParentCategory(effectiveCategory));

    const hasValidImage = (p) => {
        const img = getProductImageUri(p, allProducts);
        return img && img.startsWith('http') && img !== 'null' && img !== 'undefined';
    };
    const hasValidPrice = (p) => p.price && String(p.price).trim() !== '' && !isNaN(parseFloat(String(p.price).replace(/[^\d.]/g, '')));
    const isExcluded = (id) => excludedIds.some(eid => String(eid) === String(id));

    let offerLabel = 'Matching Styles';
    let promoCategory = getParentCategory(effectiveCategory);
    let matcher = () => false;

    // Classification is driven entirely by getParentCategory(effectiveCategory) — the single
    // source of truth already used for category browsing/sorting — instead of re-deriving it through
    // several separate keyword-matching helpers (isPlainShirtProduct, isCasualShirtProduct, etc.) that
    // each had their own keyword list and could individually develop gaps for new subcategory names.
    const addedParent = getParentCategory(effectiveCategory);

    if (addedParent === 'T-Shirts') {
        offerLabel = 'Matching Track Pants & Cargo Pants';
        promoCategory = 'Pants';
        matcher = (candidate) => {
            const catLower = (candidate.category || '').toLowerCase();
            const nameLower = (candidate.name || '').toLowerCase();
            const isTrackPant = catLower.includes('track') || nameLower.includes('track') || catLower.includes('trach') || nameLower.includes('trach');
            const isCargoPant = catLower.includes('cargo') || nameLower.includes('cargo');
            return isTrackPant || isCargoPant || isTrouser(candidate) || isJogger(candidate);
        };
    } else if (addedParent === 'Pants') {
        // Track/cargo pants specifically cross-sell T-Shirts (athletic pairing); every other pant
        // (formal, jeans, polo fit, cotton, etc.) cross-sells Shirts.
        const isTrackOrCargoPant = isCargoTrackPant(addedProduct) || isJogger(addedProduct) || isTrouser(addedProduct) ||
            effectiveCategory.toLowerCase().includes('track') ||
            (addedProduct.name || '').toLowerCase().includes('track') ||
            effectiveCategory.toLowerCase().includes('trach') ||
            (addedProduct.name || '').toLowerCase().includes('trach') ||
            effectiveCategory.toLowerCase().includes('cargo') ||
            (addedProduct.name || '').toLowerCase().includes('cargo');

        if (isTrackOrCargoPant) {
            offerLabel = 'Matching T-Shirts';
            promoCategory = 'T-Shirts';
            matcher = (candidate) => isTShirtCategory(candidate.category, candidate.name);
        } else {
            offerLabel = 'Matching Shirts';
            promoCategory = 'Shirts';
            matcher = (candidate) => isShirtCategory(candidate.category, candidate.name) && !isTShirtCategory(candidate.category, candidate.name);
        }
    } else if (addedParent === 'Shorts') {
        offerLabel = 'Matching T-Shirts';
        promoCategory = 'T-Shirts';
        matcher = (candidate) => isTShirtCategory(candidate.category, candidate.name);
    } else if (addedParent === 'Shirts') {
        offerLabel = 'Matching Pants';
        promoCategory = 'Pants';
        matcher = (candidate) => isBottomWearProduct(candidate);
    } else {
        offerLabel = 'Matching Pants';
        promoCategory = 'Pants';
        matcher = (candidate) => isBottomWearProduct(candidate);
    }

    const candidates = allProducts.filter(candidate => {
        if (candidate.id === addedProduct.id) return false;
        if (isExcluded(candidate.id)) return false;
        if (Number(candidate.stock) <= 0) return false;
        if (!hasValidPrice(candidate)) return false;

        return matcher(candidate);
    });

    return {
        offerLabel,
        promoCategory,
        candidates
    };
}

// Helper to retrieve customer's last order details
async function getCustomerLastOrder(phone) {
    try {
        const cleanPhone = String(phone).trim();
        const { data, error } = await supabase
            .from('orders')
            .select('customer_name, customer_phone, customer_address')
            .eq('customer_phone', cleanPhone)
            .order('date', { ascending: false })
            .limit(1);
        if (error) throw error;
        if (data && data.length > 0) {
            return data[0];
        }
    } catch (err) {
        console.error("Error fetching customer last order:", err);
    }
    return null;
}

// Helper to initiate checkout
const startCheckout = async (session, from = null, products = []) => {
    if (!session.cart || session.cart.length === 0) {
        return goToTopCategoryMenu(session, products, "Your cart is empty. 😊 Please select a category to start shopping.");
    }

    if (from) {
        const lastOrder = await getCustomerLastOrder(from);
        if (lastOrder && lastOrder.customer_address && lastOrder.customer_name) {
            session.state = "AWAITING_CHECKOUT_USE_SAVED_ADDRESS";
            session.orderDetails = {
                customerName: lastOrder.customer_name,
                customerPhone: lastOrder.customer_phone || from,
                customerAddress: lastOrder.customer_address,
                paymentMethod: 'UPI'
            };

            let cartSummary = `🛒 *Your Cart:*\n\n`;
            session.cart.forEach((item, i) => {
                cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.product || item.name} (${item.size}) - Qty: ${item.qty || 1} - ₹${Number(item.price) * (item.qty || 1)}\n`;
            });
            const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price) * (item.qty || 1), 0);
            cartSummary += `\n💰 Total: ₹${cartTotal}\n\n`;

            return {
                sendButtons: {
                    body: `${cartSummary}We found a saved address from your previous order:\n\n👤 *Name:* ${lastOrder.customer_name}\n📞 *Phone:* ${lastOrder.customer_phone || from}\n🏠 *Address:* ${lastOrder.customer_address}\n\nWould you like to use this saved address?`,
                    buttons: [
                        { id: 'use_saved_yes', title: '✅ Yes, Use Saved' },
                        { id: 'use_saved_no', title: '✍️ Enter New Address' }
                    ]
                },
                sendImages: []
            };
        }
    }

    let cartSummary = `🛒 *Your Cart:*\n\n`;
    session.cart.forEach((item, i) => {
        cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.product || item.name} (${item.size}) - Qty: ${item.qty || 1} - ₹${Number(item.price) * (item.qty || 1)}\n`;
    });
    const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price) * (item.qty || 1), 0);
    cartSummary += `\n💰 Total: ₹${cartTotal}\n\nThank you for shopping! Let's get your delivery details step-by-step. 😊\n\n👤 Please enter your *Full Name*:`;
    session.state = "AWAITING_CHECKOUT_NAME";
    session.orderDetails = { customerName: '', customerPhone: '', customerAddress: '', paymentMethod: 'UPI' };
    return { replyText: cartSummary, sendImages: [] };
};

// =============================
// Intent Detection & Routing Layer
// =============================

// Shared with the SEARCH case in handleIntent below — hoisted so detectIntent's catalog check
// (looksLikeProductQuery) uses the exact same cleaning/stopword rules as the real match, instead
// of a second, drifting copy.
const SEARCH_EN_STOP = new Set(['is', 'are', 'available', 'do', 'you', 'have', 'any', 'the', 'a', 'an',
    'in', 'stock', 'please', 'send', 'show', 'get', 'got', 'what', 'which', 'want', 'need',
    'needed', 'wanted', 'wants', 'i', 'my', 'me', 'us', 'we', 'this', 'that', 'one', 'ones',
    'looking', 'for', 'tell', 'me', 'price', 'cost', 'how', 'much', 'under', 'below', 'less',
    'than', 'find', 'display', 'search', 'some', 'can', 'give', 'look',
    // Quantity/order-question filler — a customer asking "how many can I order" or "single
    // piece" about an already-identified product is asking about QUANTITY, not naming an extra
    // product attribute, so these must never be able to veto an otherwise-good category match
    // (see Bug: "Brand T Shirt 10 pieces how much bro" was wrongly going to OUT_OF_STOCK_REPLY).
    'pieces', 'piece', 'pcs', 'pc', 'qty', 'quantity', 'single', 'minimum', 'min']);
const SEARCH_TA_STOP = new Set(['iruka', 'irukkuma', 'irukka', 'iruku', 'irruku', 'iruke', 'pakanum',
    'vaikanum', 'panunga', 'sollu', 'kodu', 'kudu', 'da', 'bro', 'anna', 'sir', 'madam', 'la', 'ku',
    'ah', 'ha', 'na', 'tharinga', 'kudunga', 'thareengala', 'venum', 'vendum', 'venam', 'vena',
    'enaku', 'eanku', 'yenaku', 'enakku', 'yenakku', 'naaku', 'kaatu', 'kaattunga', 'hai',
    // Common misspellings of "colour"/"color" — meaningless for matching (the actual color comes
    // from a COLOR_KEYWORDS term like "cream"), so they're dropped rather than left to veto an
    // otherwise-good AND match (see makeSearchTerms' noise filtering below).
    'colur', 'colour', 'color', 'culer', 'colr',
    'வேணும்', 'இருக்கா', 'பாருங்க', 'எனக்கு']);

// Normalizes common spelling variants — applied to both the customer's query and product fields
// so e.g. "t-shirt"/"tshirts"/"T-Shirts" all collapse to the same comparable token.
const normalizeSearchSpelling = (s) => s
    // "Lenin Plain" is the catalog's real (typo'd) category name for linen shirts — common
    // misspellings of "linen" itself need to collapse onto that same "lenin" token too, not
    // just the correctly-spelled word.
    .replace(/\b(?:linen|lelin)\b/g, 'lenin')
    // "t shirt"/"t-shirt"/"tshirts"/"t.shirt" AND typo'd variants missing the final "t" (e.g.
    // "t.shirs", "tshirs", "T.shirs L size venum") all collapse to "tshirt" here, before the
    // word ever becomes a standalone "shirt"/"shirts" term — otherwise a typo'd T-Shirt mention
    // loses its leading "t" to punctuation-stripping, the remaining "shirs" gets fuzzy-corrected
    // to the generic "shirt" (see findFuzzyCatalogMatch), and the T-Shirt signal is gone entirely,
    // leaving a bare "shirt" that can match into the unrelated "Shirts" (formal shirts) group —
    // e.g. "White Shirts" — instead of "T-Shirts".
    .replace(/\bt[.\s-]?shirt?s?\b/g, 'tshirt')
    .replace(/\bphants?\b/g, 'pant')
    .replace(/\bpants?\b/g, 'pant')
    .replace(/\bfoot\s*bal+s?\b/g, 'football')
    .replace(/\bjeans?\b/g, 'jeans')
    .replace(/\bjens\b/g, 'jeans')
    .replace(/\bshrt\b/g, 'shirt')
    .replace(/\bshir\b/g, 'shirt')
    .replace(/\btrousers?\b/g, 'trouser');

function cleanSearchQuery(rawText) {
    return normalizeSearchSpelling(
        (rawText || '').toLowerCase()
            .replace(/(?:under|below|less than)\s*₹?\s*\d+/g, '')
            .replace(/[?!.,'"]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
}

// Plain Levenshtein edit distance — used by findFuzzyCatalogMatch below to tell a typo of a real
// catalog word (e.g. "lelin" vs "lenin") apart from a word for something genuinely not in the
// catalog (e.g. "korean"), which used to be conflated as the same kind of "noise" (see Bug 1 in
// the commit that first added makeSearchTerms's catalog-drop pass).
function levenshteinDistance(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// Real words present in the live catalog (category/name/color/pattern), normalized the same way
// searchTermMatches compares against them. Built lazily (only when a term doesn't already match
// literally) since it's an O(products) scan.
function buildCatalogVocabulary(inStockProducts) {
    const words = new Set(COLOR_KEYWORDS);
    inStockProducts.forEach(p => {
        const cats = Array.isArray(p.categories) && p.categories.length > 0 ? p.categories : [p.category];
        [p.name, ...cats, p.color, p.pattern].forEach(field => {
            normalizeSearchSpelling((field || '').toLowerCase())
                .split(/\s+/)
                .filter(w => w.length > 2)
                .forEach(w => words.add(w));
        });
    });
    return words;
}

// True if `term` isn't a literal catalog match but is a plausible typo of one — e.g. "lelin" is
// distance 1 from "lenin". The distance cap scales with word length so short words need a near-
// exact match (avoiding accidental matches like "wite"->"wine") while longer words tolerate one
// extra typo; either way it stays far short of unrelated real words like "korean" (distance >= 3
// from every catalog word), so those are never mistaken for a misspelling of something we carry.
function findFuzzyCatalogMatch(term, vocabulary) {
    if (term.length < 4) return null;
    const maxDistance = term.length <= 5 ? 1 : 2;
    for (const word of vocabulary) {
        if (Math.abs(word.length - term.length) > maxDistance) continue;
        if (levenshteinDistance(term, word) <= maxDistance) return word;
    }
    return null;
}

// Stop-word-filtered terms from free text, with one extra pass for multi-term queries that
// classifies each remaining term instead of blanket-dropping anything not in the catalog (see
// Bug 1 in the commit that first added this pass, and the false-positive it caused: "Korean lelin
// shirts" dropped BOTH "Korean" and "lelin" as equally harmless noise, leaving only the generic
// "shirts" to loosely match an unrelated category like White Shirts). Now:
//   - a term that matches the catalog literally is kept as-is;
//   - a term that's a typo of a real catalog word (fuzzy match) is normalized to that word, so a
//     misspelling like "lelin" still participates in the AND match as "lenin";
//   - a term that matches nothing at all, even with typo tolerance, is a genuine attribute/origin/
//     brand the customer asked for that we don't carry (e.g. "korean") — flagged via
//     hasUnmatchedTerm so the caller can refuse to fall back to ANY category/product instead of
//     silently dropping it.
// Single-term queries skip this pass since the SEARCH case already has its own looser single-term
// fallback.
function makeSearchTerms(rawText, inStockProducts) {
    const rawTerms = cleanSearchQuery(rawText).split(/\s+/)
        // A bare number ("10 pieces", "32 size") is never itself a catalog match signal in this
        // free-text term system — actual size selection happens through the separate size-button
        // flow, not by a literal number appearing in a product's name/category. Dropping it here
        // (alongside stopwords) stops a stray quantity/size number from ever being misread as an
        // unmatched genuine constraint (see hasUnmatchedTerm below).
        .filter(w => w.length > 0 && !SEARCH_EN_STOP.has(w) && !SEARCH_TA_STOP.has(w) && !SIZE_KEYWORDS.has(w) && !/^\d+$/.test(w));
    if (rawTerms.length <= 1) return { terms: rawTerms, hasUnmatchedTerm: false };

    const inCatalog = (term) => COLOR_KEYWORDS.includes(term) || inStockProducts.some(p => searchTermMatches(p, term));
    let vocabulary = null;
    let hasUnmatchedTerm = false;
    const terms = [];

    for (const term of rawTerms) {
        if (inCatalog(term)) {
            terms.push(term);
            continue;
        }
        if (!vocabulary) vocabulary = buildCatalogVocabulary(inStockProducts);
        const fuzzyMatch = findFuzzyCatalogMatch(term, vocabulary);
        if (fuzzyMatch) {
            terms.push(fuzzyMatch);
        } else {
            hasUnmatchedTerm = true;
        }
    }

    return { terms, hasUnmatchedTerm };
}

function searchTermMatches(p, term) {
    const cats = Array.isArray(p.categories) && p.categories.length > 0
        ? p.categories : [p.category];
    return normalizeSearchSpelling((p.name || '').toLowerCase()).includes(term) ||
        cats.some(c => normalizeSearchSpelling((c || '').toLowerCase()).includes(term)) ||
        (p.color || '').toLowerCase().includes(term) ||
        (p.pattern || '').toLowerCase().includes(term);
}

// Routing-only check (used by detectIntent below): true if the message contains a real catalog
// word — matches some in-stock product's name/category/color/pattern, or a known color — even
// without an exact parent-category word like "shirt"/"pant" (e.g. "polo fit cream" matches the
// "Polo Fit Pant" category via "polo"/"fit"). Terms of length <= 2 are ignored so short noise
// words can never trigger this on their own.
function looksLikeProductQuery(rawText, products) {
    const inStock = products.filter(p => Number(p.stock) > 0);
    const terms = cleanSearchQuery(rawText).split(/\s+/)
        .filter(w => w.length > 2 && !SEARCH_EN_STOP.has(w) && !SEARCH_TA_STOP.has(w));
    return terms.some(term => COLOR_KEYWORDS.includes(term) || inStock.some(p => searchTermMatches(p, term)));
}

// Generic short fallback for "we have no idea what this means" — replaces the old behavior of
// dumping the entire numbered category+subcategory list in chat (see Bug 3 in the commit that
// added this); the customer is pointed at the website instead of an in-chat list.
const SHORT_NOT_FOUND_REPLY = `😔 Couldn't find that exact item.\nType *menu* to see our full collection, or visit our website:\nhttps://supercollections.in/shop/`;

// Used specifically when makeSearchTerms flags a genuine catalog-unmatched term (a real
// attribute/origin/brand the customer named that we don't carry at all, e.g. "Korean") — distinct
// from SHORT_NOT_FOUND_REPLY, which is for queries that don't recognizably mention anything. This
// one must NOT fall through to a category/product suggestion, since that's the exact bug it fixes
// (e.g. "Korean lelin shirts" used to fall back to "White Shirts").
const OUT_OF_STOCK_REPLY = `Sorry, this item is currently out of stock. 😔\nWe'll update you as soon as it's available!`;

// Matches an Instagram/Facebook/YouTube link in an INCOMING customer message — e.g. a customer
// pasting a Reel/post link and asking "is this available". Checked against the raw user message
// (see the early-return in _handleSalesAssistantJS below), never against anything the bot itself
// sends, so a website link we send back can't ever be mistaken for this case. We can't open or
// parse these links to know which product they mean, so this short-circuits straight to
// SOCIAL_MEDIA_LINK_REPLY instead of letting the URL fall into SEARCH as meaningless free text
// (where it used to either misfire on the wrong category or trip the out-of-stock fallback).
const SOCIAL_MEDIA_LINK_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|facebook\.com|fb\.watch|youtube\.com|youtu\.be)/i;

// Exact Tanglish wording requested — do not translate or reword.
const SOCIAL_MEDIA_LINK_REPLY = `😊 Sorry , Instagram/Facebook link direct ah open panna mudiyathu.

Video la irukura product name type pannunga, naan check panni solleren 👕

Illana *menu* type pannunga, categories paathu website la  paarunga 🛍️`;

// True if `text` is ONLY digits plus light separators (commas, "&", "and", whitespace/newlines)
// — e.g. "1,2 & 3", "1 2 3", "1\n2\n3" — as opposed to ordinary free text that merely contains a
// digit somewhere (e.g. "I want 5 shirts" or an order ID like "4406"), which must never be
// hijacked as a numbered-menu reply. A single bare number (e.g. "5") also passes this check —
// callers combine it with extractMenuNumbers below to handle both the one-number and
// multiple-numbers case with the same code path.
function isNumbersOnlyText(text) {
    const stripped = (text || '').replace(/\band\b/gi, ' ').replace(/[,&\s]+/g, ' ').trim();
    return stripped.length > 0 && /^\d+(\s+\d+)*$/.test(stripped);
}

// Extracts every standalone integer token from free text (e.g. "1,2 & 3" -> [1,2,3]). \d+ matches
// each contiguous digit run as ONE number, so a multi-digit value is never split into separate
// digits — only meaningful once isNumbersOnlyText has already confirmed the message is a
// numbers-only menu reply, not order-ID lookup text (handled separately, much earlier).
function extractMenuNumbers(text) {
    const matches = (text || '').match(/\d+/g);
    return matches ? matches.map(m => parseInt(m, 10)) : [];
}

// Appended to a numbered-menu reply when the customer listed more than one number at once (e.g.
// "1,2 & 3") — we act on the first one rather than either spamming every option back-to-back or
// rejecting the whole message as unparseable (see MULTIPLE_CATEGORY_NOTE callers below).
const MULTIPLE_CATEGORY_NOTE = "You mentioned multiple categories. Here's the first one. Reply with another number if you want to see another category.";

function detectIntent(text, products = [], session = null) {
    const t = text.toLowerCase().trim();

    // Customer typing a delivery complaint unprompted (e.g. "not delivered", "already
    // ordered but not deliver") — must resolve regardless of session state, since this can
    // be the very first thing they type. Without this check it used to fall through to
    // free-text product search and return a confusing "out of stock" reply. No order id is
    // attached here (this is free text, not a structured button reply), so the
    // ORDER_DELIVERY_COMPLAINT handler just acknowledges and provides contact numbers.
    // Matched as SUBSTRINGS so multi-word messages like "Already I am ordered but not
    // deliver" are caught even when surrounded by other words.
    const deliveryComplaintPhrases = [
        'not deliver', 'not received', 'not yet deliver',
        'order not deliver', 'already ordered', 'where is my order',
        'order not come', 'parcel not come', 'item not received',
        'product not received', 'when will deliver', 'delivery not done',
        'not got', 'not yet received', 'deliver aagala', 'deliver pannala',
        'parcel vanthu', 'vanthucha',
        // Legacy exact-match phrase ids from button replies
        'order_not_delivered', '❌ not delivered', '❌ order not delivered'
    ];
    if (deliveryComplaintPhrases.some(phrase => t.includes(phrase))) {
        return { type: 'ORDER_DELIVERY_COMPLAINT', orderRowId: null, orderDisplayNumber: null };
    }

    // Global Cancel trigger
    const excludeIntents = ['cancel_continue_shopping', 'cancel_exit_shopping', 'cancel_clear_exit', 'cancel_checkout'];
    if (!excludeIntents.includes(t) && (t === 'cancel' || t === '❌ cancel' || t === 'cancel_shopping' || t === 'cancel_order' || t === 'confirm_order_cancel')) {
        return { type: 'CANCEL_SHOPPING' };
    }

    // Order Help submenu: while awaiting a 1-4 choice, intercept it BEFORE any other routing
    // (category numbers, search, cart flow) so it can't be mistaken for a subcategory/product pick.
    // Anything other than a 1-4 digit clears the flag here and falls through to normal routing,
    // so a stale flag can't hijack a later category/product number.
    if (session && session.awaitingOrderHelpChoice) {
        if (/^[1-4]$/.test(t)) {
            return { type: 'ORDER_HELP_CHOICE', choice: t };
        }
        session.awaitingOrderHelpChoice = false;
    }

    // Main welcome-menu numeric selection: while awaiting a 1-9 reply to the redesigned main
    // menu, intercept it before any other routing (category-name search, greetings, etc.) so a
    // bare digit always resolves to the menu choice instead of being mistaken for something else.
    // A customer who lists several numbers at once (e.g. "1,2 & 3") almost certainly wants the
    // FIRST one acted on, not a confusing "couldn't find that" search miss — isNumbersOnlyText
    // requires the WHOLE message to be numbers+separators, so ordinary text that merely contains
    // a digit (e.g. "I want 5 shirts") is never misread as a menu choice.
    if (session && session.state === "AWAITING_MAIN_MENU_SELECTION" && isNumbersOnlyText(t)) {
        const menuNumbers = extractMenuNumbers(t).filter(n => n >= 1 && n <= 9);
        if (menuNumbers.length > 0) {
            return { type: 'MAIN_MENU_SELECT', choice: String(menuNumbers[0]), multipleFound: menuNumbers.length > 1 };
        }
    }

    // Intro menu triggers (the two buttons shown on greeting)
    // Accept the typed phrase too (not just the button id) — referenced by the generic
    // fallback reply, so it needs to actually resolve to the order-help menu.
    if (t === 'order_enquiry' || t === 'order enquiry' || t === 'order inquiry' || t === 'order_help' || t === 'order help') {
        console.log('[IntroMenu] order enquiry triggered');
        return { type: 'ORDER_HELP' };
    }
    if (t === 'shop_now') {
        console.log('[IntroMenu] shop_now button clicked — routing to flat subcategory list');
        return { type: 'SHOP_MORE' };
    }
    if (t === 'customer_support' || t === 'customer support') {
        console.log('[IntroMenu] customer_support triggered');
        return { type: 'CUSTOMER_SUPPORT' };
    }
    if (ORDER_GUIDANCE_VIDEO_ENABLED && (t === 'order_guidance_video' || t === 'order guidance video' || t === 'video guide' || t === 'order video')) {
        console.log('[IntroMenu] order_guidance_video triggered');
        return { type: 'ORDER_GUIDANCE_VIDEO' };
    }
    if (t === 'location' || t === 'store location') {
        console.log('[IntroMenu] location triggered');
        return { type: 'LOCATION' };
    }

    // Global Shop More trigger — always navigate to category list regardless of current state
    if (t === 'shop_more' || t === 'shop more') {
        return { type: 'SHOP_MORE' };
    }

    // 0. CATEGORY keyword routing when a promo category exists
    if (session && session.promoCategory && (t === 'category' || t === 'view category' || t === 'show category' || t.includes('view collection') || t.includes('show collection'))) {
        return { type: 'CATEGORY', category: session.promoCategory };
    }

    // 1. HUMAN Intent
    const humanKeywords = ['owner', 'human', 'customer support', 'call me', 'agent', 'support', 'talk to owner', 'contact owner', 'connect to human', 'chat with owner', 'human mode'];
    if (humanKeywords.some(k => t.includes(k))) {
        return { type: 'HUMAN' };
    }

    // 1.5 ORDER/SUPPORT QUESTIONS — chat logs showed these falling through to either the old
    // generic "Super Collections, online orders only" STORE INFO reply or the catch-all "didn't
    // quite get that" fallback, frustrating customers who just wanted a phone number or to know
    // whether delivery/ordering works at all (one literally replied "You cheating me"). Checked
    // here — after HUMAN, before CHECKOUT/FAQ/SEARCH — so a descriptive phrase always resolves to
    // the right answer, but a bare digit (order-ID lookup, numbered-menu reply) is never affected
    // since none of these keyword lists match a lone number. "how to place order" in particular
    // must be checked before the CHECKOUT keyword match below, since it contains the substring
    // "place order" and would otherwise be misrouted into starting checkout.
    const customerCareKeywords = ['customer care number', 'customer care', 'shop number', 'customer number',
        'contact number', 'phone number', 'team number', 'care number'];
    if (customerCareKeywords.some(k => t.includes(k))) {
        return {
            type: 'FAQ',
            reply: `📞 You can reach our team directly here:\n+91 8668066503\n+91 7418755096\nWe're happy to help! 😊`
        };
    }

    // Distinct from the delivery-TIME FAQ below ("when will it arrive") — this customer wants
    // the courier tracking ID/link for an order already placed, so the reply is explicit about
    // needing the Order ID for tracking specifically instead of a generic "share your Order ID".
    const trackingKeywords = ['tracking number', 'tracking details', 'courier tracking', 'track my order',
        'track order', 'where is my order'];
    if (trackingKeywords.some(k => t.includes(k))) {
        return {
            type: 'FAQ',
            reply: `📦 To check your courier tracking, please share your Order ID (e.g. 4475) and our team will share the tracking details with you shortly.`
        };
    }

    const deliveryAvailabilityKeywords = ['delivery available', 'do you deliver', 'delivery pannuvingala',
        'shipping available', 'delivery aaguma', 'delivery panuvingala'];
    if (deliveryAvailabilityKeywords.some(k => t.includes(k))) {
        return {
            type: 'FAQ',
            reply: `🚚 Yes! We offer delivery across India with FREE Shipping on all orders. Just place your order on our website and we'll deliver to your doorstep! 😊`
        };
    }

    const howToOrderKeywords = ['how to order', 'how to place order', 'how i place the order', 'how to ordee',
        "i don't know how to order", 'i dont know how to order', 'ordering pannrathu epdi'];
    if (howToOrderKeywords.some(k => t.includes(k))) {
        return {
            type: 'FAQ',
            reply: `🛍️ Ordering is easy!\n1. Type *menu* to browse categories\n2. Tap any product link to open our website\n3. Add to cart & checkout — it takes 2 minutes!\nNeed help? Contact our team: +91 8668066503`
        };
    }

    // The exact-match 'location'/'store location' triggers above (checked earlier, before HUMAN)
    // already send a richer location card via sendLocationCard — this only catches the other
    // phrasings that fall through to here instead, e.g. "where is your shop".
    const shopLocationKeywords = ['where is your shop', 'shop located', 'shop address', 'store location',
        'kadai enga', 'store address', 'shop enga', 'store enga', 'location'];
    if (shopLocationKeywords.some(k => t.includes(k))) {
        return {
            type: 'FAQ',
            reply: `📍 Super Collections, Udumalpet.\nFor exact directions or to visit, contact: +91 8668066503\nOr shop online anytime — type *menu*! 😊`
        };
    }

    // 2. CHECKOUT Intent
    const checkoutKeywords = ['checkout', 'place order', 'confirm order', 'buy now', 'buy', 'order confirm'];
    if (checkoutKeywords.some(k => t === k || (t.includes('checkout') && !t.includes('no_checkout') && !t.includes('no checkout') && !t.includes('no-checkout')) || t.includes('place order') || t.includes('confirm order') || t.includes('buy now'))) {
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

    // ─── COMPLAINT / PRICING PROBLEM Handler ───
    // Checked BEFORE all FAQ auto-replies. If the customer is reporting a fee bug,
    // checkout problem, or expressing "not fair" about charges, no automated FAQ
    // answer is appropriate — hand off to the human team instead.
    //
    // Two routes into this handler:
    //   A) Message contains a specific complaint phrase on its own ("not fair",
    //      "fee added", "per item", "per selection", etc.)
    //   B) Message mentions a delivery/shipping fee term AND a complaint signal
    //      word ("problem", "wrong", "issue", etc.) together.
    const _feeProblemPhrases = [
        'not fair', 'getting added', 'fee added', 'fee is added', 'per item',
        'per product', 'per selection', 'each selection', 'extra charge', 'extra fee',
        'double charge', 'charging extra', 'charge extra', 'unfair', 'wrong fee',
        'wrong charge', 'charge problem', 'fee problem', 'billing problem',
        'overcharged', 'over charged'
    ];
    const _checkoutComplaintSignals = [
        'problem', 'issue', 'error', 'bug', 'wrong', 'incorrect',
        'not right', 'cheating', 'not working', 'broken', 'glitch'
    ];
    const _deliveryFeeTerms = [
        'delivery fee', 'delivery charge', 'shipping fee',
        'shipping cost', 'shipping charge', 'courier fee', 'courier charge'
    ];
    const _hasFeeProblemPhrase = _feeProblemPhrases.some(k => t.includes(k));
    const _hasDeliveryFeeComplaint = _deliveryFeeTerms.some(k => t.includes(k)) &&
        _checkoutComplaintSignals.some(s => t.includes(s));

    if (_hasFeeProblemPhrase || _hasDeliveryFeeComplaint) {
        return {
            type: 'FAQ',
            reply: `🙏 Sorry for the trouble! This needs our team's attention.\n\nPlease contact us directly and we'll sort it out right away:\n📞 +91 8668066503\n📞 +91 7418755096`
        };
    }

    // ─── DELIVERY TIME Check (tightened) ───
    // Old approach: loose groupA+groupB combination — "each" matched "reach" and
    // "products" matched "product", so any message mentioning products falsely
    // triggered "7 working days" (e.g. a fee-per-item complaint). Replaced with
    // explicit phrase matching so only genuine delivery-time questions match.
    const isDeliveryTime =
        t.includes('delivery time') || t.includes('delivery days') ||
        t.includes('delivery duration') || t.includes('delivery takes') ||
        t.includes('delivery eppo') || t.includes('delivery naal') ||
        t.includes('how many days') || t.includes('how long delivery') ||
        t.includes('days to deliver') || t.includes('when will deliver') ||
        t.includes('when deliver') || t.includes('shipping time') ||
        t.includes('deliver agum') || t.includes('deliver varum') ||
        t.includes('evlo naal') || t.includes('evvalavu naal') ||
        t.includes('parcel eppo') || t.includes('order eppo');

    if (isDeliveryTime) {
        return { type: 'FAQ', reply: '🚚 Delivery usually takes 7 working days.' };
    }

    // ─── SHIPPING CHARGES Combination Match ───
    const shipChargeGroupA = ['charge', 'charges', 'rate', 'fee', 'fees', 'amount', 'cost', 'price', 'evlo', 'evvalavu', 'how much', 'cash', 'kasu', 'kaasu', 'rupees', 'rs'];
    const shipChargeGroupB = ['ship', 'delivery', 'delei', 'delci', 'delve', 'delvi', 'dlvr', 'courier', 'post', 'parcel'];
    const isShippingCharge = (matchesGroup(words, shipChargeGroupA) && matchesGroup(words, shipChargeGroupB)) ||
        t.includes('shipping fee') || t.includes('delivery amount') || t.includes('shipping amount');

    if (isShippingCharge) {
        return { type: 'FAQ', reply: '🚚 Delivery charge is ₹80.' };
    }

    // ─── COD Combination Match ───
    // Multi-word/concatenated phrases (e.g. "delivery cash", "cashondelivery") must be checked
    // against the full text, not via matchesGroup's per-word fuzzy containment — otherwise a
    // single word like "delivery" gets treated as a match just because it's a substring of a
    // longer group entry (e.g. "cashondelivery".includes("delivery")), wrongly flagging plain
    // delivery-related messages as COD requests.
    const codGroupA = ['cod', 'cash', 'pod'];
    const codPhraseGroupA = ['pay on delivery', 'payment on delivery', 'delivery cash', 'cashondelivery'];
    const codGroupB = ['available', 'iruka', 'irukka', 'delivery', 'deliv', 'delei', 'delci'];
    const isCOD = words.includes('cod') ||
        codPhraseGroupA.some(p => t.includes(p)) ||
        (matchesGroup(words, codGroupA) && matchesGroup(words, codGroupB));

    if (isCOD) {
        return { type: 'FAQ', reply: 'We apologize, but Cash on Delivery (COD) is not available. We accept GPay / UPI payments only. 😊' };
    }

    // ─── RETURN / EXCHANGE / REFUND Match ───
    const returnKeywords = ['return', 'exchange', 'refund', 'replace', 'maatunga', 'maatuga', 'size match', 'wrong size', 'size wrong', 'size issue', 'size change', 'change size', 'damage', 'torn', 'defect', 'stain', 'hole', 'quality', 'bad quality'];
    if (returnKeywords.some(k => t.includes(k))) {
        if (t.includes('size match') || t.includes('size wrong') || t.includes('wrong size') || t.includes('size poda')) {
            return { type: 'FAQ', reply: '📌 Having size issues?\n\nWe offer a 7-day exchange. Please share your Order ID and a photo of the product.' };
        }
        if (t.includes('refund')) {
            return { type: 'FAQ', reply: '💰 For refunds, please share your Order ID. We will verify and process your refund within 3-5 working days.' };
        }
        if (t.includes('damage') || t.includes('torn') || t.includes('defect') || t.includes('hole') || t.includes('stain')) {
            return { type: 'FAQ', reply: '📸 Please send your Order ID and a photo of the product. We will verify and arrange an exchange for you. 😊' };
        }
        return { type: 'FAQ', reply: '✅ 7-day return and exchange is available. Please share your Order ID and a photo of the product.' };
    }

    // ─── PAYMENT METHODS Match ───
    const paymentKeywords = ['payment', 'pay', 'gpay', 'upi', 'google pay', 'googlepay', 'phonepe', 'phone pay', 'bank transfer', 'account number', 'upi id', 'gpay number', 'screenshot', 'pay panna', 'gpay details'];
    if (paymentKeywords.some(k => t.includes(k))) {
        return { type: 'FAQ', reply: '💳 Payment Details:\n\nGPay / UPI: yourupi@okaxis\n\nPlease share a screenshot once the payment is completed. 😊' };
    }

    // ─── DISCOUNT / OFFERS Match ───
    const discountKeywords = ['discount', 'offer', 'sale', 'coupon', 'rate kam', 'cheap', 'kammiya', 'kammi', 'price drop', 'less price', 'best price'];
    if (discountKeywords.some(k => t.includes(k))) {
        return { type: 'FAQ', reply: 'We offer fixed pricing as our products are already at the best possible price. Thank you for understanding! 😊🔥' };
    }

    // 4. GREETING Intent
    const greetKeywords = ['hi', 'hello', 'hey', 'vanakkam', 'hai', 'hii', 'yo', 'sup'];
    if (greetKeywords.some(k => t === k || t === k + ' bro' || t === k + ' anna')) {
        return { type: 'GREETING' };
    }

    // 5. Category vs Search Intent
    // T-Shirts must be checked before Shirts: "t-shirts" contains a word boundary right after the
    // hyphen, so the \bShirt(s)?\b regex below would otherwise match it and misclassify as Shirts.
    //
    // Any mention of a parent-category word — including typing a category/subcategory name
    // verbatim, e.g. "Casual Shirts", "Plain Shirts", "Track Pant" — always routes to SEARCH.
    // There used to be a CATEGORY branch here that diverted short/plain-named text into the old
    // "select a subcategory" menu (AWAITING_SUBCATEGORY_SELECTION), which produced inconsistent
    // behavior: "plain shirt" went through search-cards but "Plain Shirts" (an exact match) hit
    // the old menu. Free text is never a menu selection — only a numeric reply while a menu is
    // actively awaiting one (handled separately, by session.state, not here) or a recognized
    // command (greeting/menu, handled earlier above) should skip the search flow. The "Shop Now"
    // button's flat category list + numeric browsing (SHOP_MORE / AWAITING_SUBCATEGORY_SELECTION)
    // is untouched — it's a different intent type, not reachable through this branch.
    const parentCategories = ['New Arrivals', 'T-Shirts', 'Shirts', 'Shorts', 'Pants'];
    let foundCategory = parentCategories.find(cat => {
        const catSingular = cat.endsWith('s') ? cat.slice(0, -1) : cat;
        const regex = new RegExp(`\\b${catSingular}(s)?\\b`, 'i');
        return regex.test(t);
    });
    // Jeans are grouped under Pants; Shorts has its own parent (see parentCategories above)
    if (!foundCategory && /\bjean(s)?\b/i.test(t)) {
        foundCategory = 'Pants';
    }

    if (foundCategory) {
        return { type: 'SEARCH', query: t };
    }

    const searchKeywords = ['printed', 'linen', 'cotton', 'cargo', 'black', 'white', 'green', 'blue', 'red', 'under', 'below', 'budget'];
    if (searchKeywords.some(kw => t.includes(kw))) {
        return { type: 'SEARCH', query: t };
    }

    // Catalog-driven fallback for the two checks above — those only know a fixed 5-category list
    // plus a dozen hardcoded keywords, so a real subcategory name with no parent-category word in
    // it (e.g. "polo fit cream" for the "Polo Fit Pant" category) fell all the way through to
    // UNKNOWN instead of SEARCH. This checks the actual catalog instead of a hardcoded list.
    if (looksLikeProductQuery(t, products)) {
        return { type: 'SEARCH', query: t };
    }

    // ─── THANK YOU Acknowledgment ───
    // Checked last, right before the UNKNOWN fallback, so a plain "thanks"/"tq"/"nandri" gets a
    // warm acknowledgment instead of the generic "Sorry, I didn't quite get that!" — cheap keyword
    // match on word boundaries, no AI call needed for something this simple.
    const thankYouKeywords = ['tq', 'thank', 'thanks', 'thanku', 'thankyou', 'thnku', 'thnx', 'thx', 'tnx', 'nandri', 'nanri', 'நன்றி'];
    if (words.some(w => thankYouKeywords.includes(w))) {
        return { type: 'THANKS' };
    }

    return { type: 'UNKNOWN' };
}

function matchParentCategory(text, parentCategories) {
    const t = text.toLowerCase().trim();
    // T-Shirts keys must come before the plain 'shirt'/'shirts' keys: t.includes('shirt') is true
    // for "t-shirts" too, so checking 'shirt' first would misclassify T-Shirts input as Shirts.
    const mappings = {
        'new arrival': 'New Arrivals',
        'new arrivals': 'New Arrivals',
        'tshirt': 'T-Shirts',
        'tshirts': 'T-Shirts',
        't-shirt': 'T-Shirts',
        't-shirts': 'T-Shirts',
        'shirt': 'Shirts',
        'shirts': 'Shirts',
        'pant': 'Pants',
        'pants': 'Pants',
        'phant': 'Pants',
        'phants': 'Pants',
        'jeans': 'Pants',
        'jean': 'Pants',
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

function withInlineCancelSection(sections) {
    const normalizedSections = (sections || []).map(section => ({
        ...section,
        rows: Array.isArray(section.rows) ? [...section.rows] : []
    }));
    const hasCancel = normalizedSections.some(section =>
        section.rows.some(row => row.id === 'cancel_shopping')
    );

    if (!hasCancel) {
        // Count total rows across all sections
        const totalRows = normalizedSections.reduce((sum, s) => sum + s.rows.length, 0);
        if (totalRows < 10) {
            normalizedSections.push({
                title: "Actions",
                rows: [
                    {
                        id: 'cancel_shopping',
                        title: '❌ Cancel',
                        description: 'Stop shopping for now'
                    }
                ]
            });
        } else {
            // Trim last section to make room for cancel
            const lastSection = normalizedSections[normalizedSections.length - 1];
            lastSection.rows = lastSection.rows.slice(0, lastSection.rows.length - 1);
            normalizedSections.push({
                title: "Actions",
                rows: [
                    {
                        id: 'cancel_shopping',
                        title: '❌ Cancel',
                        description: 'Stop shopping for now'
                    }
                ]
            });
        }
    }

    return normalizedSections;
}

function makeSubcategoriesListResponse(subs, subcategoryCounts, selectedParent) {
    const body = `*${selectedParent}*:\n\nPlease select a subcategory.`;
    const buttonText = "Select Subcategory";
    const sections = withInlineCancelSection([
        {
            title: "Subcategories",
            rows: subs.slice(0, 9).map((sub, sIdx) => {
                const capSub = sub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                return {
                    id: String(sIdx + 1),
                    title: capSub.substring(0, 24),
                    description: `${subcategoryCounts[sub]} items available`
                };
            })
        }
    ]);
    return {
        sendList: { body, buttonText, sections },
        sendImages: [],
        listContext: { type: 'subcategories', data: subs, selectedParentCategory: selectedParent }
    };
}

async function showCartSummaryWithCrossSell(session, products) {
    let cartSummary = `🛒 *Your Cart Summary:*\n\n`;
    let totalQty = 0;
    let totalAmount = 0;

    const cart = session.cart || [];
    cart.forEach((item, i) => {
        const itemTotal = Number(item.price) * (item.qty || 1);
        cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.product || item.name} (${item.size}) - Qty: ${item.qty || 1} - ₹${itemTotal}\n`;
        totalQty += (item.qty || 1);
        totalAmount += itemTotal;
    });
    cartSummary += `\n📦 *Total Quantity:* ${totalQty}`;
    cartSummary += `\n💰 *Total Amount:* ₹${totalAmount}\n\n`;

    if (session.crossSellShown || session.cartCrossSellShown) {
        session.state = "AWAITING_CART_SUMMARY_DECISION";
        session.crossSellOptionAvailable = false;
        return {
            sendButtons: {
                body: cartSummary + `What would you like to do next?`,
                buttons: [
                    { id: 'shop_more', title: '🛍️ Shop More' },
                    { id: 'continue_checkout', title: '🛒 Checkout' },
                    { id: 'cancel_order', title: '❌ Cancel' }
                ]
            },
            sendImages: []
        };
    }

    let bodyText = cartSummary + `🔥 *Matching Offers Available!*\n`;

    let promoCategory = 'Pants';
    let offerLabel = 'Matching Styles';
    let related = [];
    if (cart.length > 0) {
        const lastItem = cart[cart.length - 1];
        const matchedProduct = products.find(p => String(p.id) === String(lastItem.id))
            || products.find(p => p.name === lastItem.name)
            || products.find(p => p.name === lastItem.product);
        if (matchedProduct) {
            const excludedIds = cart.map(item => item.id);
            const offer = getCrossSellOffer(matchedProduct, products, excludedIds);
            if (offer) {
                promoCategory = offer.promoCategory;
                offerLabel = offer.offerLabel;
                related = offer.candidates;
            }
        }
    }

    if (related.length === 0) {
        session.state = "AWAITING_CART_SUMMARY_DECISION";
        session.crossSellOptionAvailable = false;
        return {
            sendButtons: {
                body: cartSummary + `What would you like to do next?`,
                buttons: [
                    { id: 'shop_more', title: '🛍️ Shop More' },
                    { id: 'continue_checkout', title: '🛒 Checkout' },
                    { id: 'cancel_order', title: '❌ Cancel' }
                ]
            },
            sendImages: []
        };
    }

    bodyText += `We have special deals on matching *${promoCategory}* matching your selection. Tap "Shop ${promoCategory}" to view and buy them! 👇`;

    const promoCandidates = related.slice(0, 2);
    let collageUrl = null;
    if (promoCandidates.length >= 2) {
        collageUrl = await createRecommendationCollage(promoCandidates[0], promoCandidates[1], 1, products);
    } else if (promoCandidates.length === 1) {
        collageUrl = getProductImageUri(promoCandidates[0], products);
    }

    session.state = "AWAITING_CART_SUMMARY_DECISION";
    session.crossSellPromoCategory = promoCategory;
    session.crossSellOfferLabel = offerLabel;
    session.crossSellProductIds = related.slice(0, 20).map(p => p.id);
    session.crossSellOptionAvailable = true;
    session.cartCrossSellShown = true;

    const shopBtnLabel = `🛍️ Shop ${promoCategory}`;

    return {
        sendButtons: {
            body: bodyText,
            buttons: [
                { id: 'view_matches', title: shopBtnLabel },
                { id: 'continue_checkout', title: '🛒 Checkout' },
                { id: 'cancel_order', title: '❌ Cancel' }
            ]
        },
        sendImages: collageUrl ? [{ url: collageUrl, caption: `Matching ${promoCategory} Deals` }] : []
    };
}

async function getStatePrompt(session, products) {
    switch (session.state) {
        case "AWAITING_SUBCATEGORY_SELECTION": {
            const subs = session.subCategories || [];
            if (session.selectedParentCategory) {
                const subcategoryCounts = {};
                products.forEach(p => {
                    if (Number(p.stock) > 0 && subs.includes(p.category)) {
                        subcategoryCounts[p.category] = (subcategoryCounts[p.category] || 0) + 1;
                    }
                });
                return makeSubcategoriesListResponse(subs, subcategoryCounts, session.selectedParentCategory);
            }
            return goToTopCategoryMenu(session, products);
        }
        case "AWAITING_MODEL_SELECTION": {
            const selectedSub = session.selectedSubCategory;
            const emoji = getCategoryEmoji(session.selectedParentCategory || '');
            const capSub = selectedSub ? selectedSub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Products';

            let replyText = `${emoji} *${capSub}:*\n\n`;
            session.searchProducts.forEach((p, pIdx) => {
                let displayName = p.name;
                if (p.color && !displayName.toLowerCase().includes(p.color.toLowerCase())) {
                    displayName = `${p.color} ${displayName}`;
                }
                replyText += `*${pIdx + 1}.* ${displayName}\n`;
                replyText += `   💰 ₹${p.price}  |  📦 Stock: ${p.stock}\n\n`;
            });
            replyText += `Please reply with the product number.`;

            return {
                replyText,
                sendImages: [],
                listContext: { type: 'products', data: session.searchProducts, selectedSubCategory: selectedSub, selectedParentCategory: session.selectedParentCategory }
            };
        }
        case "AWAITING_SIZE_SELECTION": {
            const product = session.pendingProduct;
            if (!product) return { replyText: "Please select a category to start shopping.", sendImages: [] };
            const sizeList = (Array.isArray(product.sizes)
                ? product.sizes
                : String(product.sizes).split(',').map(s => s.trim())
            ).filter(Boolean);
            const sizesText = sizeList.map(s => `* ${s.toUpperCase()}`).join('\n');
            const replyText = `${product.color ? product.color + ' ' : ''}${product.name}\n💰 ₹${product.price}\n📦 Stock: ${product.stock} pcs\n\n📐 Available Sizes:\n${sizesText}\n\nPlease select your preferred size.`;

            return {
                replyText,
                sendImages: [{ url: getProductImageUri(product, products), caption: product.name }],
                pendingProduct: product
            };
        }
        case "AWAITING_RECOMMENDATION_CHOICE": {
            return await prepareRecommendationResponse(session, products);
        }
        case "AWAITING_CART_CONFIRM": {
            const product = session.pendingProduct;
            if (!product) return { replyText: "Please select a category to start shopping.", sendImages: [] };
            return {
                sendButtons: {
                    body: `✅ ${product.name} - ${session.selectedSize}\n\nWould you like to add this item to your cart?`,
                    buttons: [
                        { id: 'yes', title: '✅ YES' },
                        { id: 'no', title: '❌ NO' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_POST_ADD_TO_CART_DECISION": {
            return {
                sendButtons: {
                    body: `✅ *Item added to cart.*\n\nWhat would you like to do next?`,
                    buttons: [
                        { id: 'choose_same_cat', title: '🔄 Same Category' },
                        { id: 'continue_diff_cat', title: '🛍️ Other Category' },
                        { id: 'cart_summary', title: '🛒 Checkout' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_CART_SUMMARY_DECISION": {
            return await showCartSummaryWithCrossSell(session, products);
        }
        case "AWAITING_MORE_ITEMS": {
            return {
                sendButtons: {
                    body: `Would you like to continue shopping?`,
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
                cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.product || item.name} (${item.size}) - Qty: ${item.qty || 1} - ₹${Number(item.price) * (item.qty || 1)}\n`;
            });
            const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price) * (item.qty || 1), 0);
            cartSummary += `\n💰 Total: ₹${cartTotal}\n\n🛒 You have an unfinished order in your cart.\n\nPlease choose an option below:`;
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
        case "AWAITING_CHECKOUT_USE_SAVED_ADDRESS": {
            let cartSummary = `🛒 *Your Cart:*\n\n`;
            session.cart.forEach((item, i) => {
                cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.product || item.name} (${item.size}) - Qty: ${item.qty || 1} - ₹${Number(item.price) * (item.qty || 1)}\n`;
            });
            const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price) * (item.qty || 1), 0);
            cartSummary += `\n💰 Total: ₹${cartTotal}\n\n`;

            return {
                sendButtons: {
                    body: `${cartSummary}We found a saved address from your previous order:\n\n👤 *Name:* ${session.orderDetails?.customerName}\n📞 *Phone:* ${session.orderDetails?.customerPhone}\n🏠 *Address:* ${session.orderDetails?.customerAddress}\n\nWould you like to use this saved address?`,
                    buttons: [
                        { id: 'use_saved_yes', title: '✅ Yes, Use Saved' },
                        { id: 'use_saved_no', title: '✍️ Enter New Address' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_CHECKOUT_NAME": {
            return {
                sendButtons: {
                    body: "👤 Please enter your *Full Name*:",
                    buttons: [
                        { id: 'cancel_shopping', title: '❌ Cancel' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_CHECKOUT_PHONE": {
            return {
                sendButtons: {
                    body: `👤 Name: *${session.orderDetails?.customerName || ''}*\n\n📞 Please enter your *Mobile Number* or choose to use your current WhatsApp number:`,
                    buttons: [
                        { id: 'use_current_phone', title: '📱 Use Current Number' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_CHECKOUT_PINCODE": {
            return {
                sendButtons: {
                    body: "📍 Please enter your 6-digit *Delivery Pincode* (e.g. 642126):",
                    buttons: [
                        { id: 'cancel_shopping', title: '❌ Cancel' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_CHECKOUT_ADDRESS": {
            return {
                sendButtons: {
                    body: "🏠 Please enter your *Delivery Address* (Door No, Street Name, Area/City):",
                    buttons: [
                        { id: 'cancel_shopping', title: '❌ Cancel' }
                    ]
                },
                sendImages: []
            };
        }
        case "AWAITING_PRODUCT_SIZE": {
            // Reachable here only via indirect callers (e.g. CHECKOUT/FAQ "continue shopping"
            // reminders) re-rendering whatever the customer was last doing — the main flow renders
            // size prompts directly via renderSizePrompt/enqueueProductsForOrdering instead.
            const entry = getMostRecentPending(session, 'AWAITING_PRODUCT_SIZE');
            if (!entry) return { replyText: "Please select a category to start shopping.", sendImages: [] };
            return await renderSizePrompt(entry, null, products);
        }
        case "AWAITING_PRODUCT_QTY": {
            const entry = getMostRecentPending(session, 'AWAITING_PRODUCT_QTY');
            if (!entry) return { replyText: "Please select a category to start shopping.", sendImages: [] };
            return renderQtyPrompt(entry);
        }
        case "AWAITING_ORDER_CONFIRMATION": {
            let summaryText = `🛒 *Order Summary:*\n\n`;
            let total = 0;
            const cartItems = session.cart || [];
            cartItems.forEach(item => {
                const itemTotal = Number(item.price) * (item.qty || 1);
                total += itemTotal;
                summaryText += `• ${item.product || item.name} (${item.size}) - Qty: ${item.qty || 1} - ₹${itemTotal}\n`;
            });
            summaryText += `\n💰 *Total:* ₹${total}\n\n`;
            if (session.orderDetails) {
                summaryText += `👤 *Name:* ${session.orderDetails.customerName}\n`;
                summaryText += `📞 *Phone:* ${session.orderDetails.customerPhone}\n`;
                summaryText += `🏠 *Address:* ${session.orderDetails.customerAddress}\n\n`;
            }
            return {
                replyText: summaryText,
                sendImages: [],
                sendButtons: {
                    body: `Is this information correct?`,
                    buttons: [
                        { id: 'confirm_order_yes', title: '✅ Yes, Place Order' },
                        { id: 'confirm_order_cancel', title: '❌ Cancel' }
                    ]
                }
            };
        }
        default: {
            return goToTopCategoryMenu(session, products);
        }
    }
}

function getShortProductName(p) {
    let name = p.name || '';
    const parenMatch = name.match(/\(([^)]+)\)/);
    if (parenMatch) {
        return parenMatch[1].trim();
    }
    if (p.color && p.color !== 'null' && p.color !== 'undefined') {
        return p.color.trim();
    }
    return name.trim();
}

// Builds one cta_url card per matched product — image header (that product's own photo), body
// text (name/color + price + sizes), and a "See More" button linking straight to that
// product's own page. Falls back to the product's category page (lib/categoryUrls.js) when a
// product has no permalink (sync gap), logging a warning, so a missing field never sends a
// broken link. Every matched product gets a card in one go — there's no pagination, so there's
// nothing to page through.
function buildProductCardsResponse(productsPool, products, queryLabel) {
    const cards = products.map(p => {
        let url = p.permalink;
        if (!url) {
            console.warn(`[ProductCards] Product ${p.id} ("${p.name}") has no permalink — falling back to category URL`);
            url = getCategoryUrl(p.category);
        }

        const colorPrefix = p.color ? `${p.color} ` : '';
        let body = `*${colorPrefix}${p.name}*\n💰 ₹${p.price}`;
        const sizeList = (Array.isArray(p.sizes) ? p.sizes : []).filter(Boolean);
        if (sizeList.length > 0) {
            body += `\n📐 Sizes: ${sizeList.map(s => String(s).toUpperCase()).join(' ')}`;
        }

        return {
            imageUrl: getProductImageUri(p, productsPool),
            body,
            buttonText: 'See More',
            url
        };
    });

    return {
        replyText: `👔 *${queryLabel}*`,
        sendProductCards: cards,
        sendImages: []
    };
}

// When ctaOptions is passed (only by the subcategory-browsing call sites — enterSubCategoryByIndex
// and the AWAITING_SUBCATEGORY_SELECTION number handler), this sends a representative collage
// preview alongside a single cta_url button to that subcategory's page on supercollections.in.
// Every other caller — search results AND plain category-browsing alike — renders the full match
// list as individual product cards (see buildProductCardsResponse): no pagination, since
// WhatsApp's interactive list message (the old UI this replaced for category-browsing) caps out
// at 10 rows and cards have no such limit.
async function prepareProductsPageResponse(session, productsPool, queryLabel, ctaOptions = null) {
    const allProducts = session.searchProducts || [];

    if (allProducts.length === 0) {
        return {
            replyText: "No products were found. 😔",
            sendImages: []
        };
    }

    if (!ctaOptions) {
        return buildProductCardsResponse(productsPool, allProducts, queryLabel);
    }

    // Collage is just a visual preview alongside the website link — capped at 9 products since
    // it was never paginated to begin with (ctaOptions never exposed Next/Prev buttons).
    const previewProducts = allProducts.slice(0, 9);
    console.log('[Collage] Order going into createProductCollage:', previewProducts.map((p, i) => `${i + 1}=${p.color || ''} ${p.name}`.trim()));
    // Include the ordered product IDs in the cache key so a cache hit only ever serves a
    // collage that was built from this exact same product order — if the underlying products
    // array order ever drifts between requests, the key changes and the collage regenerates
    // instead of silently showing a stale order that no longer matches the list below.
    const orderSignature = crypto.createHash('md5').update(previewProducts.map(p => p.id).join(',')).digest('hex').substring(0, 12);
    // COLLAGE_CACHE_VERSION is prefixed into the key so changing how createProductCollage()
    // renders (e.g. removing the number badges) automatically invalidates every previously
    // cached row instead of silently keeping stale-looking collages alive — bump this
    // whenever the visual output of that function changes again. Old rows under the
    // previous prefix just become unreachable dead rows; no manual cache-clearing needed.
    const COLLAGE_CACHE_VERSION = 'v2';
    const cacheKey = COLLAGE_CACHE_VERSION + '_' + (session.selectedSubCategory || '').toLowerCase().replace(/\s+/g, '_') + '_preview_' + orderSignature;
    let collageUrl = null;
    if (session.selectedSubCategory) {
        const { data: cachedCollage } = await supabase
            .from('collage_cache')
            .select('collage_url')
            .eq('cache_key', cacheKey)
            .maybeSingle();
        if (cachedCollage?.collage_url) {
            console.log(`[Collage] Cache HIT: ${cacheKey}`);
            collageUrl = cachedCollage.collage_url;
        }
    }
    if (!collageUrl) {
        console.log(`[Collage] Cache MISS: ${cacheKey}, generating...`);
        collageUrl = await createProductCollage(previewProducts, 1, productsPool);
        if (collageUrl && session.selectedSubCategory) {
            try {
                const { error } = await supabase
                    .from('collage_cache')
                    .upsert(
                        { cache_key: cacheKey, collage_url: collageUrl },
                        { onConflict: 'cache_key' }
                    );

                if (error) {
                    console.warn('[Collage] Cache save failed:', error.message);
                }
            } catch (err) {
                console.warn('[Collage] Cache save failed:', err.message);
            }
        }
    }

    const displayName = ctaOptions.subCategoryDisplayName;
    const url = getCategoryUrl(session.selectedSubCategory || displayName);
    let buttonText = `Shop ${displayName}`;
    if (buttonText.length > 20) buttonText = 'Shop Now';

    return {
        sendImages: collageUrl ? [{ url: collageUrl, caption: displayName }] : [],
        sendCtaUrl: {
            body: displayName,
            buttonText,
            url
        }
    };
}

// Static FAQ-style replies for the "Order Help" submenu (placeholders — wording to be customized later).
async function handleOrderHelpChoice(choice, customerPhone) {
    const followUp = "\n\nNeed more help? Reply 4 to talk to our team, or type 'menu' to go back to shopping.";

    switch (choice) {
        case '1':
            console.log('[OrderHelp] Order Status FAQ sent to', customerPhone);
            return {
                replyText: `📦 *Order Status*\n\nPlease share your Order ID and we'll check the latest status for you.${followUp}`,
                sendImages: []
            };
        case '2':
            console.log('[OrderHelp] Returns & Exchange FAQ sent to', customerPhone);
            return {
                replyText: `🔄 *Returns & Exchange*\n\nWe offer a 7-day return and exchange policy. Please share your Order ID and a photo of the product to start the process.${followUp}`,
                sendImages: []
            };
        case '3':
            console.log('[OrderHelp] Delivery Time FAQ sent to', customerPhone);
            return {
                replyText: `🚚 *Delivery Time*\n\nOrders are usually delivered within 7 working days.${followUp}`,
                sendImages: []
            };
        case '4': {
            console.log('[OrderHelp] Talk to team — contact number sent to', customerPhone);
            const contactNumber = process.env.STORE_CONTACT_NUMBER || '+91-XXXXXXXXXX';
            return {
                replyText: `🙋 Our team will assist you! Contact us directly here: ${contactNumber}`,
                sendImages: []
            };
        }
        default:
            return {
                replyText: "⚠️ Please reply with a number between 1 and 4.",
                sendImages: []
            };
    }
}

// Common shirt/pant colors recognized in free-text product queries (see SEARCH case below) —
// distinguishes a generic category mention ("plain shirt iruka") from a specific color/variant
// request ("plain shirt cream") so the right reply (category page vs. exact product page) goes out.
const COLOR_KEYWORDS = ['cream', 'white', 'black', 'blue', 'navy', 'grey', 'gray', 'maroon', 'green',
    'beige', 'pink', 'yellow', 'red', 'orange', 'brown', 'purple', 'mustard', 'khaki', 'wine', 'olive'];

// Size/quantity words a customer tacks onto a search query (e.g. "stripe t shirts xl size") —
// these never describe a category/pattern/color, so makeSearchTerms strips them out before the
// "genuine unmatched term" check runs (see hasUnmatchedTerm below); without this, "xl"/"size"
// don't match anything in the catalog and used to get flagged as a missing-product signal,
// wrongly triggering the out-of-stock reply for an otherwise perfectly findable item.
const SIZE_KEYWORDS = new Set(['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '2xl', '3xl', '4xl',
    'size', 'sizes', 'saiz']);

// Generic product-type words — describe WHAT KIND of garment, not which specific
// category/pattern/color. See the cross-group conflict check in the SEARCH case below:
// AND-requiring one of these on the same product as a specific style word (e.g. "stripe") used to
// either let a coincidental match on an unrelated category win (e.g. "Brand T Shirt"), or — after
// an earlier fix — silently drop the generic word and show whichever OTHER top-level group the
// pattern happens to exist in (e.g. "Stripes Shirts", under "Shirts" — a different group than the
// "T-Shirts" the customer explicitly named). Neither is right: when the customer explicitly names
// a group via one of these words, a pattern that doesn't exist in THAT group should never be
// silently redirected into a different one.
const GENERIC_PRODUCT_WORDS = new Set(['shirt', 'shirts', 'tshirt', 'pant', 'short', 'shorts', 'jeans', 'trouser']);

// Maps a generic product-type term to the parent category group the customer explicitly named by
// using it — e.g. "tshirt" unambiguously means the T-Shirts group specifically, not generic
// "Shirts". Used only by the cross-group conflict check below.
const GENERIC_TERM_TO_PARENT = {
    shirt: 'Shirts', shirts: 'Shirts',
    tshirt: 'T-Shirts',
    pant: 'Pants', jeans: 'Pants', trouser: 'Pants',
    short: 'Shorts', shorts: 'Shorts'
};

// Display emoji/name per parent group for the cross-group conflict reply. "Shirts" gets a
// "(formal)" suffix specifically because that's the exact ambiguity this reply exists to resolve —
// customers say "shirt" colloquially for either Shirts or T-Shirts.
const PARENT_GROUP_DISPLAY = {
    'Shirts': { emoji: '🎨', name: 'Shirts (formal)' },
    'T-Shirts': { emoji: '👕', name: 'T-Shirts' },
    'Pants': { emoji: '👖', name: 'Pants' },
    'Shorts': { emoji: '🩳', name: 'Shorts' }
};

// A handful of style/pattern words need their adjective form spelled out for the reply text
// ("stripe" -> "Striped"); everything else not listed here is already adjective-shaped (plain,
// printed, cotton, polo, casual, checked, ...) and just needs capitalizing.
const PATTERN_DISPLAY_NAME = { stripe: 'Striped', stripes: 'Striped' };

// Built when a specific style/pattern term (e.g. "stripe") doesn't exist within the group the
// customer explicitly named (e.g. "T-Shirts"), but DOES exist in a different group (e.g.
// "Shirts") — see the SEARCH case's cross-group conflict check. Names both: where the pattern
// actually exists, and the general group the customer originally asked about.
function buildCrossGroupConflictReply(specificTerms, actualCategory, requestedParent) {
    const patternDisplay = specificTerms
        .map(t => PATTERN_DISPLAY_NAME[t] || (t.charAt(0).toUpperCase() + t.slice(1)))
        .join(' ');
    const actualParent = getParentCategory(actualCategory);
    const actualLabel = actualParent === 'Shirts' ? `${actualCategory} (formal)` : actualCategory;
    const requestedDisplay = PARENT_GROUP_DISPLAY[requestedParent] || { emoji: '🛍️', name: requestedParent };

    const replyText = `😔 Sorry, we don't have ${patternDisplay} ${requestedDisplay.name.replace(' (formal)', '')} currently.\n\n` +
        `But we do have:\n` +
        `🎨 ${actualLabel} 👉 ${getCategoryUrl(actualCategory)}\n` +
        `${requestedDisplay.emoji} ${requestedDisplay.name.replace(' (formal)', '')} collection 👉 ${getCategoryUrl(requestedParent)}\n\n` +
        `Check these out, might find something you like! 😊`;

    return { replyText, sendImages: [] };
}

// Product Availability Check, Scenario B (exact category + color match) — replies with that one
// product's own image/price and a button straight to its own page. Returned as a declarative
// reply object (sendProductCards) so the existing dispatcher sends it via sendProductCtaCard,
// the same cta_url path every other product card already goes through.
function buildSpecificProductReply(product, productsPool) {
    const colorPrefix = product.color ? `${product.color} ` : '';
    let url = product.permalink;
    if (!url) {
        console.warn(`[ProductAvailability] Product ${product.id} ("${product.name}") has no permalink — falling back to category URL`);
        url = getCategoryUrl(product.category);
    }
    return {
        replyText: null,
        sendImages: [],
        sendProductCards: [{
            imageUrl: getProductImageUri(product, productsPool),
            body: `*${colorPrefix}${product.name}*\n💰 ₹${product.price}`,
            buttonText: 'View & Buy 🛒',
            url
        }]
    };
}

// Product Availability Check, Scenario A (category mentioned with no color, or a mentioned color
// that isn't in stock) — replies "Yes, available" with one sample in-stock product's image and a
// button to that category's page on the website. Never lists products in chat text.
function buildCategoryAvailableReply(sampleProduct, productsPool) {
    const categoryName = sampleProduct.category || 'this category';
    const capName = categoryName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    return {
        replyText: null,
        sendImages: [],
        sendProductCards: [{
            imageUrl: getProductImageUri(sampleProduct, productsPool),
            body: `Yes, available ✅\n\n👔 *${capName}*`,
            buttonText: 'See More Colours 👀',
            url: getCategoryUrl(categoryName)
        }]
    };
}

// Finds one in-stock product representing a TOP_CATEGORY_MENU_NAMES entry, for the
// AWAITING_TOP_CATEGORY_SELECTION handler to feed into buildCategoryAvailableReply (Scenario A)
// above. getParentCategory() alone can't tell "Pants" apart from "Track Pants" (both classify as
// 'Pants' there, since the flat subcategory sort only needed Shirts/T-Shirts/Pants/Shorts
// buckets) — isTrackOrCargoPant mirrors the same track/cargo/jogger/trouser check getCrossSellOffer
// already uses to split that group for cross-sell purposes.
const isTrackOrCargoPant = (p) => {
    const cat = (p.category || '').toLowerCase();
    const name = (p.name || '').toLowerCase();
    return cat.includes('track') || cat.includes('trach') || cat.includes('cargo') ||
        name.includes('track') || name.includes('trach') || name.includes('cargo') ||
        isCargoTrackPant(p) || isTrouser(p) || isJogger(p);
};

function findSampleProductForTopCategory(categoryName, products) {
    const inStock = products.filter(p => Number(p.stock) > 0);
    switch (categoryName) {
        case 'Shirts':
            return inStock.find(p => getParentCategory(p.category) === 'Shirts');
        case 'T-Shirts':
            return inStock.find(p => getParentCategory(p.category) === 'T-Shirts');
        case 'Pants':
            return inStock.find(p => getParentCategory(p.category) === 'Pants' && !isTrackOrCargoPant(p));
        case 'Track Pants':
            return inStock.find(p => getParentCategory(p.category) === 'Pants' && isTrackOrCargoPant(p));
        case 'Imported Shorts':
            return inStock.find(p => getParentCategory(p.category) === 'Shorts');
        case 'Men':
            return inStock.find(p => getParentCategory(p.category) === 'Men');
        case 'New Arrivals':
            return inStock.find(p => getParentCategory(p.category) === 'New Arrivals');
        default:
            return undefined;
    }
}

// Sets up the session for the numbered flat-subcategory-list flow and builds that list for one
// parent category — shared by the CATEGORY case below and by SEARCH's ambiguous-generic-term
// fallback (see GENERIC_PRODUCT_WORDS in the SEARCH case), so both routes into this same flow use
// one implementation instead of two drifting copies.
function showSubcategoryListForParent(selectedParent, products, session) {
    session.selectedParentCategory = selectedParent;
    session.state = "AWAITING_SUBCATEGORY_SELECTION";
    session.pendingProduct = null;
    session.selectedSize = null;
    session.searchProducts = [];
    session.lastRecommendation = null;
    session.isRecommendation = false;
    session.fromCrossSell = false;
    session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
    session.cartCrossSellShown = false;

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

    return makeSubcategoriesListResponse(subs, subcategoryCounts, selectedParent);
}

async function handleIntent(intentResult, session, products, from) {
    switch (intentResult.type) {
        case 'ORDER_DELIVERY_COMPLAINT': {
            const { orderRowId, orderDisplayNumber } = intentResult;
            console.log(`[OrderComplaint] ⚠️ ${from} reported order ${orderRowId || '(unknown — free-text complaint, no order id attached)'} as NOT delivered — flagging for review.`);
            if (orderRowId) {
                try {
                    const { error } = await supabase
                        .from('orders')
                        .update({ delivery_complaint_at: new Date().toISOString() })
                        .ilike('id', orderRowId);
                    if (error) {
                        console.error('[OrderComplaint] ❌ Failed to flag order in Supabase:', error.message);
                    }
                } catch (err) {
                    console.error('[OrderComplaint] ❌ Unexpected error flagging order:', err.message);
                }
            }
            const orderRef = orderDisplayNumber ? ` (#${orderDisplayNumber})` : '';
            // Free-text complaint (no order id attached): give direct contact numbers.
            // Button-reply complaint (specific order id): flag the row and give the old reply.
            if (!orderRowId) {
                return {
                    replyText: `😔 Sorry to hear that!\nPlease contact our team directly:\n📞 +91 8668066503\n📞 +91 7418755096`,
                    sendImages: []
                };
            }
            return {
                replyText: `😔 Sorry to hear that! We've flagged your order${orderRef} for review. Our team will contact you shortly to resolve this. 🙏`,
                sendImages: []
            };
        }
        case 'CANCEL_SHOPPING': {
            if (session.cart && session.cart.length > 0) {
                // Change 2: You have items pending in your cart
                session.state = "AWAITING_CANCEL_PENDING_DECISION";
                let cartSummary = `🛒 *Pending Items in Cart:*\n\n`;
                session.cart.forEach((item, i) => {
                    cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.product || item.name} (${item.size}) - Qty: ${item.qty || 1} - ₹${Number(item.price) * (item.qty || 1)}\n`;
                });
                const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price) * (item.qty || 1), 0);
                cartSummary += `\n💰 Total: ₹${cartTotal}\n\n`;

                return {
                    sendButtons: {
                        body: `⚠️ *You have items pending in your cart.*\n\n${cartSummary}Would you like to checkout, continue shopping, or clear the cart and exit?`,
                        buttons: [
                            { id: 'cancel_continue_shopping', title: '🛍️ Continue Shopping' },
                            { id: 'cancel_checkout', title: '🛒 Checkout' },
                            { id: 'cancel_clear_exit', title: '❌ Clear Cart & Exit' }
                        ]
                    },
                    sendImages: []
                };
            } else {
                // Change 1: Shopping cancelled.
                session.state = "AWAITING_CANCEL_NO_CART_DECISION";
                session.pendingProduct = null;
                session.selectedSize = null;
                session.selectedColor = null;
                session.searchProducts = [];
                session.isRecommendation = false;
                session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
                session.cartCrossSellShown = false;
                session.fromCrossSell = false;
                session.orderingQueue = [];
                session.pendingSelections = {};
                session.pendingOrder = [];
                session.subCategories = null;
                session.selectedParentCategory = null;
                session.selectedSubCategory = null;
                session.lastRecommendation = null;
                session.awaitingRecommendationResponse = false;
                session.awaitingCartAdditionConfirmation = false;

                return {
                    sendButtons: {
                        body: `Shopping cancelled.`,
                        buttons: [
                            { id: 'cancel_continue_shopping', title: '🛍️ Continue Shopping' },
                            { id: 'cancel_exit_shopping', title: '❌ Exit' }
                        ]
                    },
                    sendImages: []
                };
            }
        }
        case 'SHOP_MORE': {
            session.pendingProduct = null;
            session.selectedSize = null;
            session.fromCrossSell = false;
            return goToTopCategoryMenu(session, products);
        }
        case 'ORDER_HELP': {
            session.awaitingOrderHelpChoice = false;
            return {
                replyText: "Please type your order details here. We will check and help you with your order.",
                sendImages: []
            };
        }
        case 'CUSTOMER_SUPPORT': {
            return {
                replyText: CUSTOMER_SUPPORT_MESSAGE,
                sendImages: []
            };
        }
        case 'ORDER_GUIDANCE_VIDEO': {
            if (!ORDER_GUIDANCE_VIDEO_ENABLED) {
                return {
                    replyText: "Order guidance video is currently unavailable.",
                    sendImages: []
                };
            }
            try {
                await sendVideoGuideCard(from);
                await logChatMessage(from, 'bot', ORDER_GUIDANCE_VIDEO_FALLBACK);
                return {
                    replyText: "Order guidance video shared above.",
                    sendImages: []
                };
            } catch (err) {
                console.error('[OrderGuidanceVideo] Failed to send video guide card:', JSON.stringify(err.response?.data || err.message, null, 2));
                return {
                    replyText: ORDER_GUIDANCE_VIDEO_FALLBACK,
                    sendImages: []
                };
            }
        }
        case 'LOCATION': {
            try {
                await sendLocationCard(from);
                await logChatMessage(from, 'bot', 'Store Location\n127 Srinivasa Street, Udumalpet - 642126');
                return {
                    replyText: "Store location shared above.",
                    sendImages: []
                };
            } catch (err) {
                console.error('[Location] Failed to send location card:', JSON.stringify(err.response?.data || err.message, null, 2));
                return {
                    replyText: "Store Location\n127 Srinivasa Street, Udumalpet - 642126",
                    sendImages: []
                };
            }
        }
        case 'ORDER_HELP_CHOICE': {
            // Keep the flag armed after 1-3 so the customer can immediately type another digit
            // (the FAQ reply text itself invites this: "Reply 4 to talk to our team"). Only
            // choice 4 (terminal — hands off to a human) clears it.
            session.awaitingOrderHelpChoice = intentResult.choice !== '4';
            console.log('[IntroMenu] Order Help choice selected:', intentResult.choice, 'for', from);
            return await handleOrderHelpChoice(intentResult.choice, from);
        }
        case 'CLEAR_CART': {
            session.cart = [];
            session.pendingProduct = null;
            session.selectedSize = null;
            session.searchProducts = [];
            session.isRecommendation = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            session.fromCrossSell = false;

            return goToTopCategoryMenu(session, products, "Your cart has been cleared. 😊");
        }
        case 'HUMAN': {
            return {
                replyText: "Sure! 🙋‍♂️ We have paused the chat assistant. Our representative will connect with you shortly.",
                sendImages: [],
                isHumanHandoff: true
            };
        }
        case 'THANKS': {
            return {
                replyText: "🙏 You're welcome! Happy shopping with Super Collections. Type *menu* anytime to browse more, or *order help* for order questions. 😊",
                sendImages: []
            };
        }
        case 'CHECKOUT': {
            if (!session.cart || session.cart.length === 0) {
                let replyText = "Your cart is empty. 😊 Please add products to your cart first.";
                if (!isAtTopLevelMenu(session)) {
                    const statePrompt = await getStatePrompt(session, products);
                    if (statePrompt.replyText) {
                        replyText += `\n\nFeel free to continue shopping: 😊\n\n${statePrompt.replyText}`;
                    } else {
                        replyText += `\n\nFeel free to continue shopping: 😊`;
                    }
                    return {
                        replyText,
                        sendImages: statePrompt.sendImages || [],
                        sendButtons: statePrompt.sendButtons || null,
                        sendList: statePrompt.sendList || null,
                        listContext: statePrompt.listContext || null
                    };
                }
                return { replyText, sendImages: [] };
            }
            session.fromCrossSell = false;
            return await startCheckout(session, from, products);
        }
        case 'FAQ': {
            let replyText = intentResult.reply;
            // Only drag the current step's prompt back into the reply when the customer is mid
            // multi-step input (checkout, size/qty, order confirmation) — there's nothing they
            // still owe the bot while just browsing a category/product list, so re-dumping the
            // subcategory menu after a plain FAQ answer is unnecessary noise.
            if (!isAtTopLevelMenu(session) && !isPassivelyBrowsing(session)) {
                const statePrompt = await getStatePrompt(session, products);
                if (statePrompt.replyText) {
                    replyText += `\n\nFeel free to continue shopping: 😊\n\n${statePrompt.replyText}`;
                } else {
                    replyText += `\n\nFeel free to continue shopping: 😊`;
                }
                return {
                    replyText,
                    sendImages: statePrompt.sendImages || [],
                    sendButtons: statePrompt.sendButtons || null,
                    sendList: statePrompt.sendList || null,
                    listContext: statePrompt.listContext || null
                };
            }
            return { replyText, sendImages: [] };
        }
        case 'GREETING': {
            session.fromCrossSell = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            session.awaitingOrderHelpChoice = false;
            if (session.cart && session.cart.length > 0) {
                session.state = "AWAITING_PENDING_CART_DECISION";
                return await getStatePrompt(session, products);
            }
            session.pendingProduct = null;
            session.selectedSize = null;
            session.lastRecommendation = null;
            session.selectedSubCategory = null;
            session.isRecommendation = false;

            console.log('[IntroMenu] Greeting detected — showing main menu for', from);
            session.state = "AWAITING_MAIN_MENU_SELECTION";
            return {
                replyText: MAIN_MENU_TEXT,
                sendImages: []
            };
        }
        case 'MAIN_MENU_SELECT': {
            // The customer listed more than one number at once (e.g. "1,2 & 3") — we've already
            // acted on the first (intentResult.choice), so just append a note instead of either
            // spamming every option back-to-back or rejecting the whole message as unparseable.
            const note = intentResult.multipleFound ? `\n\n${MULTIPLE_CATEGORY_NOTE}` : '';
            const link = CATEGORY_LINKS[intentResult.choice];
            if (link) {
                return {
                    replyText: `${link.emoji} *${link.name} Collection*\nCheck out all our ${link.label} here 👇\n${link.url}${note}`,
                    sendImages: []
                };
            }
            if (intentResult.choice === '7') {
                const helpResponse = await handleIntent({ type: 'ORDER_HELP' }, session, products, from);
                if (note && helpResponse?.replyText) helpResponse.replyText += note;
                return helpResponse;
            }
            if (intentResult.choice === '8') {
                const supportResponse = await handleIntent({ type: 'CUSTOMER_SUPPORT' }, session, products, from);
                if (note && supportResponse?.replyText) supportResponse.replyText += note;
                return supportResponse;
            }
            if (intentResult.choice === '9') {
                return {
                    replyText: SIZE_GUIDE_TEXT + note,
                    sendImages: []
                };
            }
            return { replyText: MAIN_MENU_TEXT, sendImages: [] };
        }
        case 'CATEGORY': {
            const categoryCounts = getCategoryCounts(products);
            const parents = getSortedParents(categoryCounts);
            const selectedParent = matchParentCategory(intentResult.category, parents);

            if (selectedParent) {
                return showSubcategoryListForParent(selectedParent, products, session);
            }
            // If match fails, fall through to SEARCH
        }
        case 'SEARCH': {
            const query = intentResult.query || intentResult.category || '';

            // Extract price ceiling before cleaning
            let maxPrice = null;
            const underMatch = query.toLowerCase().match(/(?:under|below|less than)\s*₹?\s*(\d+)/);
            if (underMatch) maxPrice = parseInt(underMatch[1], 10);

            const applyPriceFilter = (list) => {
                if (!maxPrice) return list;
                return list.filter(p => {
                    const parsed = parseFloat(String(p.price || '').replace(/[^\d.]/g, ''));
                    return !isNaN(parsed) && parsed <= maxPrice;
                });
            };

            const inStock = products.filter(p => Number(p.stock) > 0);

            // Stop-word removal, spelling normalization, and term classification are shared with
            // detectIntent's looksLikeProductQuery (see makeSearchTerms above) so both use the
            // exact same rules instead of two drifting copies.
            const { terms: searchTerms, hasUnmatchedTerm } = makeSearchTerms(query, inStock);
            const termMatches = searchTermMatches;

            const matchAllTerms = (termList) => applyPriceFilter(
                inStock.filter(p => termList.every(term => termMatches(p, term)))
            );

            // Cross-group pattern conflict check — a specific style/pattern term (e.g. "stripe")
            // combined with a generic product-type word that explicitly names a group (e.g.
            // "tshirt" -> T-Shirts) must never be silently resolved by guessing. If no real
            // product satisfies the full request (pattern + the explicitly-named group) but the
            // pattern DOES exist in some other group, that's a genuine "we don't carry that
            // combination" case, not noise to drop — ask for clarification instead of either
            // matching the wrong unrelated product (the original bug) or silently substituting in
            // a different top-level group (an earlier, still-wrong fix for that bug).
            const specificTerms = searchTerms.filter(t => !GENERIC_PRODUCT_WORDS.has(t));
            const genericTermUsed = searchTerms.find(t => GENERIC_PRODUCT_WORDS.has(t));
            let crossGroupConflictReply = null;
            if (specificTerms.length > 0 && genericTermUsed) {
                const specificOnlyMatched = matchAllTerms(specificTerms);
                if (specificOnlyMatched.length > 0 && matchAllTerms(searchTerms).length === 0) {
                    const requestedParent = GENERIC_TERM_TO_PARENT[genericTermUsed];
                    const actualParent = getParentCategory(specificOnlyMatched[0].category);
                    if (requestedParent && requestedParent !== actualParent) {
                        crossGroupConflictReply = buildCrossGroupConflictReply(specificTerms, specificOnlyMatched[0].category, requestedParent);
                    }
                }
            }

            const terms = searchTerms;
            let matched = [];

            if (terms.length > 0) {
                // AND logic: every term must match
                matched = matchAllTerms(terms);

                // Step 4 — Fallback: only if single term search
                if (matched.length === 0 && terms.length === 1) {
                    matched = applyPriceFilter(
                        inStock.filter(p => termMatches(p, terms[0]))
                    );
                }
            }

            // Reset per-flow state regardless of which branch below fires — mirrors the
            // housekeeping the old single-card path always did, minus AWAITING_MODEL_SELECTION/
            // searchProducts (neither scenario below offers an in-chat "reply 1 to select" step;
            // the CTA button sends the customer straight to the website instead).
            session.pendingProduct = null;
            session.selectedSize = null;
            session.isRecommendation = false;
            session.fromCrossSell = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;

            if (crossGroupConflictReply) {
                return crossGroupConflictReply;
            }

            // A genuine catalog-unmatched term (e.g. "Korean") means the customer asked for a
            // specific attribute/origin/brand we don't carry at all — refuse to fall back to ANY
            // category/product suggestion (that's the bug this fixes: "Korean lelin shirts" used
            // to fall through to a loose "shirts" match and suggest White Shirts).
            // Guard: require at least one term DID match the catalog (terms.length > 0). If
            // every term failed to match (terms is empty), the message was never about a real
            // product at all — delivery complaints, random text, etc. that somehow slipped
            // through to SEARCH. In that case fall through to SHORT_NOT_FOUND_REPLY instead
            // of falsely claiming the item is "out of stock".
            if (hasUnmatchedTerm && terms.length > 0) {
                return { replyText: OUT_OF_STOCK_REPLY, sendImages: [] };
            }

            // A query left with ONLY generic product-type word(s) (e.g. bare "shirt" or "tshirt",
            // no color and no specific style/subcategory word) can't confidently resolve to ONE
            // subcategory — "shirt" alone matches White Shirts, Plain Shirts, Lenin Plain, and
            // every other real Shirts subcategory all at once; "tshirt" alone is just as
            // ambiguous across T-Shirts, Football T Shirt, Round Neck T Shirt, etc. Picking
            // matched[0] in that case is really just "whichever happens to be first in the
            // products array" — that's the bug this fixes ("T.shirs L size venum" used to fall
            // back to a bare "shirt" match and pick whatever shirt-category product was first,
            // e.g. White Shirts). Show the existing numbered subcategory list for that parent
            // group instead of silently guessing one. (`terms.every(generic)` already implies no
            // color term is present, since no COLOR_KEYWORDS entry is in GENERIC_PRODUCT_WORDS.)
            if (terms.length > 0 && terms.every(t => GENERIC_PRODUCT_WORDS.has(t)) && matched.length > 0) {
                const ambiguousParent = getParentCategory(matched[0].category);
                return showSubcategoryListForParent(ambiguousParent, products, session);
            }

            // Product Availability Check — a color/variant word among the search terms (see
            // COLOR_KEYWORDS) decides Scenario B (specific product page) vs. Scenario A (generic
            // "yes, available" + category page). Neither scenario lists products in chat text.
            const colorTerm = terms.find(t => COLOR_KEYWORDS.includes(t));

            if (colorTerm && matched.length > 0) {
                return buildSpecificProductReply(matched[0], products);
            }

            // Category-only match — re-run without the color term so a mentioned-but-out-of-stock
            // color (e.g. "stripes shirt blue" with no blue in stock) still resolves to the
            // category instead of a dead-end "not found".
            const categoryTerms = colorTerm ? terms.filter(t => t !== colorTerm) : terms;
            const categoryMatched = colorTerm ? matchAllTerms(categoryTerms) : matched;

            if (categoryMatched.length > 0) {
                return buildCategoryAvailableReply(categoryMatched[0], products);
            }

            // Nothing recognizable at all — short pointer to the menu/website instead of dumping
            // the entire numbered category+subcategory list in chat (see Bug 3).
            return { replyText: SHORT_NOT_FOUND_REPLY, sendImages: [] };
        }
        default:
            return null;
    }
}

// States where the bot is actively waiting for a specific raw number (phone/pincode),
// so a bare numeric message must NOT be hijacked as an order-id lookup.
const NUMERIC_INPUT_STATES = ['AWAITING_CHECKOUT_PHONE', 'AWAITING_CHECKOUT_PINCODE'];

// Extract an Order ID from free-form customer text. Supports "ORD-<digits>",
// "order #1234" / "order 1234", and a bare number (3+ digits) on its own.
function extractOrderId(rawText, skipBareNumber = false) {
    const text = (rawText || '').trim();
    if (!text) return null;

    let match = text.match(/\bORD-\d+\b/i);
    if (match) return match[0].toUpperCase();

    match = text.match(/\border\b\s*(?:id)?\s*[:#]?\s*(\d{3,})/i);
    if (match) return match[1];

    if (!skipBareNumber && /^\d{3,}$/.test(text)) return text;

    return null;
}

// True when the customer's text contains more than one number (e.g. "2 and 7", "2,7", "2 & 7"),
// so we can nudge them to send one at a time instead of showing a generic invalid-format error.
const hasMultipleNumbers = (text) => {
    const matches = (text || '').match(/\d+/g);
    return !!matches && matches.length > 1;
};

const MULTIPLE_NUMBERS_REPLY = `😊 Please reply with just ONE number at a time.\n\nFor example, type *2* to see that category first. Once you're done, you can type another number like *7* to browse that category too!`;

// Used when session.state nominally expects a numbered-list reply (e.g. AWAITING_SUBCATEGORY_SELECTION,
// AWAITING_MODEL_SELECTION) but there's no actual list backing it (session.subCategories /
// session.searchProducts is empty) — typically a freshly reset/idle session left over after checkout.
// Showing "reply with a number from the list" when no list was ever shown is confusing, so we use this
// friendlier, neutral nudge instead.
const GENERIC_FALLBACK_REPLY = `Sorry, I didn't quite get that! 😊 Type *menu* to browse our shop, or *order help* if you have a question about your order.`;

// Standalone color question with no product/category mentioned at all (e.g. "colours", "colors
// available?", "enna colour irukku") — checked in the FAQ fallback chain below, well after
// detectIntent's SEARCH-routing checks (parentCategories/searchKeywords/looksLikeProductQuery)
// have already failed to find a category match, and before the final GENERIC_FALLBACK_REPLY.
// Reaching that FAQ chain at all already implies no category/product keyword was recognized —
// SEARCH always returns its own reply and never falls through here — so this only needs to check
// for a color word, not separately re-verify the absence of a category word.
const GENERIC_COLOR_INQUIRY_REPLY = `🎨 Yes! We have lots of colours available across all our collections 😊

Check them out here 👇
https://supercollections.in/shop/

Illana product name sollunga (e.g. "plain shirt"), naan exact colours kaatturen!`;

// =====================================================================================
// AI MESSAGE CLASSIFIER (Claude Haiku) — replaces the keyword/substring intent matching
// above for free-text browsing messages. Gated behind USE_AI_CLASSIFIER (see top of file).
// =====================================================================================

// Replies the AI router needs that weren't already named constants in the keyword logic above
// (the keyword logic has them as inline string literals inside FAQ/global-handler branches —
// duplicated here verbatim rather than extracted, so neither path can drift from the other
// silently if one is edited later).
const AI_DELIVERY_TIME_REPLY = "🚚 Delivery usually takes 7 working days.";
const AI_WHOLESALE_REPLY = "For bulk orders, please contact us directly. Our team will get in touch with you. 📞";
const AI_FIT_QUESTION_REPLY = `📏 Size Guide:\n\nS - 38" chest\nM - 40" chest\nL - 42" chest\nXL - 44" chest\n\nIf you share your usual size, naan confirm panni solren correct fit varuma! 😊`;
const AI_ACK_BUTTONS = {
    body: "Would you like any further assistance? 😊",
    buttons: [
        { id: 'help_yes', title: '✅ YES' },
        { id: 'help_no', title: '❌ NO' }
    ]
};

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const AI_CLASSIFIER_MODEL = 'claude-haiku-4-5';
const AI_CLASSIFIER_TIMEOUT_MS = 8000;

// Only these states represent open-ended "customer is browsing/asking something" turns — every
// other state (checkout data-entry fields, yes/no decision prompts, size/qty/model selection)
// expects a specific structured reply and must keep going through the existing state-machine
// handlers untouched, never through the AI. This is what keeps "free-text handling" scoped
// correctly: the AI never sees a checkout name/phone/pincode/address or a button-id payload.
const AI_CLASSIFIER_ELIGIBLE_STATES = new Set([
    'AWAITING_MAIN_MENU_SELECTION',
    'AWAITING_TOP_CATEGORY_SELECTION',
    'AWAITING_SUBCATEGORY_SELECTION'
]);

// Builds a compact, live (not hardcoded) summary of in-stock categories/subcategories from the
// products array already fetched for this request (itself sourced straight from Supabase via
// getProducts() — see top of file), grouped by parent so the prompt stays small even as the
// catalog grows. Re-querying Supabase separately here would just duplicate that same data with
// extra latency on every single classified message, so the in-memory array is reused instead.
function getCatalogSummaryForAI(products) {
    const byParent = {};
    products.forEach(p => {
        if (Number(p.stock) <= 0) return;
        const sub = (p.category || '').trim();
        if (!sub) return;
        const subLower = sub.toLowerCase();
        if (['men', 'menu', 'general', 'uncategorized', 'new arrival', 'new arrivals'].includes(subLower)) return;
        const parent = getParentCategory(sub);
        if (!byParent[parent]) byParent[parent] = new Set();
        byParent[parent].add(sub);
    });

    const lines = [];
    SUBCATEGORY_GROUP_ORDER.forEach(parent => {
        if (byParent[parent]) {
            lines.push(`${parent}: ${Array.from(byParent[parent]).sort().join(', ')}`);
            delete byParent[parent];
        }
    });
    Object.keys(byParent).sort().forEach(parent => {
        lines.push(`${parent}: ${Array.from(byParent[parent]).sort().join(', ')}`);
    });
    return lines.join('\n');
}

function buildClassifierSystemPrompt(catalogSummary) {
    return `You are a message classifier for "Super Collections", a WhatsApp clothing store bot serving Tamil Nadu, India customers. Customer messages are Tanglish (Tamil + English mixed), frequently containing typos and filler words (iruka, venum, available, bro, sir, anna, da). Ignore filler words when classifying.

LIVE CATALOG (in-stock categories and their subcategories — use these EXACT names for "category"/"subcategory", never invent, translate, or rephrase them):
${catalogSummary}

COLORS we carry: ${COLOR_KEYWORDS.join(', ')}
SIZES we carry: S, M, L, XL, XXL/2XL, XXXL/3XL

Known typo/slang mappings (apply these when the customer's wording is close):
- "lelin", "linin", "lenin" -> look for a Lenin/Linen Plain Shirts subcategory in the catalog above
- "kurka" -> Gurkha Pants subcategory
- "pola fit", "polo fit" (pants context) -> Polo Fit Pants subcategory
- "mars fabric", "mars fab" -> look for a stripe/mars-fabric subcategory in the catalog above; if none exists, set category to the T-Shirts/Shirts group it most resembles and leave subcategory null
- "t.shirs", "tshirs" -> the T-Shirts group
- "colur" is just "color" misspelled — never treat it as part of a product name

Return ONLY this JSON shape, no markdown fences, no commentary, no extra keys:
{"intent": "product_query" | "order_status" | "support_handoff" | "delivery_time" | "wholesale" | "acknowledgment" | "social_link" | "fit_question" | "greeting" | "unrelated", "category": "<exact top-level category from the catalog above, or null>", "subcategory": "<exact subcategory from the catalog above, or null>", "color": "<normalized color word, or null>", "size": "<S|M|L|XL|XXL|2XL|3XL, or null>", "order_id": "<order number digits if mentioned, or null>", "confidence": "high" | "medium" | "low"}

Intent rules:
- "product_query": asking about/searching for/describing a product. Resolve category/subcategory from the live catalog above, applying the typo mappings. If they only use a generic product word ("shirt", "pant") with nothing more specific, set category to that group, leave subcategory null, confidence "medium". If they describe something genuinely not in the catalog above (e.g. "Korean", "checked", "zipper", "hoodie", a brand we don't carry), set BOTH category and subcategory to null, confidence "high". Never invent a category/subcategory that isn't in the catalog above.
- "order_status": asking about an existing order — delivery status, tracking, "not delivered yet", "where is my order", "already ordered but...". Extract order_id if a number is present.
- "support_handoff": wants a human/agent, a contact/customer-care number, reports a payment failure, refund, return, exchange, wrong/damaged/missing item, or a fee/charge complaint.
- "delivery_time": a plain question about how many days delivery takes (no complaint attached).
- "wholesale": bulk/wholesale/minimum-order-quantity inquiry.
- "acknowledgment": just "ok"/"sari"/"thanks"/"okay sir" etc. with no other request in the message.
- "social_link": message contains (or is mostly) an Instagram/Facebook/YouTube link.
- "fit_question": asking whether a particular size will fit them, or general sizing advice.
- "greeting": "hi"/"hello"/"hai"/"vanakkam" and nothing else of substance.
- "unrelated": random/meaningless text, or a genuine question that doesn't fit any intent above (e.g. general "how do I place an order" process questions). When genuinely unsure, prefer "unrelated" with confidence "low" rather than guessing.

Always return valid, parseable JSON exactly matching the shape above. Use null (not the string "null") for empty fields.`;
}

// Strips markdown code fences a model sometimes wraps JSON in, then parses. Throws on anything
// that isn't valid JSON — callers must catch and fail safe (see runAIClassifierRoute).
function parseClassifierJSON(rawText) {
    const cleaned = (rawText || '').trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
    const parsed = JSON.parse(cleaned);
    return {
        intent: parsed.intent || 'unrelated',
        category: parsed.category || null,
        subcategory: parsed.subcategory || null,
        color: parsed.color || null,
        size: parsed.size || null,
        order_id: parsed.order_id || null,
        confidence: parsed.confidence || 'low'
    };
}

// Calls Claude Haiku to classify one customer message. Throws on any API/network/timeout/parse
// failure — never swallows errors here, since the caller (runAIClassifierRoute) is the single
// fail-safe boundary that decides what to show the customer when classification is unavailable.
async function classifyMessage(customerMessage, catalogSummary, sessionContext = {}) {
    const systemPrompt = buildClassifierSystemPrompt(catalogSummary);
    const contextNote = sessionContext.selectedParentCategory
        ? `\n(Customer is currently browsing: ${sessionContext.selectedParentCategory})`
        : '';
    const userPrompt = `Customer message: "${customerMessage}"${contextNote}`;

    const response = await axios.post(ANTHROPIC_API_URL, {
        model: AI_CLASSIFIER_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
    }, {
        headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        timeout: AI_CLASSIFIER_TIMEOUT_MS
    });

    const rawText = response.data?.content?.[0]?.text || '';
    return parseClassifierJSON(rawText);
}

// Routes a parsed classification to the existing, already-battle-tested reply builders —
// buildSpecificProductReply / buildCategoryAvailableReply / showSubcategoryListForParent /
// getOrderById / the fixed FAQ-style replies — so the AI only ever decides WHICH of these to
// call, never how to render a product card or query Supabase itself.
async function routeClassifiedIntent(c, userMessage, products, session) {
    const inStock = products.filter(p => Number(p.stock) > 0);
    const lower = userMessage.toLowerCase();

    // Universal color-only-inquiry guard: a bare "colours"/"colors available?" type message has
    // no category/subcategory for the AI to anchor on and doesn't cleanly fit any single intent,
    // so it's checked directly against the raw text regardless of what intent the AI guessed —
    // mirrors the existing GENERIC_COLOR_INQUIRY_REPLY catch-all in the keyword path.
    if (!c.category && !c.subcategory && c.intent !== 'greeting' && c.intent !== 'order_status') {
        const isColorOnlyInquiry = ['colour', 'colours', 'color', 'colors'].some(w => lower.includes(w)) ||
            COLOR_KEYWORDS.some(col => lower.includes(col));
        if (isColorOnlyInquiry) {
            return { replyText: GENERIC_COLOR_INQUIRY_REPLY, sendImages: [], _aiRoute: 'color_inquiry' };
        }
    }

    switch (c.intent) {
        case 'product_query': {
            if (!c.category && !c.subcategory) {
                if (c.confidence === 'high') {
                    return { replyText: OUT_OF_STOCK_REPLY, sendImages: [], _aiRoute: 'out_of_stock' };
                }
                return { replyText: GENERIC_FALLBACK_REPLY, sendImages: [], _aiRoute: 'fallback_low_confidence' };
            }

            let candidates = inStock;
            if (c.subcategory) {
                candidates = candidates.filter(p => productMatchesSubCategory(p, c.subcategory));
            } else if (c.category) {
                candidates = candidates.filter(p => getParentCategory(p.category) === c.category);
            }

            if (candidates.length === 0) {
                // Named subcategory has no stock at all — fall back to the parent category if that has stock.
                if (c.subcategory && c.category) {
                    const catOnly = inStock.filter(p => getParentCategory(p.category) === c.category);
                    if (catOnly.length > 0) {
                        return { ...buildCategoryAvailableReply(catOnly[0], products), _aiRoute: 'category_available_fallback' };
                    }
                }
                return { replyText: OUT_OF_STOCK_REPLY, sendImages: [], _aiRoute: 'out_of_stock' };
            }

            if (c.color) {
                const colorMatch = candidates.find(p => (p.color || '').toLowerCase().includes(c.color.toLowerCase()));
                if (colorMatch) {
                    return { ...buildSpecificProductReply(colorMatch, products), _aiRoute: 'specific_product' };
                }
                return { ...buildCategoryAvailableReply(candidates[0], products), _aiRoute: 'category_available_color_oos' };
            }

            if (c.subcategory) {
                return { ...buildSpecificProductReply(candidates[0], products), _aiRoute: 'specific_product' };
            }

            // Category only, no subcategory — scoped subcategory list for that one category, not
            // the giant all-categories dump.
            return { ...showSubcategoryListForParent(c.category, products, session), _aiRoute: 'subcategory_list' };
        }

        case 'order_status': {
            if (c.order_id) {
                const order = await getOrderById(c.order_id);
                if (order) {
                    return {
                        replyText: `📦 Thank you! We found your order (#${order.id}).\n\nOur team will dispatch it shortly and share the tracking ID with you here on WhatsApp once it's shipped. 🙏\n\nNeed anything else? Reply 'menu' to continue shopping.`,
                        sendImages: [],
                        _aiRoute: 'order_found'
                    };
                }
                return { replyText: "We couldn't find that order. Please double check the Order ID, or our team will verify and get back to you shortly.", sendImages: [], _aiRoute: 'order_not_found' };
            }
            return { replyText: "Please share your Order ID. We will check the tracking details and update you. 📦", sendImages: [], _aiRoute: 'order_status_ask_id' };
        }

        case 'support_handoff':
            return { replyText: CUSTOMER_SUPPORT_MESSAGE, sendImages: [], _aiRoute: 'support_handoff' };

        case 'delivery_time':
            return { replyText: AI_DELIVERY_TIME_REPLY, sendImages: [], _aiRoute: 'delivery_time' };

        case 'wholesale':
            return { replyText: AI_WHOLESALE_REPLY, sendImages: [], _aiRoute: 'wholesale' };

        case 'acknowledgment':
            session.state = "AWAITING_HELP_CONFIRM";
            return { sendButtons: AI_ACK_BUTTONS, sendImages: [], _aiRoute: 'acknowledgment' };

        case 'social_link':
            return { replyText: SOCIAL_MEDIA_LINK_REPLY, sendImages: [], _aiRoute: 'social_link' };

        case 'fit_question':
            return { replyText: AI_FIT_QUESTION_REPLY, sendImages: [], _aiRoute: 'fit_question' };

        case 'greeting': {
            session.pendingProduct = null;
            session.selectedSize = null;
            session.crossSellShown = false;
            session.cartCrossSellShown = false;
            session.awaitingOrderHelpChoice = false;
            session.state = "AWAITING_MAIN_MENU_SELECTION";
            return { replyText: MAIN_MENU_TEXT, sendImages: [], _aiRoute: 'greeting' };
        }

        case 'unrelated':
        default:
            return { replyText: GENERIC_FALLBACK_REPLY, sendImages: [], _aiRoute: 'fallback_unrelated' };
    }
}

// Single entry point called from _handleSalesAssistantJS when USE_AI_CLASSIFIER is on. Logs the
// raw message, the parsed classification, and the route taken on every call (for Vercel log
// review/tuning per the logging requirement) and is the one place that turns ANY failure
// (network, timeout, malformed JSON) into the existing generic fallback reply instead of letting
// it propagate — the AI path must never crash the webhook.
async function runAIClassifierRoute(userMessage, products, session) {
    const catalogSummary = getCatalogSummaryForAI(products);
    let classification;
    try {
        classification = await classifyMessage(userMessage, catalogSummary, {
            selectedParentCategory: session.selectedParentCategory || null
        });
    } catch (err) {
        console.error(`[AIClassifier] Classification failed for "${userMessage}":`, err.message);
        return { replyText: GENERIC_FALLBACK_REPLY, sendImages: [] };
    }

    console.log(`[AIClassifier] message=${JSON.stringify(userMessage)} classification=${JSON.stringify(classification)}`);

    let reply;
    try {
        reply = await routeClassifiedIntent(classification, userMessage, products, session);
    } catch (err) {
        console.error(`[AIClassifier] Routing failed for "${userMessage}":`, err.message);
        return { replyText: GENERIC_FALLBACK_REPLY, sendImages: [] };
    }

    console.log(`[AIClassifier] route=${reply._aiRoute || 'unknown'} for message=${JSON.stringify(userMessage)}`);
    delete reply._aiRoute;
    return reply;
}

async function _handleSalesAssistantJS(from, userMessage, products, session) {
    const normalizedMessage = normalizeQuery(userMessage);
    const textLower = normalizedMessage.toLowerCase();

    // Ensure session properties are initialized
    session.cart = session.cart || [];
    session.state = session.state || "AWAITING_SUBCATEGORY_SELECTION";
    session.isRecommendation = session.isRecommendation || false;
    session.crossSellShown = session.crossSellShown || false;
    session.promoCategory = session.promoCategory || null;
    session.orderingQueue = session.orderingQueue || [];
    session.pendingSelections = session.pendingSelections || {};
    session.pendingOrder = session.pendingOrder || [];

    // Backward compatibility for stale recommendation states
    if (session.state === "AWAITING_RECOMMENDATION_CONFIRM" || session.state === "AWAITING_COMBO_CART_CONFIRM") {
        session.state = "AWAITING_MORE_ITEMS";
    }

    // ─── Size/Qty button replies are routed directly by the product ID embedded in the button's
    // id (size_<productId>_<SIZE>, qty_<productId>_<N>) — independent of session.state. This lets
    // two products be mid-flow (size/qty) at once without one clobbering the other, since each
    // reply unambiguously names which pendingSelections entry it belongs to. Checked before order
    // tracking / intent detection so neither can ever intercept these structured payloads.
    const sizeReplyMatch = textLower.match(/^size_(\d+)_(.+)$/);
    if (sizeReplyMatch) {
        const reply = handleSizeReply(session, sizeReplyMatch[1], sizeReplyMatch[2]);
        if (reply) return reply;
    }
    const qtyReplyMatch = textLower.match(/^qty_(\d+)_(\d+)$/);
    if (qtyReplyMatch) {
        const reply = await handleQtyReply(session, products, qtyReplyMatch[1], parseInt(qtyReplyMatch[2], 10));
        if (reply) return reply;
    }

    // ─── Order Tracking Lookup (checked EARLY, before any other intent matching) ───
    const skipBareOrderNumber = NUMERIC_INPUT_STATES.includes(session.state);
    const trackedOrderId = extractOrderId(userMessage, skipBareOrderNumber);
    if (trackedOrderId) {
        const order = await getOrderById(trackedOrderId);
        if (order) {
            return {
                replyText: `📦 Thank you! We found your order (#${order.id}).\n\nOur team will dispatch it shortly and share the tracking ID with you here on WhatsApp once it's shipped. 🙏\n\nNeed anything else? Reply 'menu' to continue shopping.`,
                sendImages: []
            };
        }
        return {
            replyText: "We couldn't find that order. Please double check the Order ID, or our team will verify and get back to you shortly.",
            sendImages: []
        };
    }

    // ─── Meaningless/random input guard ───
    // Fires before intent detection so "...", emoji-only messages, and pure-symbol strings
    // never reach looksLikeProductQuery or the SEARCH pipeline (which used to return
    // "couldn't find" for these). Matches any message with no letters, digits, or Tamil
    // characters — catches dots, ellipsis, standalone emoji, and lone punctuation.
    const _strippedForMeaningless = userMessage.trim();
    if (_strippedForMeaningless.length > 0 && !/[a-zA-Z0-9஀-௿]/.test(_strippedForMeaningless)) {
        return {
            replyText: `👋 Hi! How can I help you?\nType *menu* to browse our collection, or tell me what you're looking for! 😊`,
            sendImages: []
        };
    }

    // ─── Social media link guard (checked before SEARCH/intent detection, after structured
    // button replies / order-tracking above so those keep first claim on the message) ─── A
    // customer pasting an Instagram/Facebook/YouTube link — with or without extra text alongside
    // it, e.g. "this one available? https://instagram.com/reel/..." — can't be resolved to a
    // product; we never attempt to parse the surrounding text, since that used to land the raw
    // URL in SEARCH as noise and either misfire on the wrong category or wrongly claim the item
    // is out of stock.
    if (SOCIAL_MEDIA_LINK_REGEX.test(userMessage)) {
        return { replyText: SOCIAL_MEDIA_LINK_REPLY, sendImages: [] };
    }

    // ─── AI Classifier (Claude Haiku) — replaces the keyword detectIntent/handleIntent path
    // below for free-text browsing turns only, when USE_AI_CLASSIFIER is on. Restricted to
    // AI_CLASSIFIER_ELIGIBLE_STATES and skipped for numbers-only text (numbered-menu replies like
    // "3" or "1,2 & 3") so menu number selection, checkout data-entry fields, and button-id
    // payloads all keep going through the existing state-machine handlers untouched — only an
    // actual open-ended sentence in a browsing state reaches the AI. On any classifier failure
    // this returns the existing generic fallback reply rather than throwing, so flipping
    // USE_AI_CLASSIFIER off always instantly restores the exact behavior below with zero risk.
    if (USE_AI_CLASSIFIER && ANTHROPIC_API_KEY &&
        AI_CLASSIFIER_ELIGIBLE_STATES.has(session.state) &&
        !isNumbersOnlyText(userMessage)) {
        return await runAIClassifierRoute(userMessage, products, session);
    }

    // ─── Intent Detection & Routing Layer ───
    const intentResult = detectIntent(textLower, products, session);
    if (intentResult.type !== 'UNKNOWN') {
        const intentResponse = await handleIntent(intentResult, session, products, from);
        if (intentResponse) {
            return intentResponse;
        }
    }

    // Backward compatibility variables for existing state handler below
    const intent = intentResult.type;

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
    const GREETING_WORDS = ['hi', 'hello', 'hey', 'hii', 'hiii', 'hiiii', 'helo',
        'hlo', 'vanakkam', 'வணக்கம்', 'start', 'menu', 'good morning',
        'good afternoon', 'good evening', 'sir', 'hi sir', 'hello sir'];
    const cleanedForGreeting = textLower.replace(/[^a-zA-Zஅ-ஹ\s]/g, '').trim();
    const isGreeting = GREETING_WORDS.some(g => cleanedForGreeting === g) ||
        /^h+i+\b/.test(cleanedForGreeting) ||
        cleanedForGreeting === 'hi sir' || cleanedForGreeting === 'hello sir';

    // 2. STATE-SPECIFIC HANDLERS

    // STATE: AWAITING_CANCEL_NO_CART_DECISION
    if (session.state === "AWAITING_CANCEL_NO_CART_DECISION") {
        const choice = textLower.trim();
        if (choice === 'cancel_continue_shopping' || choice.includes('continue') || choice === '1') {
            session.cart = [];
            session.orderingQueue = [];
            session.pendingSelections = {};
            session.pendingOrder = [];
            session.pendingProduct = null;
            session.selectedSize = null;
            session.selectedColor = null;
            session.searchProducts = [];
            session.isRecommendation = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            session.fromCrossSell = false;
            session.selectedSubCategory = null;
            session.lastRecommendation = null;
            session.awaitingRecommendationResponse = false;
            session.awaitingCartAdditionConfirmation = false;

            return goToTopCategoryMenu(session, products, "👋 Welcome back! Please select a category to start shopping:");
        } else if (choice === 'cancel_exit_shopping' || choice.includes('exit') || choice === '2') {
            return {
                replyText: "Thank you for visiting! Have a great day! 😊",
                sendImages: [],
                shouldDeleteSession: true
            };
        } else {
            return {
                sendButtons: {
                    body: `Shopping cancelled.`,
                    buttons: [
                        { id: 'cancel_continue_shopping', title: '🛍️ Continue Shopping' },
                        { id: 'cancel_exit_shopping', title: '❌ Exit' }
                    ]
                },
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_CANCEL_PENDING_DECISION
    if (session.state === "AWAITING_CANCEL_PENDING_DECISION") {
        const choice = textLower.trim();
        if (choice === 'cancel_continue_shopping' || choice.includes('continue') || choice === '1') {
            session.orderingQueue = [];
            session.pendingSelections = {};
            session.pendingOrder = [];
            session.pendingProduct = null;
            session.selectedSize = null;
            session.selectedColor = null;
            session.searchProducts = [];
            session.isRecommendation = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            session.fromCrossSell = false;
            session.selectedSubCategory = null;
            session.lastRecommendation = null;
            session.awaitingRecommendationResponse = false;
            session.awaitingCartAdditionConfirmation = false;

            return goToTopCategoryMenu(session, products, "Sure! 😊 Keep shopping and add more items to your cart:");
        } else if (choice === 'cancel_checkout' || choice.includes('checkout') || choice === '2') {
            session.fromCrossSell = false;
            return await startCheckout(session, from, products);
        } else if (choice === 'cancel_clear_exit' || choice.includes('clear') || choice === '3') {
            session.cart = [];
            session.orderingQueue = [];
            session.pendingSelections = {};
            session.pendingOrder = [];
            return {
                replyText: "Your cart has been cleared. Goodbye! 😊",
                sendImages: [],
                shouldDeleteSession: true
            };
        } else {
            let cartSummary = `🛒 *Pending Items in Cart:*\n\n`;
            session.cart.forEach((item, i) => {
                cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.product || item.name} (${item.size}) - Qty: ${item.qty || 1} - ₹${Number(item.price) * (item.qty || 1)}\n`;
            });
            const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price) * (item.qty || 1), 0);
            cartSummary += `\n💰 Total: ₹${cartTotal}\n\n`;

            return {
                sendButtons: {
                    body: `⚠️ *You have items pending in your cart.*\n\n${cartSummary}Would you like to checkout, continue shopping, or clear the cart and exit?`,
                    buttons: [
                        { id: 'cancel_continue_shopping', title: '🛍️ Continue Shopping' },
                        { id: 'cancel_checkout', title: '🛒 Checkout' },
                        { id: 'cancel_clear_exit', title: '❌ Clear Cart & Exit' }
                    ]
                },
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_PENDING_CART_DECISION
    if (session.state === "AWAITING_PENDING_CART_DECISION") {
        const lowerInput = textLower.trim();
        const isCheckout = lowerInput === "checkout" || lowerInput === "complete" || lowerInput === "1" || lowerInput === "1️⃣" || lowerInput.includes("checkout") || lowerInput.includes("complete") || lowerInput.includes("order");
        const isContinue = lowerInput === "continue" || lowerInput === "shop" || lowerInput === "2" || lowerInput === "2️⃣" || lowerInput.includes("continue") || lowerInput.includes("shop");
        const isClear = lowerInput === "clear" || lowerInput === "cancel" || lowerInput === "delete" || lowerInput === "3" || lowerInput === "3️⃣" || lowerInput.includes("clear") || lowerInput.includes("cancel") || lowerInput.includes("delete");

        if (isCheckout) {
            session.crossSellShown = true;
            session.cartCrossSellShown = true;
            return await startCheckout(session, from, products);
        } else if (isContinue) {
            session.fromCrossSell = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;

            return goToTopCategoryMenu(session, products, "Sure! 😊 Please select a category to continue:");
        } else if (isClear) {
            session.cart = [];
            session.pendingProduct = null;
            session.selectedSize = null;
            session.searchProducts = [];
            session.isRecommendation = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            session.fromCrossSell = false;

            return goToTopCategoryMenu(session, products, "Your cart has been cleared. 😊");
        } else if (!isGreeting && !isCategorySearch && !isCheckoutTrigger) {
            return {
                sendButtons: {
                    body: `⚠️ Invalid option. You have an unfinished order in your cart. Please select whether to complete or cancel your order:`,
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

    // STATE: AWAITING_POST_ADD_TO_CART_DECISION
    if (session.state === "AWAITING_POST_ADD_TO_CART_DECISION") {
        const choice = textLower.trim();
        if (choice === "choose_same_cat" || choice.includes("same") || choice === "1") {
            session.state = "AWAITING_MODEL_SELECTION";
            session.fromCrossSell = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            const label = session.selectedSubCategory || "Products";
            return await prepareProductsPageResponse(session, products, label);
        } else if (choice === "continue_diff_cat" || choice.includes("other") || choice.includes("diff") || choice === "2") {
            session.pendingProduct = null;
            session.selectedSize = null;
            session.fromCrossSell = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            return goToTopCategoryMenu(session, products);
        } else if (choice === "cart_summary" || choice.includes("checkout") || choice === "3") {
            session.cartCrossSellShown = true;
            return await showCartSummaryWithCrossSell(session, products);
        } else {
            return {
                replyText: `⚠️ Invalid option. Please choose one of the options below:`,
                sendButtons: {
                    body: `What would you like to do next?`,
                    buttons: [
                        { id: 'choose_same_cat', title: '🔄 Same Category' },
                        { id: 'continue_diff_cat', title: '🛍️ Other Category' },
                        { id: 'cart_summary', title: '🛒 Checkout' }
                    ]
                },
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_CART_SUMMARY_DECISION
    if (session.state === "AWAITING_CART_SUMMARY_DECISION") {
        const choice = textLower.trim();
        const isShopMatches = choice === "view_matches" || choice === "shop_matches" || choice.includes("match") || (session.crossSellOptionAvailable && choice === "1");
        const isShopMore = choice === "shop_more" || choice.includes("more") || (!session.crossSellOptionAvailable && choice === "1") || choice === "shop more";

        if (isShopMatches) {
            // Navigate to subcategory list for the promo category (e.g. Pants → Formal Pant, Cargo Pant...)
            const promoCategory = session.crossSellPromoCategory || 'Pants';

            // Mark crossSellShown as true so they won't see recommendations again
            session.crossSellShown = true;
            session.cartCrossSellShown = true;
            session.crossSellOptionAvailable = false;

            const subcategoryCounts = {};
            products.forEach(p => {
                if (Number(p.stock) > 0 && getParentCategory(p.category) === promoCategory) {
                    const sub = p.category || 'General';
                    subcategoryCounts[sub] = (subcategoryCounts[sub] || 0) + 1;
                }
            });

            const subs = Object.keys(subcategoryCounts).filter(sub => subcategoryCounts[sub] > 0);
            subs.sort((a, b) => a.localeCompare(b));

            if (subs.length === 0) {
                return await startCheckout(session, from, products);
            }

            session.fromCrossSell = true;
            session.selectedParentCategory = promoCategory;

            // If only 1 subcategory, skip the list and go directly to that subcategory — through
            // the same collage + "Shop [Category]" CTA flow every other subcategory selection
            // uses (passing ctaOptions), not the old full product-cards list.
            if (subs.length === 1) {
                const selectedSub = subs[0];
                const matched = products.filter(p => Number(p.stock) > 0 && productMatchesSubCategory(p, selectedSub));
                if (matched.length > 0) {
                    session.selectedSubCategory = selectedSub;
                    session.state = "AWAITING_SUBCATEGORY_SELECTION";
                    session.searchProducts = matched;
                    const emoji = getCategoryEmoji(promoCategory);
                    const capSub = selectedSub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                    return await prepareProductsPageResponse(session, products, `${emoji} ${capSub}`, { subCategoryDisplayName: capSub });
                }
            }

            session.subCategories = subs;
            session.state = "AWAITING_SUBCATEGORY_SELECTION";
            return makeSubcategoriesListResponse(subs, subcategoryCounts, promoCategory);
        } else if (isShopMore) {
            session.pendingProduct = null;
            session.selectedSize = null;
            session.fromCrossSell = false;
            return goToTopCategoryMenu(session, products);
        } else if (choice === "continue_checkout" || choice.includes("checkout") || choice.includes("continue") || choice === "2") {
            session.fromCrossSell = false;
            return await startCheckout(session, from, products);
        } else if (choice === "cancel_order" || choice.includes("cancel") || choice === "3") {
            session.cart = [];
            session.orderingQueue = [];
            session.pendingSelections = {};
            session.pendingOrder = [];
            session.pendingProduct = null;
            session.selectedSize = null;
            session.fromCrossSell = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            return goToTopCategoryMenu(session, products, "Your order has been cancelled. Please select a category to continue shopping:");
        } else {
            const buttons = session.crossSellShown ? [
                { id: 'shop_more', title: '🛍️ Shop More' },
                { id: 'continue_checkout', title: '🛒 Checkout' },
                { id: 'cancel_order', title: '❌ Cancel' }
            ] : [
                { id: 'view_matches', title: `🛍️ Shop ${session.crossSellPromoCategory || 'Pants'}` },
                { id: 'continue_checkout', title: '🛒 Checkout' },
                { id: 'cancel_order', title: '❌ Cancel' }
            ];
            return {
                replyText: `⚠️ Invalid option. Please select an option:`,
                sendButtons: {
                    body: `Select option:`,
                    buttons
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
            return goToTopCategoryMenu(session, products);
        } else if (noKeywords.includes(textLower) || textLower.includes('no') || textLower.includes('illa') || textLower.includes('vendam')) {
            session.subCategories = null;
            session.selectedParentCategory = null;
            session.state = "AWAITING_TOP_CATEGORY_SELECTION";
            session.pendingProduct = null;
            session.selectedSize = null;
            return {
                replyText: "🙏 Thank you for supporting Super Collections! ❤️ Feel free to message us anytime. 😊",
                sendImages: []
            };
        } else {
            session.subCategories = null;
            session.selectedParentCategory = null;
            session.state = "AWAITING_TOP_CATEGORY_SELECTION";
        }
    }

    // STATE: AWAITING_CHECKOUT_USE_SAVED_ADDRESS
    if (session.state === "AWAITING_CHECKOUT_USE_SAVED_ADDRESS") {
        const choice = textLower.trim();
        if (choice === "use_saved_yes" || choice.includes("yes") || choice === "1") {
            session.state = "AWAITING_ORDER_CONFIRMATION";
            return await getStatePrompt(session, products);
        } else {
            session.state = "AWAITING_CHECKOUT_NAME";
            session.orderDetails = { customerName: '', customerPhone: '', customerAddress: '', paymentMethod: 'UPI' };
            return {
                replyText: "👤 Please enter your *Full Name*:",
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_CHECKOUT_NAME
    if (session.state === "AWAITING_CHECKOUT_NAME") {
        session.orderDetails = session.orderDetails || {};
        session.orderDetails.customerName = userMessage.trim();
        session.state = "AWAITING_CHECKOUT_PHONE";

        return {
            sendButtons: {
                body: `👤 Name: *${session.orderDetails.customerName}*\n\n📞 Please enter your *Mobile Number* or choose to use your current WhatsApp number:`,
                buttons: [
                    { id: 'use_current_phone', title: '📱 Use Current Number' }
                ]
            },
            sendImages: []
        };
    }

    // STATE: AWAITING_CHECKOUT_PHONE
    if (session.state === "AWAITING_CHECKOUT_PHONE") {
        session.orderDetails = session.orderDetails || {};
        const choice = textLower.trim();
        if (choice === "use_current_phone" || choice.includes("use current")) {
            session.orderDetails.customerPhone = from;
        } else {
            const cleanedNum = choice.replace(/\D/g, '');
            if (cleanedNum.length < 10) {
                return {
                    replyText: "⚠️ Invalid mobile number. Please enter a valid 10-digit mobile number:",
                    sendImages: []
                };
            }
            session.orderDetails.customerPhone = userMessage.trim();
        }
        session.state = "AWAITING_CHECKOUT_PINCODE";
        return {
            replyText: "📍 Please enter your 6-digit *Delivery Pincode* (e.g. 642126):",
            sendImages: []
        };
    }

    // STATE: AWAITING_CHECKOUT_PINCODE
    if (session.state === "AWAITING_CHECKOUT_PINCODE") {
        session.orderDetails = session.orderDetails || {};
        const choice = textLower.trim().replace(/\s/g, '');
        if (!/^\d{6}$/.test(choice)) {
            return {
                replyText: "⚠️ Invalid Pincode. Please enter a valid 6-digit Pincode (e.g., 642126):",
                sendImages: []
            };
        }
        session.orderDetails.pincode = choice;
        session.state = "AWAITING_CHECKOUT_ADDRESS";
        return {
            replyText: "🏠 Please enter your *Delivery Address* (Door No, Street Name, Area/City):",
            sendImages: []
        };
    }

    // STATE: AWAITING_CHECKOUT_ADDRESS
    if (session.state === "AWAITING_CHECKOUT_ADDRESS") {
        session.orderDetails = session.orderDetails || {};
        session.orderDetails.customerAddress = userMessage.trim() + ", Pin: " + (session.orderDetails.pincode || '');
        session.state = "AWAITING_ORDER_CONFIRMATION";
        return await getStatePrompt(session, products);
    }

    // STATE: AWAITING_TOP_CATEGORY_SELECTION (expects 1-7 from the simplified top-category quick
    // menu — see TOP_CATEGORY_MENU_NAMES/goToTopCategoryMenu). Routes straight into the same
    // Scenario A "Yes, available" reply (buildCategoryAvailableReply) used for category-level
    // search matches elsewhere, instead of a follow-up numbered subcategory list. Accepts several
    // numbers at once (e.g. "1,2 & 3") and acts on the first — isNumbersOnlyText requires the
    // WHOLE message to be numbers+separators, so this never hijacks an order-ID lookup like "4406".
    if (session.state === "AWAITING_TOP_CATEGORY_SELECTION" && isNumbersOnlyText(textLower)) {
        const menuNumbers = extractMenuNumbers(textLower).filter(n => n >= 1 && n <= TOP_CATEGORY_MENU_NAMES.length);
        if (menuNumbers.length === 0) {
            return {
                replyText: `⚠️ Invalid selection. Please choose a category number from 1 to ${TOP_CATEGORY_MENU_NAMES.length}. 😊`,
                sendImages: []
            };
        }
        const categoryName = TOP_CATEGORY_MENU_NAMES[menuNumbers[0] - 1];
        const sampleProduct = findSampleProductForTopCategory(categoryName, products);
        if (!sampleProduct) {
            return { replyText: "We are sorry, but this category is currently out of stock. 😔", sendImages: [] };
        }
        const reply = buildCategoryAvailableReply(sampleProduct, products);
        if (menuNumbers.length > 1) {
            reply.replyText = MULTIPLE_CATEGORY_NOTE;
        }
        return reply;
    }

    // STATE: AWAITING_SUBCATEGORY_SELECTION (expects a number)
    // Only treat this as a real menu reply when a subcategory list was actually shown — a freshly
    // reset/idle session (e.g. right after checkout) defaults to this state with no list behind it,
    // and a stray number there should fall through to the generic fallback, not a stale "1 to 1" error.
    // Accepts several numbers at once (e.g. "1,2 & 3") and acts on the first — isNumbersOnlyText
    // requires the WHOLE message to be numbers+separators, so this never hijacks an order-ID
    // lookup like "4406" (that's handled separately, much earlier, regardless of session.state).
    if (session.state === "AWAITING_SUBCATEGORY_SELECTION" && isNumbersOnlyText(textLower) && Array.isArray(session.subCategories) && session.subCategories.length > 0) {
        const menuNumbers = extractMenuNumbers(textLower).filter(n => n >= 1 && n <= session.subCategories.length);
        if (menuNumbers.length > 0) {
            const idx = menuNumbers[0] - 1;
            const selectedSub = session.subCategories[idx];
            const matched = products.filter(p => Number(p.stock) > 0 && productMatchesSubCategory(p, selectedSub));

            if (matched.length > 0) {
                session.selectedSubCategory = selectedSub;
                session.selectedParentCategory = session.selectedParentCategory || getParentCategory(selectedSub);
                session.searchProducts = matched;

                // Every subcategory — regardless of match count — goes through the same
                // collage + "Shop [Category]" CTA flow. A single-match shortcut into the old
                // size/qty/cart flow used to live here; removed for the same reason as the
                // matching shortcut in enterSubCategoryByIndex above.
                session.state = "AWAITING_SUBCATEGORY_SELECTION";
                const emoji = getCategoryEmoji(session.selectedParentCategory || '');
                const capSub = selectedSub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

                const response = await prepareProductsPageResponse(session, products, `${emoji} ${capSub}`, { subCategoryDisplayName: capSub });
                if (menuNumbers.length > 1) {
                    response.replyText = MULTIPLE_CATEGORY_NOTE;
                }
                return response;
            } else {
                return { replyText: "We are sorry, but this subcategory is currently out of stock. 😔", sendImages: [] };
            }
        } else {
            const max = session.subCategories?.length || 1;
            return {
                replyText: `⚠️ Invalid selection. Please choose a subcategory number from 1 to ${max}. 😊`,
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_MODEL_SELECTION (expects a number or multiple numbers)
    if (session.state === "AWAITING_MODEL_SELECTION") {
        const selections = parseProductSelections(textLower);
        if (selections.length > 0) {
            const maxVal = session.searchProducts?.length || 0;
            const validSelections = selections.filter(idx => idx >= 1 && idx <= maxVal);

            if (validSelections.length > 0) {
                const newProducts = validSelections.map(idx => session.searchProducts[idx - 1]);
                return await enqueueProductsForOrdering(session, products, newProducts);
            } else {
                // The number didn't match a product on this list — it might still be a valid
                // category number from the main flat subcategory menu (e.g. customer is viewing
                // "Five Sleeve T Shirt" products but types "12", which is actually a different
                // category like "Polo T-shirts (pocket)"). Jump straight into that category.
                if (selections.length === 1) {
                    const allSubs = getAllSubCategoriesList(products);
                    const categoryJump = await enterSubCategoryByIndex(session, products, selections[0] - 1, allSubs);
                    if (categoryJump) return categoryJump;
                }

                // No real product list behind this state (stale/idle session) — don't show a
                // fabricated "1 to 1" range, fall back to the friendly generic reply instead.
                if (maxVal === 0) {
                    return { replyText: GENERIC_FALLBACK_REPLY, sendImages: [] };
                }

                return {
                    replyText: `⚠️ Invalid selection. Please choose a product number from 1 to ${maxVal}. 😊`,
                    sendImages: []
                };
            }
        }
    }

    // STATE: AWAITING_PRODUCT_SIZE / AWAITING_PRODUCT_QTY (typed input, e.g. "M" or "3" — no
    // product ID attached, unlike size_<id>_<value>/qty_<id>_<value> button replies which are
    // routed earlier in the function instead).
    //
    // session.state alone can't disambiguate which step to apply a typed reply to when two
    // products are pending in *different* steps at once (e.g. product A is awaiting qty while
    // product B, selected afterwards, is still awaiting size) — session.state only ever holds one
    // value. So both states are handled in one place, keyed off the most-recently-touched pending
    // entry's *own* step rather than session.state.
    if (session.state === "AWAITING_PRODUCT_SIZE" || session.state === "AWAITING_PRODUCT_QTY") {
        const entry = resolveTypedPendingEntry(session, textLower.trim());
        if (!entry) {
            return goToTopCategoryMenu(session, products, "Something went wrong. Let's restart.");
        }

        if (entry.step === 'AWAITING_PRODUCT_SIZE') {
            return applySizeSelection(session, entry, textLower.trim());
        }

        const typedQty = parseInt(textLower.trim(), 10);
        if (isNaN(typedQty) || typedQty <= 0 || typedQty >= 100) {
            session.state = entry.step;
            return {
                replyText: `⚠️ Invalid quantity. Please select a quantity from the list or type a number:`,
                ...renderQtyPrompt(entry)
            };
        }

        return await applyQtySelection(session, products, entry, typedQty);
    }

    // STATE: AWAITING_ORDER_CONFIRMATION
    if (session.state === "AWAITING_ORDER_CONFIRMATION") {
        const choice = textLower.trim();
        const isConfirm = choice === "1" || choice === "confirm" || choice === "confirm_order_yes" || choice.includes("confirm") || choice.includes("yes");
        const isModify = choice === "modify" || choice === "confirm_order_modify" || choice.includes("modify");
        const isCancel = choice === "2" || choice === "cancel" || choice === "confirm_order_cancel" || choice.includes("cancel") || choice === "3" || choice.includes("no");

        if (isConfirm) {
            session.isOrderConfirmed = true;
            return {
                sendImages: [],
                isOrderConfirmed: true,
                orderDetails: session.orderDetails
            };
        } else if (isModify) {
            session.cart = [];
            session.orderingQueue = [];
            session.pendingSelections = {};
            session.pendingOrder = [];
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;

            return goToTopCategoryMenu(session, products, "Let's modify your order. Please select a category to continue shopping:");
        } else if (isCancel) {
            session.cart = [];
            session.orderingQueue = [];
            session.pendingSelections = {};
            session.pendingOrder = [];
            session.subCategories = null;
            session.selectedParentCategory = null;
            session.state = "AWAITING_TOP_CATEGORY_SELECTION";

            return { replyText: "Your order is cancelled", sendImages: [] };
        } else {
            return {
                replyText: `⚠️ Invalid response. Please confirm or cancel your order using the buttons below.`,
                sendButtons: {
                    body: `Is this information correct?`,
                    buttons: [
                        { id: 'confirm_order_yes', title: '✅ Yes, Place Order' },
                        { id: 'confirm_order_cancel', title: '❌ Cancel' }
                    ]
                },
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_RECOMMENDATION_CHOICE
    if (session.state === "AWAITING_RECOMMENDATION_CHOICE") {
        const choiceText = textLower.trim();
        const isShowMore = choiceText === 'show_more_recs' || choiceText.includes('show more') || choiceText === 'showmore';

        if (isShowMore) {
            session.recommendationIndex = (session.recommendationIndex || 0) + 2;
            return await prepareRecommendationResponse(session, products);
        }

        const isNum = /^[1-9][0-9]?$/.test(choiceText);
        if (isNum) {
            const selectedNum = parseInt(choiceText, 10);
            const idx = session.recommendationIndex || 0;
            const pool = session.recommendationPool || [];

            let selectedProductId = null;
            if (selectedNum === idx + 1) {
                selectedProductId = pool[idx];
            } else if (selectedNum === idx + 2) {
                selectedProductId = pool[idx + 1];
            }

            if (selectedProductId) {
                const product = products.find(p => p.id === selectedProductId);
                if (product) {
                    session.isRecommendation = true;
                    return await enqueueProductsForOrdering(session, products, [product]);
                }
            }
        }

        const isSkip = ['skip', 'no', 'n', 'illa', 'vendam', 'cancel', 'exit'].some(w => choiceText.includes(w));
        if (isSkip) {
            session.pendingProduct = null;
            session.selectedSize = null;
            session.isRecommendation = false;
            session.fromCrossSell = false;
            return await showCartSummaryWithCrossSell(session, products);
        }

        const idx = session.recommendationIndex || 0;
        const pool = session.recommendationPool || [];
        const validOptions = `${idx + 1}, ${idx + 2}`;
        let errorMsg = `⚠️ Invalid selection. Please choose a valid match number (${validOptions}).`;
        if (idx + 3 <= pool.length) {
            errorMsg += ` Or type *SHOW MORE* for other options.`;
        }
        return {
            replyText: errorMsg,
            sendImages: []
        };
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
                    body: `Would you like to continue shopping?`,
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
                    body: `✅ ${product.name} - ${session.selectedSize}\n\nWould you like to add this item to your cart?`,
                    buttons: [
                        { id: 'yes', title: '✅ YES' },
                        { id: 'no', title: '❌ NO' }
                    ]
                },
                selectedSize: session.selectedSize
            };
        } else {
            const sizeList = Array.isArray(product.sizes) ? product.sizes.join(', ') : product.sizes;
            let errorText = `❌ We didn't recognize that as a valid size.\n\nAvailable sizes:\n${sizeList}`;
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
                    body: `✅ ${product.name} - ${session.selectedSize}\n\nWould you like to add this item to your cart?`,
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
                        body: `✅ Item added to cart successfully.\n\nWould you like to continue shopping?`,
                        buttons: [
                            { id: 'yes', title: '🛍️ YES' },
                            { id: 'no_checkout', title: '🛒 NO - Checkout' }
                        ]
                    },
                    sendImages: [],
                    cart: session.cart
                };
            }

            if (session.crossSellShown) {
                // If promo teaser already shown once, do not suggest again
                session.state = "AWAITING_MORE_ITEMS";
                return {
                    sendButtons: {
                        body: `✅ Item added to cart successfully.\n\nWould you like to continue shopping?`,
                        buttons: [
                            { id: 'yes', title: '🛍️ YES' },
                            { id: 'no_checkout', title: '🛒 NO - Checkout' }
                        ]
                    },
                    sendImages: [],
                    cart: session.cart
                };
            }

            const uniqueProducts = [...new Map(products.map(p => [p.id, p])).values()];
            const excludedIds = session.cart.map(item => item.id);
            const offer = getCrossSellOffer(product, uniqueProducts, excludedIds);
            let promoCategory = offer?.promoCategory || 'Pants';
            const offerLabel = offer?.offerLabel || 'Matching Styles';
            const candidates = offer?.candidates || [];

            session.promoCategory = promoCategory;

            if (candidates.length === 0) {
                session.state = "AWAITING_MORE_ITEMS";
                return {
                    sendButtons: {
                        body: `✅ Item added to cart successfully.\n\nWould you like to continue shopping?`,
                        buttons: [
                            { id: 'yes', title: '🛍️ YES' },
                            { id: 'no_checkout', title: '🛒 NO - Checkout' }
                        ]
                    },
                    sendImages: [],
                    cart: session.cart
                };
            }

            // Score and sort candidates by color and style compatibility
            const sortedCandidates = candidates
                .map(p => ({ product: p, score: getRecommendationScore(product, p, uniqueProducts) }))
                .sort((a, b) => b.score - a.score)
                .map(item => item.product);

            // Randomly pick 4 from the top 8 scored recommendations for variety
            let promoCandidates = pickRandomTopCandidates(sortedCandidates);

            // Validation: Ensure unique product IDs inside collage
            if (new Set(promoCandidates.map(p => p.id)).size !== promoCandidates.length) {
                const uniquePromoCandidates = [];
                const seenIds = new Set();
                for (const p of promoCandidates) {
                    if (!seenIds.has(p.id)) {
                        seenIds.add(p.id);
                        uniquePromoCandidates.push(p);
                    }
                }
                promoCandidates = uniquePromoCandidates;
            }

            let collageUrl = null;
            if (promoCandidates.length > 1) {
                // Generate collage with unique products (2, 3, or 4 products). Do not duplicate slots.
                collageUrl = await createPromoCollage(promoCandidates, uniqueProducts);
            } else if (promoCandidates.length === 1) {
                // Show single product image only. Do NOT create collage.
                collageUrl = getProductImageUri(promoCandidates[0], uniqueProducts);
            }

            session.subCategories = null;
            session.selectedParentCategory = null;
            session.state = "AWAITING_TOP_CATEGORY_SELECTION";
            session.pendingProduct = null;
            session.selectedSize = null;
            session.isRecommendation = false;
            session.crossSellShown = true;
            session.cartCrossSellShown = true;

            const addedName = `${product.color ? product.color + ' ' : ''}${product.name}`;

            let promoEmoji = '🛍️';
            if (promoCategory === 'Shirts') promoEmoji = '👕';
            if (promoCategory === 'Pants' || promoCategory === 'Jeans') promoEmoji = '👖';
            if (promoCategory === 'T-Shirts') promoEmoji = '👕';
            if (promoCategory === 'Shorts') promoEmoji = '🩳';

            const promoKeyword = promoCategory.toUpperCase();

            let bodyText = `✅ *${addedName}* added to cart.\n\n`;
            bodyText += `🔥 Special Offer!\n`;
            bodyText += `Matching Collection Available`;

            return {
                sendButtons: {
                    body: bodyText,
                    buttons: [
                        { id: promoKeyword, title: `${promoEmoji} VIEW ${promoKeyword}` },
                        { id: 'CHECKOUT', title: '🛒 CHECKOUT' }
                    ]
                },
                sendImages: collageUrl ? [{ url: collageUrl, caption: `${promoCategory} trending collection` }] : [],
                cart: session.cart
            };
        } else if (textLower === "no" || textLower === "n" || textLower === "illai") {
            session.isRecommendation = false;
            session.pendingProduct = null;
            session.selectedSize = null;
            session.state = "AWAITING_MORE_ITEMS";
            return {
                sendButtons: {
                    body: `Item was not added to your cart.\n\nWould you like to continue shopping?`,
                    buttons: [
                        { id: 'yes', title: '🛍️ YES' },
                        { id: 'no_checkout', title: '🛒 NO - Checkout' }
                    ]
                },
                sendImages: []
            };
        } else if (!isGreeting && !isCategorySearch && !isCheckoutTrigger) {
            return {
                replyText: `⚠️ Invalid response. Please reply with YES or NO. 😊`,
                sendImages: []
            };
        }
    }

    // STATE: AWAITING_MORE_ITEMS
    if (session.state === "AWAITING_MORE_ITEMS") {
        if (textLower === "yes" || textLower === "y" || textLower === "aama") {
            const cartCount = session.cart.length;
            const cartTotal = session.cart.reduce((sum, i) => sum + Number(i.price), 0);

            return goToTopCategoryMenu(session, products, `Great! 😊 You have ${cartCount} item(s) in your cart (Total: ₹${cartTotal}).`);
        } else if (textLower === "no" || textLower === "n" || textLower === "illai" || textLower === "checkout" || textLower === "no_checkout") {
            return await startCheckout(session, from, products);
        } else if (!isGreeting && !isCategorySearch && !isCheckoutTrigger) {
            return {
                replyText: `⚠️ Invalid response. Please reply with YES or NO. 😊`,
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
                body: "Would you like any further assistance? 😊",
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
            return { replyText: '📸 We apologize for the issue. 😔\n\nPlease share your Order ID and a photo of the product. We will verify and resolve this quickly.', sendImages: [] };
        }
        if (textLower.includes('damage') || textLower.includes('defect') || textLower.includes('torn') || textLower.includes('dirty') || textLower.includes('stain') || textLower.includes('hole') || textLower.includes('bad quality') || textLower.includes('quality illa') || textLower.includes('used item') || textLower.includes('packaging')) {
            return { replyText: '😔 We are very sorry. Please share your Order ID along with a photo or video of the product. Our team will verify and arrange a replacement.', sendImages: [] };
        }
        if (textLower.includes('not received') || textLower.includes('kedaikala') || textLower.includes('varala') || textLower.includes('receive pannala') || textLower.includes('delivery delay') || textLower.includes('still not') || textLower.includes('not yet') || textLower.includes('late achu') || textLower.includes('late aguthu') || textLower.includes('parcel varala') || textLower.includes('pakketla')) {
            return { replyText: '😔 We apologize for the delay. Please share your Order ID. We will check the tracking details and provide an update. 📦', sendImages: [] };
        }
        if (textLower.includes('missing') || textLower.includes('item missing') || textLower.includes('parcel missing')) {
            return { replyText: '😔 We apologize. Please share your Order ID along with the unboxing photo. We will verify and resolve this for you.', sendImages: [] };
        }
        return { replyText: '😔 We apologize for the inconvenience. Please share your Order ID, and we will check and assist you immediately. 🙏', sendImages: [] };
    }

    // RETURN / EXCHANGE HANDLER
    if (intent === 'RETURN_EXCHANGE') {
        session.complaintMode = true;
        if (textLower.includes('size match agala') || textLower.includes('size match agulana') || textLower.includes('size wrong') || textLower.includes('size poda')) {
            return { replyText: '📌 Having size issues?\n\nWe offer a 7-day exchange. Please share your Order ID and a photo of the product.', sendImages: [] };
        }
        if (textLower.includes('refund')) {
            return { replyText: '💰 For refunds, please share your Order ID. We will verify and process your refund within 3-5 working days.', sendImages: [] };
        }
        return { replyText: '✅ 7-day return and exchange is available. Please share your Order ID and a photo of the product. 🙏', sendImages: [] };
    }

    // Clear complaint mode if customer shifts to shopping
    if (intent === 'GREETING' || intent === 'PRODUCT_ENQUIRY' || intent === 'ORDER_PLACEMENT' || intent === 'ORDER_CONFIRMATION') {
        session.complaintMode = false;
    }

    // FAQ MATCHES
    if (textLower.includes("delivery eppo") || textLower.includes("delivery time") || textLower.includes("evlo naal") || textLower.includes("evvalavu naal") || textLower.includes("kku evlo naal") || textLower.includes("vanthudum")) {
        return { replyText: "🚚 Delivery usually takes 7 working days.", sendImages: [] };
    }
    // Guard: don't reply "Delivery charge is ₹80" when the customer is complaining
    // about a fee issue — hand off to the team instead.
    {
        const _stmFeeComplaintSignals = ['problem', 'issue', 'not fair', 'unfair', 'wrong',
            'added', 'getting added', 'per item', 'per product', 'per selection', 'error', 'bug'];
        const _stmHasFeeComplaint = _stmFeeComplaintSignals.some(s => textLower.includes(s));
        if (!_stmHasFeeComplaint && (textLower.includes("delivery charge") || textLower.includes("delivery rate") || textLower.includes("delivery fee") || textLower.includes("shipping charge") || textLower.includes("courier charge"))) {
            return { replyText: "🚚 Delivery charge is ₹80.", sendImages: [] };
        }
        if (_stmHasFeeComplaint && (textLower.includes("delivery fee") || textLower.includes("shipping fee") || textLower.includes("delivery charge") || textLower.includes("shipping charge"))) {
            return { replyText: `🙏 Sorry for the trouble! This needs our team's attention.\n\nPlease contact us directly and we'll sort it out right away:\n📞 +91 8668066503\n📞 +91 7418755096`, sendImages: [] };
        }
    }
    if (textLower.includes("delivery area") || textLower.includes("deliver panringa") || textLower.includes("tamilnadu") || textLower.includes("india delivery") || textLower.includes("all india")) {
        return { replyText: "✅ We deliver all across India! 🚚", sendImages: [] };
    }
    if (textLower.includes("tracking") || textLower.includes("where is my order") || textLower.includes("order enga") || textLower.includes("track order") || textLower.includes("order status")) {
        return { replyText: "Please share your Order ID. We will check the tracking details and update you. 📦", sendImages: [] };
    }
    if (textLower.includes("size match agala") || textLower.includes("size match agulana") || textLower.includes("size chart") || textLower.includes("shirt small") || textLower.includes("shirt big") || textLower.includes("wrong size") || textLower.includes("size poda") || textLower.includes("size guide")) {
        return { replyText: "📌 Size Guide:\n\nS - 38\" chest\nM - 40\" chest\nL - 42\" chest\nXL - 44\" chest\n\nIf you have any questions or need to arrange an exchange, please provide your Order ID! 😊", sendImages: [] };
    }
    if (textLower.includes("return") || textLower.includes("exchange") || textLower.includes("refund") || textLower.includes("replace") || textLower.includes("maatunga")) {
        return { replyText: "✅ 7-day return and exchange is available. Please share your Order ID and a photo of the product.", sendImages: [] };
    }
    if (textLower.includes("damage") || textLower.includes("torn") || textLower.includes("wrong colour") || textLower.includes("vera colour") || textLower.includes("wrong color") || textLower.includes("wrong product") || textLower.includes("defect")) {
        return { replyText: "📸 Please send your Order ID and a photo of the product. We will verify and arrange an exchange for you. 😊", sendImages: [] };
    }
    if (textLower.includes("cod iruka") || textLower.includes("cash on delivery") || textLower.includes("cod available") || textLower === "cod") {
        return { replyText: "We apologize, but Cash on Delivery (COD) is not available. We accept GPay / UPI payments only. 😊", sendImages: [] };
    }
    if (textLower === "gpay" || textLower.includes("gpay pannalama") || textLower.includes("upi address") || textLower.includes("google pay") || textLower.includes("payment details") || textLower.includes("pay panna") || textLower.includes("payment eppo") || textLower.includes("upi id") || textLower.includes("gpay number")) {
        return {
            replyText: "💳 Payment Details:\n\nGPay / UPI: yourupi@okaxis\n\nPlease share a screenshot once the payment is completed. 😊",
            sendImages: []
        };
    }
    if (textLower.includes("online pay") || textLower.includes("prepaid") || textLower.includes("netbanking") || textLower.includes("card")) {
        return { replyText: "💳 GPay, PhonePe, and UPI payments are accepted.\n\nUPI ID: yourupi@okaxis", sendImages: [] };
    }
    if (textLower.includes("discount") || textLower.includes("offer") || textLower.includes("sale") || textLower.includes("coupon") || textLower.includes("rate kam") || textLower.includes("cheap") || textLower.includes("kammiya")) {
        return { replyText: "We offer fixed pricing as our products are already at the best possible price. Thank you for understanding! 😊🔥", sendImages: [] };
    }
    if (textLower.includes("bulk") || textLower.includes("wholesale") || textLower.includes("minimum order") || textLower.includes("lots")) {
        return { replyText: "For bulk orders, please contact us directly. Our team will get in touch with you. 📞", sendImages: [] };
    }
    if (textLower.includes("vere color") || textLower.includes("vera colour") || textLower.includes("other color") || textLower.includes("different color") || textLower.includes("color available") || textLower.includes("colour iruka")) {
        return { replyText: "Please select a category, and we will share the list of available colors! 😊", sendImages: [] };
    }
    // GENERIC COLOR INQUIRY — broader catch-all for color questions the more specific phrasings
    // above didn't already match (e.g. "colours", "colors available?"). Checked after those so
    // existing FAQ wording keeps its current reply unchanged.
    if (["colour", "colours", "color", "colors"].some(w => textLower.includes(w)) ||
        COLOR_KEYWORDS.some(c => textLower.includes(c))) {
        return { replyText: GENERIC_COLOR_INQUIRY_REPLY, sendImages: [] };
    }
    if (textLower.includes("quality") || textLower.includes("fabric") || textLower.includes("material") || textLower.includes("genuine") || textLower.includes("original")) {
        return { replyText: "💪 100% premium quality products. Super Collections guarantees premium quality! 😊", sendImages: [] };
    }
    if (textLower.includes("shop address") || textLower.includes("store address") || textLower.includes("shop enga") || textLower.includes("location") || textLower.includes("contact number") || textLower.includes("phone number kodu")) {
        return { replyText: "🏪 Super Collections\n\nWe accept online orders only. Please place your order via WhatsApp! 😊", sendImages: [] };
    }

    // NOT INTERESTED
    const notInterestedKeywords = ["no bro", "ethum venam", "vendam", "later", "paravala"];
    if (notInterestedKeywords.some(kw => textLower.includes(kw))) {
        session.cart = [];
        session.subCategories = null;
        session.selectedParentCategory = null;
        session.state = "AWAITING_TOP_CATEGORY_SELECTION";
        session.pendingProduct = null;
        session.selectedSize = null;
        session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
        session.cartCrossSellShown = false;
        return {
            replyText: "Feel free to message us anytime for your future shopping needs. Thank you for choosing Super Collections! 😊",
            sendImages: []
        };
    }

    // GREETING ("hi", "hello", etc.)
    if (isGreeting) {
        session.cart = [];
        session.orderingQueue = [];
        session.pendingSelections = {};
        session.pendingOrder = [];
        session.pendingProduct = null;
        session.selectedSize = null;
        session.crossSellShown = false;
        session.cartCrossSellShown = false;
        session.awaitingOrderHelpChoice = false;

        console.log('[IntroMenu] Greeting detected — showing main menu for', from);
        session.state = "AWAITING_MAIN_MENU_SELECTION";
        return {
            replyText: MAIN_MENU_TEXT,
            sendImages: []
        };
    }

    // CHECKOUT INITIATION
    if (isCheckoutTrigger) {
        return await startCheckout(session, from, products);
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
            replyText += `Please reply with the product number.`;

            session.searchProducts = displayProducts;
            session.state = "AWAITING_MODEL_SELECTION";

            return { replyText, sendImages: [], searchProducts: displayProducts, listContext: { type: 'products', data: displayProducts } };
        } else {
            return { replyText: "We are sorry, but those products are currently out of stock. 😔", sendImages: [] };
        }
    }

    // SMART FALLBACKS & GENERAL FALLBACKS
    if (session.state === "AWAITING_POST_ADD_TO_CART_DECISION") {
        return {
            replyText: `⚠️ Invalid option. Please choose one of the options below:`,
            sendButtons: {
                body: `What would you like to do next?`,
                buttons: [
                    { id: 'choose_same_cat', title: '🔄 Same Category' },
                    { id: 'continue_diff_cat', title: '🛍️ Other Category' },
                    { id: 'cart_summary', title: '🛒 Checkout' }
                ]
            },
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CART_SUMMARY_DECISION") {
        const _promoLbl = `🛍️ Shop ${session.crossSellPromoCategory || 'Pants'}`;
        return {
            replyText: `⚠️ Invalid option. Please choose:`,
            sendButtons: {
                body: `Select option:`,
                buttons: [
                    { id: 'view_matches', title: _promoLbl },
                    { id: 'continue_checkout', title: '🛒 Checkout' },
                    { id: 'cancel_order', title: '❌ Cancel' }
                ]
            },
            sendImages: []
        };
    }
    if (session.state === "AWAITING_ORDER_CONFIRMATION") {
        return {
            replyText: `⚠️ Invalid response. Please choose an option:\n1. Confirm\n2. Modify\n3. Cancel`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CHECKOUT_USE_SAVED_ADDRESS") {
        return {
            replyText: "⚠️ Please reply with YES or NO to use your saved address.",
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CHECKOUT_NAME") {
        return {
            sendButtons: {
                body: "👤 Please enter your *Full Name*:",
                buttons: [
                    { id: 'cancel_shopping', title: '❌ Cancel' }
                ]
            },
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CHECKOUT_PHONE") {
        return {
            replyText: "⚠️ Please enter a valid mobile number or choose to use your current WhatsApp number.",
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CHECKOUT_PINCODE") {
        return {
            sendButtons: {
                body: "⚠️ Please enter your 6-digit *Delivery Pincode*:",
                buttons: [
                    { id: 'cancel_shopping', title: '❌ Cancel' }
                ]
            },
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CHECKOUT_ADDRESS") {
        return {
            sendButtons: {
                body: "🏠 Please enter your *Delivery Address* (Door No, Street Name, Area/City):",
                buttons: [
                    { id: 'cancel_shopping', title: '❌ Cancel' }
                ]
            },
            sendImages: []
        };
    }
    if (session.state === "AWAITING_TOP_CATEGORY_SELECTION") {
        // Reached only when the message isn't purely numbers+separators — a numbers-only reply
        // (single or multiple, e.g. "1,2 & 3") is always handled earlier, by the
        // AWAITING_TOP_CATEGORY_SELECTION handler above. This covers mixed text that merely
        // contains a digit (e.g. "category 5 please").
        if (!/\d/.test(textLower)) {
            return { replyText: GENERIC_FALLBACK_REPLY, sendImages: [] };
        }
        return {
            replyText: hasMultipleNumbers(textLower) ? MULTIPLE_NUMBERS_REPLY : `⚠️ Invalid format. Please reply with a category number from 1 to ${TOP_CATEGORY_MENU_NAMES.length}. 😊`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_MODEL_SELECTION") {
        // Only nudge "reply with a number" when (a) a real product list is actually active, AND
        // (b) the message contains a digit at all — i.e. it at least looks like an attempted
        // selection. Free text with no digits (typo'd FAQ, random question, etc.) was never a
        // selection attempt, so it gets the friendly generic reply regardless of list state —
        // a stale/idle session has no list, and even a real list shouldn't force non-numeric
        // text through list-validation wording.
        if (!(session.searchProducts?.length > 0) || !/\d/.test(textLower)) {
            return { replyText: GENERIC_FALLBACK_REPLY, sendImages: [] };
        }
        return {
            replyText: hasMultipleNumbers(textLower) ? MULTIPLE_NUMBERS_REPLY : `⚠️ Invalid format. Please reply with a number from the list (1, 2, 3...). 😊`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_SUBCATEGORY_SELECTION") {
        // Same idea — AWAITING_SUBCATEGORY_SELECTION doubles as the default/idle state, so an
        // empty subCategories list means no menu is actually active right now. And digit-free text
        // was never a list-selection attempt, so it shouldn't get list-validation wording either.
        if (!(session.subCategories?.length > 0) || !/\d/.test(textLower)) {
            return { replyText: GENERIC_FALLBACK_REPLY, sendImages: [] };
        }
        return {
            replyText: hasMultipleNumbers(textLower) ? MULTIPLE_NUMBERS_REPLY : `⚠️ Invalid format. Please reply with a number from the list (1, 2, 3...). 😊`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_SIZE_SELECTION") {
        const sizeList = session.pendingProduct?.sizes
            ? (Array.isArray(session.pendingProduct.sizes) ? session.pendingProduct.sizes.join(', ') : session.pendingProduct.sizes)
            : 'S, M, L, XL';
        return {
            replyText: `Please select a size. 😊 Available sizes: ${sizeList}`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_CART_CONFIRM") {
        return {
            replyText: `⚠️ Invalid response. Please reply with YES or NO. 😊`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_MORE_ITEMS") {
        return {
            replyText: `⚠️ Invalid response. Please reply with YES or NO. 😊`,
            sendImages: []
        };
    }
    // Dynamic general fallback — short pointer to the menu/website instead of dumping the entire
    // numbered category+subcategory list in chat (see Bug 3).
    return { replyText: SHORT_NOT_FOUND_REPLY, sendImages: [] };
}

export async function handleSalesAssistantJS(from, userMessage, products, session) {
    const res = await _handleSalesAssistantJS(from, userMessage, products, session);
    if (res && typeof res === 'object') {
        if (res.crossSellShown === undefined) {
            res.crossSellShown = session.crossSellShown;
        }
        if (res.cartCrossSellShown === undefined) {
            res.cartCrossSellShown = session.cartCrossSellShown;
        }
        if (res.sendButtons && res.sendButtons.buttons) {
            const buttons = res.sendButtons.buttons;
            const hasCancel = buttons.some(b =>
                b.id === 'cancel_shopping' ||
                b.id.toLowerCase().includes('cancel') ||
                b.title.toLowerCase().includes('cancel') ||
                ['cancel_continue_shopping', 'cancel_exit_shopping', 'cancel_clear_exit', 'cancel_checkout'].includes(b.id)
            );
            if (!hasCancel) {
                buttons.push({ id: 'cancel_shopping', title: '❌ Cancel' });
            }
        }
    }
    return res;
}

// =============================
// Core Message Handler (async — uses await for all DB calls)
// =============================

async function handleMessage(msg) {
    const text = msg.text?.body?.trim() || msg.interactive?.button_reply?.id?.trim() || msg.interactive?.list_reply?.id?.trim() || '';
    const from = msg.from;

    console.log(`[handleMessage] from=${from} | text="${text}"`);

    if (!text) {
        console.log('[handleMessage] ⚠️ Empty text — ignoring.');
        return;
    }

    const logText = msg.text?.body?.trim() || msg.interactive?.button_reply?.title?.trim() || msg.interactive?.button_reply?.id?.trim() || msg.interactive?.list_reply?.title?.trim() || msg.interactive?.list_reply?.id?.trim() || '';
    await logChatMessage(from, 'customer', logText, 'text', null, msg.id);

    // Check if bot is paused
    const chats = await getChats();
    if (chats[from]?.botPaused) {
        console.log(`[handleMessage] Bot is PAUSED for ${from}. Skipping auto-reply.`);
        return;
    }

    console.log(`[handleMessage] Bot active for ${from} — processing...`);

    // Serialize processing per customer: if a previous message from the same
    // customer is still being handled (e.g. two messages sent seconds apart),
    // wait for it to finish so this request reads post-write session state
    // instead of evaluating its menu selection against a stale one.
    const sessionLockAcquired = await waitForSessionLock(from);

    try {
        const products = await getProducts();
        const orders = await getOrders();
        console.log(`[handleMessage] Loaded ${products.length} products, ${orders.length} orders from Supabase.`);

        // Admin Commands
        if (text.toUpperCase().startsWith('ADMIN')) {
            const parts = text.toUpperCase().split(' ');
            const cmd = parts[1];

            if (cmd === 'ORDERS') {
                const activeOrders = orders.filter(o => o.status !== 'cancelled').slice(-10);
                if (activeOrders.length === 0) {
                    return await sendText(from, "No active orders found.");
                }
                let reply = `📋 *Recent Orders:*\n\n`;
                activeOrders.forEach(o => {
                    reply += `🆔 ${o.id || o.orderId}\n👤 ${o.customer || o.customerName || o.customerDetails}\n🛍️ ${o.items ? o.items.map(item => item.product).join(', ') : (o.product || o.shirtName)} (x${o.quantity || 1})\n📦 Status: ${o.status}\n\n`;
                });
                return await sendText(from, reply);
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
        const isListReply = Boolean(msg.interactive?.list_reply?.id);
        if (isListReply && quotedMsgId && session.msgContext?.[quotedMsgId]) {
            const context = session.msgContext[quotedMsgId];
            console.log(`[handleMessage] Recovered context from quoted message ${quotedMsgId}:`, context);
            if (context.type === 'subcategories') {
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

        const aiResponse = await handleSalesAssistantJS(from, text, products, session);

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
        if (aiResponse.crossSellShown !== undefined) session.crossSellShown = aiResponse.crossSellShown;
        if (aiResponse.cartCrossSellShown !== undefined) session.cartCrossSellShown = aiResponse.cartCrossSellShown;

        // Save session details to Supabase
        if (aiResponse && aiResponse.shouldDeleteSession) {
            await deleteSession(from);
        } else {
            await saveSession(from, session);
        }

        // Order Confirmed — save to Supabase + update stock
        if (aiResponse.isOrderConfirmed && aiResponse.orderDetails) {
            const orderId = 'ORD-' + Date.now();
            const orderDate = new Date();
            const dateStr = orderDate.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });
            const timeStr = orderDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

            const cartItems = session.cart;
            const totalPrice = cartItems.reduce((sum, item) => sum + Number(item.price) * (item.qty || 1), 0);

            const newOrder = {
                id: orderId,
                customer_phone: from,
                customer_name: aiResponse.orderDetails.customerName || '',
                customer_address: aiResponse.orderDetails.customerAddress || '',
                items: cartItems.map(item => ({
                    productId: item.id || item.productId,
                    product: item.product || item.name,
                    color: item.color || '',
                    size: item.size || 'N/A',
                    price: Number(item.price),
                    qty: item.qty || 1
                })),
                total_price: totalPrice,
                status: 'pending_payment',
                date: orderDate.toISOString()
            };

            const { error: insertError } = await supabase.from('orders').insert([newOrder]);
            if (insertError) console.error('❌ Error inserting order:', insertError.message);

            // Decrement stock
            for (const item of cartItems) {
                const product = products.find(p => String(p.id) === String(item.id || item.productId) || p.code === item.code);
                if (product) {
                    const newStock = Math.max(0, Number(product.stock) - (item.qty || 1));
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
                bill += `${i + 1}. ${colorPrefix}${item.product || item.name}\n`;
                bill += `   Size: ${item.size}  |  Qty: ${item.qty || 1}  |  ₹${Number(item.price) * (item.qty || 1)}\n`;
            });
            bill += `${divider}\n`;
            bill += `💰 *Total: ₹${totalPrice}*\n`;
            bill += `${divider}\n`;

            // Try to create Razorpay Payment Link
            let paymentLink = null;
            if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
                paymentLink = await createRazorpayPaymentLink(
                    orderId,
                    totalPrice,
                    aiResponse.orderDetails.customerName,
                    aiResponse.orderDetails.customerPhone || from
                );
            }

            if (paymentLink) {
                bill += `💳 *Payment:* Online Payment (Razorpay)\n`;
                bill += `🔗 *Pay Link:* ${paymentLink}\n\n`;
                bill += `⏳ Please click the link above to pay via UPI, GPay, PhonePe, Card, or NetBanking.\n`;
                bill += `Once paid, your order will be confirmed automatically! 😊\n`;
            } else {
                // Fallback to manual UPI
                bill += `💳 *Payment:* GPay / UPI\n`;
                bill += `📲 yourupi@okaxis\n\n`;
                bill += `📨 Please share a screenshot of the payment receipt.\n`;
                bill += `Our representative will contact you shortly! 😊\n`;
            }

            bill += `${divider}\n`;
            bill += `🙏 Thanks for shopping at\n`;
            bill += `*Super Collections!* ❤️`;

            // Order placed — wipe the session row entirely (cart, subcategory/numeric-list
            // context, checkout fields, everything) so the customer's next message starts from a
            // clean, neutral state instead of being validated against stale leftover context.
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
        if (aiResponse.sendList) {
            const listData = aiResponse.sendList;
            const apiRes = await sendList(
                from,
                listData.body,
                listData.buttonText,
                listData.sections,
                listData.headerText,
                listData.footerText
            );
            const listMsgId = apiRes?.messages?.[0]?.id;
            if (listMsgId) {
                sentMsgId = listMsgId;
            }
            const listLog = `${listData.body}\n[${listData.buttonText}]`;
            await logChatMessage(from, 'bot', listLog, 'text', null, listMsgId);
        }
        if (aiResponse.sendCtaUrl) {
            const ctaData = aiResponse.sendCtaUrl;
            try {
                const apiRes = await sendCtaUrlMessage(from, ctaData.body, ctaData.buttonText, ctaData.url);
                const ctaMsgId = apiRes?.messages?.[0]?.id;
                if (ctaMsgId) {
                    sentMsgId = ctaMsgId;
                }
                await logChatMessage(from, 'bot', `${ctaData.body}\n[${ctaData.buttonText}]`, 'text', null, ctaMsgId);
            } catch (err) {
                console.error('[sendCtaUrl] Failed to send CTA URL message:', JSON.stringify(err.response?.data || err.message, null, 2));
            }
        }
        if (Array.isArray(aiResponse.sendProductCards)) {
            for (const card of aiResponse.sendProductCards) {
                try {
                    const apiRes = await sendProductCtaCard(from, card.imageUrl, card.body, card.buttonText, card.url);
                    const cardMsgId = apiRes?.messages?.[0]?.id;
                    if (cardMsgId) {
                        sentMsgId = cardMsgId;
                    }
                    await logChatMessage(from, 'bot', `${card.body}\n[${card.buttonText}]`, 'text', null, cardMsgId);
                } catch (err) {
                    console.error('[sendProductCards] Failed to send product card:', JSON.stringify(err.response?.data || err.message, null, 2));
                }
            }
        }

        // Store the context for this message
        if (sentMsgId && aiResponse.listContext && (!aiResponse || !aiResponse.shouldDeleteSession)) {
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
            await sendButtons(
                from,
                aiResponse.sendButtons.body,
                aiResponse.sendButtons.buttons,
                { addCancel: aiResponse.sendButtons.addCancel !== false }
            );
            let buttonMsg = aiResponse.sendButtons.body;
            if (aiResponse.sendButtons.buttons) {
                buttonMsg += '\n' + aiResponse.sendButtons.buttons.map(b => `[${b.title}]`).join(' ');
            }
            await logChatMessage(from, 'bot', buttonMsg);
        }
        if (Array.isArray(aiResponse.sendButtonGroups)) {
            for (const group of aiResponse.sendButtonGroups) {
                await sendButtons(from, group.body, group.buttons, { addCancel: group.addCancel !== false });
                let buttonMsg = group.body;
                if (group.buttons) {
                    buttonMsg += '\n' + group.buttons.map(b => `[${b.title}]`).join(' ');
                }
                await logChatMessage(from, 'bot', buttonMsg);
            }
        }

    } catch (err) {
        console.error('❌ Error handling message:', err);
        await sendText(from, "⚠️ We apologize, but a small error occurred. Please try again later.");
    } finally {
        if (sessionLockAcquired) await releaseSessionLock(from);
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

// =============================
// Razorpay Payment Integration Helpers
// =============================

export async function createRazorpayPaymentLink(orderId, totalAmount, customerName, customerPhone) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
        console.warn('[Razorpay] Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET. Skipping Razorpay link creation.');
        return null;
    }

    try {
        const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
        const payload = {
            amount: Math.round(totalAmount * 100), // convert to paise
            currency: 'INR',
            accept_partial: false,
            description: `Payment for Order ${orderId}`,
            customer: {
                name: customerName || 'Customer',
                contact: customerPhone || ''
            },
            notify: {
                sms: false,
                email: false
            },
            reminder_enable: false,
            notes: {
                orderId: orderId
            }
        };

        const response = await axios.post('https://api.razorpay.com/v1/payment_links', payload, {
            headers: {
                'Authorization': `Basic ${authHeader}`,
                'Content-Type': 'application/json'
            },
            timeout: 8000
        });

        if (response.data && response.data.short_url) {
            console.log(`[Razorpay] Created payment link successfully: ${response.data.short_url}`);
            return response.data.short_url;
        }

        console.error('[Razorpay] Payment link response was missing short_url:', response.data);
        return null;
    } catch (error) {
        console.error('[Razorpay] Error creating payment link:', error.response?.data || error.message);
        return null;
    }
}

export async function handleRazorpayWebhook(req, res) {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    console.log('[Razorpay Webhook] Received webhook event');

    // 1. Signature Verification
    if (webhookSecret) {
        if (!signature) {
            console.error('[Razorpay Webhook] Missing x-razorpay-signature header');
            return res.status(400).send('Missing signature');
        }

        const rawBody = req.rawBody || '';
        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(rawBody)
            .digest('hex');

        if (signature !== expectedSignature) {
            console.error('[Razorpay Webhook] Invalid signature mismatch');
            return res.status(400).send('Invalid signature');
        }
        console.log('[Razorpay Webhook] Signature verified successfully');
    } else {
        console.warn('[Razorpay Webhook] RAZORPAY_WEBHOOK_SECRET is not configured. Signature verification bypassed.');
    }

    // 2. Process Event
    try {
        const eventData = req.body;
        console.log(`[Razorpay Webhook] Event type: ${eventData.event}`);

        if (eventData.event === 'payment_link.paid') {
            const paymentLinkObj = eventData.payload?.payment_link?.entity;
            if (!paymentLinkObj) {
                console.error('[Razorpay Webhook] Missing payment link entity in payload');
                return res.sendStatus(200);
            }

            // Extract Order ID from notes or description
            const orderId = paymentLinkObj.notes?.orderId || paymentLinkObj.description?.match(/ORD-\d+/)?.[0];
            const paymentStatus = paymentLinkObj.status;

            console.log(`[Razorpay Webhook] Payment link for order ${orderId} is ${paymentStatus}`);

            if (orderId && paymentStatus === 'paid') {
                // Find order in Supabase
                const { data: order, error: findError } = await supabase
                    .from('orders')
                    .select('*')
                    .eq('id', orderId)
                    .maybeSingle();

                if (findError) {
                    console.error('[Razorpay Webhook] Database error finding order:', findError.message);
                    return res.sendStatus(200);
                }

                if (!order) {
                    console.error(`[Razorpay Webhook] Order ${orderId} not found in database`);
                    return res.sendStatus(200);
                }

                // If not already confirmed/paid, update status
                if (order.status === 'pending_payment') {
                    const { error: updateError } = await supabase
                        .from('orders')
                        .update({ status: 'confirmed' })
                        .eq('id', orderId);

                    if (updateError) {
                        console.error('[Razorpay Webhook] Database error updating status:', updateError.message);
                        return res.sendStatus(200);
                    }
                    console.log(`[Razorpay Webhook] Successfully updated order ${orderId} status to 'confirmed'`);

                    // Send WhatsApp success message to customer
                    const customerPhone = order.customer_phone;
                    if (customerPhone) {
                        const successMsg = `✅ *Payment Received!*\n\nYour Order *${orderId}* has been paid successfully and is now confirmed! 🛍️\n\nWe are preparing your items for delivery. Thank you for shopping with us! ❤️`;
                        await sendText(customerPhone, successMsg);
                        await logChatMessage(customerPhone, 'bot', successMsg);
                        console.log(`[Razorpay Webhook] Sent payment confirmation WhatsApp message to ${customerPhone}`);
                    }
                } else {
                    console.log(`[Razorpay Webhook] Order ${orderId} was already in status: ${order.status}`);
                }
            }
        }

        res.sendStatus(200); // Always return 200 to acknowledge webhook receipt
    } catch (err) {
        console.error('[Razorpay Webhook] Processing error:', err);
        res.sendStatus(200);
    }
}
