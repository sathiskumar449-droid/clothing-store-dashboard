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

    console.log('=== CHAT HISTORY ===');
    const msgs = chat.messages || [];
    msgs.slice(-30).forEach((m, idx) => {
        console.log(`[${idx}] ${m.sender.toUpperCase()} (${m.type}): "${m.text}" | timestamp: ${m.timestamp}`);
    });
}

run();
