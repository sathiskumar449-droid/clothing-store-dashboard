// test-bot-scenarios.js
//
// Pre-launch smoke test that drives api/webhook.js's REAL conversation logic
// (intent detection, state machine, cross-sell, checkout, FAQ) with simulated
// WhatsApp webhook payloads — without ever calling the real Meta Graph API or
// the real (live-mode) Razorpay API, and without mutating real product stock
// or inserting fake rows into the real `orders` table.
//
// Safety measures:
//   1. All outgoing WhatsApp sends (text/buttons/list/image/cta_url/location)
//      go through axios.post to graph.facebook.com — intercepted below and
//      logged instead of actually sent.
//   2. Razorpay payment link creation hits api.razorpay.com with this repo's
//      LIVE keys — also intercepted/logged instead of actually called, so no
//      real payment link is created in the live merchant dashboard.
//   3. `orders` insert and `products` stock update (the two REAL DB writes
//      that fire when an order is confirmed) are intercepted/logged instead
//      of executed, so this run cannot corrupt real inventory counts or
//      clutter the real orders table.
//   4. Everything else (reading the product catalog, an existing order for
//      the tracking-lookup test, and the session/chat rows for the fake test
//      number below) hits the REAL Supabase — that's what we want to exercise.
//
// Run with:  node test-bot-scenarios.js

import axios from 'axios';
import { supabase } from './lib/supabase.js';
import {
    receiveWebhook,
    getProducts,
    getAllSubCategoriesList,
    getParentCategory
} from './api/webhook.js';

const TEST_PHONE = '911111111111'; // obviously-fake test number — keeps real customer data untouched

// ─────────────────────────────────────────────────────────────
// 1. Mock outgoing network calls (WhatsApp + Razorpay)
// ─────────────────────────────────────────────────────────────
let turnLog = [];
const realAxiosPost = axios.post.bind(axios);

axios.post = async function mockedAxiosPost(url, payload, config) {
    if (typeof url === 'string' && url.includes('graph.facebook.com/v18.0') && url.endsWith('/media')) {
        turnLog.push({ channel: 'MEDIA_UPLOAD', url });
        return { data: { id: `MOCK_MEDIA_${Date.now()}` } };
    }
    if (typeof url === 'string' && url.includes('graph.facebook.com')) {
        turnLog.push({ channel: 'WHATSAPP', url, payload });
        return {
            data: {
                messaging_product: 'whatsapp',
                contacts: [{ wa_id: payload?.to }],
                messages: [{ id: `wamid.MOCK.${Date.now()}.${Math.random().toString(36).slice(2, 8)}` }],
                id: `MOCK_MEDIA_${Date.now()}` // covers uploadMedia()'s response.data?.id
            }
        };
    }
    if (typeof url === 'string' && url.includes('api.razorpay.com')) {
        turnLog.push({ channel: 'RAZORPAY', url, payload });
        return {
            data: {
                id: 'plink_MOCKTEST00000000',
                short_url: 'https://rzp.io/i/MOCK_TEST_LINK',
                status: 'created'
            }
        };
    }
    return realAxiosPost(url, payload, config);
};

// ─────────────────────────────────────────────────────────────
// 2. Intercept the two destructive Supabase writes (stock decrement + order insert).
//    Everything else (reads, sessions, chats, collage_cache) hits the real DB.
// ─────────────────────────────────────────────────────────────
const realFrom = supabase.from.bind(supabase);

