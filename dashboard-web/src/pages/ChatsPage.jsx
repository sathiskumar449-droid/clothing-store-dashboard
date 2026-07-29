import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Send, Bot, BotOff, Trash2, ArrowLeft, RefreshCw, MessageSquare,
  CheckCheck, ChevronDown, Pencil, X, Check, Bell, Plus, Search, Settings, TrendingUp
} from 'lucide-react';
import {
  getAllChats, getChatHistory, sendMessage, toggleBot, deleteChat,
  editMessage, deleteMessage
} from '../api/chatsApi';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';
import Badge from '../components/ui/Badge';

function getAvatarBg(name) {
  const char = (name || 'C')[0].toUpperCase();
  const code = char.charCodeAt(0);
  if (code % 4 === 0) return 'bg-emerald-100 text-emerald-600';
  if (code % 4 === 1) return 'bg-indigo-100 text-indigo-600';
  if (code % 4 === 2) return 'bg-purple-100 text-purple-600';
  return 'bg-amber-100 text-amber-600';
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
// Chat list timestamp: "Today"/"Yesterday" for the last two calendar days, DD/MM/YYYY
// for anything older.
function formatChatListTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export default function ChatsPage() {
  const { phone: phoneParam } = useParams();
  const navigate = useNavigate();

  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingChats, setLoadingChats] = useState(true);
  const [refreshingChats, setRefreshingChats] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [search, setSearch] = useState('');

  // Edit / Delete states
  const [activeMenuIndex, setActiveMenuIndex] = useState(null);
  const [editingIndex, setEditingIndex] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [editingSubmit, setEditingSubmit] = useState(false);

  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchChats = useCallback(async () => {
    setRefreshingChats(true);
    try {
      const res = await getAllChats();
      setChats(res.data?.chats || []);
    } catch {/* silent */} finally {
      setLoadingChats(false);
      setRefreshingChats(false);
    }
  }, []);

  // 20s (was 8s) — the list doesn't need second-level freshness, and this now pauses
  // entirely while the tab is hidden (see useAutoRefresh).
  useAutoRefresh(fetchChats, 20000);

  const openChat = useCallback(async (phone) => {
    setLoadingMsgs(true);
    setEditingIndex(null);
    setActiveMenuIndex(null);
    navigate(`/chats/${phone}`, { replace: true });
    try {
      const res = await getChatHistory(phone);
      const chat = res.data?.chat || {};
      setActiveChat(chat);
      setMessages(chat.messages || []);
      setTimeout(scrollToBottom, 100);
    } catch {/* silent */} finally {
      setLoadingMsgs(false);
    }
  }, [navigate]);

  // Auto-refresh messages for the open conversation — 15s (was 5s), paused while the tab
  // is hidden. `immediate: false` since openChat() above already fetched it once.
  const refreshActiveChat = useCallback(async () => {
    if (!activeChat?.customerPhone) return;
    try {
      const res = await getChatHistory(activeChat.customerPhone);
      const chat = res.data?.chat || {};
      setActiveChat(chat);
      setMessages(chat.messages || []);
    } catch {/* silent */}
  }, [activeChat?.customerPhone]);

  useAutoRefresh(refreshActiveChat, 15000, [activeChat?.customerPhone], { immediate: false });

  // Scroll to bottom on initial load and when message length increases
  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages.length]);

  // Open from URL param
  useEffect(() => {
    if (phoneParam) openChat(phoneParam);
  }, [phoneParam, openChat]);

  const handleSend = async () => {
    if (!text.trim() || !activeChat) return;
    setSending(true);
    const optimisticMsg = { sender: 'owner', text, timestamp: new Date().toISOString(), type: 'text' };
    setMessages(prev => [...prev, optimisticMsg]);
    const sentText = text;
    setText('');
    try {
      await sendMessage(activeChat.customerPhone, { text: sentText, type: 'text' });
      const res = await getChatHistory(activeChat.customerPhone);
      const chat = res.data?.chat || {};
      setActiveChat(chat);
      setMessages(chat.messages || []);
      setTimeout(scrollToBottom, 50);
    } catch {/* silent */} finally {
      setSending(false);
    }
  };

  const handleToggleBot = async () => {
    if (!activeChat) return;
    try {
      const res = await toggleBot(activeChat.customerPhone, !activeChat.botPaused);
      setActiveChat(prev => ({ ...prev, botPaused: res.data?.botPaused }));
      setChats(prev =>
        prev.map(c =>
          c.customerPhone === activeChat.customerPhone
            ? { ...c, botPaused: res.data?.botPaused }
            : c
        )
      );
    } catch {/* silent */}
  };

  const handleDelete = async (phone) => {
    if (!window.confirm('Delete this chat?')) return;
    try {
      await deleteChat(phone);
      setChats(prev => prev.filter(c => c.customerPhone !== phone));
      if (activeChat?.customerPhone === phone) {
        setActiveChat(null);
        setMessages([]);
        navigate('/chats', { replace: true });
      }
    } catch {/* silent */}
  };

  // Edit Message
  const handleEditInit = (index, currentText) => {
    setEditingIndex(index);
    setEditingText(currentText);
    setActiveMenuIndex(null);
  };

  const handleEditSave = async (index) => {
    if (!editingText.trim() || !activeChat) return;
    setEditingSubmit(true);
    try {
      const phone = activeChat.customerPhone;
      const res = await editMessage(phone, index, editingText);
      if (res.data?.success) {
        const updatedChat = res.data.chat;
        setActiveChat(updatedChat);
        setMessages(updatedChat.messages || []);
        setEditingIndex(null);
        setEditingText('');
      }
    } catch (err) {
      alert('Failed to edit message. Please try again.');
    } finally {
      setEditingSubmit(false);
    }
  };

  // Delete Message
  const handleDeleteMessage = async (index) => {
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      const phone = activeChat.customerPhone;
      const res = await deleteMessage(phone, index);
      if (res.data?.success) {
        const updatedChat = res.data.chat;
        setActiveChat(updatedChat);
        setMessages(updatedChat.messages || []);
        setActiveMenuIndex(null);
      }
    } catch (err) {
      alert('Failed to delete message. Please try again.');
    }
  };

  // Close menus on click outside
  useEffect(() => {
    const handleOutsideClick = () => {
      setActiveMenuIndex(null);
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  const filtered = chats.filter(c =>
    (c.customerName || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.customerPhone || '').includes(search)
  );

  return (
    <div className="fixed top-0 bottom-20 left-0 right-0 md:static md:w-full md:h-screen flex overflow-hidden bg-[#f0f2f5]">
      {/* Chat List Panel */}
      <div className={`
        ${activeChat ? 'hidden md:flex' : 'flex'}
        flex-col w-full md:w-88 bg-[#f8fafc]/90 border-r border-gray-100 shrink-0
      `}>
        {/* List Header */}
        <div className="p-4 flex items-center justify-between border-b border-gray-100 bg-white/50 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-[#00d285] text-white font-black flex items-center justify-center text-xs shadow-md shadow-emerald-500/25">
              SC
            </div>
            <div>
              <h1 className="text-base font-bold text-gray-900 tracking-tight">WhatsApp Chats</h1>
            </div>
          </div>
          <button
            onClick={fetchChats}
            className="w-9 h-9 flex items-center justify-center rounded-2xl bg-white border border-gray-100 text-gray-500 hover:text-gray-800 hover:bg-gray-50 transition-all duration-200 active:scale-90 shadow-sm"
          >
            <RefreshCw size={16} className={refreshingChats ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Search */}
        <div className="p-3 bg-white/40">
          <div className="relative">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search or start a new chat..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 min-h-11 text-xs rounded-2xl border border-gray-200/80 bg-[#f0f3ff] text-gray-800 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-indigo-400 transition-all shadow-inner"
            />
          </div>
        </div>

        {/* Chat Items */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loadingChats ? (
            <Loader size="sm" text="Loading chats..." />
          ) : filtered.length === 0 ? (
            <EmptyState icon={MessageSquare} title="No chats found" />
          ) : (
            filtered.map(chat => {
              const isChatActive = activeChat?.customerPhone === chat.customerPhone;
              return (
                <div
                  key={chat.customerPhone}
                  onClick={() => openChat(chat.customerPhone)}
                  className={`
                    flex items-center gap-3 p-3.5 rounded-2xl cursor-pointer
                    transition-all duration-200 relative group border
                    ${isChatActive
                      ? 'bg-gradient-to-r from-indigo-50/90 to-purple-50/90 border-indigo-200/80 shadow-md shadow-indigo-500/10'
                      : 'bg-white hover:bg-gray-50/90 border-gray-100/80 shadow-sm'}
                  `}
                >
                  <div className={`w-11 h-11 rounded-2xl ${getAvatarBg(chat.customerName)} flex items-center justify-center text-base font-bold shrink-0 shadow-sm`}>
                    {(chat.customerName || 'C')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold text-gray-900 truncate">{chat.customerName || chat.customerPhone}</p>
                      <span className="text-[10px] text-gray-400 font-medium shrink-0 ml-2">{formatChatListTimestamp(chat.lastUpdated)}</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-xs text-gray-500 truncate pr-2">{chat.lastMessage || 'No messages'}</p>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${chat.botPaused ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                        {chat.botPaused ? 'Paused' : 'Bot'}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(chat.customerPhone); }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-xl hover:bg-rose-50 text-gray-400 hover:text-rose-600 transition-all ml-1"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Chat Window */}
      <div className={`flex-1 flex flex-col ${activeChat ? 'flex' : 'hidden md:flex'} bg-[#f8fafc]/50 relative`}>
        {/* Top Action Header Bar */}
        <div className="p-4 flex items-center justify-between border-b border-gray-100 bg-white/70 backdrop-blur-md z-20">
          <div className="relative flex-1 max-w-md">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search chats, name or mobile..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 min-h-11 text-xs rounded-2xl bg-[#f0f3ff] text-gray-800 placeholder-gray-400 border border-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all"
            />
          </div>
          <div className="flex items-center gap-3">
            <button className="w-10 h-10 rounded-2xl bg-white shadow-sm border border-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-50 active:scale-95 transition-all relative">
              <Bell size={18} />
              <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-rose-500 ring-2 ring-white"></span>
            </button>
            <button className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-gradient-to-r from-[#5856d6] via-[#6366f1] to-[#8b5cf6] text-white font-bold text-xs shadow-md shadow-indigo-500/30 hover:opacity-95 active:scale-95 transition-all">
              <Plus size={16} /> New Chat
            </button>
          </div>
        </div>

        {!activeChat ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-gradient-to-br from-[#f8fafc] via-[#f1f5f9] to-[#eef2ff] z-10 relative overflow-hidden">
            {/* Background pattern */}
            <div className="absolute inset-0 bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] [background-size:18px_18px] opacity-60 pointer-events-none"></div>

            {/* Glowing 3D Orb Graphic */}
            <div className="relative mb-8 group cursor-pointer">
              <div className="w-44 h-44 rounded-full bg-gradient-to-tr from-indigo-500/30 via-purple-500/20 to-pink-500/30 flex items-center justify-center relative shadow-2xl backdrop-blur-md animate-pulse">
                <div className="w-32 h-32 rounded-full bg-gradient-to-tr from-[#3b82f6] via-[#8b5cf6] to-[#ec4899] flex items-center justify-center shadow-xl ring-4 ring-white/60 relative">
                  <MessageSquare size={52} className="text-white drop-shadow-md" />
                </div>
                <div className="absolute inset-0 rounded-full border border-indigo-400/30 rotate-45 scale-125 pointer-events-none"></div>
              </div>
            </div>

            {/* Headline */}
            <h3 className="text-2xl md:text-3xl font-black bg-gradient-to-r from-[#2563eb] via-[#6366f1] to-[#06b6d4] bg-clip-text text-transparent tracking-tight">
              WhatsApp Business Dashboard
            </h3>
            <p className="text-xs md:text-sm text-gray-500 mt-2 max-w-md font-medium">
              Select a conversation from the left panel to read and send messages directly to your customers.
            </p>

            {/* 3 Feature Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-10 max-w-3xl w-full">
              {/* Card 1 */}
              <div className="bg-white/90 backdrop-blur-md p-5 rounded-2xl border border-white/80 shadow-sm hover:shadow-md transition-all flex flex-col items-center text-center group">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-500 to-violet-600 text-white flex items-center justify-center shadow-md shadow-indigo-500/30 mb-3 group-hover:scale-110 transition-transform">
                  <MessageSquare size={22} />
                </div>
                <h4 className="text-xs font-bold text-gray-800">Real-time Chats</h4>
                <p className="text-[11px] text-gray-500 mt-1">Reply to customers in real-time</p>
              </div>

              {/* Card 2 */}
              <div className="bg-white/90 backdrop-blur-md p-5 rounded-2xl border border-white/80 shadow-sm hover:shadow-md transition-all flex flex-col items-center text-center group">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-400 to-teal-600 text-white flex items-center justify-center shadow-md shadow-emerald-500/30 mb-3 group-hover:scale-110 transition-transform">
                  <Settings size={22} />
                </div>
                <h4 className="text-xs font-bold text-gray-800">Smart Automation</h4>
                <p className="text-[11px] text-gray-500 mt-1">Auto reply & smart chatbot flow</p>
              </div>

              {/* Card 3 */}
              <div className="bg-white/90 backdrop-blur-md p-5 rounded-2xl border border-white/80 shadow-sm hover:shadow-md transition-all flex flex-col items-center text-center group">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-400 to-orange-500 text-white flex items-center justify-center shadow-md shadow-amber-500/30 mb-3 group-hover:scale-110 transition-transform">
                  <TrendingUp size={22} />
                </div>
                <h4 className="text-xs font-bold text-gray-800">Business Growth</h4>
                <p className="text-[11px] text-gray-500 mt-1">Engage more customers and grow sales</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="flex items-center gap-3 px-5 py-3.5 bg-white/80 backdrop-blur-md border-b border-gray-100 shadow-sm shrink-0 z-10">
              <button
                onClick={() => { setActiveChat(null); navigate('/chats', { replace: true }); }}
                className="md:hidden w-9 h-9 flex items-center justify-center rounded-2xl bg-gray-100 hover:bg-gray-200 text-gray-600 active:scale-90 transition-all duration-200"
              >
                <ArrowLeft size={18} />
              </button>
              <div className={`w-10 h-10 rounded-2xl ${getAvatarBg(activeChat.customerName)} flex items-center justify-center text-base font-bold shadow-sm`}>
                {(activeChat.customerName || 'C')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-gray-900 truncate">{activeChat.customerName || activeChat.customerPhone}</p>
                <p className="text-xs text-gray-400 font-medium">{activeChat.customerPhone}</p>
              </div>
              {/* Bot toggle */}
              <button
                onClick={handleToggleBot}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-xs font-bold transition-all duration-200 shadow-sm active:scale-95 ${
                  activeChat.botPaused
                    ? 'bg-amber-100/90 text-amber-800 hover:bg-amber-200 border border-amber-200'
                    : 'bg-indigo-100/90 text-indigo-700 hover:bg-indigo-200 border border-indigo-200'
                }`}
              >
                {activeChat.botPaused ? <BotOff size={14} /> : <Bot size={14} />}
                {activeChat.botPaused ? 'Bot Paused' : 'Bot Active'}
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 z-10">
              {loadingMsgs ? (
                <Loader size="sm" text="Loading messages..." />
              ) : messages.length === 0 ? (
                <EmptyState icon={MessageSquare} title="No messages yet" />
              ) : (
                messages.map((msg, i) => {
                  const isSentByUs = msg.sender === 'owner' || msg.sender === 'bot';
                  const isEditing = editingIndex === i;
                  return (
                    <div key={i} className={`flex ${isSentByUs ? 'justify-end' : 'justify-start'}`}>
                      <div 
                        className={`max-w-[70%] rounded-2xl px-4 py-2.5 shadow-sm relative group ${
                          isSentByUs
                            ? 'bg-gradient-to-r from-indigo-600 via-indigo-700 to-purple-700 text-white rounded-tr-none shadow-md shadow-indigo-500/20'
                            : 'bg-white text-gray-900 rounded-tl-none border border-gray-100 shadow-sm'
                        }`}
                      >
                        {/* Action Menu Button */}
                        <div className="absolute right-1 top-1 opacity-40 group-hover:opacity-100 transition-all z-20">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveMenuIndex(activeMenuIndex === i ? null : i);
                            }}
                            className={`p-0.5 rounded-full hover:bg-black/10 ${isSentByUs ? 'text-white/80' : 'text-gray-400'}`}
                          >
                            <ChevronDown size={14} />
                          </button>

                          {/* Message Dropdown Menu */}
                          {activeMenuIndex === i && (
                            <div className="absolute right-0 mt-1 w-32 bg-white rounded-2xl shadow-xl border border-gray-100 py-1.5 z-30">
                              {isSentByUs && msg.type === 'text' && (
                                <button
                                  onClick={() => handleEditInit(i, msg.text)}
                                  className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 font-medium"
                                >
                                  <Pencil size={12} /> Edit
                                </button>
                              )}
                              <button
                                onClick={() => handleDeleteMessage(i)}
                                className="w-full text-left px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-1.5 font-medium"
                              >
                                <Trash2 size={12} /> Delete
                              </button>
                            </div>
                          )}
                        </div>

                        {msg.imageUrl && (
                          <img src={msg.imageUrl} alt="shared" className="rounded-xl mb-2 max-w-full border border-black/5" />
                        )}

                        {isEditing ? (
                          /* Inline Edit Field */
                          <div className="flex flex-col gap-1.5 mt-0.5">
                            <textarea
                              rows={2}
                              value={editingText}
                              onChange={(e) => setEditingText(e.target.value)}
                              className="w-full px-2.5 py-1.5 text-xs border border-indigo-300 rounded-xl focus:outline-none resize-none bg-white text-gray-900"
                            />
                            <div className="flex justify-end gap-1.5">
                              <button
                                onClick={() => setEditingIndex(null)}
                                className="p-1 text-gray-500 hover:bg-black/5 rounded-lg"
                                title="Cancel"
                                disabled={editingSubmit}
                              >
                                <X size={14} />
                              </button>
                              <button
                                onClick={() => handleEditSave(i)}
                                className="p-1 text-indigo-600 hover:bg-indigo-50 rounded-lg font-bold"
                                title="Save"
                                disabled={editingSubmit || !editingText.trim()}
                              >
                                <Check size={14} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          /* Message Text Bubble */
                          msg.text && (
                            <p className="text-xs md:text-sm leading-relaxed break-words pr-4 whitespace-pre-wrap font-medium">
                              {msg.text}
                            </p>
                          )
                        )}

                        {/* Timestamp & Indicators */}
                        {!isEditing && (
                          <div className="flex items-center justify-end gap-1 mt-1 select-none">
                            {msg.edited && (
                              <span className={`text-[9px] italic ${isSentByUs ? 'text-indigo-200' : 'text-gray-400'}`}>edited</span>
                            )}
                            <span className={`text-[10px] ${isSentByUs ? 'text-indigo-200' : 'text-gray-400'}`}>
                              {formatDate(msg.timestamp)}
                            </span>
                            {isSentByUs && (
                              <span 
                                className={`${msg.sender === 'owner' ? 'text-cyan-300' : 'text-indigo-200'} ml-0.5`} 
                                title={msg.sender === 'owner' ? 'Read' : 'Delivered'}
                              >
                                <CheckCheck size={13} className="stroke-[2.5]" />
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="px-5 py-3.5 bg-white/80 backdrop-blur-md border-t border-gray-100 shrink-0 z-10">
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="Type a message..."
                  className="flex-1 px-4 py-2.5 min-h-11 text-xs rounded-2xl border border-gray-200/80 bg-gray-50/80 text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-indigo-400 transition-all shadow-inner"
                />
                <button
                  onClick={handleSend}
                  disabled={sending || !text.trim()}
                  className="w-11 h-11 rounded-2xl bg-gradient-to-r from-[#5856d6] via-[#6366f1] to-[#8b5cf6] flex items-center justify-center text-white hover:opacity-95 active:scale-95 disabled:opacity-40 transition-all duration-200 shrink-0 shadow-md shadow-indigo-500/30"
                >
                  <Send size={16} />
                </button>
              </div>
              {formatDate(activeChat?.lastUpdated) && (
                <p className="text-[10px] text-gray-400 text-center mt-2 font-medium">
                  Last active: {formatDate(activeChat.lastUpdated)}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
