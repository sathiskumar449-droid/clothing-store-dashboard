import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Send, Bot, BotOff, Trash2, ArrowLeft, RefreshCw, MessageSquare,
  CheckCheck, ChevronDown, Pencil, X, Check
} from 'lucide-react';
import {
  getAllChats, getChatHistory, sendMessage, toggleBot, deleteChat,
  editMessage, deleteMessage
} from '../api/chatsApi';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';
import Badge from '../components/ui/Badge';

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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
    try {
      const res = await getAllChats();
      setChats(res.data?.chats || []);
    } catch {/* silent */} finally {
      setLoadingChats(false);
    }
  }, []);

  useAutoRefresh(fetchChats, 8000);

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

  // Auto-refresh messages for active chat
  useEffect(() => {
    if (!activeChat?.customerPhone) return;
    const id = setInterval(async () => {
      try {
        const res = await getChatHistory(activeChat.customerPhone);
        const chat = res.data?.chat || {};
        setActiveChat(chat);
        setMessages(chat.messages || []);
      } catch {/* silent */}
    }, 5000);
    return () => clearInterval(id);
  }, [activeChat?.customerPhone]);

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
    <div className="flex h-screen overflow-hidden bg-[#f0f2f5]">
      {/* Chat List Panel */}
      <div className={`
        ${activeChat ? 'hidden md:flex' : 'flex'}
        flex-col w-full md:w-90 bg-white border-r border-[#d1d7db] shrink-0
      `}>
        {/* List Header */}
        <div className="px-4 py-3 bg-[#f0f2f5] flex items-center justify-between border-b border-[#d1d7db]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#00a884] flex items-center justify-center text-white font-bold">
              SC
            </div>
            <div>
              <h1 className="text-base font-bold text-[#111b21]">WhatsApp Chats</h1>
            </div>
          </div>
          <button onClick={fetchChats} className="p-1.5 rounded-full hover:bg-[#eaebeb] text-[#54656f] transition-all">
            <RefreshCw size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="px-3 py-2 bg-white border-b border-[#e9edef]">
          <div className="relative">
            <input
              type="text"
              placeholder="Search or start a new chat..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-4 pr-3 py-1.5 text-sm rounded-lg border border-transparent bg-[#f0f2f5] text-[#111b21] placeholder-[#667781] focus:outline-none focus:bg-white focus:border-[#00a884] transition-all"
            />
          </div>
        </div>

        {/* Chat Items */}
        <div className="flex-1 overflow-y-auto bg-white">
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
                    flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-[#f0f2f5]
                    transition-all relative group
                    ${isChatActive ? 'bg-[#eaebeb]' : 'hover:bg-[#f5f6f6]'}
                  `}
                >
                  {/* Selected left green indicator */}
                  {isChatActive && (
                    <div className="absolute left-0 top-0 bottom-0 w-[5px] bg-[#00a884]"></div>
                  )}

                  <div className="w-12 h-12 rounded-full bg-[#00a884]/10 text-[#00a884] flex items-center justify-center text-base font-bold shrink-0">
                    {(chat.customerName || 'C')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-[#111b21] truncate">{chat.customerName || chat.customerPhone}</p>
                      <span className="text-xs text-[#667781] shrink-0 ml-2">{formatTime(chat.lastUpdated)}</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-xs text-[#667781] truncate pr-4">{chat.lastMessage || 'No messages'}</p>
                      <Badge status={chat.botPaused ? 'paused' : 'active'} label={chat.botPaused ? 'Bot Off' : 'Bot On'} />
                    </div>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(chat.customerPhone); }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full hover:bg-rose-50 text-gray-400 hover:text-rose-600 transition-all ml-1"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Chat Window */}
      <div className={`flex-1 flex flex-col ${activeChat ? 'flex' : 'hidden md:flex'} bg-[#efeae2] relative`}>
        {/* Background Wallpaper Pattern Overlay */}
        <div 
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Cg fill='%23000000' fill-opacity='0.4'%3E%3Cpath d='M50 50c0-5.523 4.477-10 10-10s10 4.477 10 10-4.477 10-10 10c0 5.523-4.477 10-10 10s-10-4.477-10-10 4.477-10 10-10zM10 10c0-5.523 4.477-10 10-10s10 4.477 10 10-4.477 10-10 10c0 5.523-4.477 10-10 10S0 25.523 0 20s4.477-10 10-10zm10 8c4.418 0 8-3.582 8-8s-3.582-8-8-8-8 3.582-8 8 3.582 8 8 8zm40 40c4.418 0 8-3.582 8-8s-3.582-8-8-8-8 3.582-8 8 3.582 8 8 8z'/%3E%3C/g%3E%3C/svg%3E")`
          }}
        ></div>

        {!activeChat ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-[#f8fafc] z-10">
            <div className="w-24 h-24 rounded-full bg-[#00a884]/10 flex items-center justify-center mb-6">
              <MessageSquare size={48} className="text-[#00a884]" />
            </div>
            <h3 className="text-xl font-bold text-[#111b21]">WhatsApp Business Dashboard</h3>
            <p className="text-sm text-[#667781] mt-2 max-w-sm">
              Select a conversation from the left panel to read and send messages directly to your customers.
            </p>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="flex items-center gap-3 px-4 py-3 bg-[#f0f2f5] border-b border-[#d1d7db] shadow-sm shrink-0 z-10">
              <button
                onClick={() => { setActiveChat(null); navigate('/chats', { replace: true }); }}
                className="md:hidden p-1.5 rounded-full hover:bg-[#eaebeb] text-[#54656f]"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="w-10 h-10 rounded-full bg-[#00a884]/15 text-[#00a884] flex items-center justify-center text-base font-bold">
                {(activeChat.customerName || 'C')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#111b21] truncate">{activeChat.customerName || activeChat.customerPhone}</p>
                <p className="text-xs text-[#667781]">{activeChat.customerPhone}</p>
              </div>
              {/* Bot toggle */}
              <button
                onClick={handleToggleBot}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm ${
                  activeChat.botPaused
                    ? 'bg-amber-100 text-amber-800 hover:bg-[#00a884]/20 hover:text-[#00a884]'
                    : 'bg-[#e0f2fe] text-blue-800 hover:bg-amber-200 hover:text-amber-900'
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
                  const isOwner = msg.sender === 'owner';
                  const isEditing = editingIndex === i;
                  return (
                    <div key={i} className={`flex ${isOwner ? 'justify-end' : 'justify-start'}`}>
                      <div 
                        className={`max-w-[70%] rounded-xl px-3.5 py-2 shadow-sm relative group ${
                          isOwner
                            ? 'bg-[#d9fdd3] text-[#111b21] rounded-tr-none'
                            : 'bg-white text-[#111b21] rounded-tl-none border border-[#e9edef]'
                        }`}
                      >
                        {/* Hover Action Menu Button */}
                        <div className="absolute right-1.5 top-1 opacity-0 group-hover:opacity-100 transition-all z-20">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveMenuIndex(activeMenuIndex === i ? null : i);
                            }}
                            className="p-1 rounded-full hover:bg-black/5 text-[#667781]"
                          >
                            <ChevronDown size={14} />
                          </button>

                          {/* Message Dropdown Menu */}
                          {activeMenuIndex === i && (
                            <div className="absolute right-0 mt-1 w-32 bg-white rounded-lg shadow-lg border border-[#e9edef] py-1 z-30">
                              {isOwner && msg.type === 'text' && (
                                <button
                                  onClick={() => handleEditInit(i, msg.text)}
                                  className="w-full text-left px-3 py-1.5 text-xs text-[#111b21] hover:bg-[#f0f2f5] flex items-center gap-1.5"
                                >
                                  <Pencil size={12} /> Edit
                                </button>
                              )}
                              <button
                                onClick={() => handleDeleteMessage(i)}
                                className="w-full text-left px-3 py-1.5 text-xs text-rose-600 hover:bg-[#f0f2f5] flex items-center gap-1.5"
                              >
                                <Trash2 size={12} /> Delete
                              </button>
                            </div>
                          )}
                        </div>

                        {msg.imageUrl && (
                          <img src={msg.imageUrl} alt="shared" className="rounded-lg mb-1.5 max-w-full border border-black/5" />
                        )}

                        {isEditing ? (
                          /* Inline Edit Field */
                          <div className="flex flex-col gap-1.5 mt-0.5">
                            <textarea
                              rows={2}
                              value={editingText}
                              onChange={(e) => setEditingText(e.target.value)}
                              className="w-full px-2 py-1 text-xs border border-[#00a884] rounded focus:outline-none resize-none bg-white text-[#111b21]"
                            />
                            <div className="flex justify-end gap-1.5">
                              <button
                                onClick={() => setEditingIndex(null)}
                                className="p-1 text-gray-500 hover:bg-black/5 rounded"
                                title="Cancel"
                                disabled={editingSubmit}
                              >
                                <X size={14} />
                              </button>
                              <button
                                onClick={() => handleEditSave(i)}
                                className="p-1 text-[#00a884] hover:bg-black/5 rounded"
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
                            <p className="text-[13.5px] leading-relaxed break-words pr-4 whitespace-pre-wrap">
                              {msg.text}
                            </p>
                          )
                        )}

                        {/* Timestamp & Indicators */}
                        {!isEditing && (
                          <div className="flex items-center justify-end gap-1 mt-1 select-none">
                            {msg.edited && (
                              <span className="text-[9px] text-[#667781] italic">edited</span>
                            )}
                            <span className="text-[10px] text-[#667781]">
                              {formatTime(msg.timestamp)}
                            </span>
                            {isOwner && (
                              <span className="text-[#53bdeb] ml-0.5" title="Read status">
                                <CheckCheck size={14} className="stroke-[2.5]" />
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
            <div className="px-4 py-3 bg-[#f0f2f5] border-t border-[#d1d7db] shrink-0 z-10">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="Type a message..."
                  className="flex-1 px-4 py-2 text-sm rounded-lg border border-transparent bg-white text-[#111b21] placeholder-[#667781] focus:outline-none focus:ring-1 focus:ring-[#00a884] transition-all"
                />
                <button
                  onClick={handleSend}
                  disabled={sending || !text.trim()}
                  className="w-10 h-10 rounded-full bg-[#00a884] flex items-center justify-center text-white hover:bg-[#008f72] disabled:opacity-50 transition-all shrink-0 shadow-sm"
                >
                  <Send size={16} />
                </button>
              </div>
              {formatDate(activeChat.lastUpdated) && (
                <p className="text-[10px] text-[#667781] text-center mt-2 font-medium">
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
