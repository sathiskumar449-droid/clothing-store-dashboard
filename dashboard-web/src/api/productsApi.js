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

  while (hasMore) {
    const response = await axios.get(url, {
      params: { per_page: perPage, page },
      auth: { username: consumerKey, password: consumerSecret },
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

  return allProducts;
};

/**
 * Sync WooCommerce products to Supabase database via the backend API.
 */
export const syncWooProductsToDb = async (products) => {
  const response = await api.post('/products/sync', { products });
  return response.data;
};

