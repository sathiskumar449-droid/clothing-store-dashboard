// api/chats.js  — Supabase version (replaces fs-based implementation)
// All getChats/saveChats calls are now async
import { getChats, getChatByPhone, saveChats, sendText, sendImage, userSessions, deleteSession } from './webhook.js';
import { supabase } from '../lib/supabase.js';

// Chat rows default to the generic "Customer" name (the `chats` table's column default,
// since the bot never asks anyone for their real name). When an order exists for that phone,
// its customer_name is an actual name worth showing instead; when it doesn't (chatted but
// never bought), the phone number is still more identifying than the literal word "Customer".
// Batches all lookups into a single query so listing N chats never costs N order queries.
async function resolveCustomerNamesFromOrders(chatEntries) {
    const genericPhones = chatEntries
        .filter(c => !c.customerName || c.customerName === 'Customer')
        .map(c => c.customerPhone);

    if (genericPhones.length === 0) return;

    const nameByPhone = new Map();
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('customer_phone, customer_name, date')
            .in('customer_phone', genericPhones)
            .order('date', { ascending: false });

        if (error) throw error;

        for (const row of (data || [])) {
            // Ordered newest-first, so the first row seen per phone is its most recent order.
            if (!nameByPhone.has(row.customer_phone) && row.customer_name) {
                nameByPhone.set(row.customer_phone, row.customer_name);
            }
        }
    } catch (error) {
        console.error('❌ Error batch-resolving customer names from orders:', error.message);
    }

    for (const chat of chatEntries) {
        if (chat.customerName && chat.customerName !== 'Customer') continue;
        chat.customerName = nameByPhone.get(chat.customerPhone) || chat.customerPhone;
    }
}

// GET /chats
export const getAllChats = async (req, res) => {
    try {
        const chats = await getChats();
        const chatList = Object.values(chats)
            .map(chat => ({
                customerPhone: chat.customerPhone,
                customerName:  chat.customerName  || 'Customer',
                lastMessage:   chat.lastMessage   || '',
                lastUpdated:   chat.lastUpdated   || '',
                botPaused:     chat.botPaused     || false
            }))
            .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));

        await resolveCustomerNamesFromOrders(chatList);

        res.json({ success: true, chats: chatList });
    } catch (error) {
        console.error('❌ Error getting all chats:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET /chats/:phone — single phone-filtered lookup (not the full chats table)
export const getChatHistory = async (req, res) => {
    try {
        const { phone } = req.params;
        const chat = await getChatByPhone(phone) || {
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

        await resolveCustomerNamesFromOrders([chat]);

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

// PUT /chats/:phone/messages/:index — edit a message at index
export const editChatMessage = async (req, res) => {
    try {
        const { phone, index } = req.params;
        const { text } = req.body;
        const idx = parseInt(index);

        const { data: chatRow, error: findError } = await supabase
            .from('chats')
            .select('*')
            .eq('customer_phone', phone)
            .maybeSingle();

        if (findError || !chatRow) {
            return res.status(404).json({ success: false, message: 'Chat not found' });
        }

        const messages = chatRow.messages || [];
        if (isNaN(idx) || idx < 0 || idx >= messages.length) {
            return res.status(400).json({ success: false, message: 'Invalid message index' });
        }

        // Edit the message
        messages[idx].text = text;
        messages[idx].edited = true;

        // If it was the last message, update the last_message column
        let lastMessage = chatRow.last_message;
        if (idx === messages.length - 1) {
            lastMessage = messages[idx].type === 'image' ? `📷 Image${text ? ': ' + text : ''}` : text;
        }

        const { data, error } = await supabase
            .from('chats')
            .update({
                messages,
                last_message: lastMessage,
                last_updated: new Date().toISOString()
            })
            .eq('customer_phone', phone)
            .select()
            .single();

        if (error) throw error;

        res.json({
            success: true,
            chat: {
                customerPhone: data.customer_phone,
                customerName:  data.customer_name,
                lastMessage:   data.last_message,
                lastUpdated:   data.last_updated,
                botPaused:     data.bot_paused,
                messages:      (data.messages || []).filter(m => m.type !== 'session_state')
            }
        });
    } catch (error) {
        console.error(`❌ Error editing message for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE /chats/:phone/messages/:index — delete a message at index
export const deleteChatMessage = async (req, res) => {
    try {
        const { phone, index } = req.params;
        const idx = parseInt(index);

        const { data: chatRow, error: findError } = await supabase
            .from('chats')
            .select('*')
            .eq('customer_phone', phone)
            .maybeSingle();

        if (findError || !chatRow) {
            return res.status(404).json({ success: false, message: 'Chat not found' });
        }

        const messages = chatRow.messages || [];
        if (isNaN(idx) || idx < 0 || idx >= messages.length) {
            return res.status(400).json({ success: false, message: 'Invalid message index' });
        }

        // Delete the message
        messages.splice(idx, 1);

        // Update the last_message column to the new last message
        let lastMessage = '';
        if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            lastMessage = lastMsg.type === 'image' ? `📷 Image${lastMsg.text ? ': ' + lastMsg.text : ''}` : lastMsg.text;
        }

        const { data, error } = await supabase
            .from('chats')
            .update({
                messages,
                last_message: lastMessage,
                last_updated: new Date().toISOString()
            })
            .eq('customer_phone', phone)
            .select()
            .single();

        if (error) throw error;

        res.json({
            success: true,
            chat: {
                customerPhone: data.customer_phone,
                customerName:  data.customer_name,
                lastMessage:   data.last_message,
                lastUpdated:   data.last_updated,
                botPaused:     data.bot_paused,
                messages:      (data.messages || []).filter(m => m.type !== 'session_state')
            }
        });
    } catch (error) {
        console.error(`❌ Error deleting message for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};
