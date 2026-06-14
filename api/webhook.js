// api/webhook.js  — Supabase version (replaces fs-based implementation)
import axios from 'axios';
import dotenv from 'dotenv';
import { supabase } from '../lib/supabase.js';

dotenv.config();

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_ID || process.env.PHONE_NUMBER_ID;

// ✅ Startup diagnostic — visible in Vercel logs immediately on cold start
console.log('[STARTUP] ENV CHECK:');
console.log('  WHATSAPP_TOKEN  :', WHATSAPP_TOKEN  ? `SET (${WHATSAPP_TOKEN.slice(0,10)}...)` : '❌ MISSING');
console.log('  PHONE_NUMBER_ID :', PHONE_NUMBER_ID ? `SET (${PHONE_NUMBER_ID})`               : '❌ MISSING');
console.log('  VERIFY_TOKEN    :', VERIFY_TOKEN    ? `SET (${VERIFY_TOKEN})`                   : '❌ MISSING');
console.log('  SUPABASE_URL    :', process.env.SUPABASE_URL ? 'SET' : '❌ MISSING');

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
            id:       row.id,
            name:     row.name,
            code:     row.code,
            category: row.category,
            pattern:  row.pattern,
            color:    row.color,
            price:    row.price,
            stock:    row.stock,
            sizes:    row.sizes    || [],
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
        id:              row.id,
        status:          row.status,
        customerPhone:   row.customer_phone,
        customerName:    row.customer_name,
        customerAddress: row.customer_address,
        items:           row.items || [],
        totalPrice:      row.total_price,
        date:            row.date
    };
    if (row.order_id)         base.orderId         = row.order_id;
    if (row.shirt_name)       base.shirtName       = row.shirt_name;
    if (row.pant_name)        base.pantName        = row.pant_name;
    if (row.customer_details) base.customerDetails = row.customer_details;
    if (row.payment_method)   base.paymentMethod   = row.payment_method;
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
                customerName:  row.customer_name,
                lastMessage:   row.last_message,
                lastUpdated:   row.last_updated,
                botPaused:     row.bot_paused,
                messages:      row.messages || []
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
                    customer_name:  chat.customerName  || 'Customer',
                    last_message:   chat.lastMessage   || '',
                    last_updated:   chat.lastUpdated   || new Date().toISOString(),
                    bot_paused:     chat.botPaused     || false,
                    messages:       chat.messages      || []
                }, { onConflict: 'customer_phone' });

            if (error) {
                console.error(`❌ Error saving chat for ${phone}:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Error saving chats:', error.message);
    }
}

export async function logChatMessage(customerPhone, sender, text, type = 'text', imageUrl = null) {
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
            customer_name:  'Customer',
            last_message:   '',
            last_updated:   new Date().toISOString(),
            bot_paused:     false,
            messages:       []
        };

        // Try to resolve customer name from active session
        let customerName = existing.customer_name;
        if (userSessions[customerPhone]?.orderDetails?.customerName) {
            customerName = userSessions[customerPhone].orderDetails.customerName;
        }

        // Trim messages to last 100
        const messages = Array.isArray(existing.messages) ? existing.messages : [];
        messages.push({
            sender,
            type,
            text,
            imageUrl,
            timestamp: new Date().toISOString()
        });
        if (messages.length > 100) messages.shift();

        const lastMessage = type === 'image' ? `📷 Image${text ? ': ' + text : ''}` : text;

        const { error: upsertError } = await supabase
            .from('chats')
            .upsert({
                customer_phone: customerPhone,
                customer_name:  customerName,
                last_message:   lastMessage,
                last_updated:   new Date().toISOString(),
                bot_paused:     existing.bot_paused,
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
        console.error('   WHATSAPP_TOKEN  :', WHATSAPP_TOKEN  ? 'SET' : '❌ MISSING');
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
    }
}

export async function sendText(to, text) {
    await sendRequest({ to, type: 'text', text: { body: text } });
}

export async function sendImage(to, imageUrl, caption = '') {
    await sendRequest({ to, type: 'image', image: { link: imageUrl, caption } });
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
// Intent Detection
// =============================

function detectIntent(text) {
    const t = text.toLowerCase();

    const complaintKeywords = [
        'wrong', 'mistake', 'damage', 'defect', 'torn', 'dirty', 'complaint',
        'problem', 'issue', 'not received', 'kedaikala', 'varala', 'receive pannala',
        'colour wrong', 'color wrong', 'vera colour', 'vera color', 'wrong item',
        'wrong product', 'wrong colour', 'thappu', 'delivery delay', 'still not',
        'not yet', 'pakketla', 'late achu', 'late aguthu', 'parcel varala',
        'quality illa', 'bad quality', 'torn', 'hole', 'stain', 'used item',
        'packaging damage', 'box damage', 'missing item', 'item missing'
    ];
    if (complaintKeywords.some(k => t.includes(k))) return 'COMPLAINT';

    const returnKeywords = ['return', 'exchange', 'refund', 'replace', 'maatunga', 'size match agala', 'size match agulana', 'size wrong', 'size poda'];
    if (returnKeywords.some(k => t.includes(k))) return 'RETURN_EXCHANGE';

    const greetKeywords = ['hi', 'hello', 'hey', 'vanakkam', 'hai', 'hii'];
    if (greetKeywords.some(k => t === k || t === k + ' bro' || t === k + ' anna')) return 'GREETING';

    if (t === 'buy' || t === 'checkout' || t.includes('buy pannalama') || t.includes('order confirm')) return 'ORDER_CONFIRMATION';

    const orderKeywords = ['cart', 'order', 'size', 'quantity', 'buy'];
    if (orderKeywords.some(k => t.includes(k))) return 'ORDER_PLACEMENT';

    const productKeywords = ['shirt', 'pant', 'jeans', 'cargo', 'tshirt', 't-shirt', 'shorts', 'phant', 'linen', 'cotton', 'price', 'stock', 'available', 'colour iruka', 'color iruka'];
    if (productKeywords.some(k => t.includes(k))) return 'PRODUCT_ENQUIRY';

    return 'UNKNOWN';
}

// =============================
// Pure JS Sales Flow (Gemini Removed)
// =============================

export function handleSalesAssistantJS(from, userMessage, products, session) {
    const textLower = userMessage.trim().toLowerCase();

    // STATE CHECK: AWAITING_HELP_CONFIRM
    if (session.state === "AWAITING_HELP_CONFIRM") {
        const yesKeywords = ['yes', 'aama', 'help_yes', 'y', 'aam', 'ok', 'okay', 'sari', 'sari bro', 'saree', 'sari da', 'seri', 'seri bro', 'seri da', 'aama bro'];
        const noKeywords  = ['no', 'help_no', 'n', 'illai', 'illa', 'vendam', 'ethum venam', 'no bro', 'nothing', 'no thanks', 'no thank you'];

        if (yesKeywords.includes(textLower) || textLower.includes('yes') || textLower.includes('aama') || textLower.includes('sari') || textLower.includes('seri')) {
            session.state = "AWAITING_CATEGORY";
            return {
                replyText: "Welcome to Super Collections 😊\n\nEnna Shopping Panriga?\n\n1️⃣ Cotton Shirt\n2️⃣ Linen Shirt\n3️⃣ Jeans\n4️⃣ Cargo Pant\n5️⃣ T-Shirt\n\nNumber mattum reply pannunga 😊",
                sendImages: []
            };
        } else if (noKeywords.includes(textLower) || textLower.includes('no') || textLower.includes('illa') || textLower.includes('vendam')) {
            session.state     = "AWAITING_CATEGORY";
            session.cart      = [];
            session.pendingProduct = null;
            session.selectedSize   = null;
            return {
                replyText: "🙏 Thanks bro! Super Collections support pannathuku nandri ❤️ Anytime message pannunga 😊",
                sendImages: []
            };
        } else {
            session.state = "AWAITING_CATEGORY";
        }
    }

    // STEP 0: ACKNOWLEDGEMENT
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
                    { id: 'help_no',  title: '❌ NO'  }
                ]
            },
            sendImages: []
        };
    }

    // INTENT DETECTION GATE
    const intent = detectIntent(textLower);

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

    // Not Interested
    const notInterestedKeywords = ["no bro", "ethum venam", "vendam", "later", "paravala"];
    if (notInterestedKeywords.some(kw => textLower.includes(kw))) {
        session.cart          = [];
        session.state         = "AWAITING_CATEGORY";
        session.pendingProduct = null;
        session.selectedSize  = null;
        return {
            replyText: "🙏 Thanks bro.\n\nFuture la dress venumna anytime message pannunga.\n\nSuper Collections support pannathuku thanks 😊",
            sendImages: []
        };
    }

    // A. Greeting
    if (textLower === "hi" || textLower === "hello" || textLower === "hey" || textLower === "hi bro" || textLower === "hi anna" || textLower === "hii" || textLower === "hai" || textLower === "vanakkam") {
        session.state = "AWAITING_CATEGORY";
        return {
            replyText: "Welcome to Super Collections bro 😊\n\nEnna category venum?\n\n1️⃣ Cotton Shirt\n2️⃣ Linen Shirt\n3️⃣ Jeans\n4️⃣ Cargo Pant\n5️⃣ T-Shirt\n\nNumber mattum reply pannunga bro 😊",
            sendImages: []
        };
    }

    // B. BUY / Checkout initiation
    if (textLower === "buy" || textLower === "checkout" || textLower === "buy pannalama") {
        if (!session.cart || session.cart.length === 0) {
            return { replyText: "Cart empty bro 😊 Mudhalla category search pannunga.", sendImages: [] };
        }
        let cartSummary = `🛒 *Your Cart:*\n\n`;
        session.cart.forEach((item, i) => {
            cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.name} (${item.size}) - ₹${item.price}\n`;
        });
        const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price), 0);
        cartSummary += `\n💰 Total: ₹${cartTotal}\n\n📝 Order confirm panna details fill pannuga:\n\n*Name, Phone, Address*\n\nExample:\nRavi, 9876543210, 12 Anna Nagar Chennai`;
        session.state        = "AWAITING_CHECKOUT_DETAILS";
        session.orderDetails = { customerName: '', customerPhone: '', customerAddress: '', paymentMethod: 'UPI' };
        return { replyText: cartSummary, sendImages: [] };
    }

    // C. Checkout details collection
    if (session.state === "AWAITING_CHECKOUT_DETAILS") {
        const parts = userMessage.split(',').map(s => s.trim());
        if (parts.length >= 3) {
            session.orderDetails.customerName    = parts[0];
            session.orderDetails.customerPhone   = parts[1];
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

    // D-0. Welcome Category Number shortcut
    if (session.state === "AWAITING_CATEGORY" && /^[1-5]$/.test(textLower)) {
        const welcomeCategories = {
            '1': 'cotton shirt',
            '2': 'linen shirt',
            '3': 'jeans',
            '4': 'cargo pant',
            '5': 'tshirt'
        };
        const mappedCategory = welcomeCategories[textLower];
        if (mappedCategory) {
            return handleSalesAssistantJS(from, mappedCategory, products, session);
        }
    }

    // D. Category Search
    const categoryKeywords = ["shirt", "pant", "jeans", "cargo", "tshirt", "t shirt", "t-shirt", "shorts", "phant"];
    const isCategorySearch  = categoryKeywords.some(keyword => textLower.includes(keyword));

    if (isCategorySearch) {
        let matched = products.filter(p => Number(p.stock) > 0);

        if (textLower.includes("cotton") && textLower.includes("shirt")) {
            matched = matched.filter(p => p.name.toLowerCase().includes("cotton") && (p.name.toLowerCase().includes("shirt") || p.category?.toLowerCase().includes("shirt")));
        } else if (textLower.includes("linen") && textLower.includes("shirt")) {
            matched = matched.filter(p => p.name.toLowerCase().includes("linen") && (p.name.toLowerCase().includes("shirt") || p.category?.toLowerCase().includes("shirt")));
        } else if (textLower.includes("cargo")) {
            matched = matched.filter(p => p.name.toLowerCase().includes("cargo") || p.category?.toLowerCase().includes("cargo"));
        } else if (textLower.includes("jeans")) {
            matched = matched.filter(p => p.name.toLowerCase().includes("jeans") || p.category?.toLowerCase().includes("jeans") || p.pattern?.toLowerCase().includes("jeans"));
        } else if (textLower.includes("tshirt") || textLower.includes("t shirt") || textLower.includes("t-shirt")) {
            matched = matched.filter(p => p.category?.toLowerCase().includes("tshirt") || p.name.toLowerCase().includes("t shirt") || p.name.toLowerCase().includes("tshirt") || p.name.toLowerCase().includes("t-shirt"));
        } else if (textLower.includes("shirt")) {
            matched = matched.filter(p => p.category?.toLowerCase().includes("shirt") || p.name.toLowerCase().includes("shirt"));
        } else if (textLower.includes("pant") || textLower.includes("phant")) {
            matched = matched.filter(p => p.category?.toLowerCase().includes("pant") || p.category?.toLowerCase().includes("phant") || p.name.toLowerCase().includes("pant") || p.name.toLowerCase().includes("phant"));
        } else if (textLower.includes("shorts")) {
            matched = matched.filter(p => p.category?.toLowerCase().includes("shorts") || p.name.toLowerCase().includes("shorts"));
        } else {
            matched = matched.filter(p => p.name.toLowerCase().includes(textLower) || p.category?.toLowerCase().includes(textLower));
        }

        if (matched.length > 0) {
            session.searchProducts = matched;
            session.state          = "AWAITING_MODEL_SELECTION";

            const catEmoji = textLower.includes('shirt') ? '👕' :
                textLower.includes('pant') || textLower.includes('phant') ? '👖' :
                    textLower.includes('jeans') ? '👖' :
                        textLower.includes('cargo') ? '👖' :
                            textLower.includes('shorts') ? '🩲' :
                                textLower.includes('tshirt') || textLower.includes('t-shirt') ? '👕' : '🔥';

            let replyText = `${catEmoji} *Super Collections - Available Stock:*\n\n`;
            matched.forEach((p, idx) => {
                let displayName = p.name;
                if (p.color && !displayName.toLowerCase().includes(p.color.toLowerCase())) {
                    displayName = `${p.color} ${displayName}`;
                }
                replyText += `*${idx + 1}.* ${displayName}\n`;
                replyText += `   💰 ₹${p.price}  |  📦 Stock: ${p.stock}\n\n`;
            });
            replyText += `👆 number mattum reply pannunga bro! 😊`;
            return { replyText, sendImages: [], searchProducts: matched };
        } else {
            return { replyText: "Sorry bro, ippo stock illa. 😔 Vera category try pannunga!", sendImages: [] };
        }
    }

    // E. Model Selection
    const numberMatch = textLower.match(/^[1-9][0-9]?$/);
    if (numberMatch && session.state === "AWAITING_MODEL_SELECTION" && session.searchProducts?.length > 0) {
        const idx = parseInt(numberMatch[0], 10) - 1;
        if (idx >= 0 && idx < session.searchProducts.length) {
            const product       = session.searchProducts[idx];
            session.pendingProduct = product;
            session.state          = "AWAITING_SIZE_SELECTION";

            const sizeList = (Array.isArray(product.sizes)
                ? product.sizes
                : String(product.sizes).split(',').map(s => s.trim())
            ).filter(Boolean);
            const sizesText = sizeList.map(s => `* ${s.toUpperCase()}`).join('\n');

            const replyText = `${product.color ? product.color + ' ' : ''}${product.name}\n💰 ₹${product.price}\n📦 Stock: ${product.stock} pcs\n\n📐 Available Sizes:\n${sizesText}\n\nEntha size venum bro? 😊`;

            return {
                replyText,
                sendImages: [{ url: product.imageUri, caption: product.name }],
                pendingProduct: product
            };
        }
    }

    // F. Size Selection
    if (session.state === "AWAITING_SIZE_SELECTION" && session.pendingProduct) {
        const product        = session.pendingProduct;
        const availableSizes = Array.isArray(product.sizes)
            ? product.sizes.map(s => s.toLowerCase().trim())
            : String(product.sizes).toLowerCase().split(',').map(s => s.trim());

        if (availableSizes.includes(textLower)) {
            session.selectedSize = userMessage.toUpperCase();
            session.state        = "AWAITING_CART_CONFIRM";
            return {
                sendButtons: {
                    body: `✅ ${product.name} - ${session.selectedSize}\n\nCart la add pannalama bro?`,
                    buttons: [
                        { id: 'yes', title: '✅ YES' },
                        { id: 'no',  title: '❌ NO'  }
                    ]
                },
                selectedSize: session.selectedSize
            };
        } else {
            const sizeList = Array.isArray(product.sizes) ? product.sizes.join(', ') : product.sizes;
            return {
                replyText: `❌ Intha size stock illa bro.\n\nAvailable sizes:\n${sizeList}`,
                sendImages: []
            };
        }
    }

    // G. Cart Addition Confirmation
    if (session.state === "AWAITING_CART_CONFIRM" && session.pendingProduct) {
        if (textLower === "yes" || textLower === "y" || textLower === "aama" || textLower === "add" || textLower === "ok" || textLower === "add cart") {
            const product = session.pendingProduct;
            session.cart.push({ id: product.id, name: product.name, price: Number(product.price), color: product.color, size: session.selectedSize });

            const isShirt = product.name.toLowerCase().includes("shirt") || product.category?.toLowerCase().includes("shirt") || product.category?.toLowerCase().includes("tshirt");
            let recommended = isShirt
                ? products.find(p => (p.category?.toLowerCase().includes("pant") || p.category?.toLowerCase().includes("phant") || p.name.toLowerCase().includes("pant")) && Number(p.stock) > 0)
                : products.find(p => (p.category?.toLowerCase().includes("shirt") || p.name.toLowerCase().includes("shirt")) && Number(p.stock) > 0);

            session.pendingProduct = null;
            session.selectedSize   = null;

            if (recommended) {
                session.lastRecommendation = recommended;
                session.state              = "AWAITING_RECOMMENDATION_CONFIRM";

                const addedName = `${product.color ? product.color + ' ' : ''}${product.name}`;
                const recName   = `${recommended.color ? recommended.color + ' ' : ''}${recommended.name}`;
                const isShirtAdded = product.name.toLowerCase().includes('shirt') || product.category?.toLowerCase().includes('shirt');
                const matchMsg = isShirtAdded
                    ? `Bro 🔥 Intha *${addedName}*-ku *${recName}* super best match aagum!\n\n💰 ₹${recommended.price}\n\nRomba nalla combo bro 😎 Look-u super-a varum, sure try pannunga!`
                    : `Bro 🔥 Intha *${addedName}* potu *${recName}* potaa perfect combo aagum!\n\n💰 ₹${recommended.price}\n\nFriends ellam wow solluvaanga bro 😎 Try pannunga!`;

                return {
                    sendButtons: {
                        body: matchMsg + `\n\nVenuma bro?`,
                        buttons: [
                            { id: 'yes', title: '✅ YES - Add' },
                            { id: 'no',  title: '❌ NO' }
                        ]
                    },
                    sendImages: [{ url: recommended.imageUri, caption: recName }],
                    cart: session.cart,
                    lastRecommendation: recommended
                };
            } else {
                session.state = "AWAITING_MORE_ITEMS";
                return {
                    sendButtons: {
                        body: `✅ Cart la add achu bro! 😊\n\nVera ethachu pakkiriya bro?`,
                        buttons: [
                            { id: 'yes', title: '🛍️ YES' },
                            { id: 'no',  title: '🛒 NO - Checkout' }
                        ]
                    },
                    sendImages: [],
                    cart: session.cart
                };
            }
        } else if (textLower === "no" || textLower === "n" || textLower === "illai") {
            session.pendingProduct = null;
            session.selectedSize   = null;
            session.state          = "AWAITING_CATEGORY";
            return { replyText: "Ok bro 😊 Vera category search pannunga or BUY nu type pannunga.", sendImages: [] };
        }
    }

    // H. Mix & Match Recommendation Confirmation
    if (session.state === "AWAITING_RECOMMENDATION_CONFIRM" && session.lastRecommendation) {
        const rec = session.lastRecommendation;
        if (textLower === "yes" || textLower === "y" || textLower === "aama" || textLower === "add") {
            const originalItem  = session.cart[session.cart.length - 1];
            session.state       = "AWAITING_COMBO_CART_CONFIRM";
            const origName    = `${originalItem.color ? originalItem.color + ' ' : ''}${originalItem.name}`;
            const recCombName = `${rec.color ? rec.color + ' ' : ''}${rec.name}`;
            return {
                sendButtons: {
                    body: `🔥 *Combo Set:*\n\n• ${origName} (${originalItem.size})\n• ${recCombName}\n\n💰 Combo Total: ₹${Number(originalItem.price) + Number(rec.price)}\n\nBro, intha combo potu paarunga - super-a irukum! 😎👌\n\nCart la add pannalama?`,
                    buttons: [
                        { id: 'yes', title: '✅ YES - Super!' },
                        { id: 'no',  title: '❌ NO' }
                    ]
                },
                sendImages: [{ url: rec.imageUri, caption: recCombName }],
                lastRecommendation: rec
            };
        } else if (textLower === "no" || textLower === "n" || textLower === "illai") {
            session.lastRecommendation = null;
            session.state              = "AWAITING_MORE_ITEMS";
            return {
                sendButtons: {
                    body: `Ok bro! 😊\n\nVera ethachu pakkiriya bro?`,
                    buttons: [
                        { id: 'yes', title: '🛍️ YES' },
                        { id: 'no',  title: '🛒 NO - Checkout' }
                    ]
                },
                sendImages: []
            };
        }
    }

    // I. Combo Cart Confirmation
    if (session.state === "AWAITING_COMBO_CART_CONFIRM" && session.lastRecommendation) {
        const rec = session.lastRecommendation;
        if (textLower === "yes" || textLower === "y" || textLower === "aama" || textLower === "add") {
            const recSize = rec.sizes && rec.sizes.length > 0 ? rec.sizes[0] : "32";
            session.cart.push({ id: rec.id, name: rec.name, price: Number(rec.price), color: rec.color, size: recSize });
            session.lastRecommendation = null;
            session.state              = "AWAITING_MORE_ITEMS";
            return {
                sendButtons: {
                    body: `Super combo add achu bro! 😎\n\nVera ethachu pakkiriya bro?`,
                    buttons: [
                        { id: 'yes', title: '🛍️ YES' },
                        { id: 'no',  title: '🛒 NO - Checkout' }
                    ]
                },
                sendImages: [],
                cart: session.cart
            };
        } else if (textLower === "no" || textLower === "n" || textLower === "illai") {
            session.lastRecommendation = null;
            session.state              = "AWAITING_MORE_ITEMS";
            return {
                sendButtons: {
                    body: `Ok bro! 😊\n\nVera ethachu pakkiriya bro?`,
                    buttons: [
                        { id: 'yes', title: '🛍️ YES' },
                        { id: 'no',  title: '🛒 NO - Checkout' }
                    ]
                },
                sendImages: []
            };
        }
    }

    // J. More Items? (AWAITING_MORE_ITEMS)
    if (session.state === "AWAITING_MORE_ITEMS") {
        if (textLower === "yes" || textLower === "y" || textLower === "aama") {
            session.state = "AWAITING_CATEGORY";
            const cartCount = session.cart.length;
            const cartTotal = session.cart.reduce((sum, i) => sum + Number(i.price), 0);
            return {
                replyText: `Super bro! 😊 Cart la ${cartCount} item(s) iruku (₹${cartTotal})\n\nVera category search pannunga:\n• Cotton Shirt\n• Linen Shirt\n• Jeans\n• Cargo Pant\n• T-Shirt`,
                sendImages: []
            };
        } else if (textLower === "no" || textLower === "n" || textLower === "illai") {
            if (!session.cart || session.cart.length === 0) {
                session.state = "AWAITING_CATEGORY";
                return { replyText: "Cart empty bro 😊 Mudhalla category search pannunga.", sendImages: [] };
            }
            let cartSummary = `🛒 *Your Cart:*\n\n`;
            session.cart.forEach((item, i) => {
                cartSummary += `${i + 1}. ${item.color ? item.color + ' ' : ''}${item.name} (${item.size}) - ₹${item.price}\n`;
            });
            const cartTotal = session.cart.reduce((sum, item) => sum + Number(item.price), 0);
            cartSummary += `\n💰 Total: ₹${cartTotal}\n\n📝 Order confirm panna oru line la anuppunga bro:\n\n*Name, Phone, Address*\n\nExample:\nRavi, 9876543210, 12 Anna Nagar Chennai`;
            session.state        = "AWAITING_CHECKOUT_DETAILS";
            session.orderDetails = { customerName: '', customerPhone: '', customerAddress: '', paymentMethod: 'UPI' };
            return { replyText: cartSummary, sendImages: [] };
        }
    }

    // Smart fallbacks
    if (session.state === "AWAITING_CHECKOUT_DETAILS") {
        return {
            replyText: `📝 Order details anuppunga bro:\n\n*Name, Phone, Address*\n\nExample:\nRavi, 9876543210, 12 Anna Nagar Chennai`,
            sendImages: []
        };
    }
    if (session.state === "AWAITING_MODEL_SELECTION") {
        return {
            replyText: `Number mattum reply pannunga bro 😊 (1, 2, 3...)`,
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

    return {
        replyText: "😊 Enna help venumnu sollunga bro!\n\nDress thedureenga?\n• Cotton Shirt\n• Linen Shirt\n• Jeans\n• Cargo Pant\n• T-Shirt\n\nOr delivery / payment / return pathi kelvi irundha kelunga!",
        sendImages: []
    };
}

// =============================
// Core Message Handler (async — uses await for all DB calls)
// =============================

async function handleMessage(msg) {
    const text = msg.text?.body?.trim() || msg.interactive?.button_reply?.id?.trim() || '';
    const from  = msg.from;

    console.log(`[handleMessage] from=${from} | text="${text}"`);

    if (!text) {
        console.log('[handleMessage] ⚠️ Empty text — ignoring.');
        return;
    }

    const logText = msg.text?.body?.trim() || msg.interactive?.button_reply?.title?.trim() || msg.interactive?.button_reply?.id?.trim() || '';
    await logChatMessage(from, 'customer', logText);

    // Check if bot is paused
    const chats = await getChats();
    if (chats[from]?.botPaused) {
        console.log(`[handleMessage] Bot is PAUSED for ${from}. Skipping auto-reply.`);
        return;
    }

    console.log(`[handleMessage] Bot active for ${from} — processing...`);

    try {
        const products = await getProducts();
        const orders   = await getOrders();
        console.log(`[handleMessage] Loaded ${products.length} products, ${orders.length} orders from Supabase.`);

        // Admin Commands
        if (text.toUpperCase().startsWith('ADMIN')) {
            const parts = text.toUpperCase().split(' ');
            const cmd   = parts[1];

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
                const id    = parts[2];
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
                const id    = parts[2];
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

        // Initialize user session if it doesn't exist
        if (!userSessions[from]) {
            userSessions[from] = {
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

        const session    = userSessions[from];
        const aiResponse = handleSalesAssistantJS(from, text, products, session);

        // Execute session side effects
        if (aiResponse.cart)                                    session.cart                            = aiResponse.cart;
        if (aiResponse.selectedColor   !== undefined)           session.selectedColor                   = aiResponse.selectedColor;
        if (aiResponse.selectedSize    !== undefined)           session.selectedSize                    = aiResponse.selectedSize;
        if (aiResponse.searchProducts  !== undefined)           session.searchProducts                  = aiResponse.searchProducts;
        if (aiResponse.lastRecommendation !== undefined)        session.lastRecommendation              = aiResponse.lastRecommendation;
        if (aiResponse.awaitingRecommendationResponse !== undefined) session.awaitingRecommendationResponse = aiResponse.awaitingRecommendationResponse;
        if (aiResponse.awaitingCartAdditionConfirmation !== undefined) session.awaitingCartAdditionConfirmation = aiResponse.awaitingCartAdditionConfirmation;
        if (aiResponse.pendingProduct  !== undefined)           session.pendingProduct                  = aiResponse.pendingProduct;

        // Order Confirmed — save to Supabase + update stock
        if (aiResponse.isOrderConfirmed && aiResponse.orderDetails) {
            const orderId   = 'ORD-' + Date.now();
            const orderDate = new Date();
            const dateStr   = orderDate.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const timeStr   = orderDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

            const cartItems  = session.cart;
            const totalPrice = cartItems.reduce((sum, item) => sum + Number(item.price), 0);

            const newOrder = {
                id:               orderId,
                customer_phone:   from,
                customer_name:    aiResponse.orderDetails.customerName  || '',
                customer_address: aiResponse.orderDetails.customerAddress || '',
                items:            cartItems.map(item => ({
                    productId: item.id || item.productId,
                    product:   item.name,
                    color:     item.color || '',
                    size:      item.size  || 'N/A',
                    price:     item.price
                })),
                total_price: totalPrice,
                status:      'confirmed',
                date:        orderDate.toISOString()
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

            delete userSessions[from];
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
        if (aiResponse.replyText) {
            await sendText(from, aiResponse.replyText);
            await logChatMessage(from, 'bot', aiResponse.replyText);
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
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
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
    // Always respond 200 immediately so Meta doesn't retry
    res.sendStatus(200);

    try {
        const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg) return;

        console.log(`[USER -> BOT] Message ID: ${msg.id}, Text: "${msg.text?.body}"`);

        if (processed.has(msg.id)) {
            console.log(`[USER -> BOT] Duplicate message ID ignored: ${msg.id}`);
            return;
        }
        processed.add(msg.id);

        await handleMessage(msg);
    } catch (err) {
        console.error('❌ Webhook Processing Error:', err.message);
    }
};

// =============================
// Legacy combined handler (kept for backward compatibility)
// =============================

export const handleWhatsAppWebhook = async (req, res) => {
    if (req.method === 'GET') return verifyWebhook(req, res);
    return receiveWebhook(req, res);
};
