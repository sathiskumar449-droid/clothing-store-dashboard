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
