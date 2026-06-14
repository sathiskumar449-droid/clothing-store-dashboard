// lib/supabase.js
// ─────────────────────────────────────────────────────────────
// Supabase client — single shared instance for the entire app.
// Import this instead of creating a new client in every file.
// ─────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role — bypasses RLS

if (!supabaseUrl || !supabaseKey) {
    throw new Error(
        '❌ Missing Supabase env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env / Vercel dashboard.'
    );
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        // Disable auto-refresh — not needed for a server-side service role client
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
    }
});
