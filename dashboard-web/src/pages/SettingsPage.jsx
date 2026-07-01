import { useState, useEffect } from 'react';
import { Save, Store, Phone, MapPin, MessageSquare, Bot, Globe, Key, CheckCircle } from 'lucide-react';
import api from '../api/axiosInstance';
import CouponSettings from '../components/CouponSettings';

const STORE_KEY = 'store_settings';
const WOO_KEY = 'woo_settings';

const defaultStore = {
  storeName: 'Super Collection',
  phone: '',
  address: '',
  welcomeMessage: 'Hello! Welcome to our store 👋\nHow can I help you today?',
};

const defaultWoo = {
  siteUrl: '',
  consumerKey: '',
  consumerSecret: '',
};

function Section({ title, icon: Icon, children }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 md:p-6">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
          <Icon size={16} className="text-indigo-600" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Field({ label, id, children }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-gray-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full px-3.5 py-2.5 min-h-11 text-sm rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition";

export default function SettingsPage() {
  const [storeSettings, setStoreSettings] = useState(defaultStore);
  const [wooSettings, setWooSettings] = useState(defaultWoo);
  const [savedStore, setSavedStore] = useState(false);
  const [savedWoo, setSavedWoo] = useState(false);

  useEffect(() => {
    // 1. Load store settings from database (fallback to local storage)
    const loadStore = async () => {
      try {
        const response = await api.get('/settings/store');
        if (response.data && response.data.storeName) {
          setStoreSettings(response.data);
          localStorage.setItem(STORE_KEY, JSON.stringify(response.data));
        } else {
          const s = localStorage.getItem(STORE_KEY);
          if (s) setStoreSettings({ ...defaultStore, ...JSON.parse(s) });
        }
      } catch (err) {
        console.error('Failed to load store settings from database', err);
        const s = localStorage.getItem(STORE_KEY);
        if (s) setStoreSettings({ ...defaultStore, ...JSON.parse(s) });
      }
    };
    loadStore();

    // 2. Load WooCommerce settings from database (fallback to local storage)
    const loadWoo = async () => {
      try {
        const response = await api.get('/settings/woo');
        if (response.data && response.data.siteUrl) {
          setWooSettings(response.data);
          localStorage.setItem(WOO_KEY, JSON.stringify(response.data));
        } else {
          // Fallback to local storage if not configured in DB yet
          const w = localStorage.getItem(WOO_KEY);
          if (w) setWooSettings({ ...defaultWoo, ...JSON.parse(w) });
        }
      } catch (err) {
        console.error('Failed to load settings from database', err);
        // Fallback to local storage
        const w = localStorage.getItem(WOO_KEY);
        if (w) setWooSettings({ ...defaultWoo, ...JSON.parse(w) });
      }
    };
    loadWoo();
  }, []);

  const saveStore = async () => {
    try {
      // Save to localStorage
      localStorage.setItem(STORE_KEY, JSON.stringify(storeSettings));

      // Save to database
      const response = await api.post('/settings/store', storeSettings);
      if (response.data.success) {
        setSavedStore(true);
        setTimeout(() => setSavedStore(false), 2000);
      } else {
        alert(response.data.message || 'Failed to save store settings to database');
      }
    } catch (err) {
      console.error(err);
      const msg = err.response?.data?.message || 'Failed to save store settings to database';
      alert(msg);
    }
  };

  const saveWoo = async () => {
    try {
      // Save to localStorage
      localStorage.setItem(WOO_KEY, JSON.stringify(wooSettings));
      
      // Save to database
      const response = await api.post('/settings/woo', wooSettings);
      if (response.data.success) {
        setSavedWoo(true);
        setTimeout(() => setSavedWoo(false), 2000);
      } else {
        alert(response.data.message || 'Failed to save settings to database');
      }
    } catch (err) {
      console.error(err);
      const msg = err.response?.data?.message || 'Failed to save WooCommerce settings to database';
      alert(msg);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure your store and integrations</p>
      </div>

      <div className="space-y-5">
        {/* Store Info */}
        <Section title="Store Information" icon={Store}>
          <div className="space-y-4">
            <Field label="Store Name" id="store-name">
              <div className="relative">
                <Store size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="store-name"
                  type="text"
                  value={storeSettings.storeName}
                  onChange={e => setStoreSettings(p => ({ ...p, storeName: e.target.value }))}
                  className={`${inputCls} pl-9`}
                  placeholder="Your store name"
                />
              </div>
            </Field>
            <Field label="Contact Phone" id="store-phone">
              <div className="relative">
                <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="store-phone"
                  type="text"
                  value={storeSettings.phone}
                  onChange={e => setStoreSettings(p => ({ ...p, phone: e.target.value }))}
                  className={`${inputCls} pl-9`}
                  placeholder="+91 99999 99999"
                />
              </div>
            </Field>
            <Field label="Store Address" id="store-address">
              <div className="relative">
                <MapPin size={14} className="absolute left-3 top-3 text-gray-400" />
                <textarea
                  id="store-address"
                  rows={2}
                  value={storeSettings.address}
                  onChange={e => setStoreSettings(p => ({ ...p, address: e.target.value }))}
                  className={`${inputCls} pl-9 resize-none`}
                  placeholder="123 Main Street, City"
                />
              </div>
            </Field>
            <button
              onClick={saveStore}
              className={`flex items-center gap-2 px-4 py-2.5 min-h-11 rounded-xl text-sm font-semibold transition-all duration-300 ease-in-out active:scale-95 ${
                savedStore
                  ? 'bg-emerald-600 text-white'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              {savedStore ? <CheckCircle size={15} /> : <Save size={15} />}
              {savedStore ? 'Saved!' : 'Save Store Info'}
            </button>
          </div>
        </Section>

        {/* WhatsApp Bot */}
        <Section title="WhatsApp Bot Settings" icon={Bot}>
          <div className="space-y-4">
            <Field label="Welcome Message" id="welcome-msg">
              <div className="relative">
                <MessageSquare size={14} className="absolute left-3 top-3 text-gray-400" />
                <textarea
                  id="welcome-msg"
                  rows={4}
                  value={storeSettings.welcomeMessage}
                  onChange={e => setStoreSettings(p => ({ ...p, welcomeMessage: e.target.value }))}
                  className={`${inputCls} pl-9 resize-none`}
                  placeholder="Welcome message sent to new customers"
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">This message is sent automatically to customers when they greet the bot (e.g. saying "hi").</p>
            </Field>
            <button
              onClick={saveStore}
              className={`flex items-center gap-2 px-4 py-2.5 min-h-11 rounded-xl text-sm font-semibold transition-all duration-300 ease-in-out active:scale-95 ${
                savedStore
                  ? 'bg-emerald-600 text-white'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              {savedStore ? <CheckCircle size={15} /> : <Save size={15} />}
              {savedStore ? 'Saved!' : 'Save Bot Settings'}
            </button>
          </div>
        </Section>

        {/* WooCommerce */}
        <Section title="WooCommerce Integration" icon={Globe}>
          <p className="text-xs text-gray-500 mb-4 bg-blue-50 border border-blue-100 rounded-lg p-3">
            These credentials are used to fetch products from your WooCommerce store directly in the browser. 
            They are stored only in your browser's local storage.
          </p>
          <div className="space-y-4">
            <Field label="WooCommerce Site URL" id="woo-url">
              <div className="relative">
                <Globe size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="woo-url"
                  type="url"
                  value={wooSettings.siteUrl}
                  onChange={e => setWooSettings(p => ({ ...p, siteUrl: e.target.value }))}
                  className={`${inputCls} pl-9`}
                  placeholder="https://yourstore.com"
                />
              </div>
            </Field>
            <Field label="Consumer Key" id="woo-key">
              <div className="relative">
                <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="woo-key"
                  type="password"
                  value={wooSettings.consumerKey}
                  onChange={e => setWooSettings(p => ({ ...p, consumerKey: e.target.value }))}
                  className={`${inputCls} pl-9`}
                  placeholder="ck_xxxxxxxxxxxxxxxx"
                />
              </div>
            </Field>
            <Field label="Consumer Secret" id="woo-secret">
              <div className="relative">
                <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="woo-secret"
                  type="password"
                  value={wooSettings.consumerSecret}
                  onChange={e => setWooSettings(p => ({ ...p, consumerSecret: e.target.value }))}
                  className={`${inputCls} pl-9`}
                  placeholder="cs_xxxxxxxxxxxxxxxx"
                />
              </div>
            </Field>
            <p className="text-xs text-gray-400">
              Get these from: WooCommerce → Settings → Advanced → REST API → Add key
            </p>
            <button
              onClick={saveWoo}
              className={`flex items-center gap-2 px-4 py-2.5 min-h-11 rounded-xl text-sm font-semibold transition-all duration-300 ease-in-out active:scale-95 ${
                savedWoo
                  ? 'bg-emerald-600 text-white'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              {savedWoo ? <CheckCircle size={15} /> : <Save size={15} />}
              {savedWoo ? 'Saved!' : 'Save WooCommerce Settings'}
            </button>
          </div>
        </Section>

        {/* Coupon Settings */}
        <CouponSettings />
      </div>
    </div>
  );
}
