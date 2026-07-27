import { supabase } from '../lib/supabase.js';

async function run() {
  const { data, error } = await supabase
    .from('orders')
    .select('id, status, date, total_price, customer_name')
    .gte('date', '2026-07-26T00:00:00')
    .lte('date', '2026-07-26T23:59:59');

  if (error) {
    console.error('Error fetching orders:', error);
    return;
  }

  console.log(`Found ${data.length} orders in Supabase for 26-Jul-2026:`);
  data.forEach(o => {
    console.log(`- ${o.id}: Status=${o.status}, Date=${o.date}, Total=${o.total_price}, Customer=${o.customer_name}`);
  });
}

run();
