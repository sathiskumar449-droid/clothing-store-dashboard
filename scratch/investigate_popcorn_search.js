// Investigation script — drives the REAL webhook logic (receiveWebhook) against the LIVE
// Supabase catalog for the 6 Popcorn Track Pant queries, without sending real WhatsApp/Razorpay
// calls or writing to orders/products tables. Modeled on test-bot-scenarios.js's safety harness.

import axios from 'axios';
import { supabase } from '../lib/supabase.js';
import { receiveWebhook } from '../api/webhook.js';

// ---- mock outgoing network calls ----
let turnLog = [];
axios.post = async function mockedAxiosPost(url, payload) {
    if (typeof url === 'string' && url.includes('graph.facebook.com')) {
        turnLog.push({ channel: 'WHATSAPP', payload });
        return { data: { messaging_product: 'whatsapp', contacts: [{ wa_id: payload?.to }], messages: [{ id: 'MOCK' }] } };
    }
    if (typeof url === 'string' && url.includes('api.razorpay.com')) {
        turnLog.push({ channel: 'RAZORPAY', payload });
        return { data: { id: 'plink_MOCK', short_url: 'https://rzp.io/i/MOCK', status: 'created' } };
    }
    return { data: {} };
};

// ---- intercept destructive DB writes ----
const realFrom = supabase.from.bind(supabase);
supabase.from = function mockedFrom(table) {
    const real = realFrom(table);
    if (table === 'orders') {
        return new Proxy(real, { get(target, prop) {
            if (prop === 'insert') return (rows) => Promise.resolve({ data: rows, error: null });
            const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
        }});
    }
    if (table === 'products') {
        return new Proxy(real, { get(target, prop) {
            if (prop === 'update') return () => ({ eq: () => Promise.resolve({ error: null }) });
            const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
        }});
    }
    return real;
};

const fakeRes = { sendStatus() {}, status() { return { send() {}, json() {} }; } };
let msgCounter = 0;

function buildEnvelope(message) {
    return {
        object: 'whatsapp_business_account',
        entry: [{ id: 'TEST_WABA_ID', changes: [{ value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: 'TEST', phone_number_id: process.env.PHONE_ID || 'TEST_PHONE_ID' },
            contacts: [{ profile: { name: 'Investigator' }, wa_id: message.from }],
            messages: [message]
        }, field: 'messages' }] }]
    };
}

function describePayload(payload) {
    if (!payload || typeof payload !== 'object') return String(payload);
    if (payload.type === 'text') return `TEXT: "${payload.text?.body}"`;
    if (payload.type === 'image') return `IMAGE: caption="${payload.image?.caption || ''}" link=${payload.image?.link || ''}`;
    if (payload.type === 'interactive') {
        const i = payload.interactive || {};
        if (i.type === 'cta_url') {
            const header = i.header?.type === 'text' ? i.header.text : (i.header?.type === 'image' ? '(image header)' : '(no header)');
            return `CTA_URL CARD: header="${header}" body="${(i.body?.text || '').replace(/\n/g, ' | ')}" button="${i.action?.parameters?.display_text}" -> ${i.action?.parameters?.url}`;
        }
        if (i.type === 'button') {
            const btns = (i.action?.buttons || []).map(b => b.reply?.title).join(' | ');
            return `BUTTONS: "${(i.body?.text || '').replace(/\n/g, ' | ')}"  [${btns}]`;
        }
        if (i.type === 'list') {
            const rows = (i.action?.sections || []).flatMap(s => s.rows || []).map(r => r.title).join(' | ');
            return `LIST: "${(i.body?.text || '').replace(/\n/g, ' | ')}"  Rows: [${rows}]`;
        }
        return `INTERACTIVE(${i.type}): ${JSON.stringify(i)}`;
    }
    return JSON.stringify(payload);
}

async function runQuery(phoneSuffix, text) {
    const phone = `92220000${phoneSuffix}`;
    // ensure a totally fresh session for this fake phone
    await supabase.from('chats').delete().eq('phone', phone);

    msgCounter += 1;
    const message = {
        from: phone,
        id: `wamid.INVESTIGATE.${Date.now()}.${msgCounter}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: text }
    };
    turnLog = [];
    await receiveWebhook({ body: buildEnvelope(message) }, fakeRes);

    console.log(`\n${'='.repeat(78)}`);
    console.log(`QUERY: "${text}"`);
    console.log('-'.repeat(78));
    if (turnLog.length === 0) {
        console.log('BOT SENT: (nothing captured)');
    }
    for (const entry of turnLog) {
        if (entry.channel === 'WHATSAPP') console.log('BOT SENT:', describePayload(entry.payload));
        else if (entry.channel === 'RAZORPAY') console.log('RAZORPAY (mocked):', JSON.stringify(entry.payload));
    }
}

async function runConversation(phoneSuffix, texts) {
    const phone = `92230000${phoneSuffix}`;
    await supabase.from('chats').delete().eq('phone', phone);
    for (const text of texts) {
        msgCounter += 1;
        const message = {
            from: phone,
            id: `wamid.INVESTIGATE.${Date.now()}.${msgCounter}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text }
        };
        turnLog = [];
        await receiveWebhook({ body: buildEnvelope(message) }, fakeRes);
        console.log(`\n${'='.repeat(78)}`);
        console.log(`CONV[${phoneSuffix}] SAYS: "${text}"`);
        console.log('-'.repeat(78));
        if (turnLog.length === 0) console.log('BOT SENT: (nothing captured)');
        for (const entry of turnLog) {
            if (entry.channel === 'WHATSAPP') console.log('BOT SENT:', describePayload(entry.payload));
            else if (entry.channel === 'RAZORPAY') console.log('RAZORPAY (mocked):', JSON.stringify(entry.payload));
        }
    }
}

async function main() {
    const queries = [
        'Adidas Popcorn Track Pant',
        'popcorn track pant',
        'track pant',
        'adidas pant',
        'navy blue track pant',
        'royal blue track pant',
        'dark grey track pant',
        'black track pant',
        'white track pant',
        'cotton pant',
        'navy blue cotton pant',
        'cargo pant',
        'cargo pant black'
    ];
    let i = 0;
    for (const q of queries) {
        i += 1;
        await runQuery(i, q);
    }
    process.exit(0);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