supabase.from = function mockedFrom(table) {
    const real = realFrom(table);

    if (table === 'orders') {
        return new Proxy(real, {
            get(target, prop) {
                if (prop === 'insert') {
                    return (rows) => {
                        turnLog.push({ channel: 'DB-WRITE-SKIPPED', table: 'orders', op: 'insert', rows });
                        return Promise.resolve({ data: rows, error: null });
                    };
                }
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    }

    if (table === 'products') {
        return new Proxy(real, {
            get(target, prop) {
                if (prop === 'update') {
                    return (vals) => {
                        const entry = { channel: 'DB-WRITE-SKIPPED', table: 'products', op: 'update', vals, eqCalls: [] };
                        turnLog.push(entry);
                        return {
                            eq: (col, val) => {
                                entry.eqCalls.push([col, val]);
                                return Promise.resolve({ error: null });
                            }
                        };
                    };
                }
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    }

    return real;
};

// ─────────────────────────────────────────────────────────────
// 3. Webhook payload builders + transcript helpers
// ─────────────────────────────────────────────────────────────
let msgCounter = 0;
function nextMessageId() {
    msgCounter += 1;
    return `wamid.TEST.${Date.now()}.${msgCounter}`;
}

function buildEnvelope(message) {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: 'TEST_WABA_ID',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: 'TEST', phone_number_id: process.env.PHONE_ID || 'TEST_PHONE_ID' },
                    contacts: [{ profile: { name: 'Test Customer' }, wa_id: message.from }],
                    messages: [message]
                },
                field: 'messages'
            }]
        }]
    };
}

const fakeRes = { sendStatus() {}, status() { return { send() {}, json() {} }; } };

function describePayload(payload) {
    if (!payload || typeof payload !== 'object') return String(payload);
    if (payload.type === 'text') return `TEXT: "${payload.text?.body}"`;
    if (payload.type === 'location') {
        const l = payload.location || {};
        return `LOCATION: ${l.name}, ${l.address} (lat=${l.latitude}, lng=${l.longitude})`;
    }
    if (payload.type === 'image') {
        return `IMAGE: caption="${payload.image?.caption || ''}" ${payload.image?.link ? 'link=' + payload.image.link : 'media_id=' + payload.image?.id}`;
    }
    if (payload.type === 'interactive') {
        const i = payload.interactive || {};
        if (i.type === 'cta_url') {
            const header = i.header?.type === 'text' ? i.header.text : '(image header)';
            return `CTA_URL CARD: header="${header}" body="${i.body?.text}" button="${i.action?.parameters?.display_text}" -> ${i.action?.parameters?.url}`;
        }
        if (i.type === 'button') {
            const btns = (i.action?.buttons || []).map(b => b.reply?.title).join(' | ');
            return `BUTTONS: "${i.body?.text}"  [${btns}]`;
        }
        if (i.type === 'list') {
            const rows = (i.action?.sections || []).flatMap(s => s.rows || []).map(r => r.title).join(' | ');
            return `LIST: "${i.body?.text}"  Rows: [${rows}]`;
        }
        return `INTERACTIVE(${i.type}): ${JSON.stringify(i)}`;
    }
    return JSON.stringify(payload);
}

function flushTurnLog() {
    if (turnLog.length === 0) {
        console.log('BOT WOULD SEND: (nothing captured this turn)');
        return;
    }
    for (const entry of turnLog) {
        if (entry.channel === 'MEDIA_UPLOAD') {
            console.log(`BOT WOULD UPLOAD MEDIA [Meta media endpoint, MOCKED]: ${entry.url}`);
        } else if (entry.channel === 'WHATSAPP') {
            console.log(`BOT WOULD SEND [WhatsApp -> ${entry.payload?.to}]: ${describePayload(entry.payload)}`);
        } else if (entry.channel === 'RAZORPAY') {
            console.log(`BOT WOULD CALL [Razorpay, MOCKED — not a real live charge/link]: amount=₹${(entry.payload?.amount || 0) / 100} desc="${entry.payload?.description}"`);
        } else if (entry.channel === 'DB-WRITE-SKIPPED') {
            if (entry.table === 'orders') {
                console.log(`DB WRITE SKIPPED [orders.insert]: id=${entry.rows?.[0]?.id} total=₹${entry.rows?.[0]?.total_price}`);
            } else {
                console.log(`DB WRITE SKIPPED [products.update]: ${JSON.stringify(entry.vals)} WHERE ${entry.eqCalls.map(([c, v]) => `${c}=${v}`).join(', ')}`);
            }
        }
    }
    turnLog = [];
}

async function customerSendsText(text) {
    console.log(`\nCUSTOMER: ${text}`);
    turnLog = [];
    const message = {
        from: TEST_PHONE,
        id: nextMessageId(),
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: text }
    };
    await receiveWebhook({ body: buildEnvelope(message) }, fakeRes);
    flushTurnLog();
}

