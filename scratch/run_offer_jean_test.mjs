import axios from 'axios';
import { supabase } from '../lib/supabase.js';
import { receiveWebhook, getProducts } from '../api/webhook.js';

// Mock axios.post to avoid real Meta/Razorpay calls
let turnLog = [];
const realAxiosPost = axios.post.bind(axios);
axios.post = async function mockedAxiosPost(url, payload, config) {
  if (typeof url === 'string' && url.includes('graph.facebook.com')) {
    turnLog.push({ channel: 'WHATSAPP', url, payload });
    return { data: { messaging_product: 'whatsapp', contacts: [{ wa_id: payload?.to }], messages: [{ id: `MOCK.${Date.now()}` }] } };
  }
  if (typeof url === 'string' && url.includes('api.razorpay.com')) {
    turnLog.push({ channel: 'RAZORPAY', url, payload });
    return { data: { id: 'plink_MOCK', short_url: 'https://rzp.io/i/MOCK' } };
  }
  return realAxiosPost(url, payload, config);
};

// Mock destructive Supabase writes (if any)
const realFrom = supabase.from.bind(supabase);

supabase.from = function mockedFrom(table) {
  const real = realFrom(table);
  if (table === 'orders' || table === 'products') {
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'insert' || prop === 'update') {
          return (rows) => {
            turnLog.push({ channel: 'DB-WRITE-SKIPPED', table, op: prop, rows });
            return Promise.resolve({ data: rows, error: null });
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }
  return real;
};

function nextMessageId() { return `wamid.TEST.${Date.now()}`; }
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
        }, field: 'messages'
      }]
    }]
  };
}

async function run() {
  const TEST_PHONE = '911111111111';
  console.log('Running offer-jean test against receiveWebhook...');
  const message = {
    from: TEST_PHONE,
    id: nextMessageId(),
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body: 'offer jean' }
  };

  const fakeRes = { sendStatus() {}, status() { return { send() {}, json() {} }; } };
  await receiveWebhook({ body: buildEnvelope(message) }, fakeRes);

  if (turnLog.length === 0) {
    console.log('No outgoing messages captured.');
  } else {
    for (const entry of turnLog) {
      if (entry.channel === 'WHATSAPP') {
        console.log('Captured WhatsApp send:', entry.payload?.type, entry.payload?.text || entry.payload?.image || entry.payload?.interactive);
      } else if (entry.channel === 'DB-WRITE-SKIPPED') {
        console.log('DB write skipped:', entry.table, entry.op);
      }
    }
  }
}

run().catch(err => { console.error('Test failed:', err); process.exit(1); });
