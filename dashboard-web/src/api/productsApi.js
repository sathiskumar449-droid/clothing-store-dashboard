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

  // Some WooCommerce hosts time out every /variations request even though the
  // product feed works. Do not make hundreds of optional variation requests
  // during a manual sync: the parent product's stock_status still preserves the
  // important in-stock/out-of-stock state and the catalogue saves immediately.
  // WooCommerce includes descriptions, HTML and plugin metadata in every row.
  // Sending all of that back to Vercel easily exceeds its request-body limit;
  // only the fields used by mapWooProductToDb() belong in the sync payload.
  return allProducts.map(product => ({
    id: product.id,
    name: product.name,
    sku: product.sku,
    type: product.type,
    status: product.status,
    price: product.price,
    stock_status: product.stock_status,
    stock_quantity: product.stock_quantity,
    manage_stock: product.manage_stock,
    permalink: product.permalink,
    categories: (product.categories || []).map(category => ({ name: category.name })),
    attributes: (product.attributes || []).map(attribute => ({
      name: attribute.name,
      options: attribute.options
    })),
    images: product.images?.[0]?.src ? [{ src: product.images[0].src }] : []
  }));
};

/** Sync WooCommerce products to Supabase through the backend API. */
export const syncWooProductsToDb = async (products) => {
  const response = await api.post('/products/sync', { products });
  return response.data;
};