async function customerTapsButton(buttonId, buttonTitle) {
    console.log(`\nCUSTOMER: (tapped button) "${buttonTitle}" [id=${buttonId}]`);
    turnLog = [];
    const message = {
        from: TEST_PHONE,
        id: nextMessageId(),
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: buttonId, title: buttonTitle } }
    };
    await receiveWebhook({ body: buildEnvelope(message) }, fakeRes);
    flushTurnLog();
}

function section(title) {
    console.log(`\n${'═'.repeat(70)}\n${title}\n${'═'.repeat(70)}`);
}

// ─────────────────────────────────────────────────────────────
// 4. Discover real, current catalog data (read-only) to drive realistic scenarios
// ─────────────────────────────────────────────────────────────
async function discoverFixtures() {
    const products = await getProducts();
    const subCategories = getAllSubCategoriesList(products);

    if (subCategories.length < 2) {
        throw new Error(`Need at least 2 in-stock subcategories to run scenarios, found ${subCategories.length}`);
    }

    const pickSubcategoryFixture = (subName) => {
        const subProducts = products.filter(p => Number(p.stock) > 0 && p.category === subName);
        const product = subProducts[0];
        const sizeList = (Array.isArray(product.sizes) ? product.sizes : String(product.sizes).split(',').map(s => s.trim())).filter(Boolean);
        return {
            subName,
            menuNumber: subCategories.indexOf(subName) + 1,
            productCount: subProducts.length,
            firstProductName: product.name,
            validSize: sizeList[0] || 'M',
            parent: getParentCategory(subName)
        };
    };

    const fixtureA = pickSubcategoryFixture(subCategories[0]);
    const fixtureB = pickSubcategoryFixture(subCategories[1]);

    const { data: orderRows } = await supabase
        .from('orders')
        .select('id')
        .order('date', { ascending: false })
        .limit(1);
    const realOrderId = orderRows?.[0]?.id || null;

    return { subCategories, fixtureA, fixtureB, realOrderId };
}

// ─────────────────────────────────────────────────────────────
// 5. Scenarios
// ─────────────────────────────────────────────────────────────
async function scenarioGreetings() {
    section('SCENARIO (a) — Greeting variations');
    await customerSendsText('hi');
    await customerSendsText('Hii');
    await customerSendsText('வணக்கம்');
}

async function scenarioBrowseAndAddToCart(fixture) {
    section(`SCENARIO (b)+(c) — Browse "${fixture.subName}" -> select product -> add to cart -> cross-sell`);
    await customerTapsButton('shop_now', '🛍️ Shop Now');
    await customerSendsText(String(fixture.menuNumber)); // pick subcategory
    if (fixture.productCount > 1) {
        await customerSendsText('1'); // pick first product in the list
    }
    await customerSendsText(fixture.validSize); // pick size
    await customerSendsText('1'); // qty
}

async function scenarioSearch() {
    section('SCENARIO (d) — Free-text search: English, then Tanglish/typo variants');
    await customerSendsText('tshirt');
    await customerSendsText('t shirt');
    await customerSendsText('phant');
}

async function scenarioSecondAddToCartNoRepeatCrossSell(fixture) {
    section(`SCENARIO (e) — Second add-to-cart on "${fixture.subName}" — cross-sell should NOT repeat`);
    await customerSendsText('shop more');
    await customerSendsText(String(fixture.menuNumber));
    if (fixture.productCount > 1) {
        await customerSendsText('1');
    }
    await customerSendsText(fixture.validSize);
    await customerSendsText('1');
}

async function scenarioInvalidInput() {
    section('SCENARIO (f) — Invalid input handling');
    await customerSendsText('shop more'); // land back on the flat category menu (single-number state)
    await customerSendsText('1,2');
    await customerSendsText('abc xyz');
}

async function scenarioCheckout() {
    section('SCENARIO (g) — Checkout -> Razorpay payment link (MOCKED, no real live call)');
    await customerSendsText('checkout');
    await customerSendsText('Test Customer');
    await customerTapsButton('use_current_phone', '📱 Use Current Number');
    await customerSendsText('642126');
    await customerSendsText('123 Test Street, Test Town');
    await customerTapsButton('confirm_order_yes', '✅ Yes, Place Order');
}

