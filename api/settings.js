import { supabase } from '../lib/supabase.js';

// ✅ Get WooCommerce Settings
export const getWooSettings = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('*')
            .in('key', ['woo_site_url', 'woo_consumer_key', 'woo_consumer_secret']);

        if (error) {
            // Handle table not existing gracefully
            if (error.code === '42P01' || error.code === 'PGRST205') {
                return res.json({ siteUrl: '', consumerKey: '', consumerSecret: '' });
            }
            throw error;
        }

        const settings = {};
        (data || []).forEach(row => {
            if (row.key === 'woo_site_url') settings.siteUrl = row.value;
            if (row.key === 'woo_consumer_key') settings.consumerKey = row.value;
            if (row.key === 'woo_consumer_secret') settings.consumerSecret = row.value;
        });

        res.json({
            siteUrl: settings.siteUrl || '',
            consumerKey: settings.consumerKey || '',
            consumerSecret: settings.consumerSecret || ''
        });
    } catch (error) {
        console.error('❌ Get Settings Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ✅ Save WooCommerce Settings
export const saveWooSettings = async (req, res) => {
    try {
        const { siteUrl, consumerKey, consumerSecret } = req.body;

        const payload = [
            { key: 'woo_site_url', value: siteUrl || '' },
            { key: 'woo_consumer_key', value: consumerKey || '' },
            { key: 'woo_consumer_secret', value: consumerSecret || '' }
        ];

        const { error } = await supabase
            .from('settings')
            .upsert(payload, { onConflict: 'key' });

        if (error) {
            if (error.code === '42P01' || error.code === 'PGRST205') {
                return res.status(400).json({
                    success: false,
                    message: 'Settings table does not exist in Supabase. Please run the SQL setup script in your Supabase SQL Editor first!'
                });
            }
            throw error;
        }

        res.json({
            success: true,
            message: 'WooCommerce settings saved successfully to database!'
        });
    } catch (error) {
        console.error('❌ Save Settings Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ✅ Get Store Settings
export const getStoreSettings = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('*')
            .in('key', ['store_name', 'store_phone', 'store_address', 'welcome_message']);

        if (error) {
            if (error.code === '42P01' || error.code === 'PGRST205') {
                return res.json({ storeName: 'Super Collection', phone: '', address: '', welcomeMessage: '' });
            }
            throw error;
        }

        const settings = {};
        (data || []).forEach(row => {
            if (row.key === 'store_name') settings.storeName = row.value;
            if (row.key === 'store_phone') settings.phone = row.value;
            if (row.key === 'store_address') settings.address = row.value;
            if (row.key === 'welcome_message') settings.welcomeMessage = row.value;
        });

        res.json({
            storeName: settings.storeName || 'Super Collection',
            phone: settings.phone || '',
            address: settings.address || '',
            welcomeMessage: settings.welcomeMessage || 'Hello! Welcome to our store 👋\nHow can I help you today?'
        });
    } catch (error) {
        console.error('❌ Get Store Settings Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ✅ Save Store Settings
export const saveStoreSettings = async (req, res) => {
    try {
        const { storeName, phone, address, welcomeMessage } = req.body;

        const payload = [
            { key: 'store_name', value: storeName || '' },
            { key: 'store_phone', value: phone || '' },
            { key: 'store_address', value: address || '' },
            { key: 'welcome_message', value: welcomeMessage || '' }
        ];

        const { error } = await supabase
            .from('settings')
            .upsert(payload, { onConflict: 'key' });

        if (error) {
            if (error.code === '42P01' || error.code === 'PGRST205') {
                return res.status(400).json({
                    success: false,
                    message: 'Settings table does not exist in Supabase. Please run the SQL setup script in your Supabase SQL Editor first!'
                });
            }
            throw error;
        }

        res.json({
            success: true,
            message: 'Store settings saved successfully to database!'
        });
    } catch (error) {
        console.error('❌ Save Store Settings Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};
