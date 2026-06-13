import supabase from './utils/supabaseClient.js';

async function checkDatabase() {
    console.log("Checking Supabase 'products' table...");
    try {
        const { data, error } = await supabase.from('products').select('*');
        if (error) {
            console.error("Supabase Error:", error.message);
        } else {
            console.log(`Found ${data.length} products.`);
            if (data.length > 0) {
                console.log("Here are the codes in your database:");
                console.log(data.map(p => `'${p.code}'`).join(', '));
            } else {
                console.log("THE TABLE IS EMPTY! The sample data hasn't been inserted.");
            }
        }
    } catch (err) {
        console.error("Caught error:", err);
    }
}

checkDatabase();