async function scenarioOrderHelp() {
    section('SCENARIO (h) — Order Help submenu, all 4 FAQ options (typed back-to-back, no re-tapping)');
    await customerTapsButton('order_help', '📦 Order Help');
    await customerSendsText('1'); // should show FAQ #1, and stay armed for another digit
    await customerSendsText('2'); // typed immediately after #1 — should show FAQ #2, not a category response
    await customerSendsText('3'); // should show FAQ #3
    await customerSendsText('4'); // terminal choice — should show FAQ #4 and clear the flag
}

async function scenarioOrderStatusLookup(realOrderId) {
    section('SCENARIO (i) — Existing order status lookup (read-only against real orders table)');
    if (!realOrderId) {
        console.log('SKIPPED — no existing orders found in Supabase to look up.');
        return;
    }
    await customerSendsText(`Where is my order ${realOrderId}?`);
}

async function scenarioOutOfStockVariant(fixture) {
    section(`SCENARIO (j) — Select an out-of-stock size variant on "${fixture.subName}"`);
    await customerSendsText('shop more');
    await customerSendsText(String(fixture.menuNumber));
    if (fixture.productCount > 1) {
        await customerSendsText('1');
    }
    await customerSendsText('XXXL-DOES-NOT-EXIST'); // deliberately invalid/unavailable size
}

// ─────────────────────────────────────────────────────────────
// 6. Runner — each scenario isolated in try/catch so one failure doesn't abort the rest
// ─────────────────────────────────────────────────────────────
async function run() {
    console.log(`Using fake test phone number: ${TEST_PHONE}`);
    console.log('All WhatsApp sends and Razorpay calls are MOCKED. Stock updates / order inserts are SKIPPED (logged only).\n');

    let fixtures;
    try {
        fixtures = await discoverFixtures();
        console.log('Discovered catalog fixtures:');
        console.log(`  Subcategory A: "${fixtures.fixtureA.subName}" (menu #${fixtures.fixtureA.menuNumber}, parent=${fixtures.fixtureA.parent}, product="${fixtures.fixtureA.firstProductName}", size="${fixtures.fixtureA.validSize}")`);
        console.log(`  Subcategory B: "${fixtures.fixtureB.subName}" (menu #${fixtures.fixtureB.menuNumber}, parent=${fixtures.fixtureB.parent}, product="${fixtures.fixtureB.firstProductName}", size="${fixtures.fixtureB.validSize}")`);
        console.log(`  Existing order for tracking-lookup test: ${fixtures.realOrderId || '(none found)'}`);
    } catch (err) {
        console.error('❌ FATAL — could not discover catalog fixtures, aborting:', err.message);
        return;
    }

    const scenarios = [
        ['a) Greetings', () => scenarioGreetings()],
        ['b+c) Browse/add-to-cart/cross-sell', () => scenarioBrowseAndAddToCart(fixtures.fixtureA)],
        ['d) Search variants', () => scenarioSearch()],
        ['e) Second add-to-cart, no repeat cross-sell', () => scenarioSecondAddToCartNoRepeatCrossSell(fixtures.fixtureB)],
        ['f) Invalid input', () => scenarioInvalidInput()],
        ['g) Checkout + Razorpay link', () => scenarioCheckout()],
        ['h) Order Help submenu', () => scenarioOrderHelp()],
        ['i) Order status lookup', () => scenarioOrderStatusLookup(fixtures.realOrderId)],
        ['j) Out-of-stock variant', () => scenarioOutOfStockVariant(fixtures.fixtureA)]
    ];

    for (const [name, fn] of scenarios) {
        try {
            await fn();
        } catch (err) {
            console.error(`\n❌ SCENARIO "${name}" THREW AN ERROR — logged, moving to next scenario:`);
            console.error(err.stack || err.message);
        }
    }

    section('DONE');
    console.log(`Test conversation lives under phone number ${TEST_PHONE} in Supabase (sessions/chats) — safe to delete manually if you want to clean up.`);
}

run();
