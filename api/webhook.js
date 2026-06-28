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

// Sent alongside buildOrderDeliveredMessage() — gives the customer a way to flag a
// problem right from the delivery notification instead of needing to type something the
// bot has to interpret. The button id carries the order's row id (for the Supabase flag)
// and display number (for the reply text), e.g. "order_not_delivered_WOO-123|123" — see
// the matching detectIntent() check and the ORDER_DELIVERY_COMPLAINT case in handleIntent().
export async function sendOrderDeliveredWithFeedback(to, bodyText, orderRowId, orderDisplayNumber) {
    return await sendRequest({
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: bodyText },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: `order_not_delivered_${orderRowId}|${orderDisplayNumber}`, title: '❌ Not Delivered' } }
                ]
            }
        }
    });
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

// Per-product "View & Buy" card used for SEARCH results (see buildProductCardsPageResponse) —
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

async function sendButtons(to, bodyText, buttons) {
    const finalButtons = buttons ? [...buttons] : [];
    const hasCancel = finalButtons.some(b =>
        b.id === 'cancel_shopping' ||
        b.id.toLowerCase().includes('cancel') ||
        b.title.toLowerCase().includes('cancel') ||
        ['cancel_continue_shopping', 'cancel_exit_shopping', 'cancel_clear_exit', 'cancel_checkout'].includes(b.id)
    );
    if (!hasCancel) {
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
    // 't shirt' (with a space) is included because real categories like "Five Sleeve T Shirt" and
    // "Football T Shirt" use a space, not a hyphen — without it they fell through to the Shirts list below.
    if (['t-shirt', 'tshirt', 't shirt', 'round neck', 'polo t'].some(kw => catLower.includes(kw))) {
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

// Fixed display order + bold headers for the flat subcategory menu. Anything whose
// getParentCategory() isn't one of these (e.g. New Arrivals leftovers) falls into "Other".
// Emoji sits OUTSIDE the asterisks — some WhatsApp clients fail to bold the whole span when an
// emoji touches the asterisk directly inside it (*👔 Shirts*), so only the plain text is bolded.
const SUBCATEGORY_GROUP_ORDER = ['Shirts', 'T-Shirts', 'Pants', 'Shorts'];
const SUBCATEGORY_GROUP_HEADERS = {
    'Shirts': '👔 *Shirts*',
    'T-Shirts': '👕 *T-Shirts*',
    'Pants': '🧍 *Pants*',
    'Shorts': '🩳 *Shorts*'
};

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

// Emoji keycap digits (1️⃣...9️⃣), 🔟 for ten, and digit-by-digit concatenation for 11+
// (e.g. 11 -> "1️⃣1️⃣", 20 -> "2️⃣0️⃣") — purely a display choice; selection still parses the
// plain number the customer types back, untouched by this.
const KEYCAP_DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
function getEmojiNumber(n) {
    if (n === 10) return '🔟';
    if (n >= 0 && n <= 9) return KEYCAP_DIGITS[n];
    return String(n).split('').map(d => KEYCAP_DIGITS[Number(d)]).join('');
}

function makeAllSubcategoriesPlainTextResponse(subs, bodyPrefix = "📋 *Select a Category*") {
    const groupNames = [...SUBCATEGORY_GROUP_ORDER, 'Other'];
    let idx = 0;
    const groupBlocks = [];
    groupNames.forEach(group => {
        const groupSubs = subs.filter(sub => {
            const parent = getParentCategory(sub);
            return group === 'Other' ? !SUBCATEGORY_GROUP_ORDER.includes(parent) : parent === group;
        });
        if (groupSubs.length === 0) return;
        const lines = [];
        if (SUBCATEGORY_GROUP_HEADERS[group]) {
            lines.push(SUBCATEGORY_GROUP_HEADERS[group]);
        }
        groupSubs.forEach(sub => {
            const capSub = sub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            lines.push(`${getEmojiNumber(idx + 1)} ${capSub}`);
            idx++;
        });
        groupBlocks.push(lines.join('\n'));
    });

    console.log('[SubcategoryMenu] Final filtered+sorted list:', subs.map((sub, sIdx) => `${sIdx + 1}. ${sub}`));

    const replyText = `${bodyPrefix}\n\n${groupBlocks.join('\n\n')}\n\n_Please reply with the number._`;
    return {
        replyText,
        sendImages: [],
        listContext: { type: 'subcategories', data: subs }
    };
}

// Single entry point for "show category selection" — replaces the old two-step
// (main category → subcategory) flow with one flat numbered list of every subcategory.
function goToFlatSubcategoryList(session, products, bodyPrefix) {
    const subs = getAllSubCategoriesList(products);
    session.subCategories = subs;
    session.selectedParentCategory = null;
    session.state = "AWAITING_SUBCATEGORY_SELECTION";
    return bodyPrefix !== undefined
        ? makeAllSubcategoriesPlainTextResponse(subs, bodyPrefix)
        : makeAllSubcategoriesPlainTextResponse(subs);
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

            session.subCategories = getAllSubCategoriesList(products);
            session.selectedParentCategory = null;
            session.state = "AWAITING_SUBCATEGORY_SELECTION";
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

// True when the session is sitting at the flat top-level category menu (no parent/subcategory chosen yet)
const isAtTopLevelMenu = (session) => session.state === "AWAITING_SUBCATEGORY_SELECTION" && !session.selectedParentCategory;

// True when the customer is just browsing a category/product list (subcategory menu or product
// list) rather than mid-way through a required multi-step input like checkout. Unlike
// isAtTopLevelMenu, this is also true once a parent category is selected (e.g. browsing "Shirts"
// subcategories or viewing a product list) — there's no specific data the customer still owes the
// bot, so an FAQ answer doesn't need to drag the whole category/product menu back into the reply.
const isPassivelyBrowsing = (session) => session.state === "AWAITING_SUBCATEGORY_SELECTION" || session.state === "AWAITING_MODEL_SELECTION";

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
        return goToFlatSubcategoryList(session, products, "Your cart is empty. 😊 Please select a category to start shopping.");
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

function detectIntent(text, products = [], session = null) {
    const t = text.toLowerCase().trim();

    // "Order not delivered" button from the delivery notification (see
    // sendOrderDeliveredWithFeedback) — must resolve regardless of session state, since
    // the WooCommerce webhook calls deleteSession() right after sending that message, so
    // there's no session context left for this reply to be evaluated against. Without this
    // check it used to fall through to free-text product search and return a confusing
    // "out of stock" reply.
    const notDeliveredMatch = t.match(/^order_not_delivered_(.+)\|([^|]+)$/);
    if (notDeliveredMatch) {
        return { type: 'ORDER_DELIVERY_COMPLAINT', orderRowId: notDeliveredMatch[1], orderDisplayNumber: notDeliveredMatch[2] };
    }
    // Bare-id/plain-text fallback — covers a button reply that doesn't carry our
    // "<rowId>|<displayNumber>" suffix (e.g. an externally configured WhatsApp template
    // button), so the complaint still gets acknowledged instead of falling through.
    if (['order_not_delivered', 'not delivered', 'order not delivered', '❌ not delivered', '❌ order not delivered'].includes(t)) {
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

    // Intro menu triggers (the two buttons shown on greeting)
    // Accept the typed phrase too (not just the button id) — referenced by the generic
    // fallback reply, so it needs to actually resolve to the order-help menu.
    if (t === 'order_help' || t === 'order help') {
        console.log('[IntroMenu] order_help triggered');
        return { type: 'ORDER_HELP' };
    }
    if (t === 'shop_now') {
        console.log('[IntroMenu] shop_now button clicked — routing to flat subcategory list');
        return { type: 'SHOP_MORE' };
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

    // ─── DELIVERY TIME Combination Match ───
    const delivTimeGroupA = ['when', 'time', 'day', 'days', 'date', 'eppo', 'epo', 'naal', 'naalu', 'agum', 'varum', 'received', 'receive', 'get', 'arrive', 'reach', 'varala', 'varuga'];
    const delivTimeGroupB = ['deliv', 'delei', 'delci', 'delve', 'delvi', 'dlvr', 'order', 'parcel', 'package', 'dress', 'shirt', 'pant', 'item', 'product'];
    const isDeliveryTime = (matchesGroup(words, delivTimeGroupA) && matchesGroup(words, delivTimeGroupB)) ||
        t.includes('delivery duration') || t.includes('how long') || t.includes('how many days');

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

    // ─── STORE INFO Match ───
    const storeKeywords = ['shop address', 'store address', 'shop enga', 'store enga', 'location', 'phone number', 'contact number', 'kodu'];
    if (storeKeywords.some(k => t.includes(k))) {
        return { type: 'FAQ', reply: '🏪 Super Collections\n\nWe accept online orders only. Please place your order via WhatsApp! 😊' };
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
            return makeAllSubcategoriesPlainTextResponse(subs);
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
            return goToFlatSubcategoryList(session, products);
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
// text (name/color + price + sizes), and a "View & Buy" button linking straight to that
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
            buttonText: 'View & Buy',
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

async function handleIntent(intentResult, session, products, from) {
    switch (intentResult.type) {
        case 'ORDER_DELIVERY_COMPLAINT': {
            const { orderRowId, orderDisplayNumber } = intentResult;
            console.log(`[OrderComplaint] ⚠️ ${from} reported order ${orderRowId || '(unknown — no order id on the button reply)'} as NOT delivered — flagging for review.`);
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
            return goToFlatSubcategoryList(session, products);
        }
        case 'ORDER_HELP': {
            session.awaitingOrderHelpChoice = true;
            return {
                replyText: "1. Order Status\n2. Returns & Exchange\n3. Delivery Time\n4. Talk to our team\n\nPlease reply with the number.",
                sendImages: []
            };
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

            return goToFlatSubcategoryList(session, products, "Your cart has been cleared. 😊");
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

            let welcomeCardFailed = false;
            let videoCardFailed = false;
            let locationCardFailed = false;

            try {
                await sendCtaUrlWelcomeMessage(from);
                console.log('[Welcome] ✅ cta_url welcome card sent to', from);
            } catch (err) {
                welcomeCardFailed = true;
                console.error('[Welcome] ❌ cta_url welcome card failed:', JSON.stringify(err.response?.data || err.message, null, 2));
            }

            try {
                await sendVideoGuideCard(from);
                console.log('[Welcome] ✅ video guide card sent to', from);
            } catch (err) {
                videoCardFailed = true;
                console.error('[Welcome] ❌ video guide card failed:', JSON.stringify(err.response?.data || err.message, null, 2));
            }

            try {
                await sendLocationCard(from);
                console.log('[Welcome] ✅ location card sent to', from);
            } catch (err) {
                locationCardFailed = true;
                console.error('[Welcome] ❌ location card failed:', JSON.stringify(err.response?.data || err.message, null, 2));
            }

            if (welcomeCardFailed || videoCardFailed || locationCardFailed) {
                const welcomeMsg = await getWelcomeMessagePrefix();
                if (welcomeMsg) {
                    await sendText(from, welcomeMsg.trim());
                    await logChatMessage(from, 'bot', welcomeMsg.trim());
                }
            }

            console.log('[IntroMenu] Greeting detected — showing Shop Now / Order Help buttons for', from);
            return {
                sendButtons: {
                    body: "😊 How can we help you today?",
                    buttons: [
                        { id: 'shop_now', title: '🛍️ Shop Now' },
                        { id: 'order_help', title: '📦 Order Help' }
                    ]
                },
                sendImages: []
            };
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

            // Step 1 — Remove English and Tamil/Tanglish stop words
            const EN_STOP = new Set(['is', 'are', 'available', 'do', 'you', 'have', 'any', 'the', 'a', 'an',
                'in', 'stock', 'please', 'send', 'show', 'get', 'got', 'what', 'which', 'want', 'need',
                'needed', 'wanted', 'wants', 'i', 'my', 'me', 'us', 'we', 'this', 'that', 'one', 'ones',
                'looking', 'for', 'tell', 'me', 'price', 'cost', 'how', 'much', 'under', 'below', 'less',
                'than', 'find', 'display', 'search', 'some', 'can', 'give', 'look']);
            const TA_STOP = new Set(['iruka', 'irukkuma', 'irukka', 'iruku', 'irruku', 'iruke', 'pakanum',
                'vaikanum', 'panunga', 'sollu', 'kodu', 'kudu', 'da', 'bro', 'anna', 'sir', 'madam', 'la', 'ku',
                'ah', 'ha', 'na', 'tharinga', 'kudunga', 'thareengala', 'venum', 'vendum', 'venam', 'vena',
                'enaku', 'eanku', 'yenaku', 'enakku', 'yenakku', 'naaku', 'kaatu', 'kaattunga',
                'வேணும்', 'இருக்கா', 'பாருங்க', 'எனக்கு']);

            // Step 2 — Normalize common spelling variants (applied to query AND product fields)
            const normalizeSpelling = (s) => s
                .replace(/\blinen\b/g, 'lenin')
                .replace(/\bt[\s-]?shirts?\b/g, 'tshirt')
                .replace(/\bphants?\b/g, 'pant')
                .replace(/\bpants?\b/g, 'pant')
                .replace(/\bfoot\s*bal+s?\b/g, 'football')
                .replace(/\bjeans?\b/g, 'jeans')
                .replace(/\bjens\b/g, 'jeans')
                .replace(/\bshrt\b/g, 'shirt')
                .replace(/\bshir\b/g, 'shirt')
                .replace(/\btrousers?\b/g, 'trouser');

            const cleaned = normalizeSpelling(
                query.toLowerCase()
                    .replace(/(?:under|below|less than)\s*₹?\s*\d+/g, '')
                    .replace(/[?!.,'"]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
            );

            // Step 3 — Build search terms (stop words removed)
            const terms = cleaned.split(/\s+/)
                .filter(w => w.length > 0 && !EN_STOP.has(w) && !TA_STOP.has(w));

            const inStock = products.filter(p => Number(p.stock) > 0);

            const termMatches = (p, term) => {
                const cats = Array.isArray(p.categories) && p.categories.length > 0
                    ? p.categories : [p.category];
                return normalizeSpelling((p.name || '').toLowerCase()).includes(term) ||
                    cats.some(c => normalizeSpelling((c || '').toLowerCase()).includes(term)) ||
                    (p.color || '').toLowerCase().includes(term) ||
                    (p.pattern || '').toLowerCase().includes(term);
            };

            let matched = [];

            if (terms.length > 0) {
                // AND logic: every term must match
                matched = applyPriceFilter(
                    inStock.filter(p => terms.every(term => termMatches(p, term)))
                );

                // Step 4 — Fallback: only if single term search
                if (matched.length === 0 && terms.length === 1) {
                    matched = applyPriceFilter(
                        inStock.filter(p => termMatches(p, terms[0]))
                    );
                }
            }

            if (matched.length > 0) {
                // Search results always send exactly ONE representative card — the first match
                // in existing order, no special "best match" ranking — regardless of how many
                // products matched. (Other prepareProductsPageResponse callers, e.g. cross-sell/
                // same-category continuation, are untouched and still send every match.)
                session.searchProducts = [matched[0]];
                session.state = "AWAITING_MODEL_SELECTION";
                session.pendingProduct = null;
                session.selectedSize = null;
                session.isRecommendation = false;
                session.fromCrossSell = false;
                session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
                session.cartCrossSellShown = false;

                return await prepareProductsPageResponse(session, products, `Search: ${query}`);
            } else {
                const replyText = "😔 We couldn't find any matching products.";
                if (!isAtTopLevelMenu(session)) {
                    // Point at the always-valid category menu instead of echoing
                    // getStatePrompt's session.selectedSubCategory + session.searchProducts —
                    // those two fields can now drift independently under the search-cards
                    // feature (a failed search never touches either), producing a mismatched
                    // "category label from one moment, product list from another" suggestion.
                    return goToFlatSubcategoryList(session, products, `${replyText}\n\nFeel free to continue shopping: 😊`);
                }
                return { replyText, sendImages: [] };
            }
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

            return goToFlatSubcategoryList(session, products, "👋 Welcome back! Please select a category to start shopping:");
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

            return goToFlatSubcategoryList(session, products, "Sure! 😊 Keep shopping and add more items to your cart:");
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

            return goToFlatSubcategoryList(session, products, "Sure! 😊 Please select a category to continue:");
        } else if (isClear) {
            session.cart = [];
            session.pendingProduct = null;
            session.selectedSize = null;
            session.searchProducts = [];
            session.isRecommendation = false;
            session.crossSellShown = (!session.cart || session.cart.length === 0) ? false : session.crossSellShown;
            session.cartCrossSellShown = false;
            session.fromCrossSell = false;

            return goToFlatSubcategoryList(session, products, "Your cart has been cleared. 😊");
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
            return goToFlatSubcategoryList(session, products);
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
            return goToFlatSubcategoryList(session, products);
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
            return goToFlatSubcategoryList(session, products, "Your order has been cancelled. Please select a category to continue shopping:");
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
            return goToFlatSubcategoryList(session, products);
        } else if (noKeywords.includes(textLower) || textLower.includes('no') || textLower.includes('illa') || textLower.includes('vendam')) {
            session.subCategories = getAllSubCategoriesList(products);
            session.selectedParentCategory = null;
            session.state = "AWAITING_SUBCATEGORY_SELECTION";
            session.pendingProduct = null;
            session.selectedSize = null;
            return {
                replyText: "🙏 Thank you for supporting Super Collections! ❤️ Feel free to message us anytime. 😊",
                sendImages: []
            };
        } else {
            session.subCategories = getAllSubCategoriesList(products);
            session.selectedParentCategory = null;
            session.state = "AWAITING_SUBCATEGORY_SELECTION";
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

    // STATE: AWAITING_SUBCATEGORY_SELECTION (expects a number)
    // Only treat this as a real menu reply when a subcategory list was actually shown — a freshly
    // reset/idle session (e.g. right after checkout) defaults to this state with no list behind it,
    // and a stray number there should fall through to the generic fallback, not a stale "1 to 1" error.
    if (session.state === "AWAITING_SUBCATEGORY_SELECTION" && isNumber && Array.isArray(session.subCategories) && session.subCategories.length > 0) {
        const idx = parseInt(textLower, 10) - 1;
        if (idx >= 0 && idx < session.subCategories.length) {
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

                return await prepareProductsPageResponse(session, products, `${emoji} ${capSub}`, { subCategoryDisplayName: capSub });
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
            return goToFlatSubcategoryList(session, products, "Something went wrong. Let's restart.");
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

            return goToFlatSubcategoryList(session, products, "Let's modify your order. Please select a category to continue shopping:");
        } else if (isCancel) {
            session.cart = [];
            session.orderingQueue = [];
            session.pendingSelections = {};
            session.pendingOrder = [];
            session.subCategories = getAllSubCategoriesList(products);
            session.selectedParentCategory = null;
            session.state = "AWAITING_SUBCATEGORY_SELECTION";

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

            session.subCategories = getAllSubCategoriesList(products);
            session.selectedParentCategory = null;
            session.state = "AWAITING_SUBCATEGORY_SELECTION";
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

            return goToFlatSubcategoryList(session, products, `Great! 😊 You have ${cartCount} item(s) in your cart (Total: ₹${cartTotal}).`);
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
    if (textLower.includes("delivery charge") || textLower.includes("delivery rate") || textLower.includes("delivery fee") || textLower.includes("shipping charge") || textLower.includes("courier charge")) {
        return { replyText: "🚚 Delivery charge is ₹80.", sendImages: [] };
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
        session.subCategories = getAllSubCategoriesList(products);
        session.selectedParentCategory = null;
        session.state = "AWAITING_SUBCATEGORY_SELECTION";
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

        let welcomeCardFailed = false;
        let videoCardFailed = false;
        let locationCardFailed = false;

        try {
            await sendCtaUrlWelcomeMessage(from);
            console.log('[Welcome] ✅ cta_url welcome card sent to', from);
        } catch (err) {
            welcomeCardFailed = true;
            console.error('[Welcome] ❌ cta_url welcome card failed:', JSON.stringify(err.response?.data || err.message, null, 2));
        }

        try {
            await sendVideoGuideCard(from);
            console.log('[Welcome] ✅ video guide card sent to', from);
        } catch (err) {
            videoCardFailed = true;
            console.error('[Welcome] ❌ video guide card failed:', JSON.stringify(err.response?.data || err.message, null, 2));
        }

        try {
            await sendLocationCard(from);
            console.log('[Welcome] ✅ location card sent to', from);
        } catch (err) {
            locationCardFailed = true;
            console.error('[Welcome] ❌ location card failed:', JSON.stringify(err.response?.data || err.message, null, 2));
        }

        if (welcomeCardFailed || videoCardFailed || locationCardFailed) {
            const welcomeMsg = await getWelcomeMessagePrefix();
            if (welcomeMsg) {
                await sendText(from, welcomeMsg.trim());
                await logChatMessage(from, 'bot', welcomeMsg.trim());
            }
        }

        console.log('[IntroMenu] Greeting detected — showing Shop Now / Order Help buttons for', from);
        return {
            sendButtons: {
                body: "😊 How can we help you today?",
                buttons: [
                    { id: 'shop_now', title: '🛍️ Shop Now' },
                    { id: 'order_help', title: '📦 Order Help' }
                ]
            },
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
    // Dynamic general fallback
    return goToFlatSubcategoryList(session, products, "😊 How can we help you today?\n\nLooking for clothing?");
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
            await sendButtons(from, aiResponse.sendButtons.body, aiResponse.sendButtons.buttons);
            let buttonMsg = aiResponse.sendButtons.body;
            if (aiResponse.sendButtons.buttons) {
                buttonMsg += '\n' + aiResponse.sendButtons.buttons.map(b => `[${b.title}]`).join(' ');
            }
            await logChatMessage(from, 'bot', buttonMsg);
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
