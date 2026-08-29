import api from './axiosInstance';

/**
 * Fetch WooCommerce products via the backend proxy.
 *
 * WHY proxy instead of browser-direct:
 * Browser → WooCommerce direct calls trigger CORS preflight OPTIONS requests
 * that Cloudflare / most WooCommerce hosts block (ERR_CONNECTION_TIMED_OUT or 404).
 * The backend uses server-to-server Basic Auth with no preflight. Each proxy call
 * fetches one page of 100 products (< 5 s) — well within Vercel's 10 s limit.
 */
export const getWooProducts = async () => {
  let allProducts = [];
  let page = 1;
  let hasMore = true;
  const perPage = 100;

  while (hasMore) {
    const { data } = await api.get('/products/woo/page', { params: { page } });
    const products = data.products;

    if (Array.isArray(products) && products.length > 0) {
      allProducts = [...allProducts, ...products];
      if (products.length < perPage) hasMore = false;
      else page++;
    } else {
      hasMore = false;
    }
  }

  // Variable products keep their actual stock on variation rows. A small worker
  // pool avoids flooding the WooCommerce host with requests.
  const queue = allProducts.filter(product => product.type === 'variable');
  const worker = async () => {
    while (queue.length > 0) {
      const product = queue.shift();
      try {
        const { data } = await api.get(`/products/woo/${product.id}/variations`);
        const variations = data.variations || [];
        let effectiveQty = 0;

        for (const variation of variations) {
          if (variation.stock_status === 'outofstock' || variation.stock_status === 'onbackorder') continue;
          if (variation.manage_stock && variation.stock_quantity !== null && variation.stock_quantity !== undefined) {
            effectiveQty += Math.max(0, Number(variation.stock_quantity));
          } else if (variation.stock_status === 'instock' && !variation.manage_stock) {
            effectiveQty += 1;
          }
        }

        product._effective_stock_quantity = effectiveQty;
        product._effective_stock_status = effectiveQty > 0 ? 'instock' : 'outofstock';
      } catch (error) {
        // Keep the full catalogue sync usable if only one optional stock lookup fails.
        console.warn(`[getWooProducts] Could not fetch variations for product ${product.id}:`, error.message);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return allProducts;
};

/** Sync WooCommerce products to Supabase through the backend API. */
export const syncWooProductsToDb = async (products) => {
  const response = await api.post('/products/sync', { products });
  return response.data;
};
