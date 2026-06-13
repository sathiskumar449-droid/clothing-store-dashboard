import api from './axiosInstance';

// GET /chats — list all conversations
export const getAllChats = () => api.get('/chats');

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
