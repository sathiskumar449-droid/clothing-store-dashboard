import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'https://clothing-store-api-two.vercel.app';

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

export default api;
