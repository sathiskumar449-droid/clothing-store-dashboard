import { getChats, saveChats, sendText, sendImage, userSessions } from './webhook.js';

// GET /chats
export const getAllChats = (req, res) => {
    try {
        const chats = getChats();
        const chatList = Object.values(chats).map(chat => ({
            customerPhone: chat.customerPhone,
            customerName: chat.customerName || 'Customer',
            lastMessage: chat.lastMessage || '',
            lastUpdated: chat.lastUpdated || '',
            botPaused: chat.botPaused || false
        })).sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));

        res.json({ success: true, chats: chatList });
    } catch (error) {
        console.error('❌ Error getting all chats:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET /chats/:phone
export const getChatHistory = (req, res) => {
    try {
        const { phone } = req.params;
        const chats = getChats();
        const chat = chats[phone] || {
            customerPhone: phone,
            customerName: 'Customer',
            lastMessage: '',
            lastUpdated: '',
            botPaused: false,
            messages: []
        };

        res.json({ success: true, chat });
    } catch (error) {
        console.error(`❌ Error getting chat history for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST /chats/:phone/message
export const sendChatMessage = async (req, res) => {
    try {
        const { phone } = req.params;
        const { text, type, imageUrl } = req.body;

        if (type === 'image' && imageUrl) {
            // Send image via WhatsApp API
            await sendImage(phone, imageUrl, text || '');
        } else {
            if (!text) {
                return res.status(400).json({ success: false, message: 'Message text is required' });
            }
            // Send text via WhatsApp API
            await sendText(phone, text);
        }

        // Save to chat history
        const chats = getChats();
        if (!chats[phone]) {
            chats[phone] = {
                customerPhone: phone,
                customerName: 'Customer',
                lastMessage: '',
                lastUpdated: '',
                botPaused: false,
                messages: []
            };
        }

        chats[phone].messages.push({
            sender: 'owner',
            type: type || 'text',
            text: text || '',
            imageUrl: imageUrl || null,
            timestamp: new Date().toISOString()
        });

        chats[phone].lastMessage = type === 'image' ? `📷 Image${text ? ': ' + text : ''}` : text;
        chats[phone].lastUpdated = new Date().toISOString();
        
        // Auto-pause bot if owner sends a manual reply
        chats[phone].botPaused = true;

        saveChats(chats);

        res.json({ success: true, chat: chats[phone] });
    } catch (error) {
        console.error(`❌ Error sending message to ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST /chats/:phone/toggle-bot
export const toggleBot = (req, res) => {
    try {
        const { phone } = req.params;
        const { botPaused } = req.body;

        const chats = getChats();
        if (!chats[phone]) {
            chats[phone] = {
                customerPhone: phone,
                customerName: 'Customer',
                lastMessage: '',
                lastUpdated: '',
                botPaused: false,
                messages: []
            };
        }

        const targetPausedState = typeof botPaused === 'boolean' ? botPaused : !chats[phone].botPaused;
        chats[phone].botPaused = targetPausedState;
        chats[phone].lastUpdated = new Date().toISOString();

        saveChats(chats);

        // If resuming the bot, clear active session state to reset flow
        if (!targetPausedState && userSessions[phone]) {
            delete userSessions[phone];
            console.log(`[BOT] Reset active session for ${phone} due to bot resume.`);
        }

        res.json({ success: true, botPaused: chats[phone].botPaused });
    } catch (error) {
        console.error(`❌ Error toggling bot for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE /chats/:phone — completely remove a chat conversation
export const deleteChat = (req, res) => {
    try {
        const { phone } = req.params;
        const chats = getChats();

        if (!chats[phone]) {
            return res.status(404).json({ success: false, message: 'Chat not found' });
        }

        delete chats[phone];

        // Clear active bot session too
        if (userSessions[phone]) {
            delete userSessions[phone];
        }

        saveChats(chats);
        res.json({ success: true, message: `Chat for ${phone} deleted.` });
    } catch (error) {
        console.error(`❌ Error deleting chat for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// PUT /chats/:phone/rename — update customer display name
export const renameChat = (req, res) => {
    try {
        const { phone } = req.params;
        const { customerName } = req.body;

        if (!customerName || !customerName.trim()) {
            return res.status(400).json({ success: false, message: 'customerName is required' });
        }

        const chats = getChats();
        if (!chats[phone]) {
            return res.status(404).json({ success: false, message: 'Chat not found' });
        }

        chats[phone].customerName = customerName.trim();
        chats[phone].lastUpdated = new Date().toISOString();
        saveChats(chats);

        res.json({ success: true, chat: chats[phone] });
    } catch (error) {
        console.error(`❌ Error renaming chat for ${req.params.phone}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
};
