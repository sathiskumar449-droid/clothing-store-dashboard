import axios from 'axios';
import api from './axiosInstance';

/**
 * Fetch WooCommerce products using credentials stored in localStorage.
 * Settings are saved by SettingsPage.jsx under the key 'woo_settings'.
 */
export const getWooProducts = async (page = 1, perPage = 50) => {
  const raw = localStorage.getItem('woo_settings');
  if (!raw) throw new Error('WooCommerce settings not configured. Please go to Settings.');
  const { siteUrl, consumerKey, consumerSecret } = JSON.parse(raw);

  if (!siteUrl || !consumerKey || !consumerSecret) {
    throw new Error('Incomplete WooCommerce settings. Please fill in Settings.');
  }

  const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wc/v3/products`;
  const response = await axios.get(url, {
    params: { per_page: perPage, page },
    auth: { username: consumerKey, password: consumerSecret },
  });
  return response.data;
};

/**
 * Sync WooCommerce products to Supabase database via the backend API.
 */
export const syncWooProductsToDb = async (products) => {
  const response = await api.post('/products/sync', { products });
  return response.data;
};

