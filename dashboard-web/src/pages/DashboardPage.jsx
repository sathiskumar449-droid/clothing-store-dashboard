import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShoppingBag, MessageSquare, IndianRupee, Clock, CheckCircle, Users, TrendingUp
} from 'lucide-react';
import { getOrders } from '../api/ordersApi';
import { getAllChats } from '../api/chatsApi';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import StatCard from '../components/ui/StatCard';
import Loader from '../components/ui/Loader';

export default function DashboardPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [recentOrders, setRecentOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const [ordersRes, chatsRes] = await Promise.all([getOrders(), getAllChats()]);
      const orders = ordersRes.data || [];
      const chats = chatsRes.data?.chats || [];

      const totalRevenue = orders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
      const pending = orders.filter(o => o.status === 'pending').length;
      const confirmed = orders.filter(o => o.status === 'confirmed').length;
      const delivered = orders.filter(o => o.status === 'delivered').length;
      const uniqueCustomers = new Set(
        orders.map(o => o.customerPhone || o.customer)
      ).size;
      const activeChats = chats.length;
      const botPausedChats = chats.filter(c => c.botPaused).length;

      setStats({
        totalOrders: orders.length,
        totalRevenue,
        pending,
        confirmed,
        delivered,
        uniqueCustomers,
        activeChats,
        botPausedChats,
      });

      setRecentOrders(
        [...orders]
          .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt))
          .slice(0, 6)
      );
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useAutoRefresh(fetchStats, 10000);

  if (loading) return <Loader text="Loading dashboard..." />;

  const statusColor = {
    pending: 'bg-amber-100 text-amber-700',
    confirmed: 'bg-blue-100 text-blue-700',
    delivered: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-rose-100 text-rose-700',
  };

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Welcome back! Here's what's happening today.</p>
      </div>

      {/* Stats Grid */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            title="Total Orders"
            value={stats.totalOrders}
            icon={ShoppingBag}
            color="indigo"
            subtitle={`${stats.pending} pending`}
          />
          <StatCard
            title="Revenue"
            value={`₹${stats.totalRevenue.toLocaleString('en-IN')}`}
            icon={IndianRupee}
            color="emerald"
          />
          <StatCard
            title="Active Chats"
            value={stats.activeChats}
            icon={MessageSquare}
            color="violet"
            subtitle={`${stats.botPausedChats} bot paused`}
          />
          <StatCard
            title="Customers"
            value={stats.uniqueCustomers}
            icon={Users}
            color="amber"
          />
        </div>
      )}

      {/* Secondary stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div
            onClick={() => navigate('/orders?tab=pending')}
            className="bg-white rounded-xl p-4 border border-amber-100 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-gray-500">Pending</p>
              <Clock size={14} className="text-amber-500" />
            </div>
            <p className="text-2xl font-bold text-amber-600 mt-1">{stats.pending}</p>
          </div>
          <div
            onClick={() => navigate('/orders?tab=confirmed')}
            className="bg-white rounded-xl p-4 border border-blue-100 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-gray-500">Confirmed</p>
              <TrendingUp size={14} className="text-blue-500" />
            </div>
            <p className="text-2xl font-bold text-blue-600 mt-1">{stats.confirmed}</p>
          </div>
          <div
            onClick={() => navigate('/orders?tab=delivered')}
            className="bg-white rounded-xl p-4 border border-emerald-100 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-gray-500">Delivered</p>
              <CheckCircle size={14} className="text-emerald-500" />
            </div>
            <p className="text-2xl font-bold text-emerald-600 mt-1">{stats.delivered}</p>
          </div>
        </div>
      )}

      {/* Recent Orders */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">Recent Orders</h2>
          <button
            onClick={() => navigate('/orders')}
            className="text-xs text-indigo-600 font-medium hover:underline"
          >
            View all
          </button>
        </div>
        <div className="divide-y divide-gray-50">
          {recentOrders.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No orders yet</p>
          ) : (
            recentOrders.map((order) => {
              const id = order.id || order.orderId;
              const name = order.customerName || order.customerDetails || order.customer || 'Customer';
              const date = new Date(order.date || order.createdAt).toLocaleDateString('en-IN');
              const total = `₹${(order.totalPrice || 0).toLocaleString('en-IN')}`;
              return (
                <div
                  key={id}
                  onClick={() => navigate('/billing')}
                  className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{name}</p>
                    <p className="text-xs text-gray-400">{id} · {date}</p>
                  </div>
                  <div className="flex items-center gap-3 ml-3 shrink-0">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusColor[order.status] || 'bg-gray-100 text-gray-600'}`}>
                      {order.status}
                    </span>
                    <span className="text-sm font-bold text-gray-800">{total}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
