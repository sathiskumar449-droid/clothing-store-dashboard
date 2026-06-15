import { supabase } from '../lib/supabase.js';

async function run() {
    const { data, error } = await supabase
        .from('chats')
        .select('customer_phone, customer_name, last_updated')
        .order('last_updated', { ascending: false })
        .limit(10);

    if (error) {
        console.error('Error fetching chats:', error.message);
        return;
    }

    console.log('Recent Chats:');
    data.forEach(c => {
        console.log(`- ${c.customer_phone} (${c.customer_name}) updated at ${c.last_updated}`);
    });
}

run();
