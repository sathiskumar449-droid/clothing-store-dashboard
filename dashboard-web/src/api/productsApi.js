import axios from 'axios';
import api from './axiosInstance';

/**
 * Fetch WooCommerce products using credentials stored in localStorage.
 * Settings are saved by SettingsPage.jsx under the key 'woo_settings'.
 * Automatically loops through pages to fetch all products.
 */
export const getWooProducts = async () => {
  const raw = localStorage.getItem('woo_settings');
  if (!raw) throw new Error('WooCommerce settings not configured. Please go to Settings.');
  const { siteUrl, consumerKey, consumerSecret } = JSON.parse(raw);

  if (!siteUrl || !consumerKey || !consumerSecret) {
    throw new Error('Incomplete WooCommerce settings. Please fill in Settings.');
  }

  const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wc/v3/products`;
  
  let allProducts = [];
  let page = 1;
  let hasMore = true;
  const perPage = 100; // WooCommerce API limit per request is 100

  const auth = { username: consumerKey, password: consumerSecret };

  while (hasMore) {
    const response = await axios.get(url, {
      params: { per_page: perPage, page },
      auth,
    });

    const products = response.data;
    if (Array.isArray(products) && products.length > 0) {
      allProducts = [...allProducts, ...products];
      if (products.length < perPage) {
        hasMore = false;
      } else {
        page++;
      }
    } else {
      hasMore = false;
    }
  }

  // Variable products manage stock at the variation level — the parent product always
  // has manage_stock=false and stock_quantity=null. We must check each variation to
  // know how many units are actually available (and whether it's truly out of stock).
  // Attach _effective_stock_quantity and _effective_stock_status so the backend's
  // mapWooStockToSupabase() helper gets accurate inputs.
  const variableProducts = allProducts.filter(p => p.type === 'variable');
  if (variableProducts.length > 0) {
    const varBase = siteUrl.replace(/\/$/, '') + '/wp-json/wc/v3/products';
    await Promise.all(
      variableProducts.map(async (p) => {
        try {
          const { data: variations } = await axios.get(`${varBase}/${p.id}/variations`, {
            params: { per_page: 100 },
            auth,
          });

          let effectiveQty = 0;
          for (const v of variations) {
            if (v.stock_status === 'outofstock' || v.stock_status === 'onbackorder') continue;
            if (v.manage_stock && v.stock_quantity !== null && v.stock_quantity !== undefined) {
              effectiveQty += Math.max(0, Number(v.stock_quantity));
            } else if (v.stock_status === 'instock' && !v.manage_stock) {
              // Untracked variation that WooCommerce calls instock → count as 1
              effectiveQty += 1;
            }
          }

          p._effective_stock_quantity = effectiveQty;
          p._effective_stock_status   = effectiveQty > 0 ? 'instock' : 'outofstock';
        } catch (e) {
          console.warn(`[getWooProducts] Could not fetch variations for product ${p.id}:`, e.message);
        }
      })
    );
  }

  return allProducts;
};

/**
 * Sync WooCommerce products to Supabase database via the backend API.
 */
export const syncWooProductsToDb = async (products) => {
  const response = await api.post('/products/sync', { products });
  return response.data;
};

