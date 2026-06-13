import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Send, Bot, BotOff, Trash2, ArrowLeft, RefreshCw, MessageSquare
} from 'lucide-react';
import {
  getAllChats, getChatHistory, sendMessage, toggleBot, deleteChat
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
    navigate(`/chats/${phone}`, { replace: true });
    try {
      const res = await getChatHistory(phone);
      const chat = res.data?.chat || {};
      setActiveChat(chat);
      setMessages(chat.messages || []);
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

  const filtered = chats.filter(c =>
    (c.customerName || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.customerPhone || '').includes(search)
  );

  return (
    <div className="flex h-screen md:h-[calc(100vh)] overflow-hidden">
      {/* Chat List Panel */}
      <div className={`
        ${activeChat ? 'hidden md:flex' : 'flex'}
        flex-col w-full md:w-80 bg-white border-r border-gray-100 shrink-0
      `}>
        <div className="px-4 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-gray-900">Chats</h1>
            <button onClick={fetchChats} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
              <RefreshCw size={15} />
            </button>
          </div>
          <input
            type="text"
            placeholder="Search chats..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingChats ? (
            <Loader size="sm" text="Loading chats..." />
          ) : filtered.length === 0 ? (
            <EmptyState icon={MessageSquare} title="No chats found" />
          ) : (
            filtered.map(chat => (
              <div
                key={chat.customerPhone}
                onClick={() => openChat(chat.customerPhone)}
                className={`
                  flex items-start gap-3 px-4 py-3 cursor-pointer border-b border-gray-50
                  hover:bg-gray-50 transition-colors
                  ${activeChat?.customerPhone === chat.customerPhone ? 'bg-indigo-50' : ''}
                `}
              >
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-sm font-bold shrink-0">
                  {(chat.customerName || 'C')[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-800 truncate">{chat.customerName || chat.customerPhone}</p>
                    <span className="text-xs text-gray-400 shrink-0 ml-2">{formatTime(chat.lastUpdated)}</span>
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{chat.lastMessage || 'No messages'}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Badge status={chat.botPaused ? 'paused' : 'active'} label={chat.botPaused ? 'Bot Off' : 'Bot On'} />
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(chat.customerPhone); }}
                  className="p-1 rounded hover:bg-rose-100 text-gray-300 hover:text-rose-500 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat Window */}
      <div className={`flex-1 flex flex-col ${activeChat ? 'flex' : 'hidden md:flex'}`}>
        {!activeChat ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-20 h-20 rounded-2xl bg-indigo-50 flex items-center justify-center mb-4">
              <MessageSquare size={36} className="text-indigo-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-700">Select a conversation</h3>
            <p className="text-sm text-gray-400 mt-1">Choose a chat from the left panel</p>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm shrink-0">
              <button
                onClick={() => { setActiveChat(null); navigate('/chats', { replace: true }); }}
                className="md:hidden p-1.5 rounded-lg hover:bg-gray-100"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-sm font-bold">
                {(activeChat.customerName || 'C')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{activeChat.customerName || activeChat.customerPhone}</p>
                <p className="text-xs text-gray-400">{activeChat.customerPhone}</p>
              </div>
              {/* Bot toggle */}
              <button
                onClick={handleToggleBot}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                  activeChat.botPaused
                    ? 'bg-gray-100 text-gray-600 hover:bg-emerald-100 hover:text-emerald-700'
                    : 'bg-emerald-100 text-emerald-700 hover:bg-red-100 hover:text-red-600'
                }`}
              >
                {activeChat.botPaused ? <BotOff size={14} /> : <Bot size={14} />}
                {activeChat.botPaused ? 'Bot Off' : 'Bot On'}
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-slate-50">
              {loadingMsgs ? (
                <Loader size="sm" text="Loading messages..." />
              ) : messages.length === 0 ? (
                <EmptyState icon={MessageSquare} title="No messages yet" />
              ) : (
                messages.map((msg, i) => {
                  const isOwner = msg.sender === 'owner';
                  return (
                    <div key={i} className={`flex msg-animate ${isOwner ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 shadow-sm ${
                        isOwner
                          ? 'bg-indigo-600 text-white rounded-br-sm'
                          : 'bg-white text-gray-800 rounded-bl-sm border border-gray-100'
                      }`}>
                        {msg.imageUrl && (
                          <img src={msg.imageUrl} alt="shared" className="rounded-lg mb-1 max-w-full" />
                        )}
                        {msg.text && <p className="text-sm leading-relaxed">{msg.text}</p>}
                        <p className={`text-[10px] mt-1 ${isOwner ? 'text-indigo-200' : 'text-gray-400'}`}>
                          {formatTime(msg.timestamp)}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Input */}
            <div className="px-4 py-3 bg-white border-t border-gray-100 shrink-0">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="Type a message..."
                  className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                <button
                  onClick={handleSend}
                  disabled={sending || !text.trim()}
                  className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors shrink-0"
                >
                  <Send size={16} />
                </button>
              </div>
              {formatDate(activeChat.lastUpdated) && (
                <p className="text-[10px] text-gray-400 text-center mt-1.5">
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
