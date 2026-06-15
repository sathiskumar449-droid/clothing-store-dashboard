// api/chats.js  — Supabase version (replaces fs-based implementation)
// All getChats/saveChats calls are now async
import { getChats, saveChats, sendText, sendImage, userSessions, deleteSession } from './webhook.js';
import { supabase } from '../lib/supabase.js';

// GET /chats
export const getAllChats = async (req, res) => {
    try {
        const chats = await getChats();
        const chatList = Object.values(chats)
            .filter(chat => chat.customerPhone && !chat.customerPhone.startsWith('session_'))
            .map(chat => ({
                customerPhone: chat.customerPhone,
                customerName:  chat.customerName  || 'Customer',
                lastMessage:   chat.lastMessage   || '',
                lastUpdated:   chat.lastUpdated   || '',
                botPaused:     chat.botPaused     || false
            }))
            .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));

        res.json({ success: true, chats: chatList });
    } catch (error) {
        console.error('❌ Error getting all chats:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET /chats/:phone
export const getChatHistory = async (req, res) => {
    try {
        const { phone } = req.params;
        const chats     = await getChats();
        const chat      = chats[phone] || {
            customerPhone: phone,
            customerName:  'Customer',
            lastMessage:   '',
            lastUpdated:   '',
            botPaused:     false,
            messages:      []
        };

        // Filter out session state messages if any were written
        if (chat.messages) {
            chat.messages = chat.messages.filter(m => m.type !== 'session_state');
        }

        res.json({ success: true, chat });
    } catch (error) {
        console.error(`❌ Error getting chat history for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST /chats/:phone/message
export const sendChatMessage = async (req, res) => {
    try {
        const { phone }              = req.params;
        const { text, type, imageUrl } = req.body;

        if (type === 'image' && imageUrl) {
            await sendImage(phone, imageUrl, text || '');
        } else {
            if (!text) {
                return res.status(400).json({ success: false, message: 'Message text is required' });
            }
            await sendText(phone, text);
        }

        // Fetch existing chat row from Supabase
        const { data: existingRow } = await supabase
            .from('chats')
            .select('*')
            .eq('customer_phone', phone)
            .maybeSingle();

        const messages = existingRow?.messages || [];
        messages.push({
            sender:    'owner',
            type:      type      || 'text',
            text:      text      || '',
            imageUrl:  imageUrl  || null,
            timestamp: new Date().toISOString()
        });

        const lastMessage = type === 'image' ? `📷 Image${text ? ': ' + text : ''}` : text;
        const now         = new Date().toISOString();

        const { data, error } = await supabase
            .from('chats')
            .upsert({
                customer_phone: phone,
                customer_name:  existingRow?.customer_name  || 'Customer',
                last_message:   lastMessage,
                last_updated:   now,
                bot_paused:     true,        // auto-pause when owner manually replies
                messages
            }, { onConflict: 'customer_phone' })
            .select()
            .single();

        if (error) throw error;

        // Return in the same shape as the old code
        const chat = {
            customerPhone: data.customer_phone,
            customerName:  data.customer_name,
            lastMessage:   data.last_message,
            lastUpdated:   data.last_updated,
            botPaused:     data.bot_paused,
            messages:      (data.messages || []).filter(m => m.type !== 'session_state')
        };

        res.json({ success: true, chat });
    } catch (error) {
        console.error(`❌ Error sending message to ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST /chats/:phone/toggle-bot
export const toggleBot = async (req, res) => {
    try {
        const { phone }      = req.params;
        const { botPaused }  = req.body;

        const { data: existingRow } = await supabase
            .from('chats')
            .select('*')
            .eq('customer_phone', phone)
            .maybeSingle();

        const currentPaused     = existingRow?.bot_paused || false;
        const targetPausedState = typeof botPaused === 'boolean' ? botPaused : !currentPaused;

        const { data, error } = await supabase
            .from('chats')
            .upsert({
                customer_phone: phone,
                customer_name:  existingRow?.customer_name  || 'Customer',
                last_message:   existingRow?.last_message   || '',
                last_updated:   new Date().toISOString(),
                bot_paused:     targetPausedState,
                messages:       existingRow?.messages       || []
            }, { onConflict: 'customer_phone' })
            .select()
            .single();

        if (error) throw error;

        // If resuming the bot, clear active session state
        if (!targetPausedState) {
            await deleteSession(phone);
            console.log(`[BOT] Reset active session for ${phone} due to bot resume.`);
        }

        res.json({ success: true, botPaused: data.bot_paused });
    } catch (error) {
        console.error(`❌ Error toggling bot for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE /chats/:phone — completely remove a chat conversation
export const deleteChat = async (req, res) => {
    try {
        const { phone } = req.params;

        const { data: existing } = await supabase
            .from('chats')
            .select('customer_phone')
            .eq('customer_phone', phone)
            .maybeSingle();

        if (!existing) {
            return res.status(404).json({ success: false, message: 'Chat not found' });
        }

        const { error } = await supabase
            .from('chats')
            .delete()
            .eq('customer_phone', phone);

        if (error) throw error;

        await deleteSession(phone);

        res.json({ success: true, message: `Chat for ${phone} deleted.` });
    } catch (error) {
        console.error(`❌ Error deleting chat for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// PUT /chats/:phone/rename — update customer display name
export const renameChat = async (req, res) => {
    try {
        const { phone }        = req.params;
        const { customerName } = req.body;

        if (!customerName || !customerName.trim()) {
            return res.status(400).json({ success: false, message: 'customerName is required' });
        }

        const { data: existing } = await supabase
            .from('chats')
            .select('*')
            .eq('customer_phone', phone)
            .maybeSingle();

        if (!existing) {
            return res.status(404).json({ success: false, message: 'Chat not found' });
        }

        const { data, error } = await supabase
            .from('chats')
            .update({
                customer_name: customerName.trim(),
                last_updated:  new Date().toISOString()
            })
            .eq('customer_phone', phone)
            .select()
            .single();

        if (error) throw error;

        const chat = {
            customerPhone: data.customer_phone,
            customerName:  data.customer_name,
            lastMessage:   data.last_message,
            lastUpdated:   data.last_updated,
            botPaused:     data.bot_paused,
            messages:      data.messages || []
        };

        res.json({ success: true, chat });
    } catch (error) {
        console.error(`❌ Error renaming chat for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};
