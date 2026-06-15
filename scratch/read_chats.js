import { supabase } from '../lib/supabase.js';

async function run() {
    const phone = '919942305574';
    const { data: chat, error } = await supabase
        .from('chats')
        .select('*')
        .eq('customer_phone', phone)
        .maybeSingle();

    if (error) {
        console.error('Error fetching chat:', error.message);
        return;
    }

    if (!chat) {
        console.log('No chat found for', phone);
        return;
    }

    console.log('Customer Phone:', chat.customer_phone);
    console.log('Customer Name:', chat.customer_name);
    console.log('Bot Paused:', chat.bot_paused);
    console.log('Last Message:', chat.last_message);
    console.log('Messages Log:');
    chat.messages.slice(-15).forEach((m, idx) => {
        console.log(`[${idx}] ${m.sender.toUpperCase()} (${m.type}): "${m.text}" | msgId: ${m.messageId}`);
    });

    const { data: sessionData } = await supabase
        .from('chats')
        .select('*')
        .eq('customer_phone', `session_${phone}`)
        .maybeSingle();

    if (sessionData) {
        console.log('\nSession Data:', JSON.stringify(JSON.parse(sessionData.last_message), null, 2));
    }
}

run();
