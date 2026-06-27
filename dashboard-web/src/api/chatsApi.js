import api from './axiosInstance';

// GET /chats — list all conversations. params may include { startDate, endDate } (ISO
// strings) to scope to chats last active in that range; axios omits undefined keys, so
// calling with {} returns the full unfiltered list exactly like before.
export const getAllChats = (params = {}) => api.get('/chats', { params });

// GET /chats/:phone — get full chat history
export const getChatHistory = (phone) => api.get(`/chats/${phone}`);

// POST /chats/:phone/message — send a message
export const sendMessage = (phone, payload) =>
  api.post(`/chats/${phone}/message`, payload);

// POST /chats/:phone/toggle-bot
export const toggleBot = (phone, botPaused) =>
  api.post(`/chats/${phone}/toggle-bot`, { botPaused });

// DELETE /chats/:phone
export const deleteChat = (phone) => api.delete(`/chats/${phone}`);

// PUT /chats/:phone/rename
export const renameChat = (phone, customerName) =>
  api.put(`/chats/${phone}/rename`, { customerName });

// PUT /chats/:phone/messages/:index — edit a message
export const editMessage = (phone, index, text) =>
  api.put(`/chats/${phone}/messages/${index}`, { text });

// DELETE /chats/:phone/messages/:index — delete a message
export const deleteMessage = (phone, index) =>
  api.delete(`/chats/${phone}/messages/${index}`);
