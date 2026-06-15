import { supabase } from '../lib/supabase.js';

async function run() {
    const phone = '919942305574';
    const { data: chat } = await supabase
        .from('chats')
        .select('messages')
        .eq('customer_phone', phone)
        .maybeSingle();

    if (chat && chat.messages) {
        console.log('Messages Log:');
        chat.messages.slice(-20).forEach((m, idx) => {
            console.log(`[${idx}] ${m.sender.toUpperCase()} (${m.type}): "${m.text}" | msgId: ${m.messageId}`);
        });
    }
}

run();
