import { supabase } from '../lib/supabase.js';

async function run() {
    const { data: chats, error } = await supabase
        .from('chats')
        .select('customer_phone, customer_name, last_updated, last_message')
        .order('last_updated', { ascending: false });

    if (error) {
        console.error('Error fetching chats:', error.message);
        return;
    }

    console.log('=== CHATS IN DB ===');
    chats.forEach((c, idx) => {
        console.log(`[${idx}] Phone: "${c.customer_phone}" | Name: "${c.customer_name}" | Msg: "${c.last_message}" | Updated: ${c.last_updated}`);
    });
}

run();
