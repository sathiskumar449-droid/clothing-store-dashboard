// api/public-products.js
// PUBLIC read-only products endpoint — demo store ku mattum. Read-only. Safe.
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;

    const products = (data || [])
      .filter(row => (row.status || 'publish') === 'publish')
      .map(row => ({
        id: row.id, name: row.name, category: row.category,
        color: row.color, price: row.price, stock: row.stock,
        sizes: row.sizes || [], image: row.image_uri,
        permalink: row.permalink || null
      }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ success: true, count: products.length, products });
  } catch (err) {
    console.error('[public-products] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}
