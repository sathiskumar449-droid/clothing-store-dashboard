import axios from 'axios';

// VITE_ variables are bundled into the public JS bundle at build time, so there is no
// security benefit to keeping them as Vercel Secrets. Hardcoding the production values
// as fallbacks ensures the app works even when Vercel env vars aren't configured.
const PROD_API_URL = 'https://clothing-store-api-two.vercel.app';
const PROD_API_KEY = 'e2f198b6ca69db732f7475aef0150e70298905b430f9c6e2';

const rawBaseUrl = import.meta.env.VITE_API_URL || PROD_API_URL;
const BASE_URL = rawBaseUrl.endsWith('/api') ? rawBaseUrl : `${rawBaseUrl.replace(/\/+$/, '')}/api`;

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 60000, // 60 seconds default (sync-from-woo gets 3 mins via per-request override)
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': (import.meta.env.VITE_DASHBOARD_API_KEY || PROD_API_KEY).trim(),
  },
});

export default api;
