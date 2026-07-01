import axios from 'axios';

const rawBaseUrl = import.meta.env.VITE_API_URL || 'https://clothing-store-api-two.vercel.app';
const BASE_URL = rawBaseUrl.endsWith('/api') ? rawBaseUrl : `${rawBaseUrl.replace(/\/+$/, '')}/api`;

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': (import.meta.env.VITE_DASHBOARD_API_KEY || '').trim(),
  },
});

export default api;
